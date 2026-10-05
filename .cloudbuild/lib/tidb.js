'use strict';
/**
 * TiDB Cloud Serverless 连接层（Netlify Functions 运行时用）
 *
 * 参照 J:\建筑工程管理系统网页版\netlify\functions\api.js 的成熟做法：
 *   · 凭 DATABASE_URL 环境变量，绝不进前端
 *   · Serverless 空闲会休眠，首次连接常需 10~30s 唤醒 → 递增退避重试
 *   · 连接参数过短会被服务端强制关闭 → 配 keepAlive 复用
 *
 * 本地开发（netlify dev）同样可用，只需在项目根放一个 .env 或直接设环境变量。
 */
let connectFn = null;
function getConnect() {
  if (connectFn) return connectFn;
  let mod;
  try { mod = require('@tidbcloud/serverless'); }
  catch (e) {
    throw new Error('缺少依赖 @tidbcloud/serverless，请先 npm install');
  }
  connectFn = mod.connect;
  return connectFn;
}

const BACKOFF = [3000, 6000, 9000, 12000, 15000];

/**
 * 复用同一个 client（连接）。
 *
 * 【为什么必须复用 —— 这是列表页 30 秒的一个根因】
 * 之前 connect() 写在 run() 的循环体里，等于「每条 SQL 新建一个 client」。
 * 实测房源列表一个请求发出 638 条 SQL → 638 次 TCP + TLS 握手。
 * 到 TiDB Cloud Serverless 走公网 + SSL，每次握手本身就是几百毫秒到数秒，
 * 几百个握手还会在服务端排队（实测 SQL 累计耗时 920 秒，而 HTTP 墙钟只有 9 秒，
 * 差 100 倍 —— 就是在服务端/握手队列里排着）。
 *
 * @tidbcloud/serverless 的 client 本身就是连接池（keepAlive + maxIdle），
 * 复用它是官方推荐用法；TiDB Serverless 空闲会休眠，
 * 真断了会在 execute 的 catch 里重建（见下方 _reconnect）。
 */
let _client = null;
let _clientUrl = null;

function getClient() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 未配置（Netlify 环境变量或本地 .env）');
  // URL 变了（本地/云端切换）必须重建，否则会连到错的库
  if (_client && _clientUrl === url) return _client;
  const connect = getConnect();
  _client = connect({
    url,
    // Serverless 连接会被服务端按空闲时间回收，保持长连接减少反复唤醒
    keepAlive: true,
    maxIdle: 1,
    idleTimeout: 30000,
    // 并发上限：Serverless Starter 的连接配额很低，
    // 放开会让几百条并发查询把配额打爆、整体变慢。这里限流是必要的。
    minConnections: 0,
    maxConnections: 10
  });
  _clientUrl = url;
  return _client;
}

function parseDbUrl(u) {
  try {
    const m = String(u).match(/^mysql:\/\/([^:/@]+):([^@]*)@([^:/@]+)(?::\d+)?(?:\/(\S*))?$/);
    if (m) return { username: m[1], host: m[3], database: m[4] || '' };
    const url = new URL(u);
    return { username: url.username, host: url.hostname, database: url.pathname.slice(1) };
  } catch (e) { return {}; }
}

/**
 * 解析 DATABASE_URL 的库名信息。
 * 做成惰性的：不能在模块加载时就解析 process.env.DATABASE_URL，
 * 因为 lib/env.js（负责读 .env）可能在这之后才被 require。
 * 云端部署时环境变量由平台注入、时机不定，惰性求值最稳。
 */
let _dbInfo = null;
function dbInfo() {
  if (!_dbInfo) _dbInfo = parseDbUrl(process.env.DATABASE_URL || '');
  return _dbInfo;
}

const TRANSIENT = /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|timeout|ETIMEDOUT|socket hang up|has been paused|paused|Bad Request|disconnect|closed/i;

async function run(sql, params) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL 未配置（Netlify 环境变量或本地 .env）');
  let lastErr;
  for (let attempt = 0; attempt <= BACKOFF.length; attempt++) {
    // 注意：getClient() 是同步函数（返回已建好的 client，不是 Promise），
    // 写成 `await getClient().execute(...)` 会被守门人脚本判为「await 优先级陷阱」。
    // 实际两者行为相同（await 非 Promise 值会原样返回），但显式分步更清晰、也不误报。
    const client = getClient();
    try {
      return await client.execute(sql, params || []);
    } catch (e) {
      lastErr = e;
      const msg = (e && e.message) || '';
      const transient = TRANSIENT.test(msg);
      // 连接被服务端回收（idle）→ 丢掉旧 client，下一轮用新连接重试。
      // 跨请求复用 client 后这一步是必须的，否则会一直抱着一个死连接重试到底。
      if (transient) { _client = null; _clientUrl = null; }
      if (attempt < BACKOFF.length && transient) {
        await new Promise(r => setTimeout(r, BACKOFF[attempt]));
        continue;
      }
      if (/user name prefix|Access denied|authentication|password|credential/i.test(msg) && dbInfo().username) {
        e.message = msg + `  [诊断：用户名="${dbInfo().username}"，主机="${dbInfo().host}"]`;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function scalar(sql, params) {
  const r = await run(sql, params);
  return r && r.length ? r[0] : null;
}

/** 判断错误是否「唯一键冲突」，用于幂等 upsert */
function isDuplicate(e) {
  const msg = (e && e.message) || '';
  return /Duplicate entry|duplicate key|1062/i.test(msg);
}

async function ping() {
  const t0 = Date.now();
  await run('SELECT 1 AS ok', []);
  return { ok: true, ms: Date.now() - t0, db: dbInfo() };
}

module.exports = { run, scalar, ping, isDuplicate, parseDbUrl, dbInfo };