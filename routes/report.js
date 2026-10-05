'use strict';
// 报表统计与导出（CSV / Excel，支持批量几千条，含通讯地址字段）
const { ok, fail } = require('../lib/http');
const { can } = require('../lib/crud');
const audit = require('../lib/audit');
const X = require('../lib/exportx');
const fs = require('fs');
const path = require('path');
const { money, num, today, monthOf, now, uid } = require('../lib/util');
const B = require('../lib/billing');

function sendDownload(res, filename, content, mime) {
  const buf = Buffer.from(content, 'utf8');
  res.writeHead(200, {
    'Content-Type': (mime || 'text/csv') + '; charset=utf-8',
    'Content-Length': buf.length,
    'Content-Disposition': 'attachment; filename="' + encodeURIComponent(filename) + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename)
  });
  res.end(buf);
}

module.exports = function (db, router, opt) {
  const exportDir = path.join(opt.rootDir, 'exports');
  // 云端（TiDB）才支持 SQL 下推；本地 JSON 版只有内存算法。
  // 判断方式：云端版才有 groupAgg 方法（本地版是本轮同步补上的，
  // 但更可靠的判据是 kind 字段 —— clouddb 构造时写死了 kind='tidb'）。
  const isCloud = db && db.kind === 'tidb';

  /**
   * 欠费聚合：返回 { count, amount }
   *
   * 口径：**ROUND(totalAmount - paidAmount, 2) > 0.01** 且 非内部账单。
   *
   * ⚠⚠ 为什么要 ROUND 到分再比 0.01（这是金额断言测试发现的真 bug）：
   *   业务语义是「欠费超过 1 分钱才算欠」。直觉写法 `total - paid > 0.01`
   *   会被二进制浮点做错，而且**错的方向随金额变化**：
   *       100   - 99.99  = 0.010000000000005116  > 0.01  ← 误判成欠费
   *       200   - 199.99 = 0.009999999999990905  > 0.01  ← 正确
   *   也就是「差 1 分钱整」在总额 100 元时算欠费、200 元时不算，
   *   同一份数据换个金额结论就变。当前线上恰好 0 条命中（运气好），
   *   但导入/新增账单随时可能造出来。详见 scripts/test_dashboard_amount.js 第 2.5 组。
   *
   * 两种模式的实现：
   *   云端 → SQL 下推（_raw + _expr），只回一行，不拉明细
   *   本地 → 内存过滤（where 传函数），语义与云端逐分一致
   */
  const arrearsAgg = async () => {
    const specs = {
      count: { fn: 'COUNT' },
      amount: { col: 'arrearsAmount', fn: 'SUM', _expr: '(`totalAmount` - `paidAmount`)' }
    };
    if (isCloud) {
      return db.agg('bills', specs, {
        _raw: 'ROUND(`totalAmount` - `paidAmount`, 2) > 0.01 AND COALESCE(`internal`, 0) = 0'
      });
    }
    // 本地：函数条件（本地 where 支持函数），ROUND 口径与 SQL ROUND 对齐
    return db.agg('bills', specs,
      b => money(b.totalAmount - b.paidAmount) > 0.01 && !b.internal);
  };

  /* ---------- 驾驶舱 ----------
   *
   * 【SQL 侧聚合改造，2026-10-04】
   * 原来把 rooms / contracts / bills 三张表全量拉进 Node 内存再用 reduce 累加：
   *     const bills = await db.where('bills', b => b.period === curMonth);   // 349 行
   *     total: money(bills.reduce((s, b) => s + num(b.totalAmount), 0))
   * projects 更是对每个项目 filter 一遍全表（N × 全表扫描）。
   * 实测三表合计 266 + 214 + 1228 = 1708 行、约 2MB 传输，
   * 而最终只为了得到二十几个数字 —— 90% 带宽和 CPU 花在「搬回来再扔掉」。
   *
   * 现在全部下推成 SQL（见 lib/clouddb.js 的 sum / agg / groupAgg）：
   *   - 能用对象条件表达的 → 走 SQL WHERE
   *   - 「两列相减」这类算术表达式（欠费口径 totalAmount - paidAmount > 0.01）
   *     无法用 buildWhere 表达，用 agg 的 rawWhere 白名单化改写
   *   - 本地 JSON 模式（DB_MODE=local）自动回退内存算法，语义一致
   *
   * 正确性由 scripts/test_dashboard_amount.js 逐字段对拍保证 ——
   * SQL 聚合与原内存算法必须**分毫不差**，否则测试红。
   */
  router.get('/api/report/dashboard', async (req, res) => {
    if (!can(req, res, 'dashboard:view')) return;
    const curMonth = monthOf(today());

    // ---- 全部聚合查询【一次并发发起】----
    //
    // ⚠⚠ 【这是本次优化的核心：减少「往返次数」而不是「传输量」】
    //   实测每条 SQL 固定约 **80ms 网络往返**（TiDB Cloud Serverless 跨地域 TLS），
    //   而聚合在库里只花几毫秒。所以：
    //       驾驶舱耗时 ≈ SQL 条数 × 80ms
    //   改造前是「3 条全表 SELECT（1708 行 / 约 2MB）」，
    //   但 2MB 传输 + 反序列化在 Lambda 里也很贵；改造后每条都只回一行。
    //   真正决定成败的是**并发**：原来 10 余条串行 await = 800ms+，
    //   现在一次 Promise.all 全部同时发出 → 墙钟时间 ≈ 最慢那一条。
    //
    //   并发上限：lib/tidb.js 里 maxConnections=10，这里正好 12 条，
    //   超出部分会自动排队（不至于超时）。实测中位数见部署后验证。
    const [rAgg, cAgg, billAgg, arAgg, invAgg, depHold,
      roomsByPj, vacantByPj, activeByPj, allProjects,
      cCustomers, cInvoices, cDepPending, cWoAll, cAppr, cRem] = await Promise.all([
      // 房间状态分布：一条 SQL 出全部计数
      // 原写法要把 rooms(266) 整表载入再扫 N 遍 filter
      db.agg('rooms', {
        total: { fn: 'COUNT' },
        vacant: { fn: 'SUM', _case: { status: '空置' } },
        rented: { fn: 'SUM', _case: { status: '已租' } }
      }),
      // 合同状态分布：同样一条 SQL
      db.agg('contracts', {
        total: { fn: 'COUNT' },
        active: { fn: 'SUM', _case: { status: ['正常履约', '变更'] } },
        expired: { fn: 'SUM', _case: { status: '逾期' } },
        terminated: { fn: 'SUM', _case: { status: ['退租', '终止'] } }
      }),
      // 本月账单：count/total/paid 一条出；unpaid 由算术推出
      db.agg('bills', {
        count: { fn: 'COUNT' },
        total: { col: 'totalAmount', fn: 'SUM' },
        paid: { col: 'paidAmount', fn: 'SUM' }
      }, { period: curMonth }),
      // 欠费（口径见 arrearsAgg 注释：ROUND 到分再比 1 分钱）
      arrearsAgg(),
      // 发票：排除已作废
      db.agg('invoices', {
        count: { fn: 'COUNT' },
        amount: { col: 'amount', fn: 'SUM' }
      }, { status: { $ne: '已作废' } }),
      // 押金：在管金额
      db.sum('deposits', 'amount', { status: '在管' }),
      // projects 明细：原来对每个项目 filter 一遍全表（项目数 × 全表扫描），
      // 现在 rooms / contracts 各一条 GROUP BY，最后在内存按 projectId 合并
      db.groupAgg('rooms', 'projectId', { cnt: { fn: 'COUNT' }, area: { col: 'area', fn: 'SUM' } }),
      db.groupAgg('rooms', 'projectId', { cnt: { fn: 'COUNT' } }, { status: '空置' }),
      db.groupAgg('contracts', 'projectId', {
        cnt: { fn: 'COUNT' }, area: { col: 'area', fn: 'SUM' }, rent: { col: 'rentMonthly', fn: 'SUM' }
      }, { status: ['正常履约', '变更'] }),
      db.where('projects'),
      db.count('customers'),
      db.count('invoices'),
      db.count('deposits', { status: '待退回' }),
      // 工单两条计数合并成一条 SQL
      db.agg('workorders', {
        total: { fn: 'COUNT' },
        pending: { fn: 'SUM', _case: { status: ['待处理', '处理中'] } }
      }),
      db.count('approvals', { status: '审批中' }),
      // 提醒两条计数合并成一条 SQL
      db.agg('reminders', {
        total: { fn: 'SUM', _case: { status: '未处理' } },
        urgent: { fn: 'SUM', _case: { status: '未处理', level: '紧急' } }
      })
    ]);
    const projects = allProjects.map(pj => {
      const k = String(pj.id);
      const r = roomsByPj[k] || { cnt: 0, area: 0 };
      const a = activeByPj[k] || { cnt: 0, area: 0, rent: 0 };
      const area = money(r.area);
      const rentArea = money(a.area);
      return {
        projectId: pj.id, name: pj.name,
        rooms: r.cnt, vacant: Number((vacantByPj[k] && vacantByPj[k].cnt) || 0),
        contracts: a.cnt, area: area, rentArea: rentArea,
        occupancy: area > 0 ? Math.round(rentArea / area * 1000) / 10 : 0,
        monthlyRent: money(a.rent)
      };
    });

    ok(res, {
      rooms: { total: rAgg.total, vacant: rAgg.vacant, rented: rAgg.rented },
      contracts: { total: cAgg.total, active: cAgg.active, expired: cAgg.expired, terminated: cAgg.terminated },
      customers: cCustomers,
      bill: {
        count: billAgg.count,
        total: money(billAgg.total),
        paid: money(billAgg.paid),
        // 与原 reduce 语义一致：unpaid = Σ(totalAmount) - Σ(paidAmount)
        unpaid: money(money(billAgg.total) - money(billAgg.paid))
      },
      arrears: { count: arAgg.count, amount: money(arAgg.amount) },
      invoices: { count: cInvoices, amount: money(invAgg.amount) },
      deposits: { holding: money(depHold), pending: cDepPending },
      workorders: { pending: cWoAll.pending, total: cWoAll.total },
      approvals: { pending: cAppr },
      reminders: { total: cRem.total, urgent: cRem.urgent },
      projects: projects,
      todayCollection: await B.dailyCollection(db, today())
    });
  });

  /* ---------- 各项目平均单价（含税/不含税） ---------- */
  router.get('/api/report/price', async (req, res) => {
    if (!can(req, res, 'report:view')) return;
    const projects = (await db.where('projects'));
    // map 回调要 await 查合同 → Promise.all 聚合（回调是同步函数）
    const rows = await Promise.all(projects.map(async pj => {
      const cs = await db.where('contracts', c => c.projectId === pj.id && (c.status === '正常履约' || c.status === '变更'));
      const inc = cs.filter(c => c.taxIncluded), exc = cs.filter(c => !c.taxIncluded);
      const avg = arr => arr.length ? money(arr.reduce((s, c) => s + num(c.rentUnitPrice), 0) / arr.length) : 0;
      return {
        projectId: pj.id, projectName: pj.name,
        count: cs.length,
        avgTaxIncluded: avg(inc), avgTaxExcluded: avg(exc),
        avgAll: avg(cs),
        area: money(cs.reduce((s, c) => s + num(c.area), 0)),
        monthly: money(cs.reduce((s, c) => s + num(c.rentMonthly), 0)),
        minPrice: cs.length ? Math.min.apply(null, cs.map(c => num(c.rentUnitPrice))) : 0,
        maxPrice: cs.length ? Math.max.apply(null, cs.map(c => num(c.rentUnitPrice))) : 0
      };
    }));
    ok(res, rows);
  });

  /* ---------- 空置房间统计 ---------- */
  router.get('/api/report/vacant', async (req, res) => {
    if (!can(req, res, 'report:view')) return;
    const rooms = (await db.where('rooms', r => r.status === '空置'));
    // map 回调要 await 查楼栋/项目 → Promise.all 聚合
    const rows = await Promise.all(rooms.map(async r => {
      const b = await db.find('buildings', r.buildingId);
      const pj = await db.find('projects', r.projectId);
      return {
        id: r.id, code: r.code, projectName: pj ? pj.name : '', buildingName: b ? b.name : '',
        floorLabel: r.floorLabel || B.floorNameOf(r.floor), area: r.area, bizType: r.bizType,
        level: r.level, facilities: (r.facilities || []).join('、'),
        vacantDays: r.lastVacantDate ? Math.round((new Date(today()) - new Date(r.lastVacantDate)) / 86400000) : 0,
        priceStandard: num(r.priceStandard)
      };
    }));
    const byProject = {};
    rows.forEach(r => { byProject[r.projectName] = (byProject[r.projectName] || 0) + 1; });
    ok(res, { list: rows, total: rows.length, area: money(rows.reduce((s, r) => s + num(r.area), 0)), byProject: byProject });
  });

  /* ---------- 欠费客户清单 ---------- */
  router.get('/api/report/arrears', async (req, res) => {
    if (!can(req, res, 'report:view')) return;
    const list = await B.arrearsList(db, req.query);
    const byCustomer = {};
    list.forEach(r => {
      const k = r.customerId || r.customerName;
      byCustomer[k] = byCustomer[k] || { customerId: r.customerId, customerName: r.customerName, phone: r.phone, contact: r.contact, address: r.address, amount: 0, count: 0, maxOverdue: 0 };
      byCustomer[k].amount = money(byCustomer[k].amount + r.arrears);
      byCustomer[k].count += 1;
      byCustomer[k].maxOverdue = Math.max(byCustomer[k].maxOverdue, r.overdueDays);
    });
    const summary = Object.keys(byCustomer).map(k => byCustomer[k]).sort((a, b) => b.amount - a.amount);
    ok(res, { list: list, total: list.length, amount: money(list.reduce((s, r) => s + r.arrears, 0)), byCustomer: summary });
  });

  /* ---------- 导出：房源统计表 ---------- */
  router.get('/api/report/export/rooms', async (req, res) => {
    if (!can(req, res, 'report:export')) return;
    const format = req.query.format || 'csv';
    const rooms = (await db.where('rooms', r => !req.query.projectId || r.projectId === req.query.projectId));
    const headers = [
      { title: '项目', key: 'projectName', width: 120 }, { title: '楼栋', key: 'buildingName', width: 90 },
      { title: '楼层', key: 'floorLabel', width: 60 }, { title: '房号', key: 'roomNo', width: 70 },
      { title: '房源编码', key: 'code', width: 140 }, { title: '建筑面积(㎡)', key: 'area', type: 'number', width: 100 },
      { title: '使用面积(㎡)', key: 'useArea', type: 'number', width: 100 }, { title: '业态', key: 'bizType', width: 70 },
      { title: '楼层类型', key: 'level', width: 80 }, { title: '状态', key: 'status', width: 70 },
      { title: '产权证书', key: 'propertyCert', width: 200 }, { title: '权利人', key: 'ownerName', width: 180 },
      { title: '配套', key: 'facilities', width: 120 }, { title: '客户', key: 'customerName', width: 160 },
      { title: '合同号', key: 'contractCode', width: 140 }, { title: '租金单价', key: 'rentUnitPrice', type: 'number', width: 90 },
      { title: '到期日', key: 'endDate', width: 100 }, { title: '备注', key: 'remark', width: 160 }
    ];
    // map 回调要 await 三次查库 → Promise.all 聚合
    const rows = await Promise.all(rooms.map(async r => {
      const b = await db.find('buildings', r.buildingId), pj = await db.find('projects', r.projectId);
      const ct = await db.one('contracts', c => c.status !== '退租' && c.status !== '终止' && c.roomIds && c.roomIds.indexOf(r.id) >= 0);
      return {
        projectName: pj ? pj.name : '', buildingName: b ? b.name : '',
        floorLabel: r.floorLabel || B.floorNameOf(r.floor), roomNo: r.roomNo, code: r.code,
        area: r.area, useArea: r.useArea, bizType: r.bizType, level: r.level, status: r.status,
        propertyCert: r.propertyCert, ownerName: r.ownerName, facilities: (r.facilities || []).join('、'),
        customerName: ct ? ct.customerName : '', contractCode: ct ? ct.code : '',
        rentUnitPrice: ct ? ct.rentUnitPrice : 0, endDate: ct ? ct.endDate : '', remark: r.remark
      };
    }));
    audit.routeLog(db, req, '报表统计', '导出房源统计表', { detail: rows.length + ' 条' });
    download(res, '房源统计表', headers, rows, format, exportDir);
  });

  /* ---------- 导出：客户台账（含通讯地址） ---------- */
  router.get('/api/report/export/customers', async (req, res) => {
    if (!can(req, res, 'report:export')) return;
    const format = req.query.format || 'csv';
    const list = (await db.where('customers'));
    const headers = [
      { title: '客户名称', key: 'name', width: 200 }, { title: '客户类型', key: 'type', width: 90 },
      { title: '统一社会信用代码', key: 'creditCode', width: 180 }, { title: '法人/联系人', key: 'legalPerson', width: 100 },
      { title: '联系人', key: 'contact', width: 90 }, { title: '联系电话', key: 'phone', width: 110 },
      { title: '通讯地址', key: 'address', width: 260 }, { title: '开户行', key: 'bankName', width: 160 },
      { title: '银行账号', key: 'bankAccount', width: 180 }, { title: '风险标记', key: 'riskFlag', width: 90 },
      { title: '风险说明', key: 'riskNote', width: 200 }, { title: '在租房源', key: 'roomCodes', width: 200 },
      { title: '在租面积(㎡)', key: 'area', type: 'number', width: 100 }, { title: '月租金', key: 'monthlyRent', type: 'number', width: 110 },
      { title: '合同数', key: 'contractCount', type: 'number', width: 70 }, { title: '欠费金额', key: 'arrearsAmount', type: 'number', width: 110 },
      { title: '状态', key: 'status', width: 70 }
    ];
    // map 回调要 await 查合同与账单 → Promise.all 聚合
    const rows = await Promise.all(list.map(async c => {
      const cts = await db.where('contracts', x => x.customerId === c.id && x.status !== '退租' && x.status !== '终止');
      const codes = [];
      cts.forEach(x => { codes.push.apply(codes, x.roomCodes || []); });
      const bills = await db.where('bills', b => b.customerId === c.id && b.totalAmount - b.paidAmount > 0.01);
      return {
        name: c.name, type: c.type, creditCode: c.creditCode, legalPerson: c.legalPerson,
        contact: c.contact, phone: c.phone, address: c.address, bankName: c.bankName,
        bankAccount: c.bankAccount, riskFlag: c.riskFlag, riskNote: c.riskNote,
        roomCodes: codes.join('、'), area: money(cts.reduce((s, x) => s + num(x.area), 0)),
        monthlyRent: money(cts.reduce((s, x) => s + num(x.rentMonthly), 0)), contractCount: cts.length,
        arrearsAmount: money(bills.reduce((s, b) => s + (b.totalAmount - b.paidAmount), 0)), status: c.status
      };
    }));
    audit.routeLog(db, req, '报表统计', '导出客户台账', { detail: rows.length + ' 条' });
    download(res, '客户台账', headers, rows, format, exportDir);
  });

  /* ---------- 导出：收费台账 ---------- */
  router.get('/api/report/export/bills', async (req, res) => {
    if (!can(req, res, 'report:export')) return;
    const format = req.query.format || 'csv';
    const q = req.query;
    const list = (await db.where('bills', b => (!q.period || b.period === q.period) && (!q.projectId || b.projectId === q.projectId) && (!q.status || b.status === q.status) && (!q.month || b.period === q.month)));
    const headers = [
      { title: '账单号', key: 'code', width: 140 }, { title: '账期', key: 'period', width: 80 },
      { title: '项目', key: 'projectName', width: 120 }, { title: '房号', key: 'roomCodes', width: 160 },
      { title: '客户', key: 'customerName', width: 180 }, { title: '联系电话', key: 'phone', width: 110 },
      { title: '通讯地址', key: 'address', width: 240 }, { title: '合同号', key: 'contractCode', width: 140 },
      { title: '应收合计', key: 'totalAmount', type: 'number', width: 110 },
      { title: '已收', key: 'paidAmount', type: 'number', width: 110 },
      { title: '欠费', key: 'arrears', type: 'number', width: 110 },
      { title: '税额', key: 'taxAmount', type: 'number', width: 100 },
      { title: '状态', key: 'status', width: 90 }, { title: '开票状态', key: 'invoiceStatus', width: 90 },
      { title: '应收日期', key: 'dueDate', width: 100 }, { title: '是否跨月', key: 'crossMonthText', width: 90 },
      { title: '费用明细', key: 'itemsText', width: 320 }, { title: '备注', key: 'remark', width: 140 }
    ];
    // map 回调要 await 查客户/项目 → Promise.all 聚合
    const rows = await Promise.all(list.map(async b => {
      const cu = await db.find('customers', b.customerId);
      const pj = await db.find('projects', b.projectId);
      return {
        code: b.code, period: b.period, projectName: (pj || {}).name || '',
        roomCodes: (b.roomCodes || []).join('、'), customerName: b.customerName,
        phone: cu ? cu.phone : '', address: cu ? cu.address : '', contractCode: b.contractCode,
        totalAmount: b.totalAmount, paidAmount: b.paidAmount, arrears: money(b.totalAmount - b.paidAmount),
        taxAmount: b.taxAmount, status: b.status, invoiceStatus: b.invoiceStatus, dueDate: b.dueDate,
        crossMonthText: b.crossMonth ? '是' : '否',
        itemsText: (b.items || []).map(it => it.name + ' ' + it.qty + it.unit + '×' + it.price + '=' + it.amount + '元').join('；'),
        remark: b.remark
      };
    }));
    audit.routeLog(db, req, '报表统计', '导出收费台账', { detail: rows.length + ' 条' });
    download(res, '收费台账', headers, rows, format, exportDir);
  });

  /* ---------- 导出：合同台账 / 合同清单 ---------- */
  router.get('/api/report/export/contracts', async (req, res) => {
    if (!can(req, res, 'report:export')) return;
    const format = req.query.format || 'csv';
    const q = req.query;
    const list = (await db.where('contracts', c => (!q.projectId || c.projectId === q.projectId) && (!q.status || c.status === q.status)));
    const headers = [
      { title: '合同号', key: 'code', width: 140 }, { title: '项目', key: 'projectName', width: 120 },
      { title: '楼栋', key: 'buildingName', width: 90 }, { title: '房号', key: 'roomCodes', width: 160 },
      { title: '承租方', key: 'customerName', width: 180 }, { title: '客户类型', key: 'customerType', width: 90 },
      { title: '联系人', key: 'lesseeContact', width: 90 }, { title: '联系电话', key: 'lesseePhone', width: 110 },
      { title: '通讯地址', key: 'address', width: 240 }, { title: '出租方', key: 'lessorName', width: 180 },
      { title: '面积(㎡)', key: 'area', type: 'number', width: 90 },
      { title: '租金单价(元/㎡/月)', key: 'rentUnitPrice', type: 'number', width: 140 },
      { title: '是否含税', key: 'taxText', width: 80 }, { title: '月租金', key: 'rentMonthly', type: 'number', width: 110 },
      { title: '租期起', key: 'startDate', width: 100 }, { title: '租期止', key: 'endDate', width: 100 },
      { title: '免租期', key: 'freeText', width: 200 }, { title: '押金', key: 'deposit', type: 'number', width: 100 },
      { title: '押金状态', key: 'depositStatus', width: 90 }, { title: '押金退回', key: 'depositRefundStatus', width: 90 },
      { title: '付款周期', key: 'payCycle', width: 80 }, { title: '状态', key: 'status', width: 90 },
      { title: '剩余天数', key: 'daysLeft', type: 'number', width: 90 }, { title: '版本', key: 'version', type: 'number', width: 60 }
    ];
    // map 回调要 await 查客户/楼栋/项目 → Promise.all 聚合
    const rows = await Promise.all(list.map(async c => {
      const cu = await db.find('customers', c.customerId);
      const b = await db.find('buildings', c.buildingId), pj = await db.find('projects', c.projectId);
      return {
        code: c.code, projectName: pj ? pj.name : '', buildingName: b ? b.name : '',
        roomCodes: (c.roomCodes || []).join('、'), customerName: c.customerName,
        customerType: cu ? cu.type : (c.customerType || ''), lesseeContact: c.lesseeContact, lesseePhone: c.lesseePhone,
        address: cu ? cu.address : '', lessorName: c.lessorName, area: c.area,
        rentUnitPrice: c.rentUnitPrice, taxText: c.taxIncluded ? '含税' : '不含税',
        rentMonthly: c.rentMonthly, startDate: c.startDate, endDate: c.endDate,
        freeText: c.freeMonths ? (c.freeMonths + '个月（' + c.freeStart + '~' + c.freeEnd + '）') : '无',
        deposit: c.deposit, depositStatus: c.depositStatus, depositRefundStatus: c.depositRefundStatus,
        payCycle: c.payCycle, status: c.status,
        daysLeft: Math.round((new Date(c.endDate) - new Date(today())) / 86400000), version: c.version
      };
    }));
    audit.routeLog(db, req, '报表统计', '导出合同清单', { detail: rows.length + ' 条' });
    download(res, '合同清单', headers, rows, format, exportDir);
  });

  /* ---------- 导出：出租明细（出租单报表） ---------- */
  router.get('/api/report/export/rent-detail', async (req, res) => {
    if (!can(req, res, 'report:export')) return;
    const format = req.query.format || 'csv';
    const list = (await db.where('contracts', c => c.status === '正常履约' || c.status === '变更'));
    const headers = [
      { title: '项目', key: 'projectName', width: 120 }, { title: '房号', key: 'roomCode', width: 150 },
      { title: '面积(㎡)', key: 'area', type: 'number', width: 90 }, { title: '客户', key: 'customerName', width: 180 },
      { title: '合同号', key: 'code', width: 140 }, { title: '单价', key: 'rentUnitPrice', type: 'number', width: 90 },
      { title: '含税', key: 'taxText', width: 60 }, { title: '月租金', key: 'rentMonthly', type: 'number', width: 110 },
      { title: '年租金', key: 'yearRent', type: 'number', width: 120 }, { title: '租期', key: 'periodText', width: 180 },
      { title: '剩余天数', key: 'daysLeft', type: 'number', width: 90 }, { title: '欠费', key: 'arrears', type: 'number', width: 110 }
    ];
    // map 回调要 await 查项目/账单 → Promise.all 聚合
    const rows = await Promise.all(list.map(async c => {
      const pj = await db.find('projects', c.projectId);
      const bills = await db.where('bills', b => b.contractId === c.id);
      return {
        projectName: pj ? pj.name : '', roomCode: (c.roomCodes || []).join('、'), area: c.area,
        customerName: c.customerName, code: c.code, rentUnitPrice: c.rentUnitPrice,
        taxText: c.taxIncluded ? '是' : '否', rentMonthly: c.rentMonthly,
        yearRent: money(num(c.rentMonthly) * 12), periodText: c.startDate + ' ~ ' + c.endDate,
        daysLeft: Math.round((new Date(c.endDate) - new Date(today())) / 86400000),
        arrears: money(bills.reduce((s, b) => s + (b.totalAmount - b.paidAmount), 0))
      };
    }));
    audit.routeLog(db, req, '报表统计', '导出出租明细', { detail: rows.length + ' 条' });
    download(res, '出租明细', headers, rows, format, exportDir);
  });

  /* ---------- 导出：发票台账 ---------- */
  router.get('/api/report/export/invoices', async (req, res) => {
    if (!can(req, res, 'report:export')) return;
    const format = req.query.format || 'csv';
    const q = req.query;
    const list = (await db.where('invoices', i => (!q.month || (i.invoiceDate || '').indexOf(q.month) === 0) && (!q.category || i.category === q.category) && (!q.projectId || i.projectId === q.projectId)));
    const headers = [
      { title: '单据号', key: 'code', width: 130 }, { title: '发票号码', key: 'invoiceNo', width: 120 },
      { title: '开票日期', key: 'invoiceDate', width: 100 }, { title: '发票类型', key: 'type', width: 110 },
      { title: '开票内容', key: 'category', width: 90 }, { title: '客户', key: 'customerName', width: 180 },
      { title: '项目', key: 'projectName', width: 120 }, { title: '房号', key: 'roomCodes', width: 150 },
      { title: '合同号', key: 'contractCode', width: 140 },
      { title: '金额', key: 'amount', type: 'number', width: 110 },
      { title: '税率(%)', key: 'taxRate', type: 'number', width: 80 },
      { title: '税额', key: 'taxAmount', type: 'number', width: 100 },
      { title: '模板', key: 'template', width: 90 }, { title: '开票人', key: 'by', width: 90 },
      { title: '状态', key: 'status', width: 90 }, { title: '备注', key: 'remark', width: 160 }
    ];
    // map 回调要 await 查项目 → Promise.all 聚合
    const rows = await Promise.all(list.map(async i => Object.assign({}, i, {
      projectName: ((await db.find('projects', i.projectId)) || {}).name || '',
      roomCodes: (i.roomCodes || []).join('、')
    })));
    audit.routeLog(db, req, '报表统计', '导出发票台账', { detail: rows.length + ' 条' });
    download(res, '发票台账', headers, rows, format, exportDir);
  });

  /* ---------- 导出：收款明细 ---------- */
  router.get('/api/report/export/payments', async (req, res) => {
    if (!can(req, res, 'report:export')) return;
    const format = req.query.format || 'csv';
    const q = req.query;
    const list = (await db.where('payments', p => (!q.date || p.date === q.date) && (!q.month || p.date.indexOf(q.month) === 0) && (!q.projectId || p.projectId === q.projectId)));
    const headers = [
      { title: '收款单号', key: 'code', width: 130 }, { title: '收款日期', key: 'date', width: 100 },
      { title: '账单号', key: 'billCode', width: 140 }, { title: '房号', key: 'roomCodes', width: 150 },
      { title: '客户', key: 'customerName', width: 180 }, { title: '项目', key: 'projectName', width: 120 },
      { title: '金额', key: 'amount', type: 'number', width: 110 }, { title: '方式', key: 'method', width: 100 },
      { title: '收款人', key: 'by', width: 90 }, { title: '备注', key: 'remark', width: 160 }
    ];
    // map 回调要 await 查项目 → Promise.all 聚合
    const rows = await Promise.all(list.map(async p => Object.assign({}, p, {
      roomCodes: (p.roomCodes || []).join('、'),
      projectName: ((await db.find('projects', p.projectId)) || {}).name || ''
    })));
    audit.routeLog(db, req, '报表统计', '导出收款明细', { detail: rows.length + ' 条' });
    download(res, '收款明细', headers, rows, format, exportDir);
  });

  /* ---------- 导出：押金台账 ---------- */
  router.get('/api/report/export/deposits', async (req, res) => {
    if (!can(req, res, 'report:export')) return;
    const format = req.query.format || 'csv';
    const list = (await db.where('deposits'));
    const headers = [
      { title: '合同号', key: 'contractCode', width: 140 }, { title: '客户', key: 'customerName', width: 180 },
      { title: '类型', key: 'type', width: 80 }, { title: '金额', key: 'amount', type: 'number', width: 110 },
      { title: '收/退日期', key: 'date', width: 100 }, { title: '状态', key: 'status', width: 90 },
      { title: '已退金额', key: 'refundAmount', type: 'number', width: 110 },
      { title: '扣款金额', key: 'deductAmount', type: 'number', width: 110 },
      { title: '扣款原因', key: 'deductReason', width: 200 }, { title: '经办人', key: 'by', width: 90 }
    ];
    audit.routeLog(db, req, '报表统计', '导出押金台账', { detail: list.length + ' 条' });
    download(res, '押金台账', headers, list, format, exportDir);
  });

  function download(res, name, headers, rows, format, dir) {
    const stamp = today();
    if (format === 'xls') {
      const content = X.toXls([{ name: name, headers: headers, rows: rows }]);
      sendDownload(res, name + '_' + stamp + '.xls', content, 'application/vnd.ms-excel');
    } else {
      const content = X.toCSV(headers, rows);
      sendDownload(res, name + '_' + stamp + '.csv', content, 'text/csv');
    }
  }

  /* ---------- 导出文件列表（服务端留档） ---------- */
  router.get('/api/report/files', async (req, res) => {
    if (!can(req, res, 'report:view')) return;
    if (!fs.existsSync(exportDir)) return ok(res, []);
    const files = fs.readdirSync(exportDir).map(f => {
      const st = fs.statSync(path.join(exportDir, f));
      return { name: f, size: st.size, time: new Date(st.mtime).toISOString().slice(0, 19).replace('T', ' '), url: '/exports/' + encodeURIComponent(f) };
    }).sort((a, b) => a.time < b.time ? 1 : -1);
    ok(res, files);
  });

  router.post('/api/report/save', async (req, res) => {
    if (!can(req, res, 'report:export')) return;
    const b = req.body || {};
    const name = (b.name || '导出') + '_' + today() + '_' + uid('').slice(0, 5);
    const content = b.format === 'xls'
      ? X.toXls([{ name: b.sheetName || '导出', headers: b.headers, rows: b.rows }])
      : X.toCSV(b.headers, b.rows);
    const fp = X.writeExport(exportDir, name + (b.format === 'xls' ? '.xls' : '.csv'), content);
    audit.routeLog(db, req, '报表统计', '生成导出文件', { detail: path.basename(fp) });
    ok(res, { file: path.basename(fp), url: '/exports/' + encodeURIComponent(path.basename(fp)) });
  });

  return router;
};
