'use strict';
// 操作留痕：所有增删改写日志，支持按模块/业务单号回溯
const { uid, now } = require('./util');

/**
 * 写操作日志。
 *
 * 刻意保持「同步签名」：内部自己消化 Promise，调用方一律不需要 await。
 * 原因：
 *   1. 审计日志是旁路行为，写失败不该影响主业务（原来就是 try/catch 吞掉）
 *   2. 全项目 100+ 处调用，若都改成 await 会污染业务代码，且漏一处就是
 *      "unhandled promise" 噪音
 *   3. 云端 db 是 async，本地是同步，签名保持一致最省心
 * 所以这里 await 的是内部函数，外层用 fire-and-forget 包一层。
 */
function write(db, opt) {
  try {
    const r = writeAsync(db, opt);
    if (r && typeof r.catch === 'function') r.catch(() => { /* 已由 writeAsync 内部记日志 */ });
  } catch (e) { console.error('[audit] 写日志失败', e.message); }
}

async function writeAsync(db, opt) {
  try {
    await db.insert('logs', {
      id: uid('log'),
      time: now(),
      userId: opt.userId || '',
      userName: opt.userName || '系统',
      module: opt.module || '系统',
      action: opt.action || '操作',
      bizType: opt.bizType || '',
      bizId: opt.bizId || '',
      bizCode: opt.bizCode || '',
      detail: opt.detail || '',
      before: opt.before || null,
      after: opt.after || null,
      ip: opt.ip || ''
    });
  } catch (e) { console.error('[audit] 写日志失败', e.message); }
}

function routeLog(db, req, module, action, opt) {
  opt = opt || {};
  write(db, {
    userId: req.user ? req.user.id : '',
    userName: req.user ? req.user.name : '系统',
    module: module, action: action,
    bizType: opt.bizType || '', bizId: opt.bizId || '', bizCode: opt.bizCode || '',
    detail: opt.detail || '',
    before: opt.before || null, after: opt.after || null,
    // IP 取值要兼容云端：Netlify Function（Lambda）没有 req.connection / req.socket，
// 只能读 x-forwarded-for / x-real-ip 头。直接访问 req.connection.remoteAddress
// 在云端会 TypeError，而 routeLog 遍布所有增删改接口 → 全站 500。
    ip: (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] ||
      (req.connection && req.connection.remoteAddress) ||
      (req.socket && req.socket.remoteAddress) || '')
  });
}

module.exports = { write, writeAsync, routeLog };
