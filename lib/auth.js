'use strict';
// 认证、会话与权限（多级审批 / 岗位隔离 / 数据范围）
const crypto = require('crypto');
const { uid, md5 } = require('./util');

// 权限点定义
//
// 【为什么要升级成「菜单 + 子权限」两级】
// 原来只有一维的编码列表，角色编辑页只能给一个 textarea 让管理员手填
// "contract:view,contract:manage"。问题是：
//   ① 抄错编码系统不报错，那个权限只是悄悄失效，排查极难
//   ② 63 个编码全靠肉眼对照下方那张「权限点一览」表逐个抄
//   ③ 不知道每个模块下有哪些动作，容易漏
//
// 升级后每个模块带 menu（菜单名/icon/path，勾选界面按菜单分组）与
// actions（子权限 {code, label}，勾成复选框）。角色仍然**只存 perms 扁平数组**
// —— 菜单的勾选状态由子权限推导（勾了 xxx:view 菜单就亮），不新增存储字段，
// 所以老角色数据原样可用，hasPerm 逻辑一行都不用改。
const PERMS = [
  ['dashboard', '驾驶舱', ['view']],
  ['org', '组织权限', ['view', 'manage']],
  ['property', '房源管理', ['view', 'manage', 'import']],
  ['customer', '客户档案', ['view', 'manage', 'risk']],
  ['contract', '合同管理', ['view', 'manage', 'approve', 'terminate']],
  ['billing', '收费管理', ['view', 'manage', 'collect', 'meter', 'deposit']],
  ['invoice', '发票管理', ['view', 'manage', 'split']],
  ['approval', '审批流程', ['view', 'approve', 'price', 'rent', 'free']],
  ['workorder', '工单巡检', ['view', 'manage', 'patrol']],
  ['hr', '人事管理', ['view', 'manage', 'attend', 'payroll']],
  ['patrol', '巡更检查', ['view', 'manage', 'import', 'analyze', 'export']],
  ['income', '收入台账', ['view', 'manage', 'export', 'import']],
  ['report', '报表统计', ['view', 'export']],
  ['system', '系统设置', ['view', 'manage', 'log']]
];

/**
 * 动作码 → 中文标签。
 *
 * 【为什么必须有这个字典】勾选界面上要显示「查看 / 新增编辑 / 审批」这种
 * 人能看懂的中文，不能让人对着 approve / terminate / split 猜含义。
 * 同一个动作码在不同模块下含义可能不同（比如 import 在房源是「导入」、
 * 在巡更是「导入记录」），所以支持按模块覆盖。
 */
const ACT_LABELS = {
  view: '查看',
  manage: '新增 / 编辑 / 删除',
  import: '导入',
  approve: '审批',
  terminate: '终止 / 退租',
  risk: '风险标记',
  collect: '收款登记',
  meter: '抄表',
  deposit: '押金 / 预收',
  split: '拆分 / 红冲',
  price: '价格审批',
  rent: '租金审批',
  free: '减免审批',
  patrol: '巡更记录',
  attend: '考勤',
  payroll: '工资',
  log: '操作日志',
  export: '导出 Excel'
};

// 按模块覆盖的动作标签（值里可用 {name} 引用模块名）
const ACT_LABELS_BY_MODULE = {
  patrol: { patrol: '巡更记录录入', analyze: '覆盖率分析' },
  workorder: { patrol: '巡更记录' },
  property: { import: '批量导入房源' },
  income: { import: '导入台账' }
};

// 菜单的展示名与图标（与 routes/auth.js 的 menusOf 保持一致）
// key 与 PERMS 的模块名一一对应；两处不一致会导致「勾了权限但菜单不出现」
const MENU_META = {
  dashboard: { label: '驾驶舱', icon: 'home', path: '#/dashboard' },
  org: { label: '组织权限', icon: 'org', path: '#/org' },
  property: { label: '房源管理', icon: 'building', path: '#/property' },
  customer: { label: '客户档案', icon: 'user', path: '#/customer' },
  contract: { label: '合同管理', icon: 'doc', path: '#/contract' },
  billing: { label: '收费管理', icon: 'money', path: '#/billing' },
  invoice: { label: '发票管理', icon: 'ticket', path: '#/invoice' },
  approval: { label: '审批流程', icon: 'flow', path: '#/approval' },
  workorder: { label: '工单巡检', icon: 'tool', path: '#/workorder' },
  hr: { label: '人事薪酬', icon: 'team', path: '#/hr' },
  patrol: { label: '巡更检查', icon: 'patrol', path: '#/patrol' },
  income: { label: '收入台账', icon: 'income', path: '#/income' },
  report: { label: '报表统计', icon: 'chart', path: '#/report' },
  system: { label: '系统设置', icon: 'set', path: '#/system' }
};

/**
 * 动作码的中文名。
 * @param {string} mod 模块名，如 contract
 * @param {string} act 动作码，如 approve
 * @returns {string}
 */
function actLabel(mod, act) {
  const byMod = ACT_LABELS_BY_MODULE[mod];
  if (byMod && byMod[act]) return byMod[act];
  return ACT_LABELS[act] || act;
}

/**
 * 构建「菜单 → 子权限」树，供前端勾选界面直接渲染。
 *
 * 【返回结构】
 *   [{
 *     key: 'contract', label: '合同管理', icon: 'doc', path: '#/contract',
 *     viewCode: 'contract:view',          // 菜单的「查看」权限码
 *     actions: [{ code:'contract:view', label:'查看' }, ...]
 *   }, ...]
 *
 * 每一项都带 viewCode 是因为「菜单可见」在业务上就等于「有该模块的 view 权限」，
 * 前端勾选时把 viewCode 当成该菜单的开关即可，不用另外发明字段。
 *
 * @returns {Array}
 */
function permTree() {
  return PERMS.map(([mod, label, acts]) => {
    const meta = MENU_META[mod] || {};
    return {
      key: mod,
      label: meta.label || label,
      icon: meta.icon || 'set',
      path: meta.path || ('#/' + mod),
      viewCode: mod + ':view',
      actions: acts.map(a => ({ code: mod + ':' + a, label: actLabel(mod, a) }))
    };
  });
}

function allPermCodes() {
  const out = [];
  PERMS.forEach(([m, label, acts]) => acts.forEach(a => out.push(m + ':' + a)));
  return out;
}

// 数据范围
const SCOPES = {
  all: '全部数据',
  dept: '本部门数据',
  project: '所属项目数据',
  self: '仅本人经办'
};

// 会话：内存 Map + 落盘（sessions.json），服务重启后登录态不丢
// token -> { userId, loginTime, ip, ua, expireAt }
const sessions = new Map();
const SESSION_TTL_MS = 24 * 3600 * 1000;   // 与 Cookie Max-Age 对齐：24 小时
const MAX_SESSION_PER_USER = 10;           // 同一用户最多保留的会话数（超出顶掉最旧的）
let _db = null;

async function loadSessions(db) {
  _db = db;
  try {
    const arr = (await db.all('sessions'));
    const nowTs = Date.now();
    let n = 0;
    arr.forEach(s => {
      if (!s || !s.token || !s.userId) return;
      if (s.expireAt && new Date(s.expireAt).getTime() < nowTs) return;   // 过期丢弃
      sessions.set(s.token, s);
      n++;
    });
    if (n) console.log('[AUTH] 已恢复 ' + n + ' 个登录会话');
  } catch (e) { /* sessions.json 不存在或损坏时忽略 */ }
  // 后台每小时清理一次过期会话
  const t = setInterval(purgeSessions, 3600 * 1000);
  if (t.unref) t.unref();
}

/**
 * 会话落盘（sessions 表）。
 *
 * 会话本身常驻内存 Map，这里只做「把当前快照写回存储」。
 * 本地 db.replace 是同步的，云端 clouddb.replace 是 async 返回 Promise，
 * 所以这里统一成 fire-and-forget：返回 Promise 并挂 catch，调用方不必 await。
 * 会话快照写失败不应该把登录流程搞挂 —— 最坏后果是重启后会话丢失，重新登录即可。
 */
function persistSessions() {
  if (!_db) return;
  try {
    const r = _db.replace('sessions', Array.from(sessions.values()));
    if (r && typeof r.catch === 'function') {
      r.catch(e => console.error('[auth] 会话落盘失败', e && e.message));
    }
  } catch (e) { }
}

function purgeSessions() {
  const nowTs = Date.now();
  let n = 0;
  sessions.forEach((v, k) => { if (v.expireAt && new Date(v.expireAt).getTime() < nowTs) { sessions.delete(k); n++; } });
  if (n) persistSessions();
}

async function login(db, username, password, req) {
  if (!_db) loadSessions(db);
  const u = (await db.one('users', r => r.username === String(username).trim() && r.status !== '停用'));
  if (!u) return { ok: false, msg: '用户不存在' };
  if (u.password !== crypto.createHash('md5').update(String(password)).digest('hex')) return { ok: false, msg: '密码错误' };
  const token = crypto.randomBytes(18).toString('hex');
  // 取客户端 IP：本地有 req.socket，Netlify Function（Lambda）没有 socket 对象，
  //   只能靠 x-forwarded-for / x-real-ip 头。
  // 之前直接读 req.socket.remoteAddress，云端一登录就 TypeError ——
//   登录是所有接口的前置，整站会瘫。
  const ip = (req && req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) ||
    (req && req.socket && req.socket.remoteAddress) || '';
  const ua = (req && req.headers && req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 200) : '');

  // 说明：不做「同 IP+UA 立即顶掉旧会话」——
  //   同一台电脑重复登录（切号再切回、旧标签页未关闭）是正常场景，顶掉会导致旧标签页立刻掉线。
  //   改为「按用户限量」：同一用户最多保留 MAX_PER_USER 个会话，超出时只顶掉最旧的。
  //   这样既不会让正常旧标签页掉线，也不会让 sessions.json 无限膨胀。
  const mine = [];
  sessions.forEach((v, k) => { if (v.userId === u.id) mine.push({ k: k, t: v.loginTime || '' }); });
  mine.sort((a, b) => String(a.t).localeCompare(String(b.t)));   // 旧的在前
  let replaced = 0;
  if (mine.length >= MAX_SESSION_PER_USER) {
    mine.slice(0, mine.length - MAX_SESSION_PER_USER + 1).forEach(x => { sessions.delete(x.k); replaced++; });
  }

  sessions.set(token, {
    token: token,
    userId: u.id,
    loginTime: new Date().toISOString(),
    expireAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    ip: ip,
    ua: ua
  });
  purgeSessions();
  persistSessions();
  // safeUser 要查部门/岗位/角色（云端 async），必须 await，否则返回的是 Promise，
  // 前端拿到 user.menus=[] 与空 perms → 侧边栏全空、所有接口 403
  return { ok: true, token: token, user: await safeUser(db, u), replaced: replaced };
}

function logout(token) {
  if (sessions.delete(token)) persistSessions();
}

async function sessionUser(db, token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expireAt && new Date(s.expireAt).getTime() < Date.now()) { sessions.delete(token); persistSessions(); return null; }
  const u = (await db.find('users', s.userId));
  if (!u || u.status === '停用') return null;
  return u;
}

// 在线会话列表（系统管理页展示：谁在线、从哪几台机器登录）
// 按「人」聚合：同一人多台电脑登录合并为一行，devices 列出各客户端
async function onlineList(db) {
  const byUser = new Map();
  // 必须用 for...of 而不是 forEach：回调里要 await db.find（云端返回 Promise），
  // forEach 的回调是同步函数，await 不会等待，会把 undefined 写进 byUser。
  for (const s of sessions) {
    const u = await db.find('users', s.userId);
    if (!u || u.status === '停用') continue;
    const key = s.userId;
    if (!byUser.has(key)) {
      byUser.set(key, {
        userId: s.userId, userName: u.name, username: u.username,
        loginTime: s.loginTime, expireAt: s.expireAt, deviceCount: 0,
        devices: []
      });
    }
    const row = byUser.get(key);
    row.deviceCount++;
    row.devices.push({ ip: s.ip || '', ua: s.ua || '', loginTime: s.loginTime });
    if (String(s.loginTime) > String(row.loginTime)) row.loginTime = s.loginTime;
  }
  return Array.from(byUser.values())
    .sort((a, b) => b.deviceCount - a.deviceCount || String(b.loginTime).localeCompare(String(a.loginTime)));
}

function forceLogout(userId) {
  let n = 0;
  const arr = [];
  sessions.forEach((v, k) => { if (v.userId === userId) { sessions.delete(k); n++; } else arr.push(v); });
  if (n) persistSessions();
  return n;
}

async function safeUser(db, u) {
  if (!u) return null;
  const dept = (await db.find('depts', u.deptId));
  const post = (await db.find('posts', u.postId));
  const role = (await db.find('roles', u.roleId));
  return {
    id: u.id, username: u.username, name: u.name, phone: u.phone,
    deptId: u.deptId, deptName: dept ? dept.name : '',
    postId: u.postId, postName: post ? post.name : '',
    roleId: u.roleId, roleName: role ? role.name : '',
    // 这里必须用「长度判断」而不是 ||：
    //   空数组 [] 在 JS 里是 truthy，`u.perms || role.perms` 短路后会直接返回那个空数组，
    //   fallback 永远不触发。用户在 users 表里的 perms 一旦是 []（老数据/云端导入补齐过字段），
    //   登录回来 perms 就是 0 项 → 前端菜单全空、所有接口 403。
    perms: (Array.isArray(u.perms) && u.perms.length) ? u.perms : (role && Array.isArray(role.perms) ? role.perms : []),
    dataScope: u.dataScope || (role ? role.dataScope : 'all') || 'all',
    projectIds: u.projectIds || [],
    isAdmin: !!u.isAdmin,
    dingtalkUserId: u.dingtalkUserId || ''
  };
}

function hasPerm(user, code) {
  if (!user) return false;
  if (user.isAdmin) return true;
  if (Array.isArray(user.perms) && user.perms.indexOf('*') >= 0) return true;
  return Array.isArray(user.perms) && user.perms.indexOf(code) >= 0;
}

// 路由级权限校验中间件（在业务 handler 前执行）
function permGuard(code) {
  return function (req, res) {
    if (!req.user) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, msg: '未登录或登录已失效', code: 401 }));
      return false;
    }
    if (!hasPerm(req.u, code)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, msg: '无权限：需要 ' + code + ' 权限', code: 403 }));
      return false;
    }
    return true;
  };
}

// 数据可见范围过滤：给集合行打标签（ownerId / deptId / projectId）
function scopeFilter(user, row) {
  if (!user || user.isAdmin || user.dataScope === 'all') return true;
  if (user.dataScope === 'dept') return String(row.deptId || '') === String(user.deptId || '');
  if (user.dataScope === 'project') {
    const pid = row.projectId;
    if (!pid) return true;
    return !user.projectIds || user.projectIds.length === 0 || user.projectIds.indexOf(pid) >= 0;
  }
  if (user.dataScope === 'self') return String(row.ownerId || row.createdBy || '') === String(user.id || '');
  return true;
}

// 中间件：解析用户。
// 内部闭包是 async（safeUser 要查库），且 sessionUser 同样是 async，必须 await。
// server.js 以 before 中间件挂载，http.js 的中间件循环已 `await mw(req, res)`。
function attachUser(db) {
  return async function (req, res) {
    const token = (req.cookies && req.cookies['plm_token']) || (req.headers['x-token']) || (req.query && req.query.token);
    req.user = token ? await sessionUser(db, token) : null;
    if (req.user) req.u = await safeUser(db, req.user);
    return true;
  };
}

/* ---------- 云端（TiDB）异步孪生函数 ----------
 * 本地 db.js 是全同步 API，云端 db 是全异步，
 * 因此下面这组是 sessionUser / safeUser / attachUser 的 await 版。
 * 逻辑与同步版逐行一致，只把 db.find 改成 await db.find。
 */

/** 云端版：按 token 取用户（会话仍在内存，落盘逻辑共用） */
async function sessionUserAsync(db, token) {
  let s = sessions.get(token);
  // ---- 关键：内存未命中时必须回源数据库 ----
  // Netlify Function 的 Lambda 实例会被回收重建，模块级 Map 会整个清空。
  // 若只查内存，实例一换所有人瞬间掉线（实测：登录后第一个请求 504 超时，
  // 醒来后所有接口 401）。所以这里查不到就去 sessions 表捞一次并回填内存。
  if (!s) {
    try {
      const row = await db.find('sessions', token);
      if (row && row.token && row.userId) s = row;
    } catch (e) { /* 表不存在或网络异常 → 视为未登录 */ }
    if (s) sessions.set(token, s);
  }
  if (!s) return null;
  if (s.expireAt && new Date(s.expireAt).getTime() < Date.now()) {
    sessions.delete(token);
    try { await persistSessionsAsync(db); } catch (e) { /* 落盘失败不阻断本次鉴权 */ }
    return null;
  }
  const u = await db.find('users', s.userId);
  if (!u || u.status === '停用') return null;
  return u;
}

/** 云端版：组装带权限点的用户信息（供前端 /api/auth/me） */
async function safeUserAsync(db, u) {
  if (!u) return null;
  const [dept, post, role] = await Promise.all([
    (await db.find('depts', u.deptId)),
    (await db.find('posts', u.postId)),
    (await db.find('roles', u.roleId))
  ]);
  return {
    id: u.id, username: u.username, name: u.name, phone: u.phone,
    deptId: u.deptId, deptName: dept ? dept.name : '',
    postId: u.postId, postName: post ? post.name : '',
    roleId: u.roleId, roleName: role ? role.name : '',
    // 同 safeUser：空数组 truthy，必须用长度判断，否则 perms 恒为 0 项
    perms: (Array.isArray(u.perms) && u.perms.length) ? u.perms : (role && Array.isArray(role.perms) ? role.perms : []),
    dataScope: u.dataScope || (role ? role.dataScope : 'all') || 'all',
    projectIds: u.projectIds || [],
    isAdmin: !!u.isAdmin,
    dingtalkUserId: u.dingtalkUserId || ''
  };
}

/** 会话落盘（云端版：sessions 集合写库） */
async function persistSessionsAsync(db) {
  if (!db || typeof db.replace !== 'function') return;
  await db.replace('sessions', Array.from(sessions.values()));
}

/** 云端中间件：把用户挂到 req.user / req.u */
async function attachUserAsync(db, req) {
  const token = (req.cookies && req.cookies['plm_token']) || (req.headers['x-token']) || (req.query && req.query.token);
  req.user = token ? await sessionUserAsync(db, token) : null;
  if (req.user) req.u = await safeUserAsync(db, req.user);
  return true;
}

/** 云端版：登录（密码校验 + 建会话 + 落库） */
async function loginAsync(db, username, password, req) {
  const u = await db.one('users', { username: String(username || '').trim() });
  if (!u) return { ok: false, msg: '账号不存在' };
  if (u.status === '停用') return { ok: false, msg: '账号已停用，请联系管理员' };
  if (u.password !== md5(password)) return { ok: false, msg: '密码不正确' };
  const token = uid('tk');
  const now = new Date();
  sessions.set(token, {
    token, userId: u.id, loginTime: now.toISOString(),
    expireAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    ip: (req && (req.ip || req.headers['x-forwarded-for'])) || '',
    ua: (req && req.ua) || (req && req.headers['user-agent']) || ''
  });
  await persistSessionsAsync(db);
  return { ok: true, token, user: u };
}

// 需要登录
function authGuard(req, res) {
  if (!req.user) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, msg: '未登录或登录已失效', code: 401 }));
    return false;
  }
  return true;
}

module.exports = {
  PERMS, SCOPES, allPermCodes, login, logout, sessionUser, safeUser,
  hasPerm, permGuard, scopeFilter, attachUser, authGuard, sessions,
  loadSessions, persistSessions, purgeSessions, onlineList, forceLogout, SESSION_TTL_MS,
  // 菜单 / 子权限树（角色勾选权限用）
  permTree, actLabel, MENU_META,
  // 云端异步孪生（TiDB）
  sessionUserAsync, safeUserAsync, attachUserAsync, loginAsync, persistSessionsAsync
};
