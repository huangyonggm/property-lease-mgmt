'use strict';
// 通用 CRUD 注册器 + 权限守卫（减少重复代码）
const { ok, fail } = require('./http');
const { hasPerm } = require('./auth');

function deny(res, msg, code) {
  const body = JSON.stringify({ ok: false, msg: msg, code: code || 403 });
  res.writeHead(code || 403, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
  return false;
}

function can(req, res, code) {
  if (!req.user) return deny(res, '未登录或登录已失效', 401);
  if (!hasPerm(req.u, code)) return deny(res, '无权限：需要 ' + code + ' 权限', 403);
  return true;
}

// 仅要求登录
function needLogin(req, res) {
  if (!req.user) return deny(res, '未登录或登录已失效', 401);
  return true;
}

// 组合两个 where 条件（db.page 的 where 支持函数或对象，这里统一走函数交集）
function andWhere(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (typeof a === 'function') return r => a(r) && b(r);
  return Object.assign({}, a, b);
}

// 注册标准 REST 接口：
//   GET    /api/{base}       列表（支持 page/size/sort/order 及自定义 where）
//   GET    /api/{base}/:id   详情
//   POST   /api/{base}       新增或更新（body 带 id 则更新）
//   DELETE /api/{base}/:id   删除
function register(router, base, coll, opt) {
  opt = opt || {};
  const db = opt.db;
  const viewPerm = opt.view || base + ':view';
  const managePerm = opt.manage || base + ':manage';
  const defaultSort = opt.sort || 'createTime';

  // 填充默认值 + 派生字段计算。
  // 这是 register 的核心能力：前端表单里 amount 是只读字段（fields 里 read:true），
  // 真正算式必须落在服务端，否则用户可以随便填金额 —— 财务数据不可信。
  function applyDefaults(payload) {
    if (opt.defaults) {
      const d = opt.defaults(payload) || {};
      Object.keys(d).forEach(k => {
        if (payload[k] === undefined || payload[k] === null || payload[k] === '') payload[k] = d[k];
      });
    }
    if (opt.compute) {
      Object.keys(opt.compute).forEach(k => {
        try { payload[k] = opt.compute[k](payload); }
        catch (e) { /* 单个派生字段算错不应阻断整条记录落库 */ }
      });
    }
    return payload;
  }

  router.get(base, async (req, res) => {
    if (!can(req, res, viewPerm)) return;
    const q = req.query;
    let where = opt.where ? opt.where(q, req) : null;
    if (opt.listFilter) {           // 额外的自定义过滤（闭包式，优先于 keyword 搜索）
      const f = opt.listFilter(q, req);
      if (f) where = where ? andWhere(where, f) : f;
    }
    if (opt.scope) where = opt.scope(where, req);
    let list, total;
    const kw = q.keyword;
    if (kw && opt.search) {
      // ⚠ 必须 await！routes/ 下 12 个列表的 search 全部是 async（要查库），
      // 漏了 await 拿到的是 Promise：matched.length 是 undefined，
      // matched.slice 直接 TypeError → **所有列表页一搜索就 500「服务端异常」**。
      // （2026-10-06 实测复现：/api/invoice/invoices?keyword=租金、
      //   /api/customer/customers?keyword=公司 均返回 matched.slice is not a function）
      // `|| []` 兜底：search 实现里若有「无匹配返回 null/undefined」的分支，
      // 也不该让整个列表接口崩掉。
      const matched = (await opt.search(kw, where, req)) || [];
      total = matched.length;
      const p = Math.max(1, Number(q.page) || 1), sz = Math.max(1, Number(q.size) || 20);
      list = matched.slice((p - 1) * sz, p * sz);
    } else {
      const r = (await db.page(coll, { where: where, sort: q.sort || defaultSort, order: q.order || 'desc', page: q.page, size: q.size }));
      list = r.list; total = r.total;
    }
    // 预载（治「房源列表 5MB / contracts×20」这类 N+1）：
    // decorate 里若对某张表做「非选择性」的函数条件查询（例如房源逐行找“含该房间的有效合同”，
    // 可下推的只有 status<>'退租'，几乎命中全表），逐行查会退化成 N 次近全表拉取。
    // 先把整表载入缓存一次，之后每行 decorate 命中缓存走内存匹配、0 次网络往返。
    // opt.preload 由具体路由声明（如 rooms 声明 ['contracts']）；单表失败不阻断列表。
    if (opt.preload && opt.preload.length && list.length) {
      for (const t of opt.preload) { try { await db.all(t); } catch (e) { /* 忽略单表预载失败 */ } }
    }
    if (opt.decorate) list = await Promise.all(list.map(r => opt.decorate(r, req, db)));
    ok(res, { list: list, total: total, page: Number(q.page) || 1, size: Number(q.size) || 20 });
  });

  router.get(base + '/:id', async (req, res) => {
    if (!can(req, res, viewPerm)) return;
    const row = (await db.find(coll, req.params.id));
    if (!row) return fail(res, '记录不存在', 404);
    ok(res, opt.decorate ? await opt.decorate(row, req, db) : row);
  });

  router.post(base, async (req, res) => {
    if (!can(req, res, req.body && req.body.id ? managePerm : (opt.create || managePerm))) return;
    const b = req.body || {};
    // validate / beforeUpdate / beforeInsert / after 这些钩子都可能要查库（云端 db 是 async），
    // 所以调用点必须 await。若不 await，返回的是 Promise：
    //   - validate 返回 Promise 永远为真 → 所有提交都被拒
    //   - beforeInsert 的字段规范化还没算完就落库 → 房号/面积/承租方全丢
    if (opt.validate) {
      const err = await opt.validate(b, null, db);
      if (err) return fail(res, err);
    }
    if (b.id && (await db.find(coll, b.id))) {
      const before = JSON.parse(JSON.stringify((await db.find(coll, b.id))));
      const patch = Object.assign({}, b);
      delete patch.id;
      if (opt.beforeUpdate) await opt.beforeUpdate(patch, before, req, db);
      applyDefaults(patch);          // 更新时同样重算派生字段
      const row = (await db.update(coll, b.id, patch));
      if (opt.after) await opt.after(row, 'update', req, db, before);
      return ok(res, row);
    }
    const payload = applyDefaults(Object.assign({}, b));
    if (opt.beforeInsert) await opt.beforeInsert(payload, req, db);
    const row = (await db.insert(coll, payload));
    if (opt.after) await opt.after(row, 'insert', req, db, null);
    ok(res, row);
  });

  router.del(base + '/:id', async (req, res) => {
    if (!can(req, res, managePerm)) return;
    const row = (await db.find(coll, req.params.id));
    if (!row) return fail(res, '记录不存在', 404);
    if (opt.beforeRemove) {
      const err = await opt.beforeRemove(row, req, db);
      if (err) return fail(res, err);
    }
    (await db.remove(coll, req.params.id));
    if (opt.after) await opt.after(row, 'remove', req, db, null);
    ok(res, true);
  });

  return router;
}

module.exports = { register, can, deny, needLogin };
