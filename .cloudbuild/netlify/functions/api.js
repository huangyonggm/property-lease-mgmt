'use strict';
/**
 * 物业不动产租赁管理系统 · Netlify Function 入口
 *
 * 原理：本项目的 151 个业务接口全部挂在自研的 lib/http.js 路由器上，
 *      它按 Node 原生 http 的 req/res 约定编写。为避免为 Serverless
 *      重写一遍接口，这里做一个「事件 → req/res」适配层，
 *      复用同一份 routes/ 装配逻辑（见 lib/app.js）。
 *
 * 路由分配：
 *   /api/*     → 本函数
 *   其余        → Netlify 静态资源（netlify.toml 的 redirect 负责）
 *
 * ⚠ 业务模块一律通过 require('./_root').req('lib/xxx') 加载，**不要写
 *   硬编码的 path.join(__dirname, '..', '..', 'lib', …)**。
 *   原因见 _root.js 注释：CLI 打包与 REST 直传 zip 的解压层级不同，
 *   固定 '../..' 在其中一种布局下会解析成 /lib/xxx → 整个函数 502。
 */
const path = require('path');
const fs = require('fs');
const { req } = require('./_root');
const { buildRouter, createDb, ROOT } = req('lib/app');
const A = req('lib/auth');

// 函数实例会被复用，db 与 router 只建一次
let DB = null;
let ROUTER = null;

function ensureInit() {
  if (ROUTER) return;
  DB = createDb();
  // Lambda 的 /var/task 是只读的，mkdir 会抛 ENOENT 导致整个 Function 502。
  // 所以目录默认值改到 /tmp（唯一可写区），且创建必须容错 —— 建不出来也不能让整个服务挂掉。
  const WRITABLE = process.env.LAMBDA_TASK_ROOT ? '/tmp' : ROOT;
  const ctx = {
    rootDir: ROOT,
    dataDir: path.join(ROOT, 'data'),
    uploadDir: process.env.UPLOAD_DIR || path.join(WRITABLE, 'uploads'),
    exportDir: process.env.EXPORT_DIR || path.join(WRITABLE, 'exports')
  };
  [ctx.uploadDir, ctx.exportDir].forEach(d => {
    try {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    } catch (e) {
      // 只读文件系统：附件应走对象存储（ATT_STORAGE=qiniu），导出走内存返回。
      // 这里仅记录，不阻断 —— 真正用到该目录的接口会各自处理。
      console.warn('[init] 无法创建目录（只读文件系统？）:', d, '-', e.message);
    }
  });
  ROUTER = buildRouter(DB, ctx);
}

// ---- Node req/res 的最小模拟实现 ----
class MiniRes {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.writableEnded = false;
  }
  setHeader(k, v) { this.headers[k] = v; }
  getHeader(k) { return this.headers[k]; }
  writeHead(code, h) { this.statusCode = code; if (h) Object.assign(this.headers, h); return this; }
  write(c) { if (c) this.chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); return true; }
  end(c) { if (c) this.write(c); this.writableEnded = true; return this; }
  output() {
    return {
      statusCode: this.statusCode,
      headers: this.headers,
      body: Buffer.concat(this.chunks).toString('utf8')
    };
  }
}

function parseCookies(str) {
  const out = {};
  (str || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

exports.handler = async function (event, context) {
  ensureInit();
  // 【关键修复 —— 线上分页/过滤/搜索全部失效的根因】
  // Netlify 的 event.path **不含查询串**（只有 '/api/finance/bills'），
  // 查询参数在 event.rawUrl（含 '?size=20'）与 event.queryStringParameters 里。
  // 原写法 `event.path || event.rawUrl` 因 path 恒存在，rawUrl 永远轮不到，
  // 于是 u.searchParams 恒空 → req.query.size/period/keyword/sort 全丢 →
  //   · page() 拿不到 size → 不加 LIMIT → 每个列表接口都回「整表」
  //     （实测 bills?size=20 竟回传 1.58MB / 全部 1228 行；workorders 回 1.15MB）
  //   · 所有 ?period= / ?projectId= / ?status= 过滤、关键字搜索、排序在线上统统无效
  // 本地 server.js 用 url.parse(req.url).query 解析，所以本地一切正常 —— 只有线上中招。
  // 修复：优先用 rawUrl（含查询串）构造 URL；再用 queryStringParameters 兜底合并。
  const rawPath = event.rawUrl || event.path || '/';
  const u = new URL(rawPath, 'http://x');
  const pathname = decodeURIComponent(u.pathname);
  const headers = {};
  Object.keys(event.headers || {}).forEach(k => { headers[k.toLowerCase()] = event.headers[k]; });

  // ---- 定时预热专用分支（netlify.toml 里 functions."api".schedule 触发）----
  // 目的不是「返回内容」，而是**让 Lambda 实例与 TiDB 连接都保持温热**：
  //   · Lambda 闲置回收后再唤醒要 10~30 秒，是「首屏加载很慢」的主因
  //   · TiDB Cloud Serverless 空闲也会休眠，唤醒同样要数秒
  // 所以这里必须做一次**真实的数据库往返**（SELECT 1），
  // 只让 Lambda 醒着而数据库还冷着，等于没预热。
  if (pathname === '/api/warmup' || pathname === '/.netlify/functions/api/warmup') {
    const t0 = Date.now();
    let dbOk = false, dbErr = '';
    try {
      const tidb = req('lib/tidb');
      await tidb.run('SELECT 1 AS ok', []);
      dbOk = true;
    } catch (e) {
      dbErr = (e && e.message) || String(e);
      console.warn('[warmup] 数据库未就绪：', dbErr);
    }
    // 预热「跨请求共享缓存」：把常用表提前载入本 Lambda 实例的共享缓存。
    // 用户真正点开菜单时命中缓存 → 0 次网络往返（否则每个新实例首屏都要现拉几 MB）。
    // endRequest() 只清请求级缓存，共享缓存会保留。单表失败不阻断其余。
    //
    // 【配额权衡 —— 定时预热只带小/中表】
    // warmup.js 每 5 分钟触发一次（约 8640 次/月）。bills(1228 行)+workorders(2008 行)
    // 是最大的两张表，若每次都整表预载，一个月要白白多读约 3000 万行，逼近 TiDB
    // Serverless 免费额度。所以定时预热只载「小/中表」（鉴权基线 + 列表 decorate 常用，
    // 合计约 500 行/次，成本可忽略）；bills/workorders 留给用户首次点击时按需载入
    // （载入后进共享缓存，30 秒内复用）。需要彻底预热时可手动打 /api/warmup?full=1。
    const preloaded = [];
    if (dbOk) {
      const SMALL = ['users', 'depts', 'posts', 'roles', 'projects', 'buildings',
        'rooms', 'customers', 'contracts'];
      const BIG = ['bills', 'workorders'];
      const WARM_TABLES = (u.searchParams.get('full') === '1') ? SMALL.concat(BIG) : SMALL;
      try {
        DB.beginRequest();
        for (const t of WARM_TABLES) {
          try { await DB.all(t); preloaded.push(t); } catch (e) { /* 单表失败忽略 */ }
        }
      } catch (e) {
        console.warn('[warmup] 预热缓存异常：', e && e.message);
      } finally {
        try { DB.endRequest(); } catch (e) { }
      }
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, data: { warmed: true, db: dbOk, preloaded: preloaded, ms: Date.now() - t0, err: dbErr || undefined } })
    };
  }

  // 查询串
  const query = {};
  u.searchParams.forEach((v, k) => { query[k] = v; });
  // 兜底：某些运行时 rawUrl 可能不带查询串，用 Netlify 已解析好的 queryStringParameters 补齐。
  // 不覆盖 rawUrl 已解析出的值（rawUrl 优先，避免多值参数被压平后覆盖）。
  const qsp = event.queryStringParameters || event.multiValueQueryStringParameters;
  if (qsp) Object.keys(qsp).forEach(k => { if (query[k] === undefined) query[k] = qsp[k]; });

  // 请求体：json / urlencoded / 原始
  let body = {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '');
  const ct = String(headers['content-type'] || '');
  if (raw.length) {
    if (ct.indexOf('application/json') >= 0) {
      try { body = JSON.parse(raw.toString('utf8')); } catch (e) { body = {}; }
    } else if (ct.indexOf('application/x-www-form-urlencoded') >= 0) {
      body = {};
      new URLSearchParams(raw.toString('utf8')).forEach((v, k) => { body[k] = v; });
    } else {
      body = raw;
    }
  }

  const req = {
    method: (event.httpMethod || 'GET').toUpperCase(),
    path: pathname,
    url: rawPath,
    headers,
    cookies: parseCookies(headers.cookie),
    query,
    body,
    ip: (headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || '').split(',')[0].trim(),
    ua: headers['user-agent'] || '',
    get: k => headers[String(k).toLowerCase()]
  };
  const res = new MiniRes();

  // 开启「请求级缓存」：本次请求内同一张表只查一次，循环里逐行查关联不再打网络。
  // TiDB Serverless 单次往返约 195ms，N+1 会被放大 200 倍（实测月表格单请求 2049 条 SQL / 222 秒）。
  // 用 finally 释放：Lambda 实例会复用，不释放就会在内存里驻留过期数据。
  DB.beginRequest();
  try {
    const m = ROUTER.match(req.method, req.path);
    if (!m) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, msg: '接口不存在：' + req.method + ' ' + req.path }));
      return res.output();
    }
    req.params = m.params;

    // 会话解析（把用户挂到 req.user / req.u），与本地 attachUser 等价
    await A.attachUserAsync(DB, req);

    await m.handler(req, res);
    if (!res.writableEnded) res.end();
    return res.output();
  } catch (e) {
    console.error('[Function] ' + req.method + ' ' + req.path + ' →', e && e.stack || e);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, msg: '服务端异常：' + (e && e.message || e) }));
    return res.output();
  } finally {
    DB.endRequest();
  }
};