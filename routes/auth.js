'use strict';
// 认证 / 组织架构 / 岗位 / 角色 / 用户 / 权限
const { ok, fail } = require('../lib/http');
const A = require('../lib/auth');
const { register, can, needLogin } = require('../lib/crud');
const audit = require('../lib/audit');
const { md5 } = require('../lib/util');

module.exports = function (db, router) {
  /* ---------- 登录 ---------- */
  router.post('/api/auth/login', async (req, res) => {
    const b = req.body || {};
    // A.login 内部要查库（云端 async），必须 await，否则拿到的是 Promise，r.ok 为 undefined 会被判成失败
    const r = await A.login(db, b.username, b.password, req);
    if (!r.ok) { audit.write(db, { module: '认证', action: '登录失败', detail: (b.username || '') + '：' + r.msg }); return fail(res, r.msg); }
    // HttpOnly 防止 XSS 脚本读取 token；SameSite=Lax 防止跨站请求携带会话
    // 局域网走 http，无法加 Secure（Secure 要求 https），故不加
    res.setHeader('Set-Cookie', 'plm_token=' + r.token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400');
    audit.write(db, { userId: r.user.id, userName: r.user.name, module: '认证', action: '登录', detail: '登录成功' });
    // 必须带 menus：前端登录成功后直接取 user.menus 渲染侧边栏，缺失会退回硬编码默认菜单
    ok(res, { token: r.token, user: Object.assign({}, r.user, { menus: menusOf(r.user) }) });
  });

  router.post('/api/auth/logout', async (req, res) => {
    const token = req.cookies['plm_token'];
    if (token) {
      const u = await A.sessionUser(db, token);
      if (u) audit.write(db, { userId: u.id, userName: u.name, module: '认证', action: '退出', detail: '退出登录' });
      A.logout(token);
    }
    ok(res, true);
  });

  router.get('/api/auth/me', async (req, res) => {
    if (!req.user) return ok(res, null);
    ok(res, Object.assign({}, req.u, { menus: menusOf(req.u) }));
  });

  /* ---------- 在线会话（多电脑部署运维：谁在线 / 强制下线） ---------- */
  router.get('/api/auth/online', async (req, res) => {
    if (!needLogin(req, res)) return;
    if (!can(req, res, 'system:view')) return fail(res, '无权限：需要 system:view 权限', 403);
    ok(res, await A.onlineList(db));
  });

  router.post('/api/auth/online/kick', async (req, res) => {
    if (!needLogin(req, res)) return;
    if (!can(req, res, 'system:manage')) return fail(res, '无权限：需要 system:manage 权限', 403);
    const userId = (req.body || {}).userId;
    if (!userId) return fail(res, '缺少 userId');
    if (String(userId) === String(req.user.id)) return fail(res, '不能踢自己下线，请直接退出登录');
    const n = A.forceLogout(userId);
    const u = (await db.find('users', userId));
    audit.write(db, { userId: req.user.id, userName: req.u.name, module: '认证', action: '强制下线', detail: (u ? u.name : userId) + '（清理 ' + n + ' 个会话）' });
    ok(res, n);
  });

  router.post('/api/auth/password', async (req, res) => {
    if (!needLogin(req, res)) return;
    const b = req.body || {};
    if (!b.oldPassword || !b.newPassword) return fail(res, '请填写原密码与新密码');
    if (req.user.password !== md5(b.oldPassword)) return fail(res, '原密码不正确');
    (await db.update('users', req.user.id, { password: md5(b.newPassword) }));
    audit.routeLog(db, req, '认证', '修改密码', { detail: req.user.username });
    ok(res, true);
  });

  /* ---------- 菜单（按权限点生成） ---------- */
  function menusOf(u) {
    const all = [
      { key: 'dashboard', name: '驾驶舱', icon: 'home', perm: 'dashboard:view', path: '#/dashboard' },
      { key: 'org', name: '组织权限', icon: 'org', perm: 'org:view', path: '#/org' },
      { key: 'property', name: '房源管理', icon: 'building', perm: 'property:view', path: '#/property' },
      { key: 'customer', name: '客户档案', icon: 'user', perm: 'customer:view', path: '#/customer' },
      { key: 'contract', name: '合同管理', icon: 'doc', perm: 'contract:view', path: '#/contract' },
      { key: 'billing', name: '收费管理', icon: 'money', perm: 'billing:view', path: '#/billing' },
      { key: 'invoice', name: '发票管理', icon: 'ticket', perm: 'invoice:view', path: '#/invoice' },
      { key: 'approval', name: '审批流程', icon: 'flow', perm: 'approval:view', path: '#/approval' },
      { key: 'workorder', name: '工单巡检', icon: 'tool', perm: 'workorder:view', path: '#/workorder' },
      { key: 'hr', name: '人事薪酬', icon: 'team', perm: 'hr:view', path: '#/hr' },
      { key: 'patrol', name: '巡更检查', icon: 'patrol', perm: 'patrol:view', path: '#/patrol' },
      { key: 'income', name: '收入台账', icon: 'income', perm: 'income:view', path: '#/income' },
      { key: 'report', name: '报表统计', icon: 'chart', perm: 'report:view', path: '#/report' },
      { key: 'system', name: '系统设置', icon: 'set', perm: 'system:view', path: '#/system' }
    ];
    return all.filter(m => A.hasPerm(u, m.perm));
  }

  router.get('/api/auth/perms', async (req, res) => {
    // 勾选界面直接用 permTree 渲染（菜单分组 + 子权限中文名），
    // 保留 perms/all 两份给老代码（如导出表头、脚本）用，避免破坏兼容
    ok(res, { tree: A.permTree(), perms: A.PERMS, scopes: A.SCOPES, all: A.allPermCodes() });
  });

  /* ---------- 部门 / 岗位 / 角色 / 用户 ---------- */
  register(router, '/api/org/depts', 'depts', {
    db, view: 'org:view', manage: 'org:manage', sort: 'code',
    async beforeRemove(row) {
      const users = (await db.where('users', u => u.deptId === row.id));
      if (users.length) return '该部门下还有 ' + users.length + ' 名用户，不能删除';
      return null;
    }
  });

  register(router, '/api/org/posts', 'posts', {
    db, view: 'org:view', manage: 'org:manage', sort: 'name',
    async decorate(row) {
      const d = (await db.find('depts', row.deptId));
      return Object.assign({}, row, { deptName: d ? d.name : '' });
    },
    async beforeRemove(row) {
      const n = (await db.where('users', u => u.postId === row.id)).length;
      if (n) return '该岗位下还有 ' + n + ' 名用户，不能删除';
      return null;
    }
  });

  register(router, '/api/org/roles', 'roles', {
    db, view: 'org:view', manage: 'org:manage', sort: 'code',
    /**
     * 权限点清洗。
     *
     * 【为什么必须清洗】勾选界面传上来的是权限码数组，只要有一个拼错
     * （contract:veiw），系统不会报错，只会觉得「这个角色没有查看合同的权限」——
     * 用户点开合同菜单发现 403，却查不出是哪一步配错了。
     * 这里把非法编码直接丢掉，并补上 '*' 之外的规范处理，让库里只可能出现合法编码。
     *
     * 另外兼容两种历史格式：
     *   · 数组 ['contract:view']        —— 现在的格式
     *   · 字符串 'contract:view,xxx'    —— 早期 textarea 存过逗号分隔的串
     */
    async beforeInsert(b) {
      b.perms = cleanPerms(b.perms);
    },
    async beforeUpdate(b, before) {
      // perms 传了才清洗；没传说明表单里没这个字段，保持原值不动
      if (b.perms !== undefined) b.perms = cleanPerms(b.perms);
    },
    async beforeRemove(row) {
      const n = (await db.where('users', u => u.roleId === row.id)).length;
      if (n) return '该角色下还有 ' + n + ' 名用户，不能删除';
      return null;
    }
  });

  /**
   * 清洗权限数组：只保留系统真实存在的权限码。
   *
   * 顺带做两件事：
   *   · 字符串 'a,b,c' 自动切成数组（兼容早期 textarea 存法）
   *   · 去重 —— 勾选界面可能因为父子联动把同一个码塞进两次
   *
   * @param {Array|string} v
   * @returns {Array<string>}
   */
  function cleanPerms(v) {
    let arr = v;
    if (typeof arr === 'string') {
      arr = arr.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(arr)) return [];
    const legal = A.allPermCodes();
    const out = [];
    arr.forEach(p => {
      p = String(p || '').trim();
      // '*' 是超管通配，必须原样保留；其余必须命中白名单
      if (p === '*' || legal.indexOf(p) >= 0) {
        if (out.indexOf(p) < 0) out.push(p);
      }
    });
    return out;
  }

  register(router, '/api/org/users', 'users', {
    db, view: 'org:view', manage: 'org:manage', sort: 'username',
    async search(kw, where) {
      kw = kw.toLowerCase();
      return (await db.where('users', where)).filter(u =>
        (u.username || '').toLowerCase().indexOf(kw) >= 0 ||
        (u.name || '').toLowerCase().indexOf(kw) >= 0 ||
        (u.phone || '').indexOf(kw) >= 0);
    },
    async decorate(row, req) {
      const o = Object.assign({}, row);
      delete o.password;
      const d = (await db.find('depts', row.deptId)), p = (await db.find('posts', row.postId)), r = (await db.find('roles', row.roleId));
      o.deptName = d ? d.name : ''; o.postName = p ? p.name : ''; o.roleName = r ? r.name : '';
      // 长度判断而非 ||：空数组是 truthy，|| 短路后 fallback 不生效（会导致用户列表里每人都是 0 项权限）
      o.perms = (Array.isArray(row.perms) && row.perms.length) ? row.perms : (r && Array.isArray(r.perms) ? r.perms : []);
      return o;
    },
    async validate(b) {
      if (!b.username) return '请填写登录账号';
      if (!b.id) {
        const exist = (await db.one('users', u => u.username === b.username));
        if (exist) return '登录账号已存在';
      }
      return null;
    },
    beforeInsert(b) {
      if (b.password) b.password = (b.password.length === 32) ? b.password : md5(b.password || '123456');
      else b.password = md5('123456');
      // 用户的额外权限同样要清洗，理由与角色一致：非法编码会让权限
      // 「配了但就是不生效」，且没有任何提示
      if (b.perms !== undefined && b.perms !== null) b.perms = cleanPerms(b.perms);
      else b.perms = null;   // null = 完全跟随角色；[] = 明确不给额外权限
    },
    beforeUpdate(b, before) {
      if (b.password) b.password = (b.password.length === 32 && b.password === before.password) ? before.password : md5(b.password);
      else delete b.password;
      if (b.perms !== undefined) {
        const cleaned = cleanPerms(b.perms);
        b.perms = cleaned.length ? cleaned : null;
      }
    },
    after(row, action, req) {
      audit.routeLog(db, req, '组织权限', action === 'insert' ? '新增用户' : (action === 'remove' ? '删除用户' : '修改用户'),
        { bizId: row.id, bizCode: row.username, detail: row.name });
    }
  });

  router.post('/api/org/users/:id/reset', async (req, res) => {
    if (!can(req, res, 'org:manage')) return;
    (await db.update('users', req.params.id, { password: md5(req.body.password || '123456') }));
    audit.routeLog(db, req, '组织权限', '重置密码', { bizId: req.params.id });
    ok(res, true);
  });

  // 审批流配置（多级审批节点）
  router.get('/api/org/flows', async (req, res) => {
    if (!can(req, res, 'org:view')) return;
    ok(res, (await db.where('flows')));
  });
  router.post('/api/org/flows', async (req, res) => {
    if (!can(req, res, 'org:manage')) return;
    const b = req.body || {};
    if (b.id && (await db.find('flows', b.id))) { (await db.update('flows', b.id, b)); return ok(res, (await db.find('flows', b.id))); }
    ok(res, (await db.insert('flows', b)));
  });

  return router;
};
