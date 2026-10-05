'use strict';
/**
 * 诊断脚本（只读，不改数据）：统计每个「菜单接口」一次请求发出多少条 SQL、
 * 其中多少条是「全表 SELECT *（无 WHERE）」、各表拉了多少行/多少字节、墙钟耗时。
 *
 * 目的：定位「线上有些菜单打开明显偏慢」的根因到底是
 *   (a) 单请求 SQL 条数太多（TiDB Serverless 每次往返 ~195ms，条数堆叠）
 *   (b) 大表全量 SELECT *（bills/workorders 几 MB，传输就是几秒）
 *   (c) 冷启动（Lambda + TiDB 空闲唤醒，本脚本测不到，需公网测）
 *
 * 用法：
 *   node scripts/diag_sql.js            # 每个接口跑「冷缓存」+「热缓存」两遍
 *   PLM_ONLY=/api/finance/bills node scripts/diag_sql.js
 *
 * 说明：本脚本直连 .env 里的 TiDB，从「本机」发起，网络往返与 Lambda 不同，
 *      所以 ms 仅供相对比较；SQL 条数 / 全表次数 / 行数 / 字节数才是硬指标。
 */
require('../lib/env');
process.env.DB_MODE = 'cloud';

const tidb = require('../lib/tidb');

// ---- 在 clouddb 被 require 之前，包裹 run/scalar，记录每一条 SQL ----
const origRun = tidb.run;
const origScalar = tidb.scalar;
let LOG = [];
function isFullTable(sql) {
  // SELECT * FROM `x`  —— 没有 WHERE、没有 LIMIT 的全表拉取
  return /^\s*SELECT\s+\*\s+FROM\s+`[^`]+`\s*$/i.test(sql);
}
function tableOf(sql) {
  const m = /FROM\s+`([^`]+)`/i.exec(sql);
  return m ? m[1] : '?';
}
tidb.run = async function (sql, params) {
  const t = Date.now();
  const r = await origRun(sql, params);
  let bytes = 0; try { bytes = JSON.stringify(r && r.rows ? r.rows : (r || [])).length; } catch (e) { }
  LOG.push({ sql, ms: Date.now() - t, rows: Array.isArray(r) ? r.length : (r && r.rows ? r.rows.length : 0), bytes, full: isFullTable(sql), table: tableOf(sql) });
  return r;
};
tidb.scalar = async function (sql, params) {
  const t = Date.now();
  const r = await origScalar(sql, params);
  LOG.push({ sql, ms: Date.now() - t, rows: 1, bytes: 0, full: false, table: tableOf(sql), scalar: true });
  return r;
};

const { createDb, buildRouter } = require('../lib/app');
const A = require('../lib/auth');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const db = createDb();
const ctx = {
  rootDir: ROOT,
  dataDir: path.join(ROOT, 'data'),
  uploadDir: path.join(ROOT, 'uploads'),
  exportDir: path.join(ROOT, 'exports')
};
const router = buildRouter(db, ctx);

const TARGETS = [
  ['驾驶舱(首页)', '/api/report/dashboard'],
  ['房源管理', '/api/property/rooms?size=20'],
  ['合同管理', '/api/contract/contracts?size=20'],
  ['账单', '/api/finance/bills?size=20'],
  ['工单巡检', '/api/ops/workorders?size=20'],
  ['巡更记录', '/api/patrol/records?size=50'],
  ['客户档案', '/api/customer/customers?size=20'],
  ['员工', '/api/hr/employees?size=20'],
  ['发票', '/api/invoice/invoices?size=20'],
  ['HR驾驶舱', '/api/hr/dashboard'],
  ['收入日报', '/api/income/daily'],
  ['收入月表格', '/api/income/monthlyTables']
];

class MiniRes {
  constructor() { this.statusCode = 200; this.headers = {}; this.chunks = []; this.writableEnded = false; }
  setHeader(k, v) { this.headers[k] = v; }
  getHeader(k) { return this.headers[k]; }
  writeHead(c, h) { this.statusCode = c; if (h) Object.assign(this.headers, h); return this; }
  write(c) { if (c) this.chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); return true; }
  end(c) { if (c) this.write(c); this.writableEnded = true; return this; }
  body() { return Buffer.concat(this.chunks).map ? Buffer.concat(this.chunks).toString('utf8') : Buffer.concat(this.chunks).toString('utf8'); }
}

function makeReq(method, fullPath, cookie, body) {
  const u = new URL(fullPath, 'http://x');
  const query = {}; u.searchParams.forEach((v, k) => { query[k] = v; });
  return {
    method, path: u.pathname, url: fullPath, headers: cookie ? { cookie } : {},
    cookies: cookie ? { plm_token: cookie.split('=')[1] } : {},
    query, body: body || {}, params: {},
    get: k => (cookie && k.toLowerCase() === 'cookie') ? cookie : undefined
  };
}

async function dispatch(req) {
  const res = new MiniRes();
  db.beginRequest();
  try {
    const m = router.match(req.method, req.path);
    if (!m) { res.writeHead(404); res.end('{}'); return { status: 404, res }; }
    req.params = m.params;
    await A.attachUserAsync(db, req);
    await m.handler(req, res, m.params);
    if (!res.writableEnded) res.end();
    return { status: res.statusCode, res };
  } finally { db.endRequest(); }
}

function clearShared() {
  // 模拟「冷 Lambda 实例」：清掉跨请求共享缓存与 in-flight
  try { db._shared = new Map(); db._flight = new Map(); db._cache = null; } catch (e) { }
}

function summarize(log) {
  const total = log.length;
  const fulls = log.filter(x => x.full);
  const byTable = {};
  log.forEach(x => { byTable[x.table] = (byTable[x.table] || 0) + 1; });
  const fullByTable = {};
  fulls.forEach(x => { fullByTable[x.table] = (fullByTable[x.table] || 0) + 1; });
  const bytes = log.reduce((s, x) => s + (x.bytes || 0), 0);
  const rows = log.reduce((s, x) => s + (x.rows || 0), 0);
  const sqlMs = log.reduce((s, x) => s + (x.ms || 0), 0);
  const top = Object.entries(byTable).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return { total, fullCount: fulls.length, fullByTable, bytes, rows, sqlMs, top };
}

(async () => {
  const only = process.env.PLM_ONLY;
  const targets = only ? TARGETS.filter(t => t[1].indexOf(only) >= 0 || t[0].indexOf(only) >= 0) : TARGETS;

  // 登录拿 token
  const lr = await dispatch(makeReq('POST', '/api/auth/login', null, { username: process.env.PLM_USER || 'admin', password: process.env.PLM_PASS || '123456' }));
  let token = null;
  try { token = JSON.parse(lr.res.body()).data.token; } catch (e) { }
  if (!token) { console.error('登录失败，无法继续诊断：', lr.res.body().slice(0, 200)); process.exit(1); }
  const cookie = 'plm_token=' + token;
  LOG = [];
  console.log('已登录 admin，开始逐接口统计 SQL（冷缓存=模拟新 Lambda 实例）\n');

  const results = [];
  for (const [name, p] of targets) {
    // 冷缓存
    clearShared();
    LOG = [];
    let t0 = Date.now();
    const cold = await dispatch(makeReq('GET', p, cookie));
    const coldWall = Date.now() - t0;
    const coldSum = summarize(LOG);

    // 热缓存（不清 shared，紧接着再跑一遍）
    LOG = [];
    t0 = Date.now();
    const warm = await dispatch(makeReq('GET', p, cookie));
    const warmWall = Date.now() - t0;
    const warmSum = summarize(LOG);

    results.push({ name, p, status: cold.status, coldWall, coldSum, warmWall, warmSum });
  }

  const pad = (s, n) => String(s).padEnd(n);
  const rp = (s, n) => String(s).padStart(n);
  console.log(pad('接口', 14) + rp('状态', 5) + rp('冷SQL', 7) + rp('冷全表', 7) + rp('冷墙钟ms', 10) + rp('冷字节KB', 10) + rp('热SQL', 7) + rp('热墙钟ms', 10));
  console.log('-'.repeat(84));
  results.forEach(r => {
    console.log(
      pad(r.name, 12) + rp(r.status, 5) +
      rp(r.coldSum.total, 7) + rp(r.coldSum.fullCount, 7) + rp(r.coldWall, 10) +
      rp(Math.round(r.coldSum.bytes / 1024), 10) +
      rp(r.warmSum.total, 7) + rp(r.warmWall, 10)
    );
  });

  console.log('\n===== 冷缓存明细（每接口）=====');
  results.forEach(r => {
    const c = r.coldSum;
    console.log('\n【' + r.name + '】 ' + r.p + '  HTTP ' + r.status);
    console.log('  SQL 总条数: ' + c.total + '   全表 SELECT *: ' + c.fullCount + '   回传行数: ' + c.rows + '   回传字节: ' + Math.round(c.bytes / 1024) + 'KB   SQL累计: ' + c.sqlMs + 'ms   墙钟: ' + r.coldWall + 'ms');
    console.log('  按表SQL次数: ' + c.top.map(t => t[0] + '×' + t[1]).join(', '));
    const fk = Object.entries(c.fullByTable);
    if (fk.length) console.log('  全表拉取的表: ' + fk.map(t => t[0] + '×' + t[1]).join(', '));
  });
  process.exit(0);
})().catch(e => { console.error('诊断脚本异常：', e && e.stack || e); process.exit(1); });
