'use strict';
// 客户档案：企业/个人客户、附件、历史租赁、风险标记、多租户
const { ok, fail } = require('../lib/http');
const { register, can } = require('../lib/crud');
const audit = require('../lib/audit');
const { uid, money, num, now } = require('../lib/util');

module.exports = function (db, router) {
  register(router, '/api/customer/customers', 'customers', {
    db, view: 'customer:view', manage: 'customer:manage', sort: 'createDate',
    where(q) {
      const w = {};
      if (q.type) w.type = q.type;
      if (q.riskFlag) w.riskFlag = q.riskFlag;
      if (q.status) w.status = q.status;
      return Object.keys(w).length ? w : null;
    },
    async search(kw, where) {
      return (await db.where('customers', where)).filter(c =>
        (c.name || '').indexOf(kw) >= 0 || (c.contact || '').indexOf(kw) >= 0 ||
        (c.phone || '').indexOf(kw) >= 0 || (c.creditCode || '').indexOf(kw) >= 0 ||
        (c.legalPerson || '').indexOf(kw) >= 0 || (c.address || '').indexOf(kw) >= 0);
    },
    async decorate(row) {
      const o = Object.assign({}, row);
      const cts = (await db.where('contracts', c => c.customerId === row.id));
      o.contractCount = cts.length;
      o.activeCount = cts.filter(c => c.status === '正常履约').length;
      o.historyCount = cts.length;
      const active = cts.filter(c => c.status !== '退租' && c.status !== '终止');
      o.roomCodes = [];
      active.forEach(c => { o.roomCodes = o.roomCodes.concat(c.roomCodes || []); });
      o.area = money(active.reduce((s, c) => s + num(c.area), 0));
      o.monthlyRent = money(active.reduce((s, c) => s + num(c.rentMonthly), 0));
      const arrears = (await db.where('bills', b => b.customerId === row.id && b.totalAmount - b.paidAmount > 0.01));
      o.arrearsAmount = money(arrears.reduce((s, b) => s + (b.totalAmount - b.paidAmount), 0));
      o.arrearsCount = arrears.length;
      return o;
    },
    validate(b) {
      if (!b.name) return '请填写客户名称';
      if (b.type === '企业客户' && !b.creditCode) return '企业客户请填写统一社会信用代码';
      return null;
    },
    beforeInsert(b, req) {
      b.ownerId = req.user.id; b.deptId = req.user.deptId; b.createDate = b.createDate || new Date().toISOString().slice(0, 10);
      b.attachments = b.attachments || [];
    },
    after(row, action, req) {
      audit.routeLog(db, req, '客户档案', action === 'insert' ? '新增客户' : '修改客户', { bizId: row.id, bizCode: row.name, detail: row.type });
    }
  });

  // 客户历史租赁记录（全历史）
  router.get('/api/customer/customers/:id/history', async (req, res) => {
    if (!can(req, res, 'customer:view')) return;
    const cu = (await db.find('customers', req.params.id));
    if (!cu) return fail(res, '客户不存在', 404);
    const src = (await db.where('contracts', c => c.customerId === cu.id))
      .sort((a, b) => a.startDate < b.startDate ? 1 : -1);
    // map 回调要 await 查账单，用 Promise.all 聚合；
    // 顺带修掉原代码的重复查询：同一合同的账单原来查了 3 次
    const cts = await Promise.all(src.map(async c => {
      const bs = await db.where('bills', b => b.contractId === c.id);
      const o = Object.assign({}, c);
      o.billCount = bs.length;
      o.paidAmount = money(bs.reduce((s, b) => s + num(b.paidAmount), 0));
      o.totalAmount = money(bs.reduce((s, b) => s + num(b.totalAmount), 0));
      return o;
    }));
    const bills = (await db.where('bills', b => b.customerId === cu.id)).sort((a, b) => a.period < b.period ? 1 : -1).slice(0, 60);
    const payments = (await db.where('payments', p => p.customerId === cu.id)).sort((a, b) => a.date < b.date ? 1 : -1).slice(0, 60);
    const invoices = (await db.where('invoices', i => i.customerId === cu.id)).slice(0, 60);
    const deposits = (await db.where('deposits', d => d.customerId === cu.id));
    ok(res, { customer: cu, contracts: cts, bills: bills, payments: payments, invoices: invoices, deposits: deposits });
  });

  // 风险标记
  router.post('/api/customer/customers/:id/risk', async (req, res) => {
    if (!can(req, res, 'customer:risk')) return;
    const b = req.body || {};
    const cu = (await db.find('customers', req.params.id));
    if (!cu) return fail(res, '客户不存在', 404);
    const before = JSON.parse(JSON.stringify(cu));
    (await db.update('customers', req.params.id, { riskFlag: b.riskFlag || '正常', riskNote: b.riskNote || '' }));
    audit.routeLog(db, req, '客户档案', '风险标记', {
      bizId: cu.id, bizCode: cu.name, detail: (before.riskFlag || '正常') + ' → ' + (b.riskFlag || '正常'),
      before: before, after: (await db.find('customers', cu.id))
    });
    ok(res, (await db.find('customers', cu.id)));
  });

  // 多租户：同一房源多个客户（账单合并/分开核算）
  router.get('/api/customer/room-tenants', async (req, res) => {
    if (!can(req, res, 'customer:view')) return;
    const roomId = req.query.roomId;
    if (!roomId) return fail(res, '缺少 roomId');
    const cts = (await db.where('contracts', c => c.roomIds && c.roomIds.indexOf(roomId) >= 0));
    const room = (await db.find('rooms', roomId));
    ok(res, {
      room: room,
      contracts: cts.map(c => ({
        id: c.id, code: c.code, customerId: c.customerId, customerName: c.customerName,
        status: c.status, area: c.area, rentMonthly: c.rentMonthly,
        billingMode: (c.fees || {}).billingMode || '分开核算',
        startDate: c.startDate, endDate: c.endDate
      }))
    });
  });

  // 设置账单核算方式（合并/分开）
  router.post('/api/customer/contracts/:id/billing-mode', async (req, res) => {
    if (!can(req, res, 'customer:manage')) return;
    const c = (await db.find('contracts', req.params.id));
    if (!c) return fail(res, '合同不存在', 404);
    const fees = Object.assign({}, c.fees, { billingMode: (req.body || {}).billingMode || '分开核算' });
    (await db.update('contracts', c.id, { fees: fees }));
    audit.routeLog(db, req, '客户档案', '设置核算方式', { bizId: c.id, bizCode: c.code, detail: fees.billingMode });
    ok(res, (await db.find('contracts', c.id)));
  });

  return router;
};
