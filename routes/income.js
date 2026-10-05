'use strict';
/**
 * 收入台账 —— 按真实在用的「月表格」体系补齐
 *
 * 依据 Y:\物业实际使用的报表及合同：
 *   表3 停车费明细.xlsx   → 月租车 / 临时停车费（车牌、车量、单价、数量、租赁日期、发票详情）
 *   表10 上期尾款.xlsx    → 上期尾款（单元号、公司、摘要、金额、收入日期、余额）
 *   收入日报统计表        → 12 类收入的每日汇总
 *   表8/表9              → 支出方向（日常物业、招商、其他、垫付）
 *   表5 开票明细         → 发票的「项目大类」维度
 *
 * 设计原则：这些都是财务台账，不与「账单 bills」耦合 ——
 *   账单是「应收」，台账是「实收/实付」，两者靠 roomId/contractId/customerId 关联。
 */
const { ok, fail, sendFile } = require('../lib/http');
const { can, needLogin, register } = require('../lib/crud');
const { uid, money, num, today, now, monthOf, addMonths } = require('../lib/util');
const audit = require('../lib/audit');
const I = require('../lib/income');
const X = require('../lib/exportx');   // CSV / Excel 导出
const XL = require('../lib/xls');      // Excel 解析（导入用）

module.exports = function (db, router, ctx) {

  /* ==================== 一、停车费（表3） ==================== */
  // 车位台账：月租车位按月收，临时停车按次/小时收
  register(router, '/api/income/parking', 'parking', {
    db: db, view: 'income:view', manage: 'income:manage',
    fields: [
      { name: 'code', label: '车位编号', width: 110 },
      { name: 'companyName', label: '公司名称', width: 200 },
      { name: 'roomNo', label: '单元号', width: 100 },
      { name: 'plateNo', label: '车牌号', width: 110 },
      { name: 'carCount', label: '车量', type: 'number', width: 70, def: 1 },
      { name: 'price', label: '单价', type: 'number', width: 90 },
      { name: 'qty', label: '数量', type: 'number', width: 70, def: 1 },
      { name: 'amount', label: '金额', type: 'money', width: 100, read: true },
      { name: 'parkType', label: '类型', type: 'select', options: ['月租车位', '临时停车'], width: 110, def: '月租车位' },
      { name: 'payDate', label: '交款日期', type: 'date', width: 110 },
      { name: 'startDate', label: '租赁起始', type: 'date', width: 110 },
      { name: 'endDate', label: '租赁截止', type: 'date', width: 110 },
      { name: 'channel', label: '收入途径', type: 'select', options: I.PAY_CHANNELS, width: 90, def: '转账' },
      { name: 'incomeCat', label: '收入科目', type: 'select', options: I.INCOME_CATS.filter(c => c.group === '停车费').map(c => c.name), width: 110 },
      { name: 'invoiceNo', label: '发票详情', width: 130 },
      { name: 'remain', label: '余款', type: 'money', width: 90, def: 0 },
      { name: 'remark', label: '备注', width: 180 }
    ],
    compute: {
      amount: (b) => money(num(b.carCount || 1) * num(b.price) * num(b.qty || 1))
    },
    defaults: () => ({ payDate: today(), qty: 1, carCount: 1, channel: '转账', remain: 0, parkType: '月租车位' })
  });

  // 停车费明细台账（一条一笔，跟表3 的行结构一致）
  register(router, '/api/income/parkingItems', 'parkingItems', {
    db: db, view: 'income:view', manage: 'income:manage',
    fields: [
      { name: 'unitNo', label: '单元', width: 100 },
      { name: 'companyName', label: '公司名称', width: 190 },
      { name: 'plateNo', label: '车牌', width: 110 },
      { name: 'carCount', label: '车量', type: 'number', width: 70, def: 1 },
      { name: 'price', label: '单价', type: 'number', width: 90 },
      { name: 'qty', label: '数量', type: 'number', width: 70, def: 1 },
      { name: 'amount', label: '金额', type: 'money', width: 100, read: true },
      { name: 'payDate', label: '交款日期', type: 'date', width: 110 },
      { name: 'channel', label: '收入途径', type: 'select', options: I.PAY_CHANNELS, width: 90, def: '转账' },
      { name: 'remain', label: '余款', type: 'money', width: 90, def: 0 },
      { name: 'startDate', label: '租赁起始', type: 'date', width: 110 },
      { name: 'endDate', label: '租赁截止', type: 'date', width: 110 },
      { name: 'remark', label: '备注', width: 160 }
    ],
    compute: {
      amount: (b) => money(num(b.carCount || 1) * num(b.price) * num(b.qty || 1))
    },
    defaults: () => ({ payDate: today(), qty: 1, carCount: 1, channel: '转账', remain: 0 }),
    sort: 'payDate'
  });

  // 表3 汇总：按月横排「月租车 / 临时停车费」
  router.get('/api/income/parkingSummary', async (req, res) => {
    if (!can(req, res, 'income:view')) return;
    const q = req.query;
    const months = splitMonths(q.start, q.end, 3);
    const items = (await db.all('parkingItems')).filter(r => inRange(r.payDate, q.start, q.end));
    const rows = months.map(m => {
      const ms = items.filter(r => monthOf(r.payDate || '') === m);
      const month_ = ms.filter(r => r.parkType !== '临时停车');
      const temp = ms.filter(r => r.parkType === '临时停车');
      return {
        month: m,
        monthly: money(month_.reduce((s, r) => s + num(r.amount), 0)),
        monthlyCount: month_.length,
        temp: money(temp.reduce((s, r) => s + num(r.amount), 0)),
        tempCount: temp.length,
        total: money(ms.reduce((s, r) => s + num(r.amount), 0))
      };
    });
    ok(res, { months: months, rows: rows, total: money(rows.reduce((s, r) => s + r.total, 0)) });
  });

  /* ==================== 二、上期尾款（表10） ==================== */
  register(router, '/api/income/arrears', 'arrears', {
    db: db, view: 'income:view', manage: 'income:manage',
    fields: [
      { name: 'unitNo', label: '单元号', width: 100 },
      { name: 'companyName', label: '公司名称', width: 200 },
      { name: 'summary', label: '摘要', width: 200 },
      { name: 'amount', label: '金额', type: 'money', width: 110, def: 0 },
      { name: 'incomeDate', label: '收入日期', type: 'date', width: 120 },
      { name: 'balance', label: '余额', type: 'money', width: 110, def: 0 },
      { name: 'channel', label: '收入途径', type: 'select', options: I.PAY_CHANNELS, width: 90, def: '转账' },
      { name: 'period', label: '所属期间', width: 90, def: '' },
      { name: 'settled', label: '是否结清', type: 'select', options: ['未结清', '已结清'], width: 100, def: '未结清' },
      { name: 'remark', label: '备注', width: 180 }
    ],
    defaults: () => ({ incomeDate: today(), channel: '转账', settled: '未结清', amount: 0, balance: 0 })
  });

  // 上期尾款汇总（按季度/月份）
  router.get('/api/income/arrearsSummary', async (req, res) => {
    if (!can(req, res, 'income:view')) return;
    const q = req.query;
    let list = (await db.all('arrears'));
    if (q.start) list = list.filter(r => !r.incomeDate || r.incomeDate >= q.start);
    if (q.end) list = list.filter(r => !r.incomeDate || r.incomeDate <= q.end);
    if (q.settled) list = list.filter(r => r.settled === q.settled);
    const byChannel = {};
    I.PAY_CHANNELS.forEach(c => byChannel[c] = 0);
    let total = 0, unsettled = 0;
    list.forEach(r => {
      const a = num(r.amount);
      total += a;
      if (r.channel && byChannel[r.channel] !== undefined) byChannel[r.channel] += a;
      if (r.settled !== '已结清') unsettled += a;
    });
    ok(res, {
      list: list, total: money(total), unsettled: money(unsettled),
      settled: money(total - unsettled), byChannel: byChannel
    });
  });

  /* ==================== 三、收入日报（12 类科目） ==================== */
  router.get('/api/income/daily', async (req, res) => {
    if (!can(req, res, 'income:view')) return;
    const month = req.query.month || monthOf(today());
    const r = await I.dailyIncome(db, month, { projectId: req.query.projectId });
    ok(res, Object.assign({ month: month, cats: I.INCOME_CATS }, r));
  });

  /* ==================== 四、支出台账（表8/表9 支出方向） ==================== */
  register(router, '/api/income/expenses', 'expenses', {
    db: db, view: 'income:view', manage: 'income:manage',
    fields: [
      { name: 'expCat', label: '支出类别', type: 'select', options: I.EXPENSE_CATS.map(c => c.name), width: 150, def: '日常费用支出' },
      { name: 'expDate', label: '日期', type: 'date', width: 115 },
      { name: 'summary', label: '摘要', width: 220 },
      { name: 'amount', label: '支出金额', type: 'money', width: 115, def: 0 },
      { name: 'channel', label: '支付途径', type: 'select', options: I.PAY_CHANNELS, width: 100, def: '转账' },
      { name: 'payee', label: '收款人', width: 120 },
      { name: 'unitNo', label: '单元号', width: 100 },
      { name: 'companyName', label: '公司名称', width: 180 },
      { name: 'period', label: '所属期间', width: 90, def: '' },
      { name: 'remark', label: '备注', width: 180 }
    ],
    defaults: () => ({ expDate: today(), channel: '转账', amount: 0, expCat: '日常费用支出' })
  });

  // 支出按月汇总（表8 右侧汇总表）
  router.get('/api/income/expenseSummary', async (req, res) => {
    if (!can(req, res, 'income:view')) return;
    const q = req.query;
    const months = splitMonths(q.start, q.end, 3);
    const list = (await db.all('expenses')).filter(r => inRange(r.expDate, q.start, q.end));
    const rows = months.map(m => {
      const ms = list.filter(r => monthOf(r.expDate || '') === m);
      const byCat = {};
      I.EXPENSE_CATS.forEach(c => byCat[c.name] = 0);
      // 每笔先 money() 归整到分再累加，否则 0.1+0.2 式浮点误差会漏到页面上
      // （曾出现 56087.289999999999 这种数，财务台账不可接受）
      ms.forEach(r => { if (byCat[r.expCat] !== undefined) byCat[r.expCat] = money(byCat[r.expCat] + num(r.amount)); });
      const total = ms.reduce((s, r) => s + num(r.amount), 0);
      return { month: m, byCat: byCat, total: money(total), count: ms.length };
    });
    ok(res, {
      months: months, rows: rows, cats: I.EXPENSE_CATS,
      total: money(rows.reduce((s, r) => s + r.total, 0))
    });
  });

  /* ==================== 四之二、表9「其他费用」六张台账 ====================
   * 真实文件（表9）其他费用.xlsx 有 6 个工作表：其他收入 / 其他支出 / 中介费 /
   * 会议室收入 / 垫付收入 / 垫付支出。骨架一致，用同一个集合 otherItems 存，
   * 用 kind 字段区分归属哪张表；中介费与会议室的独有列在同一集合里（其余表留空）。
   */
  const otherKindOpts = I.OTHER_KINDS.map(k => k.name);
  register(router, '/api/income/otherItems', 'otherItems', {
    db: db, view: 'income:view', manage: 'income:manage', sort: 'occurDate',
    listFilter: q => {
      if (q.kind) return r => r.kind === q.kind;
      if (q.start) return r => inRange(r.occurDate, q.start, q.end);
      return null;
    },
    fields: [
      { name: 'kind', label: '归属台账', type: 'select', options: otherKindOpts, width: 140, def: '其他收入' },
      { name: 'occurDate', label: '收/支时间', type: 'date', width: 120 },
      { name: 'unitNo', label: '单元号', width: 100 },
      { name: 'companyName', label: '公司名称', width: 190 },
      { name: 'amount', label: '金额', type: 'money', width: 110, def: 0 },
      { name: 'totalAmount', label: '费用总金额(中介费)', type: 'money', width: 150, def: 0 },
      { name: 'paidAmount', label: '已付金额(中介费)', type: 'money', width: 140, def: 0 },
      { name: 'unpaidAmount', label: '未付金额', type: 'money', width: 120, read: true },
      { name: 'docNo', label: '单据编号(中介费)', width: 130 },
      { name: 'area', label: '面积(㎡)', type: 'number', width: 100 },
      { name: 'useDate', label: '使用日期(会议室)', type: 'date', width: 140 },
      { name: 'useTime', label: '使用时间', width: 140 },
      { name: 'taxStatus', label: '税票情况', width: 120 },
      { name: 'channel', label: '收/支途径', type: 'select', options: I.PAY_CHANNELS, width: 100, def: '转账' },
      { name: 'remain', label: '余款', type: 'money', width: 90, def: 0 },
      { name: 'remark', label: '备注', width: 170 }
    ],
    // 中介费的「未付金额」= 费用总金额 − 已付金额，实时算，不让人手填错
    compute: {
      unpaidAmount: b => money(num(b.totalAmount) - num(b.paidAmount))
    },
    search: async (kw, where, req) => {
      const k = String(kw).toLowerCase();
      const f = opt => (opt ? (typeof opt === 'function' ? opt : r => matchesObj(r, opt)) : null);
      const w = f(where);
      return (await db.all('otherItems')).filter(r =>
        [r.companyName, r.unitNo, r.docNo, r.remark, r.kind, r.useTime, r.taxStatus]
          .some(v => String(v || '').toLowerCase().indexOf(k) >= 0) && (!w || w(r)));
    },
    defaults: () => ({ occurDate: today(), channel: '转账', kind: '其他收入', amount: 0, remain: 0 })
  });

  function matchesObj(r, cond) {
    return Object.keys(cond).every(k => String(r[k] === undefined ? '' : r[k]) === String(cond[k]));
  }

  // 表9 六张台账的元数据（前端据此渲染页签与列）
  router.get('/api/income/otherKinds', async (req, res) => {
    if (!can(req, res, 'income:view')) return;
    ok(res, { kinds: I.OTHER_KINDS, channels: I.PAY_CHANNELS });
  });

  // 表9 汇总：一次拿到六张表各自的「按月分段 + 月度小计 + 总计」
  router.get('/api/income/otherSummary', async (req, res) => {
    if (!can(req, res, 'income:view')) return;
    const q = req.query;
    const months = splitMonths(q.start, q.end, 3);
    const all = (await db.all('otherItems'));
    const tables = I.OTHER_KINDS.map(k => {
      const rows = all.filter(r => r.kind === k.name);
      const seg = months.map(m => {
        const ms = rows.filter(r => monthOf(r.occurDate || '') === m);
        return {
          month: m, count: ms.length,
          amount: money(ms.reduce((s, r) => s + I.otherAmount(k, r), 0))
        };
      });
      const total = money(rows.reduce((s, r) => s + I.otherAmount(k, r), 0));
      const range = rows.filter(r => inRange(r.occurDate, months[0] + '-01', months[months.length - 1] + '-31'));
      return {
        key: k.key, name: k.name, direction: k.direction, head: k.head,
        months: seg, total: total,
        rangeTotal: money(range.reduce((s, r) => s + I.otherAmount(k, r), 0)),
        count: rows.length, rangeCount: range.length
      };
    });
    ok(res, { months: months, tables: tables });
  });

  // 表8 预提款按月分段（预提是按季计提，看数必须能拆到月）
  router.get('/api/income/prepaidSegments', async (req, res) => {
    if (!can(req, res, 'income:view')) return;
    const q = req.query;
    const months = splitMonths(q.start, q.end, 3);
    const list = (await db.all('expenses')).filter(r => inRange(r.expDate, q.start, q.end));
    const seg = I.prepaidSegments(list, months);
    ok(res, {
      months: months, segments: seg.rows,
      totalPrepaid: seg.total.prepaid, totalActual: seg.total.actual, totalAll: seg.total.total,
      totalCount: seg.total.count, totalPrepaidCount: seg.total.prepaidCount
    });
  });

  /* ==================== 五、租金递增测算 ==================== */
  router.get('/api/income/escalate/preview', async (req, res) => {
    if (!can(req, res, 'contract:view')) return;
    const cid = req.query.contractId;
    const c = cid ? (await db.find('contracts', cid)) : null;
    if (!c) return fail(res, '合同不存在');
    const text = req.query.text !== undefined ? req.query.text : (c.escalateText || '');
    const rule = I.parseEscalate(text);
    const months = [];
    const base = c.startDate || c.signDate || today();
    for (let i = 0; i < 24; i++) {
      const m = addMonths(base, i);
      const period = monthOf(m);
      const r = I.rentPriceOf(Object.assign({}, c, { escalateRule: rule, escalateText: text }), period);
      months.push({ period: period, yearNo: r.yearNo, price: r.price, times: r.times || 0, note: r.note });
    }
    ok(res, { rule: rule, text: text, basePrice: num(c.rentUnitPrice), area: num(c.area), months: months });
  });

  router.get('/api/income/escalate/rules', async (req, res) => {
    if (!can(req, res, 'contract:view')) return;
    ok(res, { types: I.ESCALATE_TYPES, phrases: I.ESCALATE_PHRASES });
  });

  /* ==================== 六、月表格一键生成（8 张表） ==================== */
  router.get('/api/income/monthlyTables', async (req, res) => {
    if (!can(req, res, 'report:view')) return;
    const month = req.query.month || monthOf(today());
    ok(res, await buildMonthlyTables(db, month));
  });

  /* ==================== 七、导出 ==================== */
  router.get('/api/income/export/daily', async (req, res) => {
    if (!can(req, res, 'income:export')) return;
    const month = req.query.month || monthOf(today());
    const r = await I.dailyIncome(db, month, {});
    const headers = [{ title: '日期', key: 'date', width: 100 }]
      .concat(I.INCOME_CATS.map(c => ({ title: c.name, key: c.code, type: 'number', width: 90 })))
      .concat([{ title: '日汇总', key: 'total', type: 'number', width: 100 }]);
    const totalRow = { date: '合计' };
    I.INCOME_CATS.forEach(c => totalRow[c.code] = r.totalByCat[c]);
    totalRow.total = r.total;
    const csv = X.toCSV(headers, r.days.concat([totalRow]));
    audit.write(db, { userId: req.user.id, userName: req.u.name, module: '收入台账', action: '导出收入日报', detail: month });
    const fp = X.writeExport(ctx.exportDir, '收入日报统计表_' + month + '.csv', csv);
    sendFile(res, fp, '收入日报统计表_' + month + '.csv');
  });

  router.get('/api/income/export/parking', async (req, res) => {
    if (!can(req, res, 'income:export')) return;
    const q = req.query;
    const list = (await db.all('parkingItems')).filter(r => inRange(r.payDate, q.start, q.end));
    const headers = [
      { title: '单元', key: 'unitNo', width: 90 }, { title: '公司名称', key: 'companyName', width: 180 },
      { title: '车牌', key: 'plateNo', width: 100 }, { title: '车量', key: 'carCount', type: 'number', width: 60 },
      { title: '单价', key: 'price', type: 'number', width: 80 }, { title: '数量', key: 'qty', type: 'number', width: 60 },
      { title: '金额', key: 'amount', type: 'number', width: 90 }, { title: '交款日期', key: 'payDate', width: 100 },
      { title: '收入途径', key: 'channel', width: 80 }, { title: '余款', key: 'remain', type: 'number', width: 80 },
      { title: '租赁起始', key: 'startDate', width: 100 }, { title: '租赁截止', key: 'endDate', width: 100 },
      { title: '备注', key: 'remark', width: 160 }
    ];
    const total = { unitNo: '合计' };
    total.amount = money(list.reduce((s, r) => s + num(r.amount), 0));
    const csv = X.toCSV(headers, list.concat([total]));
    audit.write(db, { userId: req.user.id, userName: req.u.name, module: '收入台账', action: '导出停车费明细', detail: (q.start || '') + '~' + (q.end || '') });
    const name = '停车费明细_' + (q.start || monthOf(today())) + '.csv';
    sendFile(res, X.writeExport(ctx.exportDir, name, csv), name);
  });

  router.get('/api/income/export/arrears', async (req, res) => {
    if (!can(req, res, 'income:export')) return;
    const q = req.query;
    let list = (await db.all('arrears'));
    if (q.start) list = list.filter(r => !r.incomeDate || r.incomeDate >= q.start);
    if (q.end) list = list.filter(r => !r.incomeDate || r.incomeDate <= q.end);
    const headers = [
      { title: '序号', key: 'no', width: 60 }, { title: '单元号', key: 'unitNo', width: 90 },
      { title: '公司名称', key: 'companyName', width: 180 }, { title: '摘要', key: 'summary', width: 200 },
      { title: '金额', key: 'amount', type: 'number', width: 100 }, { title: '收入日期', key: 'incomeDate', width: 100 },
      { title: '余额', key: 'balance', type: 'number', width: 100 }, { title: '备注', key: 'remark', width: 160 }
    ];
    const rows = list.map((r, i) => Object.assign({ no: i + 1 }, r));
    const total = { no: '合计' };
    total.amount = money(list.reduce((s, r) => s + num(r.amount), 0));
    total.balance = money(list.reduce((s, r) => s + num(r.balance), 0));
    const csv = X.toCSV(headers, rows.concat([total]));
    audit.write(db, { userId: req.user.id, userName: req.u.name, module: '收入台账', action: '导出上期尾款', detail: (q.start || '') + '~' + (q.end || '') });
    sendFile(res, X.writeExport(ctx.exportDir, '上期尾款.csv', csv), '上期尾款.csv');
  });

  // 表9 六张台账导出为多 sheet Excel（与真实「（表9）其他费用.xlsx」同构）
  router.get('/api/income/export/other', async (req, res) => {
    if (!can(req, res, 'income:export')) return;
    const q = req.query;
    const months = splitMonths(q.start, q.end, 3);
    const all = (await db.all('otherItems'));
    const sheets = I.OTHER_KINDS.map(k => {
      const rows = months.map(m => {
        const ms = all.filter(r => r.kind === k.name && monthOf(r.occurDate || '') === m);
        return { 月份: m, 笔数: ms.length, 合计: money(ms.reduce((s, r) => s + I.otherAmount(k, r), 0)) };
      });
      const rangeAll = all.filter(r => r.kind === k.name && inRange(r.occurDate, months[0] + '-01', months[months.length - 1] + '-31'));
      rows.push({ 月份: '总计', 笔数: rangeAll.length, 合计: money(rangeAll.reduce((s, r) => s + I.otherAmount(k, r), 0)) });
      return {
        name: k.sheet,
        headers: [{ title: '月份', key: '月份', width: 90 }, { title: '笔数', key: '笔数', type: 'number', width: 70 }, { title: '合计', key: '合计', type: 'number', width: 120 }],
        rows: rows
      };
    });
    const xml = X.toXls(sheets);
    audit.write(db, { userId: req.user.id, userName: req.u.name, module: '收入台账', action: '导出表9其他费用', detail: months.join('~') });
    const name = '表9其他费用_' + months[0] + '_' + months[months.length - 1] + '.xls';
    sendFile(res, X.writeExport(ctx.exportDir, name, xml), name);
  });

  // 表8 支出导出（含预提款季度分段）
  router.get('/api/income/export/expense', async (req, res) => {
    if (!can(req, res, 'income:export')) return;
    const q = req.query;
    const list = (await db.all('expenses')).filter(r => inRange(r.expDate, q.start, q.end));
    const headers = [
      { title: '日期', key: 'expDate', width: 100 }, { title: '类别', key: 'expCat', width: 150 },
      { title: '摘要', key: 'summary', width: 220 }, { title: '支出金额', key: 'amount', type: 'number', width: 100 },
      { title: '支付途径', key: 'channel', width: 90 }, { title: '收款人', key: 'payee', width: 100 },
      { title: '单元号', key: 'unitNo', width: 90 }, { title: '公司名称', key: 'companyName', width: 170 },
      { title: '备注', key: 'remark', width: 160 }
    ];
    const total = { expDate: '合计' };
    total.amount = money(list.reduce((s, r) => s + num(r.amount), 0));
    const csv = X.toCSV(headers, list.concat([total]));
    audit.write(db, { userId: req.user.id, userName: req.u.name, module: '收入台账', action: '导出支出明细', detail: (q.start || '') + '~' + (q.end || '') });
    sendFile(res, X.writeExport(ctx.exportDir, '支出明细.csv', csv), '支出明细.csv');
  });

  /* ==================== 导入真实文件 ==================== */
  // 导入「缴费账单.xlsx」水电充值台账（含退费/挪账）
  router.post('/api/income/import/recharge', async (req, res) => {
    if (!can(req, res, 'income:manage')) return;
    const b = req.body || {};
    if (!b.fileBase64) return fail(res, '缺少文件');
    const buf = Buffer.from(String(b.fileBase64).split(',').pop(), 'base64');
    let t;
    try { t = XL.readTable(buf, '.xlsx'); }
    catch (e) { return fail(res, '文件解析失败：' + e.message); }
    const rows = t.rows;
    let headIdx = 0;
    for (let i = 0; i < Math.min(6, rows.length); i++) {
      const line = (rows[i] || []).map(x => String(x || '')).join('');
      if (/时间/.test(line) && /金额/.test(line)) { headIdx = i; break; }
    }
    const mode = b.mode === 'cover' ? 'cover' : 'append';
    if (mode === 'cover') db.clear('recharges');
    const list = (await db.all('recharges'));
    let n = 0, refund = 0, skipped = 0;
    // 幂等保护：同一笔充值（时间+订单号+金额）只入库一次。
    // 缴费账单是按月重复导出的账单文件，没有这层保护会一次比一次多，
    // 金额直接翻倍 —— 财务台账绝不能这样。
    const seen = {};
    list.forEach(r => { seen[dedupKey(r)] = true; });
    for (let i = headIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const time = String(r[0] || '').trim();
      const amt = num(r[8]);
      if (!time || !/^\d{4}-\d{2}-\d{2}/.test(time)) continue;   // 跳过「总金额」等汇总行
      const isRefund = /退费/.test(String(r[9] || ''));
      const row = {
        id: uid('rc'),
        time: time,
        meterNo: String(r[1] || ''),                 // 表号
        accountNo: String(r[2] || ''),               // 户号
        userName: String(r[3] || ''),
        phone: String(r[4] || ''),
        installAddr: String(r[5] || ''),             // 表安装地址
        chargeType: String(r[6] || ''),              // 充值方式
        operator: String(r[7] || ''),
        amount: amt,
        operation: isRefund ? '退费' : '充值',
        orderNo: String(r[10] || ''),
        remark: String(r[11] || ''),
        createTime: now()
      };
      // 文件内自身重复 + 与库内已有重复，都跳过
      const k = dedupKey(row);
      if (seen[k]) { skipped++; continue; }
      seen[k] = true;
      list.push(row); n++;
      if (isRefund) refund++;
    }
    db.replace('recharges', list);
    audit.write(db, { userId: req.user.id, userName: req.u.name, module: '收入台账', action: '导入充值台账', detail: '导入 ' + n + ' 条（退费 ' + refund + '，跳过重复 ' + skipped + '），模式 ' + mode });
    ok(res, { count: n, refund: refund, skipped: skipped, mode: mode, file: b.fileName || '', total: list.length });
  });

  router.get('/api/income/recharges', async (req, res) => {
    if (!can(req, res, 'income:view')) return;
    const q = req.query;
    let list = (await db.all('recharges'));
    if (q.keyword) {
      const k = String(q.keyword).toLowerCase();
      list = list.filter(r => [r.meterNo, r.accountNo, r.userName, r.orderNo, r.remark]
        .some(v => String(v || '').toLowerCase().indexOf(k) >= 0));
    }
    if (q.start) list = list.filter(r => String(r.time || '').slice(0, 10) >= q.start);
    if (q.end) list = list.filter(r => String(r.time || '').slice(0, 10) <= q.end);
    const total = list.reduce((s, r) => s + num(r.amount), 0);
    const refundTotal = list.filter(r => r.operation === '退费').reduce((s, r) => s + num(r.amount), 0);
    ok(res, {
      list: list.slice(0, Number(q.size || 200)),
      totalCount: list.length,
      total: money(total),
      chargeTotal: money(list.filter(r => r.operation !== '退费').reduce((s, r) => s + num(r.amount), 0)),
      refundTotal: money(refundTotal)
    });
  });

  // ============ 工具 ============
  function splitMonths(start, end, defCount) {
    // 默认区间：含当前月在内往前推 defCount 个月（财务看数习惯看「本季 + 上季」）
    const defStart = monthOf(addMonths(today() + '', -(defCount - 1)));
    const s = monthOf(start || defStart);
    const e = monthOf(end || today());
    const out = [];
    let cur = s;
    let guard = 0;
    while (cur <= e && guard++ < 36) { out.push(cur); cur = addMonths(cur + '-01', 1).slice(0, 7); }
    return out.length ? out : [monthOf(today())];
  }
  function inRange(d, start, end) {
    const s = String(d || '').slice(0, 10);
    if (!s) return false;
    if (start && s < start) return false;
    if (end && s > end) return false;
    return true;
  }
  // 充值台账去重键：时间 + 订单号 + 金额（订单号为空时退化为时间+表号+金额）
  function dedupKey(r) {
    const order = String(r.orderNo || '').trim();
    return [String(r.time || '').trim(), order || (String(r.meterNo || '') + '@' + String(r.amount || '')), Number(r.amount || 0)].join('|');
  }

  /**
   * 生成「月表格」8 张表的数据结构（与真实 Excel 同构，供前端预览 + 导出）
   */
async function buildMonthlyTables(db, month) {
    const prev = addMonths(month + '-01', -1).slice(0, 7);
    const next = addMonths(month + '-01', 1).slice(0, 7);
    const daily = await I.dailyIncome(db, month, {});

    // 表1 房租（含 3 个 sheet：本月/上月/差额）
    const rentRows = (await db.all('parkingItems')); // 占位，实际用 bills
    const billsOf = m => db.where('bills', b => b.period === m && b.status !== '作废');
    const rentSheet = async m => {
      const list = await billsOf(m);
      const rows = [];
      // for...of：循环体要 await 查合同/客户/房间
      for (const b of list) {
        const c = await db.find('contracts', b.contractId);
        const cust = c ? (await db.find('customers', c.customerId)) : null;
        const items = b.items || [];
        const rent = items.filter(i => i.category === '租金')[0] || {};
        const prop = items.filter(i => i.category === '物业费')[0] || {};
        const room = c && c.roomIds && c.roomIds[0] ? (await db.find('rooms', c.roomIds[0])) : null;
        rows.push({
          commission: '', accountName: cust ? cust.name : '',
          roomNo: room ? room.roomNo : '', company: cust ? cust.name : '',
          rentStart: c ? c.startDate : '', rentEnd: c ? c.endDate : '',
          payDate: b.payDate || '', rent: num(rent.amount),
          property: num(prop.amount), tax: num(b.taxAmount), total: num(b.totalAmount),
          taxInvoice: '', remark: b.remark || '', incomeTime: b.payDate || ''
        });
      }
      const sum = k => money(rows.reduce((s, r) => s + num(r[k]), 0));
      return {
        name: m.replace('-', '年') + '月',
        title: m + ' 入驻公司房租',
        head: ['提成', '户头', '门号', '公司', '计租时间起', '计租时间止', '交租日期', '房租', '管理费公维金', '税金', '合计', '税票情况', '备注', '收入时间'],
        rows: rows,
        total: { rent: sum('rent'), property: sum('property'), tax: sum('tax'), total: sum('total') }
      };
    };
    // rentSheet 是 async（内部要查合同/客户/房间），必须 await。
    // 漏 await 时 cur.rows 是 undefined，下面 cur.rows.concat 直接抛
    //「Cannot read properties of undefined (reading 'concat')」
    const cur = await rentSheet(month);
    const pre = await rentSheet(prev);
    const diffRows = [];
    const seen = {};
    cur.rows.concat(pre.rows).forEach(r => {
      if (!r.company) return;
      if (seen[r.company]) {
        const i = seen[r.company];
        diffRows[i].diff = money(num(diffRows[i].rent) - num(r.rent));
      } else {
        seen[r.company] = diffRows.length;
        diffRows.push(Object.assign({ company: r.company, roomNo: r.roomNo, cur: r.rent, prev: '', diff: '' }));
      }
    });

    // 表3 停车费
    const parkItems = (await db.all('parkingItems')).filter(r => monthOf(r.payDate || '') === month);
    const parkMonthly = parkItems.filter(r => r.parkType !== '临时停车');
    const parkTemp = parkItems.filter(r => r.parkType === '临时停车');

    // 表5 开票明细（加项目大类）
    const invs = (await db.all('invoices')).filter(v => String(v.invoiceDate || '').slice(0, 7) === month);
    const invRows = invs.map(v => ({
      no: v.invoiceNo, type: v.invoiceType, date: v.invoiceDate,
      projectCat: v.projectCat || '', amount: num(v.amount),
      tax: num(v.taxAmount), total: num(v.totalAmount || (num(v.amount) + num(v.taxAmount))),
      payer: v.payerName || '', unitNo: v.unitNo || ''
    }));

    // 表8 支出（本月明细）
    const exp = (await db.all('expenses')).filter(r => monthOf(r.expDate || '') === month);

    // 表8 右侧「汇总表」：把一个季度按月分段，并把预提款单独拆出来
    // （真实表8 就是「7月 / 8月 / 9月」三段 + 总计，预提款必须能按月摊销看数）
    const qMonths = [month, addMonths(month + '-01', 1).slice(0, 7), addMonths(month + '-01', 2).slice(0, 7)];
    const seg = I.prepaidSegments((await db.all('expenses')), qMonths);

    // 表10 上期尾款
    const arr = (await db.all('arrears'));

    // 表9 六张台账（其他收入 / 其他支出 / 中介费 / 会议室收入 / 垫付收入 / 垫付支出）
    const otherRows = (await db.all('otherItems'));
    const t9Sheets = I.OTHER_KINDS.map(k => {
      const rows = otherRows.filter(r => r.kind === k.name).map(r => {
        const o = { 月份: monthOf(r.occurDate || ''), 单元号: r.unitNo, 公司名称: r.companyName, 备注: r.remark };
        o[k.name.indexOf('支出') >= 0 ? '支出金额' : (k.name === '中介费' ? '费用总金额' : '金额')] = I.otherAmount(k, r);
        if (k.key === 'agency') { o['收款单位/人'] = r.companyName; o['单据编号'] = r.docNo; o['面积'] = num(r.area); o['已付金额'] = num(r.paidAmount); o['未付金额'] = num(r.unpaidAmount); o['发票'] = r.invoiceNo; o['日期'] = r.occurDate; }
        if (k.key === 'meeting') { o['使用日期'] = r.useDate; o['使用时间'] = r.useTime; o['税票情况'] = r.taxStatus; o['收入时间'] = r.occurDate; }
        else o[k.direction === 'in' ? '收入时间' : '支出时间'] = r.occurDate;
        o[k.direction === 'in' ? '收入途径明细' : '支出途径明细'] = r.channel;
        o['余款'] = num(r.remain);
        return o;
      });
      return {
        name: k.sheet + month, title: month + ' ' + k.sheet,
        head: k.head, rows: rows,
        total: { amount: money(rows.reduce((s, r) => s + num(r[Object.keys(r).find(x => /金额/.test(x)) || '金额']), 0)) }
      };
    });

    return {
      month: month,
      tables: [
        { key: 't1', name: '表1 房租', note: '含本月/上月/差额三个 sheet', sheets: [cur, pre, { name: '差额', title: month + ' 与 ' + prev + ' 房租差额表', head: ['公司', '门号', month, prev, '差额'], rows: diffRows, total: { total: money(diffRows.reduce((s, r) => s + num(r.diff), 0)) } }] },
        { key: 't3', name: '表3 停车费明细', note: '月租车 / 临时停车分列', sheets: [
          { name: '月租车' + month, title: month + ' 月租车位', head: ['单元', '公司名称', '车牌', '车量', '单价', '数量', '金额', '交款日期', '收入途径', '余款', '租赁起始', '租赁截止', '备注'], rows: parkMonthly, total: { amount: money(parkMonthly.reduce((s, r) => s + num(r.amount), 0)) } },
          { name: '临时停车' + month, title: month + ' 临时停车费', head: ['单元', '公司名称', '车牌', '车量', '单价', '数量', '金额', '交款日期', '收入途径', '余款', '备注'], rows: parkTemp, total: { amount: money(parkTemp.reduce((s, r) => s + num(r.amount), 0)) } }
        ] },
        { key: 't5', name: '表5 开票明细', note: '按项目大类统计', sheets: [
          { name: '开票明细', title: month + ' 开票明细', head: ['序号', '发票号码', '发票类型', '发票开具时间', '项目大类', '金额', '税额', '合计', '付款方名称', '单元号'], rows: invRows, total: { amount: money(invRows.reduce((s, r) => s + r.amount, 0)), tax: money(invRows.reduce((s, r) => s + r.tax, 0)) } }
        ] },
        { key: 't8', name: '表8 日常物业支出', note: '含收款人与季度合计', sheets: [
          { name: month + ' 支出', title: month + ' 物业费用、日常费用', head: ['日期', '类别', '摘要', '支出金额', '支付途径', '收款人', '备注'], rows: exp, total: { amount: money(exp.reduce((s, r) => s + num(r.amount), 0)) } },
          { name: '季度汇总', title: qMonths.join(' / ') + ' 支出汇总（含预提款分段）', head: ['月份', '笔数', '预提款支出', '实际支出', '合计'], rows: seg.rows, total: { count: seg.total.count, prepaid: seg.total.prepaid, actual: seg.total.actual, total: seg.total.total } }
        ] },
        { key: 't9', name: '表9 其他费用', note: '六张台账：其他/中介费/会议室/垫付', sheets: t9Sheets },
        { key: 't10', name: '表10 上期尾款', note: '上期遗留未结清款项', sheets: [
          { name: '上期尾款', title: '上期尾款', head: ['序号', '单元号', '公司名称', '摘要', '金额', '收入日期', '余额', '备注'], rows: arr.map((r, i) => Object.assign({ no: i + 1 }, r)), total: { amount: money(arr.reduce((s, r) => s + num(r.amount), 0)) } }
        ] },
        { key: 'daily', name: '收入日报统计表', note: '12 类收入每日汇总', sheets: [
          {
            name: '日收入', title: month + ' 日收入统计表',
            head: ['日期'].concat(I.INCOME_CATS.map(c => c.name)).concat(['日汇总']),
            rows: daily.days, total: daily.total
          }
        ] }
      ],
      daily: { cats: I.INCOME_CATS, days: daily.days, totalByCat: daily.totalByCat, total: daily.total }
    };
  }

  // 导出月表格为 Excel（多 sheet，Excel 2003 SpreadsheetML）
  router.get('/api/income/export/monthlyTables', async (req, res) => {
    if (!can(req, res, 'income:export')) return;
    const month = req.query.month || monthOf(today());
    const data = await buildMonthlyTables(db, month);
    // 把 {name,title,head[],rows[],total} 结构转成 toXls 需要的 {name,headers[],rows[]}
    const sheets = [];
    data.tables.forEach(t => {
      t.sheets.forEach(sh => {
        const headers = (sh.head || []).map(h => ({
          title: h, key: '__c' + (sh.head || []).indexOf(h), width: Math.min(240, 40 + String(h).length * 14)
        }));
        // 用位置索引取值，保证列与表头严格对齐
        const rows = (sh.rows || []).map(r => {
          const arr = Array.isArray(r) ? r.slice() : (headers.map(h => {
            const v = r[h.title];
            return v === undefined ? '' : v;
          }));
          const o = {};
          headers.forEach((h, i) => o[h.key] = isNumLike(arr[i]) ? arr[i] : (arr[i] === undefined ? '' : arr[i]));
          return o;
        });
        if (sh.total !== undefined) {
          const t2 = typeof sh.total === 'number' ? ['', money(sh.total)] : (Array.isArray(sh.total) ? sh.total : Object.values(sh.total));
          const o = {};
          headers.forEach((h, i) => o[h.key] = isNumLike(t2[i]) ? t2[i] : (t2[i] === undefined ? '' : t2[i]));
          rows.push(o);
        }
        sheets.push({
          name: (t.name.replace(/[\\\/\?\*\[\]:]/g, '') + '-' + sh.name).slice(0, 30),
          headers: headers, rows: rows
        });
      });
    });
    if (!sheets.length) return fail(res, '该月无可导出的数据');
    const xml = X.toXls(sheets);
    audit.write(db, { userId: req.user.id, userName: req.u.name, module: '收入台账', action: '导出月表格', detail: month + '（' + sheets.length + ' 个 sheet）' });
    const name = '月表格_' + month + '.xls';
    sendFile(res, X.writeExport(ctx.exportDir, name, '﻿' + xml), name);
  });
};

function isNumLike(v) {
  if (typeof v === 'number') return true;
  if (v === null || v === undefined || v === '') return false;
  return /^-?\d+(\.\d+)?$/.test(String(v).trim());
}

