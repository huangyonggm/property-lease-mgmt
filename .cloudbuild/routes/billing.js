'use strict';
// 收费管理：账单生成、抄表计费、公摊分摊、收款、押金、欠费催收
const { ok, fail } = require('../lib/http');
const { register, can } = require('../lib/crud');
const audit = require('../lib/audit');
const B = require('../lib/billing');
const { uid, money, num, now, today, monthOf } = require('../lib/util');

module.exports = function (db, router) {
  /* ---------- 账单 ---------- */
  register(router, '/api/finance/bills', 'bills', {
    db, view: 'billing:view', manage: 'billing:manage', sort: 'period',
    where(q) {
      const w = {};
      if (q.projectId) w.projectId = q.projectId;
      if (q.period) w.period = q.period;
      if (q.customerId) w.customerId = q.customerId;
      if (q.contractId) w.contractId = q.contractId;
      if (q.status) w.status = q.status;
      if (q.invoiceStatus) w.invoiceStatus = q.invoiceStatus;
      return Object.keys(w).length ? w : null;
    },
    async search(kw, where) {
      return (await db.where('bills', where)).filter(b =>
        (b.code || '').indexOf(kw) >= 0 || (b.customerName || '').indexOf(kw) >= 0 ||
        (b.contractCode || '').indexOf(kw) >= 0 || (b.roomCodes || []).join(',').indexOf(kw) >= 0);
    },
    async decorate(row) {
      const o = Object.assign({}, row);
      o.arrears = money(row.totalAmount - row.paidAmount);
      o.projectName = ((await db.find('projects', row.projectId)) || {}).name || '';
      o.buildingName = ((await db.find('buildings', row.buildingId)) || {}).name || '';
      const cu = (await db.find('customers', row.customerId));
      o.phone = cu ? cu.phone : '';
      o.overdueDays = (row.dueDate && row.status !== '已收款') ? Math.max(0, Math.round((new Date(today()) - new Date(row.dueDate)) / 86400000)) : 0;
      return o;
    },
    after(row, action, req) {
      audit.routeLog(db, req, '收费管理', action === 'insert' ? '手工新增账单' : '修改账单', { bizId: row.id, bizCode: row.code });
    }
  });

  // 生成月账单
  router.post('/api/finance/bills/generate', async (req, res) => {
    if (!can(req, res, 'billing:manage')) return;
    const b = req.body || {};
    const period = b.period || monthOf(today());
    const r = await B.generateBills(db, period, { projectId: b.projectId, userId: req.user.id, crossMonth: b.crossMonth, meter: b.meter !== false, cleaning: b.cleaning !== false, repair: b.repair !== false });
    let vacant = { created: 0 };
    if (b.vacantElectric) vacant = await B.generateVacantElectric(db, period, { projectId: b.projectId, userId: req.user.id });
    audit.routeLog(db, req, '收费管理', '生成月账单', { detail: period + '，新增 ' + r.created + ' 条，跳过 ' + r.skipped + ' 条；空置基础电费 ' + vacant.created + ' 条' });
    ok(res, Object.assign(r, { vacant: vacant }));
  });

  // 月末记账（标记）
  router.post('/api/finance/bills/close', async (req, res) => {
    if (!can(req, res, 'billing:manage')) return;
    const period = (req.body || {}).period || monthOf(today());
    const bills = (await db.where('bills', b2 => b2.period === period));
    // for...of：循环体要 await db.update
    for (const b2 of bills) {
      if (b2.totalAmount - b2.paidAmount > 0.01 && b2.status !== '逾期') await db.update('bills', b2.id, { status: '逾期', closed: true, closeTime: now() });
      else await db.update('bills', b2.id, { closed: true, closeTime: now() });
    }
    audit.routeLog(db, req, '收费管理', '月末记账', { detail: period + '，共 ' + bills.length + ' 条账单' });
    ok(res, { period: period, count: bills.length });
  });

  // 收款
  router.post('/api/finance/bills/:id/pay', async (req, res) => {
    if (!can(req, res, 'billing:collect')) return;
    const b = req.body || {};
    const r = await B.pay(db, {
      billId: req.params.id, amount: b.amount, date: b.date || today(),
      method: b.method, remark: b.remark, userName: (req.u || {}).name || '', userId: req.user.id
    });
    if (!r.ok) return fail(res, r.msg);
    audit.routeLog(db, req, '收费管理', '收款登记', {
      bizId: r.bill.id, bizCode: r.bill.code, detail: '收款 ' + money(b.amount).toFixed(2) + ' 元（' + (b.method || '银行转账') + '）'
    });
    ok(res, r);
  });

  // 费用调整（单价/面积/房间调整）
  router.post('/api/finance/bills/:id/adjust', async (req, res) => {
    if (!can(req, res, 'billing:manage')) return;
    const b = req.body || {};
    const bill = (await db.find('bills', req.params.id));
    if (!bill) return fail(res, '账单不存在', 404);
    const before = JSON.parse(JSON.stringify(bill));
    if (b.items) {
      bill.items = b.items.map(it => {
        const amount = b.recalc ? money(num(it.qty) * num(it.price)) : num(it.amount);
        return Object.assign(it, { amount: amount, taxAmount: money(amount - amount / (1 + num(it.taxRate) / 100)) });
      });
    }
    bill.totalAmount = money((bill.items || []).reduce((s, it) => s + it.amount, 0));
    bill.taxAmount = money((bill.items || []).reduce((s, it) => s + it.taxAmount, 0));
    if (bill.totalAmount - bill.paidAmount <= 0.01) bill.status = '已收款';
    else if (bill.paidAmount > 0) bill.status = '部分收款';
    else bill.status = '未收款';
    if (b.dueDate) bill.dueDate = b.dueDate;
    if (b.remark !== undefined) bill.remark = b.remark;
    (await db.update('bills', bill.id, { items: bill.items, totalAmount: bill.totalAmount, taxAmount: bill.taxAmount, status: bill.status, dueDate: bill.dueDate, remark: bill.remark }));
    audit.routeLog(db, req, '收费管理', '费用调整', { bizId: bill.id, bizCode: bill.code, detail: b.reason || '', before: before, after: bill });
    ok(res, bill);
  });

  // 租金单价变更（同步后续账单）
  router.post('/api/finance/contracts/:id/price', async (req, res) => {
    if (!can(req, res, 'billing:manage')) return;
    const b = req.body || {};
    const c = (await db.find('contracts', req.params.id));
    if (!c) return fail(res, '合同不存在', 404);
    const before = JSON.parse(JSON.stringify(c));
    const price = num(b.rentUnitPrice, c.rentUnitPrice);
    (await db.update('contracts', c.id, {
      rentUnitPrice: price, rentMonthly: money(price * num(c.area)),
      changeLog: (c.changeLog || []).concat([{ time: now(), user: (req.u || {}).name || '', action: '租金单价变更', detail: before.rentUnitPrice + ' → ' + price + '（' + (b.reason || '') + '）' }])
    }));
    audit.routeLog(db, req, '收费管理', '租金单价变更', { bizId: c.id, bizCode: c.code, detail: before.rentUnitPrice + ' → ' + price, before: before });
    ok(res, (await db.find('contracts', c.id)));
  });

  /* ---------- 表具与抄表 ---------- */
  register(router, '/api/finance/meters', 'meters', {
    db, view: 'billing:view', manage: 'billing:meter', sort: 'meterNo',
    // decorate 每行都要按 meterId 扫 readings 求最近读数/抄表次数；先整表预载 readings/rooms
    // 进缓存一次，避免 380 行并发时各拉一次 512KB（也消除 all() 的重复深拷贝）。
    preload: ['readings', 'rooms'],
    where(q) {
      const w = {};
      if (q.roomId) w.roomId = q.roomId;
      if (q.type) w.type = q.type;
      if (q.buildingId) w.buildingId = q.buildingId;
      return Object.keys(w).length ? w : null;
    },
    async decorate(row) {
      const o = Object.assign({}, row);
      const r = (await db.find('rooms', row.roomId));
      o.roomCode = r ? r.code : '';
      const rs = (await db.where('readings', x => x.meterId === row.id)).sort((a, b) => a.period < b.period ? 1 : -1);
      o.lastReading = rs[0] || null;
      o.readingCount = rs.length;
      return o;
    }
  });

  router.get('/api/finance/readings', async (req, res) => {
    if (!can(req, res, 'billing:view')) return;
    const q = req.query;
    let list = (await db.where('readings', r => (!q.meterId || r.meterId === q.meterId) && (!q.period || r.period === q.period) && (!q.roomId || r.roomId === q.roomId)));
    list = list.sort((a, b) => a.date < b.date ? 1 : -1);
    const total = list.length;

    // 【性能修复：抄表页等待很久】
    // 原实现对「列表里每一行」都执行 db.where('readings', x => x.meterId===r.meterId && x.period<r.period)
    // 求上一期读数。meterId/period 是变量，云端无法下推 SQL → 每行都在内存里把整张 readings
    // （2280 行）过滤一遍并深拷贝所有命中行，再排序取第一条 = O(N²) + 海量深拷贝，线上实测 2~3 秒。
    // 改为：一次性载入 readings/meters/rooms，按表具建「period 升序」索引，求上一期变成 O(1)~O(每表条数)。
    const allReadings = await db.all('readings');
    const meters = await db.all('meters');
    const rooms = await db.all('rooms');
    const meterMap = {}; meters.forEach(m => { meterMap[m.id] = m; });
    const roomMap = {}; rooms.forEach(r => { roomMap[r.id] = r; });
    const byMeter = {};
    allReadings.forEach(r => { (byMeter[r.meterId] = byMeter[r.meterId] || []).push(r); });
    Object.keys(byMeter).forEach(k => byMeter[k].sort((a, b) => a.period < b.period ? -1 : (a.period > b.period ? 1 : 0)));
    // byMeter[k] 已按 period 升序，最后一个 period < 当前的即「上一期」（与原 sort 降序取 [0] 等价）
    function prevOf(meterId, period) {
      const arr = byMeter[meterId];
      if (!arr) return null;
      let best = null;
      for (let i = 0; i < arr.length; i++) { if (arr[i].period < period) best = arr[i]; else break; }
      return best;
    }

    // 分页：前端「最近抄表记录」传 size=500 且只渲染前 200 条，无需把 2280 行 /818KB 全回传。
    // 与 register() 列表接口口径一致：total = 过滤后总数，list = 当前页。
    const sz = Number(q.size);
    let pageList = list;
    if (Number.isFinite(sz) && sz > 0) {
      const p = Math.max(1, Number(q.page) || 1);
      pageList = list.slice((p - 1) * sz, p * sz);
    }

    const decorated = pageList.map(r => {
      const m = meterMap[r.meterId], rm = roomMap[r.roomId];
      const prev = prevOf(r.meterId, r.period);
      return Object.assign({}, r, {
        meterNo: m ? m.meterNo : '', meterType: m ? m.type : '',
        roomCode: rm ? rm.code : '',
        usage: prev ? Math.max(0, num(r.value) - num(prev.value)) : 0,
        prevValue: prev ? prev.value : null
      });
    });
    ok(res, { list: decorated, total: total });
  });

  // 抄表录入（支持批量）
  router.post('/api/finance/readings', async (req, res) => {
    if (!can(req, res, 'billing:meter')) return;
    const b = req.body || {};
    const list = Array.isArray(b.list) ? b.list : [b];
    const saved = [], errors = [];
    // for...of：循环体要 await 查表与写入，forEach 回调是同步函数，云端会整批失败
    for (const it of list) {
      if (!it.meterId || it.value === undefined || it.value === '') { errors.push('缺少表具或读数'); continue; }
      const m = await db.find('meters', it.meterId);
      if (!m) { errors.push('表具不存在：' + it.meterId); continue; }
      const period = it.period || monthOf(it.date || today());
      const exist = await db.one('readings', r => r.meterId === it.meterId && r.period === period);
      if (exist) {
        await db.update('readings', exist.id, { value: num(it.value), date: it.date || today(), by: (req.u || {}).name || '', source: it.source || '人工抄表' });
        saved.push(exist);
      } else {
        saved.push(await db.insert('readings', {
          id: uid('rd'), meterId: it.meterId, roomId: m.roomId, period: period,
          date: it.date || today(), value: num(it.value), by: (req.u || {}).name || '', source: it.source || '人工抄表'
        }));
      }
    }
    audit.routeLog(db, req, '收费管理', '抄表录入', { detail: '录入 ' + saved.length + ' 条' + (errors.length ? '，失败 ' + errors.length + ' 条' : '') });
    ok(res, { saved: saved.length, errors: errors });
  });

  // 抄表修正（录入错误 → 产生电费差额）
  router.post('/api/finance/readings/:id/fix', async (req, res) => {
    if (!can(req, res, 'billing:meter')) return;
    const b = req.body || {};
    const rd = (await db.find('readings', req.params.id));
    if (!rd) return fail(res, '抄表记录不存在', 404);
    const before = JSON.parse(JSON.stringify(rd));
    const m = (await db.find('meters', rd.meterId));
    const prev = (await db.where('readings', x => x.meterId === rd.meterId && x.period < rd.period)).sort((a, b2) => a.period < b2.period ? 1 : -1)[0];
    const oldUsage = prev ? Math.max(0, num(rd.value) - num(prev.value)) : 0;
    (await db.update('readings', rd.id, { value: num(b.value), fixNote: b.reason || '', fixedBy: (req.u || {}).name || '', fixedTime: now() }));
    const newUsage = prev ? Math.max(0, num(b.value) - num(prev.value)) : 0;
    const diff = newUsage - oldUsage;
    // 同步修正当期账单电费
    const ct = (await db.one('contracts', c => c.roomIds && c.roomIds.indexOf(rd.roomId) >= 0));
    let billPatch = null;
    if (ct) {
      const bill = (await db.one('bills', x => x.contractId === ct.id && x.period === rd.period));
      if (bill) {
        const price = num((ct.fees || {}).electricPrice, 1);
        const item = (bill.items || []).filter(i => i.name === '电费')[0];
        if (item) {
          const oldAmt = item.amount;
          item.qty = money(newUsage);
          item.amount = money(newUsage * price);
          item.taxAmount = money(item.amount - item.amount / 1.13);
          item.remark = (item.remark ? item.remark + '；' : '') + '读数修正：' + before.value + ' → ' + b.value;
          bill.totalAmount = money((bill.items || []).reduce((s, i) => s + i.amount, 0));
          bill.taxAmount = money((bill.items || []).reduce((s, i) => s + i.taxAmount, 0));
          if (bill.totalAmount - bill.paidAmount <= 0.01) bill.status = '已收款';
          else if (bill.paidAmount > 0) bill.status = '部分收款';
          (await db.update('bills', bill.id, { items: bill.items, totalAmount: bill.totalAmount, taxAmount: bill.taxAmount, status: bill.status }));
          billPatch = { billCode: bill.code, oldAmount: oldAmt, newAmount: item.amount, diff: money(item.amount - oldAmt) };
        }
      }
    }
    audit.routeLog(db, req, '收费管理', '抄表修正', {
      bizId: rd.id, bizCode: m ? m.meterNo : '', detail: '读数 ' + before.value + ' → ' + b.value + '，电量差 ' + diff + ' 度；' + (b.reason || ''),
      before: before, after: (await db.find('readings', rd.id))
    });
    ok(res, { reading: (await db.find('readings', rd.id)), diffKwh: diff, bill: billPatch });
  });

  /* ---------- 公摊电费 ---------- */
  router.post('/api/finance/shared-electric', async (req, res) => {
    if (!can(req, res, 'billing:meter')) return;
    const b = req.body || {};
    const r = await B.allocateSharedElectric(db, Object.assign({}, b, { userId: req.user.id, userName: (req.u || {}).name || '' }));
    if (!r.ok) return fail(res, r.msg);
    audit.routeLog(db, req, '收费管理', '公摊电费分摊', {
      bizId: r.record.id, detail: r.record.period + ' / 楼层 ' + B.floorNameOf(r.record.floor) + ' / 总电费 ' + r.record.totalFee + ' 元，分摊 ' + r.applied + ' 间'
    });
    ok(res, r);
  });

  router.get('/api/finance/shared-electric', async (req, res) => {
    if (!can(req, res, 'billing:view')) return;
    const list = (await db.where('shared_electric')).sort((a, b) => a.createTime < b.createTime ? 1 : -1);
    ok(res, list);
  });

  // 用电异常监控（偷电监测）
  router.get('/api/finance/electric-anomaly', async (req, res) => {
    if (!can(req, res, 'billing:view')) return;
    const period = req.query.period || monthOf(today());
    ok(res, await B.electricAnomaly(db, period));
  });

  // 空置房基础电费
  router.post('/api/finance/vacant-electric', async (req, res) => {
    if (!can(req, res, 'billing:manage')) return;
    const r = await B.generateVacantElectric(db, (req.body || {}).period || monthOf(today()), { projectId: req.body.projectId, userId: req.user.id });
    audit.routeLog(db, req, '收费管理', '生成空置房基础电费', { detail: '新增 ' + r.created + ' 条，金额 ' + r.amount + ' 元' });
    ok(res, r);
  });

  /* ---------- 收款记录 ---------- */
  router.get('/api/finance/payments', async (req, res) => {
    if (!can(req, res, 'billing:view')) return;
    const q = req.query;
    let list = (await db.where('payments', p => (!q.date || p.date === q.date) && (!q.projectId || p.projectId === q.projectId) && (!q.customerId || p.customerId === q.customerId) && (!q.month || p.date.indexOf(q.month) === 0)));
    list = list.sort((a, b) => a.date < b.date ? 1 : -1);
    const total = money(list.reduce((s, p) => s + num(p.amount), 0));
    ok(res, { list: list, total: list.length, amount: total });
  });

  router.get('/api/finance/daily', async (req, res) => {
    if (!can(req, res, 'billing:view')) return;
    ok(res, await B.dailyCollection(db, req.query.date));
  });

  router.get('/api/finance/monthly', async (req, res) => {
    if (!can(req, res, 'billing:view')) return;
    const period = req.query.period || monthOf(today());
    ok(res, await B.monthlySummary(db, period));
  });

  router.get('/api/finance/arrears', async (req, res) => {
    if (!can(req, res, 'billing:view')) return;
    ok(res, await B.arrearsList(db, req.query));
  });

  /* ---------- 押金 ---------- */
  router.get('/api/finance/deposits', async (req, res) => {
    if (!can(req, res, 'billing:view')) return;
    const q = req.query;
    const list = (await db.where('deposits', d => (!q.projectId || d.projectId === q.projectId) && (!q.status || d.status === q.status) && (!q.customerId || d.customerId === q.customerId)))
      .sort((a, b) => a.date < b.date ? 1 : -1);
    const sum = {
      total: money(list.reduce((s, d) => s + num(d.amount), 0)),
      holding: money(list.filter(d => d.status === '在管').reduce((s, d) => s + num(d.amount), 0)),
      pending: money(list.filter(d => d.status === '待退回').reduce((s, d) => s + num(d.amount), 0)),
      refunded: money(list.filter(d => d.status === '已退回').reduce((s, d) => s + num(d.refundAmount), 0))
    };
    ok(res, { list: list, sum: sum });
  });

  router.post('/api/finance/deposits', async (req, res) => {
    if (!can(req, res, 'billing:deposit')) return;
    const b = req.body || {};
    const row = (await db.insert('deposits', Object.assign({
      id: uid('dp'), type: b.type || '收取', date: b.date || today(),
      by: (req.u || {}).name || '', byId: req.user.id, status: b.status || '在管'
    }, b)));
    if (row.type === '收取' && row.contractId) {
      const c = (await db.find('contracts', row.contractId));
      if (c) (await db.update('contracts', c.id, { depositPaid: money(num(c.depositPaid) + num(row.amount)), depositStatus: '已收' }));
    }
    audit.routeLog(db, req, '收费管理', '押金登记', { bizId: row.id, bizCode: row.contractCode, detail: row.type + ' ' + money(row.amount).toFixed(2) + ' 元' });
    ok(res, row);
  });

  router.post('/api/finance/deposits/:id/refund', async (req, res) => {
    if (!can(req, res, 'billing:deposit')) return;
    const b = req.body || {};
    const d = (await db.find('deposits', req.params.id));
    if (!d) return fail(res, '押金记录不存在', 404);
    (await db.update('deposits', d.id, {
      status: '已退回', refundAmount: money(b.refundAmount !== undefined ? b.refundAmount : d.amount),
      refundDate: b.refundDate || today(), deductAmount: num(b.deductAmount, 0), deductReason: b.deductReason || '',
      refundBy: (req.u || {}).name || ''
    }));
    if (d.contractId) (await db.update('contracts', d.contractId, { depositRefundStatus: '已退' }));
    audit.routeLog(db, req, '收费管理', '押金退回', { bizId: d.id, bizCode: d.contractCode, detail: '退回 ' + money(b.refundAmount !== undefined ? b.refundAmount : d.amount).toFixed(2) + ' 元' });
    ok(res, (await db.find('deposits', d.id)));
  });

  // ─── 电表/水表抄表导入 ───────────────────────────────────────────────────────

  /** 下载电表抄表模板 */
  router.get('/api/finance/meters/import/electric-template', async (req, res) => {
    if (!can(req, res, 'billing:meter')) return fail(res, '无权限');
    const XLSX = require('../node_modules/xlsx');
    const fields = [
      { title: '表号', key: 'meterNo' },
      { title: '抄表日期', key: 'date' },
      { title: '本期读数', key: 'value' }
    ];
    const ws = XLSX.utils.aoa_to_sheet([
      fields.map(f => f.title),
      ['DB000001', '2026-10-01', '8500']
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '电表抄表');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    const tplName = '电表抄表导入模板.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(tplName) + '"; filename*=UTF-8\'\'' + encodeURIComponent(tplName));
    res.end(buf);
  });

  /** 下载水表抄表模板 */
  router.get('/api/finance/meters/import/water-template', async (req, res) => {
    if (!can(req, res, 'billing:meter')) return fail(res, '无权限');
    const XLSX = require('../node_modules/xlsx');
    const fields = [
      { title: '表号', key: 'meterNo' },
      { title: '抄表日期', key: 'date' },
      { title: '本期读数', key: 'value' }
    ];
    const ws = XLSX.utils.aoa_to_sheet([
      fields.map(f => f.title),
      ['SB000001', '2026-10-01', '320']
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '水表抄表');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    const tplName = '水表抄表导入模板.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(tplName) + '"; filename*=UTF-8\'\'' + encodeURIComponent(tplName));
    res.end(buf);
  });

  /** 批量导入电表抄表记录 */
  router.post('/api/finance/meters/import/electric', async (req, res) => {
    if (!can(req, res, 'billing:meter')) return fail(res, '无权限');
    // 【为什么用 base64 JSON 而不是 FormData 上传】见 routes/customer.js 同名注释：
    // lib/http.js 的 readBody 对 multipart 只回 { _raw: Buffer }，
    // `Array.isArray(req.body)` 恒为 false → 前端会看到「文件为空」。
    const b = req.body || {};
    if (!b.fileBase64) return fail(res, '缺少文件');

    const XLSX = require('../node_modules/xlsx');
    let rows;
    try {
      const ab = Buffer.from(String(b.fileBase64).split(',').pop(), 'base64');
      const wb = XLSX.read(ab, { type: 'array' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    } catch (e) {
      return fail(res, 'Excel 解析失败：' + e.message);
    }
    if (rows.length === 0) return fail(res, '没有数据行');

    const meters = await db.all('meters');
    const meterMap = {};
    meters.forEach(m => { if (m.type === '电表') meterMap[m.meterNo] = m; });

    // ⚠ 计数器不能叫 ok：会遮蔽模块顶部从 lib/http 导入的 ok() 函数，
    //   导致末尾 ok(res, …) 抛「ok is not a function」。
    let okCount = 0, failList = [];
    for (const raw of rows) {
      const meterNo = String(raw['表号'] || raw['meterNo'] || '').trim();
      const date = String(raw['抄表日期'] || raw['date'] || '').trim();
      const value = Number(raw['本期读数'] || raw['value']);
      if (!meterNo || !date || isNaN(value)) {
        failList.push({ row: failList.length + 2, err: '表号、抄表日期、本期读数为必填项' });
        continue;
      }
      const m = meterMap[meterNo];
      if (!m) { failList.push({ row: failList.length + 2, err: '表号不存在：' + meterNo }); continue; }
      const period = monthOf(date);
      const exist = await db.one('readings', r => r.meterId === m.id && r.period === period);
      if (exist) {
        await db.update('readings', exist.id, {
          value: num(value), date, by: (req.u || {}).name || '', source: 'Excel导入'
        });
      } else {
        await db.insert('readings', {
          id: uid('rd'), meterId: m.id, roomId: m.roomId, period,
          date, value: num(value), by: (req.u || {}).name || '', source: 'Excel导入'
        });
      }
      okCount++;
    }
    ok(res, { imported: okCount, errors: failList });
  });

  /** 批量导入水表抄表记录 */
  router.post('/api/finance/meters/import/water', async (req, res) => {
    if (!can(req, res, 'billing:meter')) return fail(res, '无权限');
    // 【为什么用 base64 JSON 而不是 FormData 上传】见 routes/customer.js 同名注释：
    // lib/http.js 的 readBody 对 multipart 只回 { _raw: Buffer }，
    // `Array.isArray(req.body)` 恒为 false → 前端会看到「文件为空」。
    const b = req.body || {};
    if (!b.fileBase64) return fail(res, '缺少文件');

    const XLSX = require('../node_modules/xlsx');
    let rows;
    try {
      const ab = Buffer.from(String(b.fileBase64).split(',').pop(), 'base64');
      const wb = XLSX.read(ab, { type: 'array' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    } catch (e) {
      return fail(res, 'Excel 解析失败：' + e.message);
    }
    if (rows.length === 0) return fail(res, '没有数据行');

    const meters = await db.all('meters');
    const meterMap = {};
    meters.forEach(m => { if (m.type === '水表') meterMap[m.meterNo] = m; });

    // ⚠ 计数器不能叫 ok：会遮蔽模块顶部从 lib/http 导入的 ok() 函数，
    //   导致末尾 ok(res, …) 抛「ok is not a function」。
    let okCount = 0, failList = [];
    for (const raw of rows) {
      const meterNo = String(raw['表号'] || raw['meterNo'] || '').trim();
      const date = String(raw['抄表日期'] || raw['date'] || '').trim();
      const value = Number(raw['本期读数'] || raw['value']);
      if (!meterNo || !date || isNaN(value)) {
        failList.push({ row: failList.length + 2, err: '表号、抄表日期、本期读数为必填项' });
        continue;
      }
      const m = meterMap[meterNo];
      if (!m) { failList.push({ row: failList.length + 2, err: '表号不存在：' + meterNo }); continue; }
      const period = monthOf(date);
      const exist = await db.one('readings', r => r.meterId === m.id && r.period === period);
      if (exist) {
        await db.update('readings', exist.id, {
          value: num(value), date, by: (req.u || {}).name || '', source: 'Excel导入'
        });
      } else {
        await db.insert('readings', {
          id: uid('rd'), meterId: m.id, roomId: m.roomId, period,
          date, value: num(value), by: (req.u || {}).name || '', source: 'Excel导入'
        });
      }
      okCount++;
    }
    ok(res, { imported: okCount, errors: failList });
  });

  return router;
};
