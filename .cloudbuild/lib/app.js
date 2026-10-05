'use strict';
/**
 * 路由装配 —— 本地 server.js 与云端 Netlify Function 共用同一份装配逻辑
 *
 * 目的：151 个业务接口只在这里注册一次，两种运行形态复用，
 *      避免出现「本地能跑、云端少接口」这种漂移。
 *
 * 用法：
 *   const { buildRouter } = require('./lib/app');
 *   const router = buildRouter(db, ctx);
 */
const path = require('path');
// 先加载 .env：本地要连 TiDB 做云端验证时，环境变量只在文件里
require('./env');
const { Router, ok } = require('./http');
const A = require('./auth');

const ROOT = path.join(__dirname, '..');

function buildRouter(db, ctx) {
  ctx = ctx || {};
  ctx.rootDir = ctx.rootDir || ROOT;
  ctx.dataDir = ctx.dataDir || path.join(ROOT, 'data');
  ctx.uploadDir = ctx.uploadDir || path.join(ROOT, 'uploads');
  ctx.exportDir = ctx.exportDir || path.join(ROOT, 'exports');

  const router = new Router();

  router.get('/api/health', async (req, res) => {
    ok(res, { status: 'ok', time: new Date().toISOString(), mode: db.kind || 'local' });
  });
  // 集合条数在云端较慢（40 次 COUNT），单独一个轻量接口供前端探活
  router.get('/api/health/quick', async (req, res) => {
    ok(res, { status: 'ok', mode: db.kind || 'local' });
  });

  require(path.join(ROOT, 'routes/auth'))(db, router);
  require(path.join(ROOT, 'routes/property'))(db, router);
  require(path.join(ROOT, 'routes/customer'))(db, router);
  require(path.join(ROOT, 'routes/contract'))(db, router);
  require(path.join(ROOT, 'routes/contractcmp'))(db, router, ctx);
  require(path.join(ROOT, 'routes/billing'))(db, router);
  require(path.join(ROOT, 'routes/invoice'))(db, router);
  require(path.join(ROOT, 'routes/approval'))(db, router);
  require(path.join(ROOT, 'routes/ops'))(db, router, ctx);
  require(path.join(ROOT, 'routes/report'))(db, router, ctx);
  require(path.join(ROOT, 'routes/hr'))(db, router, ctx);
  require(path.join(ROOT, 'routes/patrol'))(db, router, ctx);
  require(path.join(ROOT, 'routes/income'))(db, router, ctx);

  return router;
}

/**
 * 创建数据访问实例
 *   DB_MODE=local（默认）→ lib/db.js  本地 json
 *   DB_MODE=cloud          → lib/clouddb.js  TiDB Cloud
 * 传入了 db 就直接复用（避免同一进程建两个连接）
 */
function createDb(existing) {
  if (existing) return existing;
  const mode = String(process.env.DB_MODE || '').toLowerCase();
  const hasUrl = !!process.env.DATABASE_URL;
  if (mode === 'cloud' || (mode === '' && hasUrl)) {
    const CloudDB = require('./clouddb');
    return new CloudDB();
  }
  const DB = require('./db');
  return new DB(process.env.DATA_DIR || path.join(ROOT, 'data'));
}

module.exports = { buildRouter, createDb, ROOT };