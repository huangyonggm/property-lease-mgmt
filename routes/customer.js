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

  // ─── 客户档案导入 ───────────────────────────────────────────────────────────

  /** 下载导入模板（含一行示例数据） */
  router.get('/api/customer/import/customer-template', async (req, res) => {
    if (!can(req, res, 'customer:manage')) return fail(res, '无权限');
    const XLSX = require('../node_modules/xlsx');
    const fields = [
      { title: '客户名称', key: 'name' }, { title: '客户类型', key: 'type' },
      { title: '联系人', key: 'contact' }, { title: '联系电话', key: 'phone' },
      { title: '通讯地址', key: 'address' }, { title: '统一社会信用代码', key: 'creditCode' },
      { title: '法人代表', key: 'legalPerson' }, { title: '身份证号', key: 'idCard' },
      { title: '开户银行', key: 'bankName' }, { title: '银行账号', key: 'bankAccount' },
      { title: '发票抬头', key: 'invoiceTitle' }, { title: '纳税人识别号', key: 'invoiceTaxNo' },
      { title: '风险标记', key: 'riskFlag' }, { title: '风险说明', key: 'riskNote' },
      { title: '状态', key: 'status' }
    ];
    // 用 aoa_to_sheet 确保第一行是中文表头，第二行是示例数据
    const ws = XLSX.utils.aoa_to_sheet([
      fields.map(f => f.title),
      fields.map(f => f.title === '客户名称' ? '示例企业客户' : f.title === '客户类型' ? '企业客户' : '')
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '客户档案');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const tplName = '客户档案导入模板.xlsx';
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(tplName) + '"; filename*=UTF-8\'\'' + encodeURIComponent(tplName));
    res.end(buf);
  });

  /**
   * 批量导入客户档案
   *
   * 【为什么用 base64 JSON 而不是 FormData 上传】
   * 服务端 lib/http.js 的 readBody 对 multipart/form-data 只返回 { _raw: Buffer }，
   * 而这里要的是文件字节；写成 `Array.isArray(req.body)` 会**恒为 false**，
   * 表现就是「文件为空」—— 前端明明选了文件也传不进来。
   * 本项目已验证可用的方式是「FileReader 读成 dataURL → JSON 传 fileBase64」，
   * 与 /api/income/import/recharge 保持一致，本地与 Netlify 两种运行时都走同一套。
   */
  router.post('/api/customer/import/customers', async (req, res) => {
    if (!can(req, res, 'customer:manage')) return fail(res, '无权限');
    const b = req.body || {};
    if (!b.fileBase64) return fail(res, '缺少文件');

    const XLSX = require('../node_modules/xlsx');

    // 读取 buffer → xlsx sheet → rows
    let rows;
    try {
      const ab = Buffer.from(String(b.fileBase64).split(',').pop(), 'base64');
      const wb = XLSX.read(ab, { type: 'array' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    } catch (e) {
      return fail(res, 'Excel 解析失败：' + e.message);
    }

    if (rows.length === 0) return fail(res, '没有数据行');

    let ok_count = 0, failList = [];
    // 中文表头 → 英文 key 映射
    const CN2EN = {
      '客户名称': 'name', '客户类型': 'type', '联系人': 'contact', '联系电话': 'phone',
      '通讯地址': 'address', '统一社会信用代码': 'creditCode', '法人代表': 'legalPerson',
      '身份证号': 'idCard', '开户银行': 'bankName', '银行账号': 'bankAccount',
      '发票抬头': 'invoiceTitle', '纳税人识别号': 'invoiceTaxNo',
      '风险标记': 'riskFlag', '风险说明': 'riskNote', '状态': 'status'
    };
    function normRow(raw) {
      const out = {};
      for (const [cn, en] of Object.entries(CN2EN)) {
        if (raw[en] !== undefined && raw[en] !== '') out[en] = raw[en];
        else if (raw[cn] !== undefined && raw[cn] !== '') out[en] = raw[cn];
      }
      return out;
    }
    for (const raw of rows) {
      const r = normRow(raw);
      const name = String(r.name || '').trim();
      if (!name) { failList.push({ row: failList.length + 2, err: '客户名称为空' }); continue; }

      const existing = await db.one('customers', c => c.name === name);
      if (existing) {
        // 更新已有记录
        await db.update('customers', existing.id, {
          ...r,
          updatedAt: new Date()
        });
        ok_count++;
      } else {
        // 新建
        const id = await db.insert('customers', {
          ...r,
          attachments: [],
          status: r.status || '正常',
          riskFlag: r.riskFlag || '正常',
          createDate: new Date().toISOString().slice(0, 10),
          createdAt: new Date(),
          updatedAt: new Date()
        });
        if (!id) { failList.push({ row: failList.length + 2, err: '插入失败' }); }
        else ok_count++;
      }
    }

    // 用 ok() 而不是 res.json()：本地 server.js 用的是原生 http ServerResponse，
    // Netlify 用的是 MiniRes，两者都**没有** res.json() → 直接抛
    // 「res.json is not a function」，前端只能看到「服务端异常」。
    ok(res, { total: rows.length, imported: ok_count, errors: failList });
  });

  return router;
};
