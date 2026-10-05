'use strict';
/**
 * 业务代码定位器（Netlify Function 专用）
 *
 * ══════════════════════════════════════════════════════════════
 * 为什么要这个文件（2026-10-04 线上 502 的根因）
 * ══════════════════════════════════════════════════════════════
 * 函数入口原本写的是硬编码的相对层数：
 *     require(path.join(__dirname, '..', '..', 'lib', 'app'))
 * 这在 Netlify CLI 打包时是对的（CLI 把函数放在
 * /var/task/netlify/functions/ 下，`../../` 正好回到 /var/task）。
 *
 * 但走 REST API 手工上传 zip 时，Netlify 是把 zip 内容直接解到
 * /var/task/ 根下 —— 也就是 lib/ 就在 __dirname 同一层。
 * 于是 `../../lib/app` 变成 /lib/app，找不到：
 *     Runtime.ImportModuleError: Cannot find module '/lib/app'
 *     Require stack: - /var/task/api.js
 * 整个函数 502，所有 151 个接口全挂。
 *
 * 两种布局都真实存在、且随时可能被 Netlify 改动，所以**不能赌某一层**。
 * 这里改成从 __dirname 出发逐级向上探测，找到第一个含 lib/ 的目录即停，
 * 并把结果缓存下来（函数实例复用，探测只做一次）。
 *
 * 覆盖的布局：
 *   /var/task/api.js                          → lib/ 在第 0 层
 *   /var/task/netlify/functions/api.js        → lib/ 在第 2 层
 *   <本地>/netlify/functions/api.js           → lib/ 在第 2 层（本地调试）
 */
const path = require('path');
const fs = require('fs');

/** 探测出的项目根目录（含 lib/ 与 routes/ 的那一层） */
let _root = null;

function findRoot() {
  if (_root !== null) return _root;
  // 从函数文件所在目录起，最多向上 10 层
  // 覆盖所有可能的部署布局：
  //   /var/task/api.js                          → lib/ 在第 0 层
  //   /var/task/netlify/functions/api.js        → lib/ 在第 2 层
  //   /var/task/.netlify/functions/api.js       → lib/ 在第 3 层
  let dir = __dirname;
  for (let i = 0; i < 11; i++) {
    if (fs.existsSync(path.join(dir, 'lib', 'app.js'))) { _root = dir; return dir; }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // 兜底：给一个明确错误
  const e = new Error(
    '找不到项目根目录（从 ' + __dirname + ' 向上 10 层内没有 lib/app.js）。' +
    '实际目录结构：' + JSON.stringify(fs.readdirSync(__dirname)) + '.'
  );
  e.code = 'PLM_ROOT_NOT_FOUND';
  throw e;
}

/** 按项目内的相对路径 require 业务模块，如 req('lib/app') */
function req(rel) {
  const target = path.join(findRoot(), rel);
  return require(target);
}

module.exports = { findRoot, req };
