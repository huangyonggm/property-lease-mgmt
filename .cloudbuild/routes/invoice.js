'use strict';
// 发票管理：普票/专票、按类别分开开票、校验、台账、模板
const { ok, fail } = require('../lib/http');
const { register, can } = require('../lib/crud');
const audit = require('../lib/audit');
const { uid, money, num, now, today, monthOf, addDays } = require('../lib/util');

const TEMPLATES = [
  { id: '模板1', name: '模板1 - 不动产租赁（租金）', category: '租金', taxRate: 9, title: '*经营租赁*租金', remark: '不动产经营租赁' },
  { id: '模板2', name: '模板2 - 物业服务（物业费）', category: '物业费', taxRate: 6, title: '*企业管理服务*物业服务费', remark: '物业服务' },
  { id: '模板3', name: '模板3 - 转售水电（电费/水费）', category: '电费', taxRate: 13, title: '*供电*电费', remark: '转售水电' },
  { id: '模板4', name: '模板4 - 其他服务（保洁/维修/维保）', category: '杂费', taxRate: 13, title: '*其他服务*服务费', remark: '保洁、维修及专项维保' }
];

module.exports = function (db, router) {
  register(router, '/api/invoice/invoices', 'invoices', {
    db, view: 'invoice:view', manage: 'invoice:manage', sort: 'invoiceDate',
    where(q) {
      const w = {};
      if (q.projectId) w.projectId = q.projectId;
      if (q.category) w.category = q.category;
      if (q.type) w.type = q.type;
      if (q.customerId) w.customerId = q.customerId;
      if (q.status) w.status = q.status;
      if (q.month) return i => (i.invoiceDate || '').indexOf(q.month) === 0;
      return Object.keys(w).length ? w : null;
    },
    async search(kw, where) {
      return (await db.where('invoices', where)).filter(i =>
        (i.code || '').indexOf(kw) >= 0 || (i.invoiceNo || '').indexOf(kw) >= 0 ||
        (i.customerName || '').indexOf(kw) >= 0 || (i.contractCode || '').indexOf(kw) >= 0 ||
        (i.roomCodes || []).join(',').indexOf(kw) >= 0);
    },
    async decorate(row) {
      const o = Object.assign({}, row);
      o.projectName = ((await db.find('projects', row.projectId)) || {}).name || '';
      return o;
    },
    validate(b) {
      if (!b.customerId) return '请选择开票客户';
      if (!b.amount || num(b.amount) <= 0) return '开票金额必须大于 0';
      return null;
    },
    // 钩子里要查库并回写账单开票状态，必须 async（crud.js 已 await 钩子返回值）
    async beforeInsert(b, req) {
      b.code = b.code || db.nextNo('invoices', 'FP', today());
      b.by = (req.u || {}).name || ''; b.byId = req.user.id;
      b.status = b.status || '已开具';
      // 票面 PDF/图片附件（JSON 列，云端以文本存、读时自动还原成数组）。
      // 新增时表单若没走附件控件（如「按账单拆分开票」生成的票），兜底成空数组，
      // 避免列表页 render 里 (r.attachments || []) 之外的地方读到 undefined。
      b.attachments = b.attachments || [];
      b.taxRate = num(b.taxRate, 9);
      b.taxAmount = money(num(b.amount) - num(b.amount) / (1 + b.taxRate / 100));
      if (b.billIds) {
        // for...of：循环体要 await 查/写
        for (const bid of b.billIds) {
          const bl = await db.find('bills', bid);
          if (bl) await db.update('bills', bid, { invoiceStatus: '已开票', invoiceIds: (bl.invoiceIds || []).concat([b.code]) });
        }
      }
    },
    async after(row, action, req) {
      audit.routeLog(db, req, '发票管理', action === 'insert' ? '开具发票' : '修改发票', {
        bizId: row.id, bizCode: row.code, detail: row.type + ' / ' + row.category + ' / ' + money(row.amount).toFixed(2) + ' 元'
      });
    }
  });

  router.get('/api/invoice/templates', async (req, res) => {
    if (!can(req, res, 'invoice:view')) return;
    ok(res, TEMPLATES);
  });

  // 开票校验：租户是否提供发票信息 + 金额核对
  router.post('/api/invoice/validate', async (req, res) => {
    if (!can(req, res, 'invoice:view')) return;
    const b = req.body || {};
    const cu = (await db.find('customers', b.customerId));
    const issues = [];
    if (!cu) issues.push('客户不存在');
    else {
      if (!cu.invoiceTitle) issues.push('缺少发票抬头');
      if (b.type === '增值税专票') {
        if (!cu.invoiceTaxNo) issues.push('专票缺少纳税人识别号');
        if (!cu.invoiceBank) issues.push('专票缺少开户行信息');
        if (!cu.invoiceAccount) issues.push('专票缺少银行账号');
        if (!cu.invoiceAddress) issues.push('专票缺少地址电话');
      }
      if (cu.type === '个人客户' && b.type === '增值税专票') issues.push('个人客户一般不能开具增值税专用发票');
      if (cu.riskFlag && cu.riskFlag !== '正常') issues.push('客户存在风险标记：' + cu.riskFlag + '，请谨慎开票');
    }
    // 金额核对
    let billAmount = 0, invoiced = 0;
    // for...of：循环体要 await 查账单与历史发票
    for (const bid of (b.billIds || [])) {
      const bl = await db.find('bills', bid);
      if (!bl) continue;
      billAmount = money(billAmount + bl.totalAmount);
      const exist = await db.where('invoices', i => (i.billIds || []).indexOf(bid) >= 0 && i.category === b.category);
      exist.forEach(i => { invoiced = money(invoiced + num(i.amount)); });
    }
    const remain = money(billAmount - invoiced);
    if (num(b.amount) > remain + 0.01) issues.push('开票金额 ' + num(b.amount).toFixed(2) + ' 超过可开票余额 ' + remain.toFixed(2) + ' 元');
    ok(res, { pass: issues.length === 0, issues: issues, billAmount: billAmount, invoiced: invoiced, remain: remain, customer: cu ? { name: cu.name, type: cu.type, riskFlag: cu.riskFlag, invoiceTitle: cu.invoiceTitle, invoiceTaxNo: cu.invoiceTaxNo } : null });
  });

  // 按账单拆分开票：租金/物业费/电费/杂费/保洁费 各自一张票
  router.post('/api/invoice/split', async (req, res) => {
    if (!can(req, res, 'invoice:split')) return;
    const b = req.body || {};
    const billIds = b.billIds || [];
    if (!billIds.length) return fail(res, '请选择账单');
    const created = [];
    const catMap = { '租金': 9, '物业费': 6, '电费': 13, '水费': 3, '保洁费': 6, '维修费': 13, '杂费': 13 };
    // for...of：循环体要 await 查账单 / 查发票 / 插发票 / 更新账单
    for (const bid of billIds) {
      const bl = await db.find('bills', bid);
      if (!bl) continue;
      const groups = {};
      (bl.items || []).forEach(it => {
        const cat = (it.category === '维修费') ? '杂费' : it.category;
        groups[cat] = groups[cat] || { category: cat, amount: 0, taxRate: 0, items: [] };
        groups[cat].amount = money(groups[cat].amount + num(it.amount));
        groups[cat].taxRate = num(it.taxRate, catMap[cat] || 6);
        groups[cat].items.push(it.name);
      });
      const cu = await db.find('customers', bl.customerId);
      const type = (cu && cu.type === '企业客户') ? '增值税专票' : '增值税普票';
      // 内层同样不能是 forEach：要 await 查重与插入
      for (const cat of Object.keys(groups)) {
        const g = groups[cat];
        if (num(g.amount) <= 0) continue;
        const exist = await db.one('invoices', i => (i.billIds || []).indexOf(bid) >= 0 && i.category === cat);
        if (exist) continue;
        const tpl = TEMPLATES.filter(t => t.category === cat)[0] || TEMPLATES[3];
        const inv = await db.insert('invoices', {
          id: uid('iv'), code: db.nextNo('invoices', 'FP', today()),
          invoiceNo: b.invoiceNo || '', invoiceDate: b.invoiceDate || today(),
          type: type, category: cat,
          customerId: bl.customerId, customerName: bl.customerName,
          contractId: bl.contractId, contractCode: bl.contractCode,
          billIds: [bid], billCodes: [bl.code],
          roomCodes: bl.roomCodes, projectId: bl.projectId,
          amount: g.amount, taxRate: g.taxRate,
          taxAmount: money(g.amount - g.amount / (1 + g.taxRate / 100)),
          status: b.status || '已开具', remark: (g.items || []).join('、'),
          by: (req.u || {}).name || '', byId: req.user.id,
          title: cu ? (cu.invoiceTitle || cu.name) : bl.customerName,
          taxNo: cu ? cu.invoiceTaxNo : '', bankInfo: cu ? cu.invoiceBank : '',
          address: cu ? cu.invoiceAddress : '', template: tpl.id
        });
        created.push(inv);
      }
      const ids = (bl.invoiceIds || []);
      await db.update('bills', bid, { invoiceStatus: '已开票', invoiceIds: ids });
    }
    audit.routeLog(db, req, '发票管理', '拆分开票', { detail: '账单 ' + billIds.length + ' 条，生成发票 ' + created.length + ' 张' });
    ok(res, { created: created.length, invoices: created });
  });

  // 作废
  router.post('/api/invoice/invoices/:id/cancel', async (req, res) => {
    if (!can(req, res, 'invoice:manage')) return;
    const inv = (await db.find('invoices', req.params.id));
    if (!inv) return fail(res, '发票不存在', 404);
    (await db.update('invoices', inv.id, { status: '已作废', cancelReason: (req.body || {}).reason || '', cancelBy: (req.u || {}).name || '', cancelTime: now() }));
    // for...of：循环体要 await 查账单并回写开票状态
    for (const bid of (inv.billIds || [])) {
      const bl = await db.find('bills', bid);
      if (bl) await db.update('bills', bid, { invoiceStatus: '未开票', invoiceIds: (bl.invoiceIds || []).filter(c => c !== inv.code) });
    }
    audit.routeLog(db, req, '发票管理', '发票作废', { bizId: inv.id, bizCode: inv.code, detail: (req.body || {}).reason || '' });
    ok(res, (await db.find('invoices', inv.id)));
  });

  // 发票台账统计
  router.get('/api/invoice/summary', async (req, res) => {
    if (!can(req, res, 'invoice:view')) return;
    const list = (await db.where('invoices', i => i.status !== '已作废'));
    const byCat = {}, byType = {}, byMonth = {};
    let total = 0, tax = 0;
    list.forEach(i => {
      total = money(total + num(i.amount));
      tax = money(tax + num(i.taxAmount));
      byCat[i.category] = money((byCat[i.category] || 0) + num(i.amount));
      byType[i.type] = money((byType[i.type] || 0) + num(i.amount));
      const m = (i.invoiceDate || '').slice(0, 7);
      byMonth[m] = money((byMonth[m] || 0) + num(i.amount));
    });
    ok(res, { count: list.length, total: total, tax: tax, byCategory: byCat, byType: byType, byMonth: byMonth });
  });

  return router;
};
