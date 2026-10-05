'use strict';
/**
 * 定时预热函数（Netlify Scheduled Function）
 *
 * 【为什么单独一个函数，而不是给 api 函数挂 schedule】
 * 给 api 挂 schedule 时，Netlify 定时触发的 event.path 是函数根路径（/.netlify/functions/api），
 * 落不到 api.js 里 `pathname === '/api/warmup'` 那个分支，于是「Lambda 醒了、数据库没醒」——
 * 而数据库唤醒（TiDB Serverless 空闲休眠）才是首屏 10~30 秒的大头。
 * 单独一个函数可以精确控制：先直连 TiDB 打一发 SELECT 1（唤醒数据库），
 * 再用 HTTP 打一发线上的 /api/warmup（唤醒 api Lambda 并预热它的共享缓存）。
 *
 * 【配额】schedule = "*\/5 * * * *" → 每月约 8640 次调用，远低于免费额度 12.5 万次/月。
 *
 * 配置见 netlify.toml 的 [functions.warmup] schedule。
 *
 * ⚠ 同 api.js：业务模块走 _root.js 自适应定位，**不要写死的 '../../lib/xxx'**。
 *   固定层数在 REST 直传 zip 的解压布局下会变成 /lib/xxx → 函数 502。
 */
const { req } = require('./_root');
req('lib/env');

exports.handler = async function () {
  const t0 = Date.now();
  const out = { ok: true, db: false, api: null, ms: 0, err: undefined };

  // 1) 唤醒 TiDB Serverless（真实数据库往返，光醒 Lambda 没用）
  try {
    const tidb = req('lib/tidb');
    await tidb.run('SELECT 1 AS ok', []);
    out.db = true;
  } catch (e) {
    out.err = (e && e.message) || String(e);
  }

  // 2) 唤醒 api Lambda + 预热它的跨请求共享缓存
  try {
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL || '';
    if (base) {
      const c = new AbortController();
      const to = setTimeout(() => c.abort(), 20000);
      const r = await fetch(base.replace(/\/$/, '') + '/api/warmup', { signal: c.signal });
      clearTimeout(to);
      out.api = r.status;
    }
  } catch (e) {
    // api 预热失败不影响数据库已唤醒这一主要收益
    out.apiErr = (e && e.message) || String(e);
  }

  out.ms = Date.now() - t0;
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(out)
  };
};
