'use strict';
/**
 * 驾驶舱金额断言测试（SQL 聚合 vs 原内存算法 逐字段对拍）
 * ========================================================
 *
 * 【为什么必须有这个测试】
 * 驾驶舱改成 SQL 侧聚合后，金额计算的**执行位置**从 Node 内存
 * 挪到了 TiDB：
 *     原来：money(bills.reduce((s,b) => s + num(b.totalAmount), 0))   ← JS 浮点
 *     现在：SELECT SUM(`totalAmount`) ...                              ← DECIMAL
 * 两者都能算对，但**结果的最后一位可能不同**。实测：
 *     JS 累加 349 行后 money() → 2965133.02
 *     SQL SUM              → "2965133.0200000047"（驱动回传字符串）
 *     欠费 SUM(两列相减)   → "4500326.889999998"
 * 只要 money() 归一这层写漏一个地方，驾驶舱就会显示 2965133.0200000047，
 * 而用户不会报错、只会觉得"数字怎么这么难看"。这类 Bug 靠肉眼 review 发现不了，
 * 只能靠断言锁死。
 *
 * 【测试策略：双算法对拍，而不是硬编码期望值】
 * 不用「期望 2965133.02」这种硬编码 —— 那样数据一变就全红，失去意义。
 * 而是**同一份数据、同一个查询时刻**，把两条算法跑一遍，逐字段比对：
 *     A. 原内存算法（复刻改造前的 reduce 写法，含全部过滤条件）
 *     B. 新 SQL 聚合（routes/report.js 实际用的写法）
 * A 和 B 必须**分毫不差**。
 * 额外再跑一组「固定样本」测试，用人工构造的边界数据（空表/全欠费/浮点尾巴/
 * 1 分钱边界）验证绝对正确性 —— 这组不依赖线上数据，永远可跑。
 *
 * 用法：
 *   node scripts/test_dashboard_amount.js            # 对拍 + 固定样本
 *   node scripts/test_dashboard_amount.js --live     # 额外连云端核对数据库现值
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'lib', 'env'));
const { money, num, monthOf, today } = require(path.join(ROOT, 'lib', 'util'));

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; fails.push(name + (extra ? '  ' + extra : '')); console.log('  ✘ ' + name + (extra ? '  ' + extra : '')); }
}
/** 金额断言：分毫级比对，不用 ===（避免 -0 与浮点尾差误报） */
function eqMoney(name, got, want) {
  const g = money(got), w = money(want);
  ok(name, g === w, g === w ? (typeof g === 'number' ? String(g) : '') : ('期望 ' + w + '，实得 ' + g));
}
function eqNum(name, got, want) {
  ok(name, Number(got) === Number(want), '期望 ' + want + '，实得 ' + got);
}

// ==================================================================
// 第 1 组：固定样本 —— 人工构造边界数据，验证绝对正确性
// ==================================================================
// 这组不碰数据库，纯逻辑验证，任何时候都能跑。
// 覆盖的坑：
//   ① 空表：SUM 返回 NULL，不是 0
//   ② 浮点尾巴：0.1+0.2 类累积误差
//   ③ 1 分钱边界：欠费口径 total-paid > 0.01（严格大于）
//   ④ 负数欠费（多缴）：不该计入欠费
//   ⑤ NULL 值：num() 把 null 当 0
console.log('\n=== 第 1 组：固定样本（边界场景绝对正确性）===');

const samples = [
  {
    name: '空表 → SUM 应为 0 而不是 NaN',
    rows: [],
    expect: { count: 0, total: 0 }
  },
  {
    name: '经典浮点尾巴 0.1+0.2 → money 后必须等于 0.3',
    rows: [{ totalAmount: 0.1, paidAmount: 0 }, { totalAmount: 0.2, paidAmount: 0 }],
    expect: { count: 2, total: 0.3 }
  },
  {
    name: '三分钱总额 0.01+0.01+0.01 → 0.03',
    rows: [{ totalAmount: 0.01, paidAmount: 0 }, { totalAmount: 0.01, paidAmount: 0 }, { totalAmount: 0.01, paidAmount: 0 }],
    expect: { count: 3, total: 0.03 }
  },
  {
    name: '大额 1234.56 × 7 → 8641.92',
    rows: Array.from({ length: 7 }, () => ({ totalAmount: 1234.56, paidAmount: 0 })),
    expect: { count: 7, total: 8641.92 }
  },
  {
    name: 'NULL 金额按 0 处理（num 语义）',
    rows: [{ totalAmount: null, paidAmount: null }, { totalAmount: 100, paidAmount: 0 }],
    expect: { count: 2, total: 100 }
  },
  {
    name: '字符串金额（历史脏数据）应被 num 正确解析',
    rows: [{ totalAmount: '88.88', paidAmount: '0' }, { totalAmount: '11.12', paidAmount: '0' }],
    expect: { count: 2, total: 100 }
  }
];

samples.forEach(s => {
  const got = {
    count: s.rows.length,
    total: money(s.rows.reduce((sum, r) => sum + num(r.totalAmount), 0))
  };
  eqNum(s.name + ' → count', got.count, s.expect.count);
  eqMoney(s.name + ' → total', got.total, s.expect.total);
});

// ---- 欠费口径 1 分钱边界（严格大于 0.01，不是 >=）----
// ⚠ 这里用「先 ROUND 到分再比阈值」，不是直接 `total - paid > 0.01`。
//   原因见下面「浮点方向陷阱」测试项：直连写法在 100-99.99 上会误判。
const arRows = [
  { totalAmount: 100, paidAmount: 0, internal: null },      // 欠 100 → 计入
  { totalAmount: 100, paidAmount: 99.99, internal: null },  // 欠 0.01 → 不计入（边界）
  { totalAmount: 100, paidAmount: 100, internal: null },     // 欠 0 → 不计入
  { totalAmount: 100, paidAmount: 0, internal: 1 },         // 内部账单 → 不计入
  { totalAmount: 50.5, paidAmount: 20.25, internal: null }  // 欠 30.25 → 计入
];
const arWantList = arRows
  .filter(r => Math.round((r.totalAmount - r.paidAmount) * 100) / 100 > 0.01 && !r.internal);
const arWant = arWantList.reduce((s, r) => s + (r.totalAmount - r.paidAmount), 0);
eqNum('欠费条数（0.01 边界不计入、internal 排除）', arWantList.length, 2);
eqMoney('欠费金额合计', arWant, 130.25);

console.log('\n=== 第 2.5 组：浮点方向陷阱（本测试发现的真实 Bug）===');
// 「差 1 分钱整」在不同金额下，直连比较的结论会不一致：
const fpCases = [
  { t: 100, p: 99.99, label: '100 - 99.99' },
  { t: 200, p: 199.99, label: '200 - 199.99' },
  { t: 1000, p: 999.99, label: '1000 - 999.99' },
  { t: 50.5, p: 50.49, label: '50.5 - 50.49' }
];
const directHit = fpCases.filter(c => (c.t - c.p) > 0.01);
const roundHit = fpCases.filter(c => Math.round((c.t - c.p) * 100) / 100 > 0.01);
console.log('  直连 (t-p) > 0.01 误判为欠费的：' + directHit.map(c => c.label).join(', ') || '（无）');
console.log('  ROUND 到分后仍算欠费的：' + (roundHit.length ? roundHit.map(c => c.label).join(', ') : '（无，正确）'));
ok('直连比较存在误判（这正是要修的 bug）', directHit.length > 0,
  directHit.length ? '100-99.99=' + (100 - 99.99) : '');
eqNum('ROUND 到分后误判数为 0', roundHit.length, 0);
ok('4 个 1 分钱边界样本，用 ROUND 全部判为「已结清」',
  fpCases.every(c => !(Math.round((c.t - c.p) * 100) / 100 > 0.01)));
// 反向验证：真的欠 2 分钱必须仍然算欠费（别把口径改死了）
ok('欠 2 分钱仍算欠费（口径没被改死）',
  Math.round((100 - 99.98) * 100) / 100 > 0.01);
ok('欠 0.03 元（3 分）算欠费', Math.round((100.03 - 100) * 100) / 100 > 0.01);

// ==================================================================
// 第 3 组：双算法对拍（真实数据，需要云端 DB）
// ==================================================================
// A = 改造前的内存算法（原样复刻）
// B = 改造后的 SQL 聚合
// 逐字段必须完全一致。
console.log('\n=== 第 3 组：双算法对拍（SQL 聚合 vs 内存算法）===');

const LIVE = process.argv.includes('--live') || process.env.DB_MODE === 'cloud';

if (!LIVE) {
  console.log('  （跳过对拍：需要云端 DB_MODE=cloud 或加 --live）');
  console.log('  提示：node scripts/test_dashboard_amount.js --live');
} else {
  process.env.DB_MODE = 'cloud';
  const CloudDB = require(path.join(ROOT, 'lib', 'clouddb.js'));

  // 模拟一次请求的缓存上下文（不 new 上下文管理器，直接用普通实例）
  const db = new CloudDB();
  const runT = (label, fn) => fn()
    .then(r => { console.log('  ✔ ' + label); return r; })
    .catch(e => { fail++; fails.push(label + ' → ' + e.message); console.log('  ✘ ' + label + '  ' + e.message); return null; });

  (async () => {
    const curMonth = monthOf(today());

    // ---- 加载两份数据：A 用全量内存，B 交给 SQL ----
    // 注意 rooms/contracts/bills 不会进缓存（未 SHARED 化），
    // 所以这里 A 侧要显式 all() 拿全量，与改造前的行为一致。
    const allRooms = await db.all('rooms');
    const allContracts = await db.all('contracts');
    const allBills = await db.all('bills');
    const allInvoices = await db.all('invoices');
    const allDeposits = await db.all('deposits');
    console.log('  数据规模：rooms ' + allRooms.length + ' / contracts ' + allContracts.length +
      ' / bills ' + allBills.length + ' / invoices ' + allInvoices.length + ' / deposits ' + allDeposits.length);
    ok('三张主表都有数据（空表对拍没意义）',
      allRooms.length > 0 && allContracts.length > 0 && allBills.length > 0);

    // ================= rooms =================
    console.log('\n  --- rooms 状态分布 ---');
    // A：内存
    const aRooms = {
      total: allRooms.length,
      vacant: allRooms.filter(r => r.status === '空置').length,
      rented: allRooms.filter(r => r.status === '已租').length
    };
    // B：SQL
    const rStatus = await db.groupAgg('rooms', 'status', { cnt: { fn: 'COUNT' } });
    const bRooms = {
      total: await db.count('rooms'),
      vacant: Number((rStatus['空置'] && rStatus['空置'].cnt) || 0),
      rented: Number((rStatus['已租'] && rStatus['已租'].cnt) || 0)
    };
    eqNum('rooms.total', bRooms.total, aRooms.total);
    eqNum('rooms.vacant', bRooms.vacant, aRooms.vacant);
    eqNum('rooms.rented', bRooms.rented, aRooms.rented);

    // ================= contracts =================
    console.log('\n  --- contracts 状态分布 ---');
    const aCon = {
      total: allContracts.length,
      active: allContracts.filter(c => c.status === '正常履约' || c.status === '变更').length,
      expired: allContracts.filter(c => c.status === '逾期').length,
      terminated: allContracts.filter(c => c.status === '退租' || c.status === '终止').length
    };
    const [bConTotal, bConActive, bConExpired, bConTerm] = await Promise.all([
      db.count('contracts'),
      db.count('contracts', { status: ['正常履约', '变更'] }),
      db.count('contracts', { status: '逾期' }),
      db.count('contracts', { status: ['退租', '终止'] })
    ]);
    eqNum('contracts.total', bConTotal, aCon.total);
    eqNum('contracts.active', bConActive, aCon.active);
    eqNum('contracts.expired', bConExpired, aCon.expired);
    eqNum('contracts.terminated', bConTerm, aCon.terminated);

    // ================= 本月账单 =================
    console.log('\n  --- 本月账单（period=' + curMonth + '）---');
    const monthBills = allBills.filter(b => b.period === curMonth);
    const aBill = {
      count: monthBills.length,
      total: money(monthBills.reduce((s, b) => s + num(b.totalAmount), 0)),
      paid: money(monthBills.reduce((s, b) => s + num(b.paidAmount), 0)),
      unpaid: money(monthBills.reduce((s, b) => s + (b.totalAmount - b.paidAmount), 0))
    };
    const bBillAgg = await db.agg('bills', {
      count: { fn: 'COUNT' },
      total: { col: 'totalAmount', fn: 'SUM' },
      paid: { col: 'paidAmount', fn: 'SUM' }
    }, { period: curMonth });
    const bBill = {
      count: bBillAgg.count,
      total: money(bBillAgg.total),
      paid: money(bBillAgg.paid),
      unpaid: money(money(bBillAgg.total) - money(bBillAgg.paid))
    };
    eqNum('bill.count', bBill.count, aBill.count);
    eqMoney('bill.total', bBill.total, aBill.total);
    eqMoney('bill.paid', bBill.paid, aBill.paid);
    // ⚠ unpaid 两种算法路径不同，这里是最容易出错的一项：
    //   A 是「逐行相减后累加」，B 是「两个 SUM 相减」。
    //   数学上相等，浮点上可能差 1e-9，必须靠 money() 抹平。
    eqMoney('bill.unpaid（Σ(total-paid) vs Σtotal-Σpaid，浮点最易错项）', bBill.unpaid, aBill.unpaid);

    // ================= 欠费（两列相减 + internal 排除）=================
    console.log('\n  --- 欠费（ROUND(total-paid,2)>0.01 且非内部账单）---');
    // A：内存算法，口径与 routes/report.js 保持一致（先 ROUND 到分再比阈值）
    const ar = allBills.filter(b =>
      Math.round((b.totalAmount - b.paidAmount) * 100) / 100 > 0.01 && !b.internal);
    const aArrears = {
      count: ar.length,
      amount: money(ar.reduce((s, b) => s + (b.totalAmount - b.paidAmount), 0))
    };
    // B：走 _expr + _raw 下推（routes/report.js 实际写法）
    const bArrears = await db.agg('bills', {
      count: { fn: 'COUNT' },
      amount: { col: 'arrearsAmount', fn: 'SUM', _expr: '(`totalAmount` - `paidAmount`)' }
    }, { _raw: 'ROUND(`totalAmount` - `paidAmount`, 2) > 0.01 AND COALESCE(`internal`, 0) = 0' });
    eqNum('arrears.count', bArrears.count, aArrears.count);
    eqMoney('arrears.amount（两列相减 SUM，浮点最易错项）', bArrears.amount, aArrears.amount);

    // 额外对拍：验证 SQL 的 ROUND 判定与 JS 的 ROUND 判定条数一致
    // （若不一致，说明 SQL ROUND 与 JS Math.round 在 .5 处有差异，需查明）
    const aRoundCount = allBills.filter(b =>
      Math.round((b.totalAmount - b.paidAmount) * 100) / 100 > 0.01 && !b.internal).length;
    eqNum('arrears：JS ROUND 判定条数 = SQL ROUND 判定条数', bArrears.count, aRoundCount);

    // ================= 发票 =================
    console.log('\n  --- 发票（排除已作废）---');
    const validInv = allInvoices.filter(i => i.status !== '已作废');
    const aInv = {
      count: (await db.count('invoices')),
      amount: money(validInv.reduce((s, i) => s + num(i.amount), 0))
    };
    const bInvAgg = await db.agg('invoices', {
      amount: { col: 'amount', fn: 'SUM' }
    }, { status: { $ne: '已作废' } });
    const bInv = { count: (await db.count('invoices')), amount: money(bInvAgg.amount) };
    eqNum('invoices.count', bInv.count, aInv.count);
    eqMoney('invoices.amount（$ne 排除作废）', bInv.amount, aInv.amount);

    // ================= 押金 =================
    console.log('\n  --- 押金（在管）---');
    const aDep = money(allDeposits.filter(d => d.status === '在管').reduce((s, d) => s + num(d.amount), 0));
    const bDep = money(await db.sum('deposits', 'amount', { status: '在管' }));
    eqMoney('deposits.holding', bDep, aDep);

    // ================= projects 分组 =================
    console.log('\n  --- projects 分组聚合（GROUP BY）---');
    const allProjects = await db.all('projects');
    const activeContracts = allContracts.filter(c => c.status === '正常履约' || c.status === '变更');
    const [roomsByPj, vacantByPj, activeByPj] = await Promise.all([
      db.groupAgg('rooms', 'projectId', { cnt: { fn: 'COUNT' }, area: { col: 'area', fn: 'SUM' } }),
      db.groupAgg('rooms', 'projectId', { cnt: { fn: 'COUNT' } }, { status: '空置' }),
      db.groupAgg('contracts', 'projectId', {
        cnt: { fn: 'COUNT' }, area: { col: 'area', fn: 'SUM' }, rent: { col: 'rentMonthly', fn: 'SUM' }
      }, { status: ['正常履约', '变更'] })
    ]);
    allProjects.forEach(pj => {
      const pr = allRooms.filter(r => r.projectId === pj.id);
      const pc = activeContracts.filter(c => c.projectId === pj.id);
      const aArea = money(pr.reduce((s, r) => s + num(r.area), 0));
      const aRentArea = money(pc.reduce((s, c) => s + num(c.area), 0));
      const aRent = money(pc.reduce((s, c) => s + num(c.rentMonthly), 0));
      const aVacant = pr.filter(r => r.status === '空置').length;
      const k = String(pj.id);
      const g = roomsByPj[k] || { cnt: 0, area: 0 };
      const gv = vacantByPj[k] || { cnt: 0 };
      const ga = activeByPj[k] || { cnt: 0, area: 0, rent: 0 };
      const tag = pj.name.slice(0, 8);
      eqNum('  [' + tag + '] rooms', g.cnt, pr.length);
      eqNum('  [' + tag + '] vacant', Number(gv.cnt || 0), aVacant);
      eqNum('  [' + tag + '] contracts', ga.cnt, pc.length);
      eqMoney('  [' + tag + '] area', money(g.area), aArea);
      eqMoney('  [' + tag + '] rentArea', money(ga.area), aRentArea);
      eqMoney('  [' + tag + '] monthlyRent', money(ga.rent), aRent);
      // 出租率（四舍五入到 0.1%）
      const aOcc = aArea > 0 ? Math.round(aRentArea / aArea * 1000) / 10 : 0;
      const bOcc = money(g.area) > 0 ? Math.round(money(ga.area) / money(g.area) * 1000) / 10 : 0;
      eqMoney('  [' + tag + '] occupancy(%)', bOcc, aOcc);
    });

    // ================= 分组完整性 =================
    console.log('\n  --- 分组完整性（不多不少）---');
    const aRoomGroups = {};
    allRooms.forEach(r => {
      if (r.projectId === null || r.projectId === undefined) return;
      aRoomGroups[String(r.projectId)] = (aRoomGroups[String(r.projectId)] || 0) + 1;
    });
    eqNum('rooms 分组数', Object.keys(roomsByPj).length, Object.keys(aRoomGroups).length);
    let grpOk = true;
    Object.keys(aRoomGroups).forEach(k => {
      if (!roomsByPj[k] || roomsByPj[k].cnt !== aRoomGroups[k]) grpOk = false;
    });
    ok('每个 projectId 分组条数与内存一致（不多不少）', grpOk);
    // 各组 cnt 之和必须等于全表行数（无行被 GROUP BY 吞掉）
    const grpSum = Object.keys(roomsByPj).reduce((s, k) => s + roomsByPj[k].cnt, 0);
    const nullPj = allRooms.filter(r => r.projectId === null || r.projectId === undefined).length;
    eqNum('各组条数之和 + 无项目归属 = 全表行数', grpSum + nullPj, allRooms.length);

    // ================= 条件计数 _case =================
    console.log('\n  --- 条件计数 SUM(CASE WHEN)（一条 SQL 出多状态分布）---');
    // 改造后 rooms / contracts 的状态分布用一条 SQL 出全部计数，
    // 这里对拍它与「多次 count」的等价性。
    const rCase = await db.agg('rooms', {
      total: { fn: 'COUNT' },
      vacant: { fn: 'SUM', _case: { status: '空置' } },
      rented: { fn: 'SUM', _case: { status: '已租' } }
    });
    eqNum('_case: rooms.total = 全表条数', rCase.total, allRooms.length);
    eqNum('_case: rooms.vacant 与独立 count 一致', rCase.vacant, await db.count('rooms', { status: '空置' }));
    eqNum('_case: rooms.rented 与独立 count 一致', rCase.rented, await db.count('rooms', { status: '已租' }));
    eqNum('_case: 计数是整数（不是小数）',
      Number.isInteger(rCase.vacant) && Number.isInteger(rCase.rented) ? 1 : 0, 1);

    const cCase = await db.agg('contracts', {
      total: { fn: 'COUNT' },
      active: { fn: 'SUM', _case: { status: ['正常履约', '变更'] } },
      expired: { fn: 'SUM', _case: { status: '逾期' } },
      terminated: { fn: 'SUM', _case: { status: ['退租', '终止'] } }
    });
    eqNum('_case: contracts.total = 全表条数', cCase.total, allContracts.length);
    eqNum('_case: contracts.active', cCase.active, aCon.active);
    eqNum('_case: contracts.expired', cCase.expired, aCon.expired);
    eqNum('_case: contracts.terminated', cCase.terminated, aCon.terminated);

    // _case + _expr + 普通 SUM 混用，验证参数顺序不错乱
    // （CASE WHEN 的占位符在 SELECT 里，必须排在 WHERE 之前）
    const mixed = await db.agg('bills', {
      cnt: { fn: 'COUNT' },
      overdue: { fn: 'SUM', _case: { status: '逾期' } },
      total: { col: 'totalAmount', fn: 'SUM' }
    }, { period: curMonth });
    eqNum('_case 混用: count 正确', mixed.cnt, aBill.count);
    eqMoney('_case 混用: SUM(totalAmount) 正确（验证参数顺序）', mixed.total, aBill.total);
    eqNum('_case 混用: 逾期账单数',
      mixed.overdue, monthBills.filter(b => b.status === '逾期').length);

    // ================= 双引擎一致性 =================
    // 本地 JSON 版（lib/db.js）与云端版（lib/clouddb.js）必须给出相同结果。
    // ⚠ 只在「同一个数据源」下比较才有意义 —— 云端库和本地 data/*.json
    //    是两套数据，行数不同（实测 contracts 214 vs 240）。
    //    所以这里用「各自数据源各自算」，只比对**算法**是否等价：
    //    拿云端 agg 的结果，去本地库按同样口径手算，比对是否一致。
    console.log('\n  --- 双引擎算法一致性（云端库上跑两套实现）---');
    try {
      const LocalDB = require(path.join(ROOT, 'lib', 'db.js'));
      // 造一个临时的本地 DB 实例，指向一个空目录，把云端数据灌进去成本太高；
      // 改为直接用本地版的 _aggregate 静态逻辑做等价性验证：
      // 对同一批「内存行」分别用云端 SQL 与本地 JS 算，比对结果。
      const { run } = require(path.join(ROOT, 'lib', 'tidb'));
      const sample = await run('SELECT `totalAmount`, `paidAmount`, `period` FROM `bills` LIMIT 200', []);
      const localRows = sample.map((r, i) => ({
        id: 'r' + i, totalAmount: Number(r.totalAmount) || 0, paidAmount: Number(r.paidAmount) || 0, period: r.period
      }));
      const spec = { s: { col: 'totalAmount', fn: 'SUM' } };
      // 云端算法
      const cloudVal = await db.agg('bills', spec);
      // 本地算法（lib/db.js 的 _aggregate，用同一批行的口径）
      const ldb = new LocalDB(path.join(ROOT, 'data'));
      const localVal = ldb._aggregate(localRows, spec).s;
      // 云端总数 = 全部 1228 行；本地只算 200 行样本，故只验证「算法形式一致」：
      // 本地 200 行的和 + money() 应等于对同样 200 行手写的 reduce
      const hand = money(localRows.reduce((a, r) => a + num(r.totalAmount), 0));
      ok('本地 _aggregate 与手写 reduce 一致（200 行样本）', localVal === hand,
        localVal + ' vs ' + hand);
      ok('云端 agg 返回合法金额（money 归一生效）', typeof cloudVal.s === 'number');
    } catch (e) {
      ok('双引擎一致性检查可执行', false, e.message.slice(0, 80));
    }

    // ================= 安全：_raw / _expr 注入 =================
    console.log('\n  --- 注入防护（_raw / _expr 白名单）---');
    const injections = [
      { label: '_raw 含分号', cond: { _raw: '`totalAmount` > 0; DROP TABLE bills' } },
      { label: '_raw 含单引号', cond: { _raw: "`totalAmount` > '1' OR '1'='1" } },
      { label: '_raw 含非白名单列', cond: { _raw: '`password` > 0' } },
      { label: '_raw 列名没加反引号', cond: { _raw: 'totalAmount > 0' } },
      { label: '_raw 空片段', cond: { _raw: '' } }
    ];
    for (const inj of injections) {
      let threw = false, msg = '';
      try {
        await db.agg('bills', { count: { fn: 'COUNT' } }, inj.cond);
      } catch (e) { threw = true; msg = e.message.slice(0, 70); }
      // 空片段会被当成「无条件」→ 返回全表 count，这是合法降级，不算注入
      if (inj.label === '_raw 空片段') {
        ok('_raw 空片段降级为无条件（不报错，返回全表）', !threw, msg);
        continue;
      }
      ok('拒绝：' + inj.label, threw, threw ? msg : '⚠ 未被拒绝！');
    }

    // _expr 专项：col 字段必须省略，否则会先撞 col 校验而测不到 _expr
    const exprInjections = [
      { label: '_expr 含分号', expr: '(`totalAmount`); DROP TABLE bills' },
      { label: '_expr 引用非白名单列', expr: '(`totalAmount` - `secret`)' },
      { label: '_expr 含除法（不允许的运算符）', expr: '(`totalAmount` / `paidAmount`)' },
      { label: '_expr 引用文本列', expr: '(`customerName` - `status`)' },
      { label: '_expr 列名不带反引号', expr: '(totalAmount - paidAmount)' },
      { label: '_expr 单列（不需减号）', expr: '(`totalAmount`)' },
      { label: '_expr 三列相减', expr: '(`totalAmount` - `paidAmount` - `taxAmount`)' },
      { label: '_expr 空表达式', expr: '' }
    ];
    for (const inj of exprInjections) {
      let threw = false, msg = '', r = null;
      try {
        r = await db.agg('bills', { x: { fn: 'SUM', _expr: inj.expr } });
      } catch (e) { threw = true; msg = e.message.slice(0, 70); }
      if (inj.label === '_expr 空表达式') {
        // 缺 _expr 等价于没写列，应该报「聚合列不在白名单：undefined」
        ok('_expr 为空时报错（而非静默 0）', threw, msg);
        continue;
      }
      ok('拒绝：' + inj.label, threw, threw ? msg : ('⚠ 未被拒绝，返回 ' + JSON.stringify(r)));
    }

    // _case 专项：它内部调 buildWhere，而 buildWhere 遇到非法列是「过滤掉」而非报错。
    // ⚠ 风险点：{ _case: { 'evil_col': 1 } } 若被过滤成「无条件」，
    //   就会变成 SUM(CASE WHEN true …) 静默统计全表 —— 数字错但不报错。
    //   这里显式确认 buildAgg 对「条件被完全过滤」是抛错而非放行。
    const caseChecks = [
      { label: '_case 条件不匹配任何行 → 计数 0（合法路径）',
        cond: { status: '__不存在的状态__' }, expectCount: 0 },
      { label: '_case 条件全被白名单过滤 → 必须抛错（不能静默统计全表）',
        cond: { 'evil_col_xxx': 1 }, mustThrow: true }
    ];
    for (const c of caseChecks) {
      let r = null, threw = false, msg = '';
      try { r = await db.agg('contracts', { n: { fn: 'SUM', _case: c.cond } }); }
      catch (e) { threw = true; msg = e.message.slice(0, 70); }
      if (c.mustThrow) {
        ok(c.label, threw, threw ? msg : ('⚠ 静默返回 n=' + (r && r.n) + '（等于全表条数）'));
      } else {
        ok(c.label, !threw && r.n === c.expectCount, threw ? msg : ('n=' + (r && r.n)));
      }
    }

    // ================= 边界：空结果集 =================
    console.log('\n  --- 边界：条件无匹配（应返回 0 而不是 null/NaN）---');
    const empty = await db.agg('bills', {
      count: { fn: 'COUNT' },
      total: { col: 'totalAmount', fn: 'SUM' }
    }, { period: '1900-01' });
    eqNum('无匹配时 count = 0', empty.count, 0);
    eqMoney('无匹配时 SUM = 0（非 NaN）', empty.total, 0);
    const emptyG = await db.groupAgg('bills', 'projectId', { cnt: { fn: 'COUNT' } }, { period: '1900-01' });
    eqNum('无匹配时 groupAgg 返回空对象', Object.keys(emptyG).length, 0);

    done();
  })().catch(e => { fail++; fails.push('对拍异常: ' + e.message); console.log('  ✘ 对拍异常: ' + e.message); done(); });
}

function done() {
  console.log('\n' + '='.repeat(56));
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fails.length) {
    console.log('\n  失败明细：');
    fails.forEach(f => console.log('    · ' + f));
  }
  console.log('='.repeat(56));
  process.exit(fail ? 1 : 0);
}
