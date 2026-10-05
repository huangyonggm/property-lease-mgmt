'use strict';
/**
 * 人事 / 考勤 / 薪资 核心算法
 *   - 考勤排班与月度汇总
 *   - 请假、加班核算（调休 / 加班费）
 *   - 社保公积金（单位 / 个人分项计算）
 *   - 个人所得税（2019 起「累计预扣预缴法」）
 *   - 工资表生成与发放
 */
const { num, money, pad, today, now, monthOf, addDays, addMonths, daysInMonth, diffDays } = require('./util');

/* ===================== 常量 ===================== */

// 月计薪天数（人社部规定）
const WORK_DAYS_PER_MONTH = 21.75;

// 个税「工资薪金所得」预扣预缴率表（累计预扣法）
const TAX_TABLE = [
  [36000, 0.03, 0],
  [144000, 0.10, 2520],
  [300000, 0.20, 16920],
  [420000, 0.25, 31920],
  [660000, 0.30, 52920],
  [960000, 0.35, 85920],
  [Infinity, 0.45, 181920]
];

// 加班费倍率
const OT_RATE = { '工作日': 1.5, '休息日': 2, '法定节假日': 3 };

// 请假类型 → 计薪比例（1=全薪，0=无薪）
const LEAVE_PAID = {
  '年假': 1, '调休': 1, '婚假': 1, '丧假': 1, '产假': 1, '陪产假': 1, '工伤假': 1, '出差': 1, '外勤': 1,
  '病假': 0.8, '事假': 0
};

// 默认社保公积金政策（武汉市口径，可在界面调整）
const DEFAULT_INSURANCE = {
  city: '武汉市',
  socialMin: 4492, socialMax: 22458,
  fundMin: 2010, fundMax: 29872,
  items: [
    { name: '养老', unitRate: 0.16, personalRate: 0.08 },
    { name: '医疗', unitRate: 0.08, personalRate: 0.02 },
    { name: '失业', unitRate: 0.007, personalRate: 0.003 },
    { name: '工伤', unitRate: 0.004, personalRate: 0 },
    { name: '生育', unitRate: 0.007, personalRate: 0 }
  ],
  fundRate: 0.08,
  remark: '可在「人事管理 → 社保规则」中按年度政策调整'
};

/* ===================== 基础工具 ===================== */

function clampBase(base, min, max) {
  return Math.min(max, Math.max(min, base));
}

// 是否工作日（0=周日 … 6=周六）
function isWeekend(dateStr) {
  const d = new Date(dateStr);
  const w = d.getDay();
  return w === 0 || w === 6;
}

function monthRange(month) {
  return { first: month + '-01', last: month + '-' + pad(daysInMonth(month)) };
}

/* ===================== 社保 / 公积金 ===================== */

async function insurancePolicy (db) {
  const st = (await db.one('settings', s => s.key === 'insurance'));
  const cfg = (st && st.value) ? st.value : (st || {});
  return Object.assign({}, DEFAULT_INSURANCE, {
    city: cfg.city || DEFAULT_INSURANCE.city,
    socialMin: num(cfg.socialMin, DEFAULT_INSURANCE.socialMin),
    socialMax: num(cfg.socialMax, DEFAULT_INSURANCE.socialMax),
    fundMin: num(cfg.fundMin, DEFAULT_INSURANCE.fundMin),
    fundMax: num(cfg.fundMax, DEFAULT_INSURANCE.fundMax),
    fundRate: num(cfg.fundRate, DEFAULT_INSURANCE.fundRate),
    items: Array.isArray(cfg.items) && cfg.items.length ? cfg.items : DEFAULT_INSURANCE.items
  });
}

/**
 * 计算社保公积金
 * @returns {personal, unit, fundPersonal, fundUnit, details, socialBase, fundBase}
 */
function calcInsurance(emp, policy) {
  const p = policy || DEFAULT_INSURANCE;
  // 缴费基数：优先取员工档案，其次取基本+岗位工资
  const salaryBase = num(emp.baseSalary) + num(emp.postSalary);
  const rawSocial = num(emp.socialBase) || salaryBase || 0;
  const rawFund = num(emp.fundBase) || salaryBase || 0;
  const socialBase = emp.insureEnabled === false ? 0 : clampBase(rawSocial, p.socialMin, p.socialMax);
  const fundBase = emp.fundEnabled === false ? 0 : clampBase(rawFund, p.fundMin, p.fundMax);

  const details = [];
  let personal = 0, unit = 0;
  (p.items || []).forEach(it => {
    const per = money(socialBase * num(it.personalRate));
    const uni = money(socialBase * num(it.unitRate));
    personal += per; unit += uni;
    details.push({ name: it.name, base: socialBase, personalRate: it.personalRate, unitRate: it.unitRate, personal: per, unit: uni });
  });
  const rate = num(emp.fundRate) || p.fundRate;
  const fundPersonal = money(fundBase * rate);
  const fundUnit = money(fundBase * rate);
  return {
    socialBase: socialBase, fundBase: fundBase, fundRate: rate,
    details: details, fundPersonal: fundPersonal, fundUnit: fundUnit,
    personal: money(personal + fundPersonal),
    unit: money(unit + fundUnit),
    personalSocial: money(personal),
    unitSocial: money(unit)
  };
}

/* ===================== 个人所得税（累计预扣预缴法） ===================== */

function taxOf(accumTaxable) {
  if (accumTaxable <= 0) return { tax: 0, rate: 0, quick: 0 };
  for (const [cap, rate, quick] of TAX_TABLE) {
    if (accumTaxable <= cap) {
      return { tax: money(accumTaxable * rate - quick), rate: rate, quick: quick };
    }
  }
  return { tax: 0, rate: 0, quick: 0 };
}

/**
 * @param thisIncome      本月应发（税前、扣社保前口径即「收入额」）
 * @param thisInsurance   本月个人承担的社保 + 公积金
 * @param specialDeduct   本月专项附加扣除
 * @param months          本年累计到第几个月（含本月）
 * @param opening         年初至起算前累计 { income, insurance, special, taxPaid }
 * @returns { tax, accumIncome, accumDeduction, accumTaxable, taxable }
 */
function calcTax(thisIncome, thisInsurance, specialDeduct, months, opening) {
  const op = opening || { income: 0, insurance: 0, special: 0, taxPaid: 0 };
  const monthsCount = Math.max(1, num(months, 1));
  const accumIncome = money(num(op.income) + thisIncome);
  const accumInsurance = money(num(op.insurance) + thisInsurance);
  const accumSpecial = money(num(op.special) + specialDeduct);
  const basicDeduct = 5000 * monthsCount;
  const accumTaxable = Math.max(0, money(accumIncome - accumInsurance - accumSpecial - basicDeduct));
  const whole = taxOf(accumTaxable);
  const tax = Math.max(0, money(whole.tax - num(op.taxPaid)));
  return {
    tax: tax, rate: whole.rate, quick: whole.quick,
    accumIncome: accumIncome, accumInsurance: accumInsurance, accumSpecial: accumSpecial,
    basicDeduct: basicDeduct, accumTaxable: accumTaxable,
    taxable: Math.max(0, money(thisIncome - thisInsurance - specialDeduct - 5000))
  };
}

/* ===================== 考勤 ===================== */

/**
 * 汇总某员工某月考勤
 */
async function summarizeAttendance (db, empId, month, preRecs) {
  const range = monthRange(month);
  // 用「对象条件」而非函数条件：employeeId/month 是变量，函数条件无法下推 SQL，
  // 云端会退化成整表拉取 attendance（3.6MB）。对象等值条件会下推成 WHERE employeeId=? AND month=?，
  // 只回该员工该月的几条记录。语义与 a.employeeId===empId && a.month===month 完全一致。
  // preRecs：调用方（如 attendanceOverview）已按月一次性载入时，直接传入该员工的记录，
  // 避免「逐员工各查一次」的 N+1（实测 HR 驾驶舱因此从 1 条 SQL 膨胀到 59 条）。
  const recs = (preRecs ? preRecs.slice() : await db.where('attendance', { employeeId: empId, month: month }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const s = {
    employeeId: empId, month: month,
    shouldDays: 0, realDays: 0, lateCount: 0, earlyCount: 0, lateMin: 0, earlyMin: 0,
    absentDays: 0, leaveDays: 0, businessTripDays: 0, restDays: 0,
    otHoursWorkday: 0, otHoursWeekend: 0, otHoursHoliday: 0, otHours: 0,
    nightCount: 0, missingCard: 0, detail: {}
  };
  const leaveBy = {};

  recs.forEach(r => {
    if (r.status === '休息') { s.restDays += num(r.workHours); return; }
    s.shouldDays += 1;
    const st = r.status || '';
    if (st === '正常' || st === '迟到' || st === '早退' || st === '迟到且早退' || st === '缺卡') {
      s.realDays += 1;
      if (st.indexOf('迟到') >= 0) { s.lateCount += 1; s.lateMin += num(r.lateMin); }
      if (st.indexOf('早退') >= 0) { s.earlyCount += 1; s.earlyMin += num(r.earlyMin); }
      if (st === '缺卡') s.missingCard += 1;
    } else if (st === '旷工') {
      s.absentDays += 1;
    } else if (st === '出差' || st === '外勤') {
      s.businessTripDays += 1;
    } else if (st === '请假') {
      s.leaveDays += 1;
      if (r.leaveType) leaveBy[r.leaveType] = num(leaveBy[r.leaveType]) + num(r.workHours, 1);
    }
    const oh = num(r.otHours);
    if (oh > 0) {
      const t = r.otType || '工作日';
      if (t === '休息日') s.otHoursWeekend += oh;
      else if (t === '法定节假日') s.otHoursHoliday += oh;
      else s.otHoursWorkday += oh;
      s.otHours += oh;
    }
    if (r.nightDuty) s.nightCount += 1;
  });

  s.detail = leaveBy;
  // 计薪口径请假天数（全薪的不扣）
  s.unpaidLeaveDays = Object.keys(leaveBy).reduce((acc, k) => {
    const ratio = LEAVE_PAID[k] === undefined ? 1 : LEAVE_PAID[k];
    return acc + money(num(leaveBy[k]) * (1 - ratio));
  }, 0);
  s.sickLeaveDays = num(leaveBy['病假']);
  s.paidLeaveDays = money(s.leaveDays - s.unpaidLeaveDays);
  return s;
}

/**
 * 加班费：以「基本工资 + 岗位工资」为基数折算小时工资
 */
function calcOvertimePay(emp, summary) {
  const base = num(emp.baseSalary) + num(emp.postSalary);
  if (base <= 0) return { total: 0, items: [] };
  const hourRate = base / WORK_DAYS_PER_MONTH / 8;
  const items = [];
  let total = 0;
  [['工作日', summary.otHoursWorkday, OT_RATE['工作日']],
   ['休息日', summary.otHoursWeekend, OT_RATE['休息日']],
   ['法定节假日', summary.otHoursHoliday, OT_RATE['法定节假日']]].forEach(([t, h, r]) => {
    if (num(h) > 0) {
      const amt = money(hourRate * num(h) * r);
      total += amt;
      items.push({ type: t, hours: h, rate: r, hourRate: money(hourRate), amount: amt });
    }
  });
  return { total: money(total), items: items, hourRate: money(hourRate) };
}

/* ===================== 工资表 ===================== */

/**
 * 员工本年已存在的工资表（用于累计个税）
 */
async function yearPayrolls (db, empId, year) {
  return (await db.where('payrolls', p => p.employeeId === empId && String(p.month || '').indexOf(year + '-') === 0))
    .sort((a, b) => String(a.month).localeCompare(String(b.month)));
}

function openingOf(emp) {
  return {
    income: num(emp.openingIncome), insurance: num(emp.openingInsurance),
    special: num(emp.openingSpecial), taxPaid: num(emp.openingTax)
  };
}

/**
 * 构建单个员工的工资表明细（纯计算，不落库）
 */
async function buildPayroll (db, emp, month, opt) {
  opt = opt || {};
  const policy = await insurancePolicy(db);
  const ins = calcInsurance(emp, policy);
  const sum = opt.summary || await summarizeAttendance(db, emp.id, month);
  const ot = calcOvertimePay(emp, sum);

  const items = [];
  const daySalary = (num(emp.baseSalary) + num(emp.postSalary)) / WORK_DAYS_PER_MONTH;

  /* ----- 收入项 ----- */
  items.push({ key: 'base', name: '基本工资', type: 'add', amount: money(emp.baseSalary) });
  if (num(emp.postSalary)) items.push({ key: 'post', name: '岗位工资', type: 'add', amount: money(emp.postSalary) });
  if (num(emp.perfSalary)) {
    const perfRate = num(emp.perfRate, 1);
    items.push({ key: 'perf', name: '绩效工资', type: 'add', amount: money(num(emp.perfSalary) * perfRate) });
  }
  ['allowanceTraffic:交通补贴', 'allowanceMeal:餐费补贴', 'allowancePhone:通讯补贴', 'allowanceOther:其他补贴']
    .forEach(p => {
      const [k, n] = p.split(':');
      if (num(emp[k])) items.push({ key: k, name: n, type: 'add', amount: money(emp[k]) });
    });
  if (sum.nightCount > 0 && num(emp.allowanceNight)) {
    items.push({ key: 'night', name: '夜班补贴', type: 'add', amount: money(sum.nightCount * num(emp.allowanceNight)) });
  }
  if (ot.total > 0) items.push({ key: 'ot', name: '加班费', type: 'add', amount: ot.total });
  if (num(emp.attendanceBonus) && sum.lateCount === 0 && sum.earlyCount === 0 && sum.absentDays === 0 && sum.unpaidLeaveDays === 0) {
    items.push({ key: 'fullatt', name: '全勤奖', type: 'add', amount: money(emp.attendanceBonus) });
  }
  if (opt.bonus) items.push({ key: 'bonus', name: opt.bonusName || '奖金', type: 'add', amount: money(opt.bonus) });

  /* ----- 扣款项（税前） ----- */
  if (sum.unpaidLeaveDays > 0) {
    items.push({ key: 'leaveCut', name: '事假扣款', type: 'sub', amount: money(daySalary * sum.unpaidLeaveDays) });
  }
  if (sum.sickLeaveDays > 0) {
    items.push({ key: 'sickCut', name: '病假扣款（按 80% 计薪）', type: 'sub', amount: money(daySalary * sum.sickLeaveDays * 0.2) });
  }
  if (sum.absentDays > 0) {
    items.push({ key: 'absentCut', name: '旷工扣款', type: 'sub', amount: money(daySalary * sum.absentDays * 2) });
  }
  const lateFine = num(emp.lateFine, 20);
  if ((sum.lateCount + sum.earlyCount) > 0 && lateFine > 0) {
    items.push({ key: 'lateCut', name: '迟到早退扣款', type: 'sub', amount: money((sum.lateCount + sum.earlyCount) * lateFine) });
  }

  const addTotal = items.filter(i => i.type === 'add').reduce((a, i) => a + i.amount, 0);
  const subTotal = items.filter(i => i.type === 'sub').reduce((a, i) => a + i.amount, 0);
  const gross = money(addTotal - subTotal);

  /* ----- 累计个税 ----- */
  const year = String(month).split('-')[0];
  const monthNo = Number(String(month).split('-')[1] || 1);
  const opening = openingOf(emp);
  const prevList = ((await db.where('payrolls', p => p.employeeId === emp.id && String(p.month || '').indexOf(year + '-') === 0 && String(p.month) < month)));
  if (prevList.length) {
    prevList.forEach(p => {
      opening.income += num(p.grossPay);
      opening.insurance += num(p.insurancePersonal);
      opening.special += num(p.specialDeduction);
    });
  }
  const specialDeduct = num(emp.specialDeduction);
  const specialAccumMonths = monthNo;
  const tx = calcTax(gross, ins.personal, specialDeduct, specialAccumMonths, opening);
  const tax = tx.tax;

  const netPay = money(gross - ins.personal - tax - (opt.otherCut || 0));
  if (opt.otherCut) items.push({ key: 'other', name: opt.otherCutName || '其他扣款', type: 'sub', amount: money(opt.otherCut) });

  return {
    month: month, employeeId: emp.id, employeeNo: emp.no || '', employeeName: emp.name,
    deptId: emp.deptId, deptName: emp.deptName || '', postName: emp.postName || '',
    items: items, addTotal: money(addTotal), subTotal: money(subTotal),
    grossPay: gross, netPay: netPay,
    insurancePersonal: ins.personal, insuranceUnit: ins.unit,
    socialPersonal: ins.personalSocial, fundPersonal: ins.fundPersonal,
    socialBase: ins.socialBase, fundBase: ins.fundBase,
    insuranceDetail: ins.details,
    specialDeduction: specialDeduct,
    tax: tax, taxRate: tx.rate,
    accumIncome: tx.accumIncome, accumInsurance: tx.accumInsurance,
    accumSpecial: tx.accumSpecial, accumTaxable: tx.accumTaxable, basicDeduct: tx.basicDeduct,
    overtime: ot,
    attendance: {
      shouldDays: sum.shouldDays, realDays: sum.realDays, lateCount: sum.lateCount, earlyCount: sum.earlyCount,
      lateMin: sum.lateMin, earlyMin: sum.earlyMin, absentDays: sum.absentDays,
      leaveDays: sum.leaveDays, unpaidLeaveDays: sum.unpaidLeaveDays, businessTripDays: sum.businessTripDays,
      otHours: sum.otHours, otHoursWorkday: sum.otHoursWorkday, otHoursWeekend: sum.otHoursWeekend, otHoursHoliday: sum.otHoursHoliday,
      nightCount: sum.nightCount, detail: sum.detail
    },
    status: opt.status || '草稿'
  };
}

/**
 * 月度薪酬汇总
 */
async function payrollSummary (db, month) {
  const list = (await db.where('payrolls', { month: month }));
  const empCount = list.length;
  const gross = money(list.reduce((a, p) => a + num(p.grossPay), 0));
  const net = money(list.reduce((a, p) => a + num(p.netPay), 0));
  const tax = money(list.reduce((a, p) => a + num(p.tax), 0));
  const insP = money(list.reduce((a, p) => a + num(p.insurancePersonal), 0));
  const insU = money(list.reduce((a, p) => a + num(p.insuranceUnit), 0));
  const ot = money(list.reduce((a, p) => a + num(p.overtime && p.overtime.total), 0));
  const byDept = {};
  list.forEach(p => {
    const k = p.deptName || '未分配';
    if (!byDept[k]) byDept[k] = { deptName: k, count: 0, gross: 0, net: 0, tax: 0, insurance: 0 };
    byDept[k].count += 1;
    byDept[k].gross += num(p.grossPay); byDept[k].net += num(p.netPay);
    byDept[k].tax += num(p.tax); byDept[k].insurance += num(p.insurancePersonal);
  });
  Object.keys(byDept).forEach(k => {
    const d = byDept[k];
    d.gross = money(d.gross); d.net = money(d.net); d.tax = money(d.tax); d.insurance = money(d.insurance);
    d.avg = d.count ? money(d.gross / d.count) : 0;
  });
  const paid = list.filter(p => p.status === '已发放');
  return {
    month: month, empCount: empCount, gross: gross, net: net, tax: tax,
    insurancePersonal: insP, insuranceUnit: insU, overtime: ot,
    paidCount: paid.length, unpaidCount: empCount - paid.length,
    avg: empCount ? money(gross / empCount) : 0,
    byDept: Object.values(byDept)
  };
}

/**
 * 对一组「未落库的试算结果」做汇总
 */
function payrollSummaryOfList(list) {
  const empCount = list.length;
  const gross = money(list.reduce((a, p) => a + num(p.grossPay), 0));
  const net = money(list.reduce((a, p) => a + num(p.netPay), 0));
  const tax = money(list.reduce((a, p) => a + num(p.tax), 0));
  const insurance = money(list.reduce((a, p) => a + num(p.insurancePersonal), 0));
  const unitInsurance = money(list.reduce((a, p) => a + num(p.insuranceUnit), 0));
  const ot = money(list.reduce((a, p) => a + num(p.overtime && p.overtime.total), 0));
  return {
    month: list.length ? list[0].month : '', empCount: empCount,
    gross: gross, net: net, tax: tax, insurancePersonal: insurance,
    insuranceUnit: unitInsurance, overtime: ot,
    cost: money(gross + unitInsurance),
    avg: empCount ? money(gross / empCount) : 0
  };
}

/**
 * 部门人力成本（含单位社保公积金）
 */
async function laborCost (db, month) {
  const list = (await db.where('payrolls', { month: month }));
  const total = {
    gross: money(list.reduce((a, p) => a + num(p.grossPay), 0)),
    unitInsurance: money(list.reduce((a, p) => a + num(p.insuranceUnit), 0)),
    net: money(list.reduce((a, p) => a + num(p.netPay), 0))
  };
  total.cost = money(total.gross + total.unitInsurance);
  return total;
}

/**
 * 考勤概览（某月全员）
 */
async function attendanceOverview (db, month, opt) {
  opt = opt || {};
  // month 是变量，函数条件下推不了 → 云端会整表拉 attendance（3.6MB）。
  // 改对象等值条件后下推成 WHERE month=?，只回本月记录（几十~几百条）。
  let recs = (await db.where('attendance', { month: month }));
  if (opt.deptId) recs = recs.filter(a => a.deptId === opt.deptId);
  const empMap = {};
  recs.forEach(r => {
    if (!empMap[r.employeeId]) empMap[r.employeeId] = { employeeId: r.employeeId, employeeName: r.employeeName, deptName: r.deptName, rows: [] };
    empMap[r.employeeId].rows.push(r);
  });
  // .map() 回调里要 await summarizeAttendance —— map 的回调是同步函数，
  // 必须用 Promise.all 包住，否则拿到的全是 Promise，考勤汇总表会是空的。
  const list = await Promise.all(Object.values(empMap).map(async v => {
    // 传入已按月一次性载入的该员工记录（v.rows），避免逐员工再各查一次 attendance（N+1）。
    const s = await summarizeAttendance(db, v.employeeId, month, v.rows);
    return Object.assign({ employeeName: v.employeeName, deptName: v.deptName }, s);
  }));
  return {
    month: month, records: recs.length, employees: list.length,
    lateCount: list.reduce((a, x) => a + x.lateCount, 0),
    absentDays: money(list.reduce((a, x) => a + x.absentDays, 0)),
    leaveDays: money(list.reduce((a, x) => a + x.leaveDays, 0)),
    otHours: money(list.reduce((a, x) => a + x.otHours, 0)),
    list: list
  };
}

module.exports = {
  WORK_DAYS_PER_MONTH, TAX_TABLE, OT_RATE, LEAVE_PAID, DEFAULT_INSURANCE,
  insurancePolicy, calcInsurance, calcTax, taxOf,
  summarizeAttendance, calcOvertimePay, buildPayroll, payrollSummary, payrollSummaryOfList,
  laborCost, attendanceOverview, yearPayrolls, monthRange, isWeekend, clampBase
};
