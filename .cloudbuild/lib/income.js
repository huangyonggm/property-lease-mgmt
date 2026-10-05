'use strict';
/**
 * 收入科目体系 + 租金递增引擎
 *
 * 依据该公司真实在用的报表：
 *   Y:\物业实际使用的报表及合同\2026年8月收入日报统计表(1).xlsx
 *     表头固定 12 列 + 日汇总：
 *     定金 | 新签租金物业 | 续费租金物业 | 照明电费 | 空调电费 | 月租停车费
 *     | 临时停车 | 套内保洁 | 保洁部卖废品 | 会议室 | 其他 | 日汇总
 *   月表格\（表1）房租.xlsx  → 房租 / 管理费公维金 / 税金
 *   月表格\（表2）电费、空调费.xlsx → 照明电费与空调电费分开核算，且有「预存」概念
 *   月表格\（表3）停车费明细.xlsx → 月租车 与 临时停车费 分开
 *   月表格\（表9）其他费用.xlsx → 中介费 / 会议室 / 垫付 / 其他
 *   月表格\（表10）上期尾款.xlsx → 上期尾款单独核算
 *
 * 合同模板中的递增约定（表2「入驻公司」表实测）：
 *   「不递增」/「每2年10％」/「第三年起每年递增6%」/ 空
 * 统一用下面的规则对象表达，兼容全部四种。
 */
const { num, money } = require('./util');

// ============ 收入科目（与真实收入日报 12 列一一对应） ============
const INCOME_CATS = [
  { code: 'dingjin', name: '定金', group: '租金类', order: 1, taxRate: 0, remark: '新签/续签时收取的定金' },
  { code: 'xinqian_zu', name: '新签租金物业', group: '租金类', order: 2, taxRate: 9, remark: '当期新签合同产生的租金+物业' },
  { code: 'xufu_zu', name: '续费租金物业', group: '租金类', order: 3, taxRate: 9, remark: '存量合同续期产生的租金+物业' },
  { code: 'zhaoming_dian', name: '照明电费', group: '水电费', order: 4, taxRate: 13, remark: '照明用电，非空调' },
  { code: 'kongtiao_dian', name: '空调电费', group: '水电费', order: 5, taxRate: 13, remark: '空调专用回路用电' },
  { code: 'yuezu_tingche', name: '月租停车费', group: '停车费', order: 6, taxRate: 9, remark: '包月车位 396 元/个/月' },
  { code: 'linshi_tingche', name: '临时停车', group: '停车费', order: 7, taxRate: 9, remark: '临时停车，按次/按小时' },
  { code: 'taonei_baojie', name: '套内保洁', group: '其他收入', order: 8, taxRate: 6, remark: '承租户自行聘请保洁的费用分摊' },
  { code: 'feipin', name: '保洁部卖废品', group: '其他收入', order: 9, taxRate: 0, remark: '保洁部废品变卖收入' },
  { code: 'huiyishi', name: '会议室', group: '其他收入', order: 10, taxRate: 6, remark: '会议室场地出租' },
  { code: 'zhongjie', name: '中介费', group: '其他收入', order: 11, taxRate: 6, remark: '房屋中介佣金' },
  { code: 'qita', name: '其他', group: '其他收入', order: 12, taxRate: 0, remark: '其他零星收入' }
];

// 支出科目（表8 日常物业支出 / 表9 其他支出·垫付支出）
const EXPENSE_CATS = [
  { code: 'wuyei_chu', name: '物业费用支出', group: '日常支出', order: 1 },
  { code: 'richang_chu', name: '日常费用支出', group: '日常支出', order: 2 },
  { code: 'yugao_chu', name: '预提款支出', group: '日常支出', order: 3 },
  { code: 'zhaoshang_chu', name: '招商费用支出', group: '日常支出', order: 4 },
  { code: 'qita_chu', name: '其他支出', group: '其他支出', order: 5 },
  { code: 'dianfu_chu', name: '垫付支出', group: '其他支出', order: 6 }
];

// 收入途径（表1/表3/表9 都有「收入途径明细」三列：转账/现金/其他）
const PAY_CHANNELS = ['转账', '现金', '其他'];

// ============ 租金递增引擎 ============

/**
 * 递增规则类型
 *   none      不递增
 *   annual    第 N 年起每年递增 P%（合同默认：第三年起每年 6%）
 *   everyN    每 N 年递增 P%（表2 实测：每2年10%）
 *   fixed     固定租金（不随时间变）
 */
const ESCALATE_TYPES = {
  none: { name: '不递增', desc: '租期内租金不变' },
  annual: { name: '每年递增', desc: '第 N 年起每年递增 P%' },
  everyN: { name: '每N年递增', desc: '每 N 年递增 P%' },
  fixed: { name: '固定租金', desc: '固定金额，不随时间变' }
};

/** 合同里的递增条款写法（解析表2 入驻公司表的「递增」列） */
const ESCALATE_PHRASES = {
  '不递增': { type: 'none' },
  '/': { type: 'none' },              // 空/斜杠 = 不递增
  '不调整': { type: 'none' },
  '每2年10％': { type: 'everyN', years: 2, rate: 10 },
  '每2年10%': { type: 'everyN', years: 2, rate: 10 },
  '每年10％': { type: 'annual', fromYear: 2, rate: 10 },
  '每年6％': { type: 'annual', fromYear: 3, rate: 6 },
  '第三年起每年递增6%': { type: 'annual', fromYear: 3, rate: 6 }
};

/**
 * 解析合同上的递增条款文字 → 规则对象
 * @param {string} text 合同「租金递增方式」原文，如「计租日起，第三年起每年递增6%」
 * @returns {{type:string, fromYear:number, years:number, rate:number, raw:string}}
 */
function parseEscalate(text) {
  const raw = String(text || '').trim();
  if (!raw) return Object.assign({ type: 'none', fromYear: 0, years: 0, rate: 0 }, { raw: raw });

  // 命中已知表述（去空格后比对）
  const compact = raw.replace(/\s+/g, '');
  const keys = Object.keys(ESCALATE_PHRASES);
  for (const k of keys) {
    if (compact.indexOf(k.replace(/\s+/g, '')) >= 0) {
      return Object.assign({ fromYear: 0, years: 0, rate: 0, raw: raw }, ESCALATE_PHRASES[k]);
    }
  }
  // 通用解析：「每N年递增P%」/「第N年起每年递增P%」
  let m = compact.match(/每(\d+)年(?:递增|上浮)(\d+(?:\.\d+)?)%/);
  if (m) return { type: 'everyN', years: Number(m[1]), rate: Number(m[2]), fromYear: 0, raw: raw };
  m = compact.match(/第(\d+)年起每年递增(\d+(?:\.\d+)?)%/);
  if (m) return { type: 'annual', fromYear: Number(m[1]), rate: Number(m[2]), years: 1, raw: raw };
  m = compact.match(/每年递增(\d+(?:\.\d+)?)%/);
  if (m) return { type: 'annual', fromYear: 2, rate: Number(m[1]), years: 1, raw: raw };
  if (compact.indexOf('递增') >= 0) {
    const r = /(\d+(?:\.\d+)?)%/.exec(compact);
    return { type: 'annual', fromYear: 3, rate: r ? Number(r[1]) : 6, years: 1, raw: raw };
  }
  return { type: 'none', fromYear: 0, years: 0, rate: 0, raw: raw };
}

/**
 * 计算某合同在某期间的递增后单价
 * @param {object} contract 合同（需 rentUnitPrice / startDate / escalateRule）
 * @param {string} period   期间 YYYY-MM
 * @returns {{price:number, base:number, rule:object, yearNo:number, note:string}}
 */
function rentPriceOf(contract, period) {
  const base = num(contract.rentUnitPrice);
  const rule = contract.escalateRule && contract.escalateRule.type
    ? contract.escalateRule
    : parseEscalate(contract.escalateText || '');

  const start = contract.startDate || contract.signDate;
  if (!start || rule.type === 'none' || rule.type === 'fixed') {
    return { price: base, base: base, rule: rule, yearNo: 1, note: '不递增' };
  }

  // 合同周年（不是自然年）：从计租日起每 12 个月为一个合同年
  const s = new Date(String(start).replace(/-/g, '/'));
  const [py, pm] = String(period).split('-').map(Number);
  if (isNaN(s.getTime()) || !py || !pm) {
    return { price: base, base: base, rule: rule, yearNo: 1, note: '起始日期异常，按基础价' };
  }
  const months = (py - s.getFullYear()) * 12 + (pm - (s.getMonth() + 1));
  if (months < 0) return { price: base, base: base, rule: rule, yearNo: 0, note: '未到计租日' };
  const yearNo = Math.floor(months / 12) + 1;      // 第 1..N 个合同年

  let times = 0;   // 已递增次数
  if (rule.type === 'annual') {
    // 「第三年起每年递增6%」→ 第3年涨一次，第4年再涨…
    const from = Math.max(1, num(rule.fromYear) || 3);
    times = Math.max(0, yearNo - from + (months % 12 === 0 && months > 0 ? 1 : 0));
    if (yearNo < from) times = 0;
  } else if (rule.type === 'everyN') {
    const n = Math.max(1, num(rule.years) || 2);
    times = Math.max(0, Math.floor((yearNo - 1) / n));
  }

  const price = round2(base * Math.pow(1 + num(rule.rate) / 100, times));
  let note = '不递增';
  if (times > 0) note = (rule.type === 'everyN' ? '每' + (rule.years || 2) + '年' : '第' + (rule.fromYear || 3) + '年起每年')
    + '递增' + num(rule.rate) + '%，已涨 ' + times + ' 次';
  return { price: price, base: base, rule: rule, yearNo: yearNo, times: times, note: note };
}

function round2(n) { return Math.round((num(n) + Number.EPSILON) * 100) / 100; }

// ============ 收入日报聚合（严格按真实表 12 列口径） ============
/**
 * 汇总某月（或跨月）的每日收入
 * @param {object} db
 * @param {string} month YYYY-MM
 * @param {object} opt { projectId }
 * @returns {{days:Array, totalByCat:Object, total:number}}
 */
async function dailyIncome(db, month, opt) {
  opt = opt || {};
  const codes = INCOME_CATS.map(c => c.code);
  const byCat = {};
  codes.forEach(c => byCat[c] = 0);

  const payments = (await db.all('payments')).filter(p => {
    // 收款单日期字段历史上出现过 payDate / date 两种，统一兼容
    const d = String(p.payDate || p.date || '').slice(0, 10);
    if (d.slice(0, 7) !== month) return false;
    if (p.direction === 'out') return false;              // 支出不算收入
    if (opt.projectId && p.projectId !== opt.projectId) return false;
    return true;
  });

  const dayMap = {};   // 'YYYY-MM-DD' -> {cat: amt}
  for (const p of payments) {
    const d = String(p.payDate || p.date || '').slice(0, 10);
    if (!d) continue;
    const code = await incomeCodeOf(p, db);
    if (byCat[code] === undefined) byCat[code] = 0;       // 未知科目归到「其他」
    const amt = num(p.amount);
    byCat[code] += amt;
    if (!dayMap[d]) dayMap[d] = {};
    dayMap[d][code] = (dayMap[d][code] || 0) + amt;
  }

  const days = [];
  const dim = daysInMonth(month);
  for (let i = 1; i <= dim; i++) {
    const d = month + '-' + String(i).padStart(2, '0');
    const m = dayMap[d] || {};
    const row = { date: d, day: i };
    let sum = 0;
    codes.forEach(c => { row[c] = round2(m[c] || 0); sum += m[c] || 0; });
    row.total = round2(sum);
    days.push(row);
  }
  const total = round2(Object.keys(byCat).reduce((s, c) => s + byCat[c], 0));
  const totalByCat = {};
  codes.forEach(c => totalByCat[c] = round2(byCat[c]));
  return { days: days, totalByCat: totalByCat, total: total, count: payments.length };
}

/** 把一笔收款映射到 12 类收入科目
 *  收款单本身不带费用明细，明细在关联账单（bills.items）里 —— 必须以账单为第一依据。
 */
async function incomeCodeOf(p, db) {
  // 优先用收款单上显式指定的科目
  if (p.incomeCat && INCOME_CATS.some(c => c.code === p.incomeCat) && p.incomeCatLocked) return p.incomeCat;

  const name = String(p.feeName || p.itemName || p.remark || '');
  const cat = String(p.category || p.feeCategory || '');

  // 1) 收款单自带文字线索
  if (/定金/.test(name)) return 'dingjin';
  if (/空调.*电|电.*空调/.test(name)) return 'kongtiao_dian';
  if (/照明/.test(name)) return 'zhaoming_dian';
  if (/月租.*停车|停车.*月租|月租车/.test(name)) return 'yuezu_tingche';
  if (/临时停车/.test(name)) return 'linshi_tingche';
  if (/套内保洁|室内保洁/.test(name)) return 'taonei_baojie';
  if (/会议/.test(name)) return 'huiyishi';
  if (/中介/.test(name)) return 'zhongjie';
  if (/水电费|垃圾清运费|有线电视|宽带/.test(name)) return 'qita';

  // 2) 关联账单的明细（真实来源）
  let bill = null;
  if (db && p.billId) bill = await db.find('bills', p.billId);
  if (bill) {
    const items = bill.items || [];
    // 停车费
    if (items.some(i => /停车/.test(i.name || ''))) {
      return /临时/.test(items.map(i => i.name).join('')) ? 'linshi_tingche' : 'yuezu_tingche';
    }
    // 会议 / 中介（专用科目，必须先判）
    if (items.some(i => /会议/.test(i.name || ''))) return 'huiyishi';
    if (items.some(i => /中介/.test(i.name || ''))) return 'zhongjie';
    // 租金 / 物业 → 区分新签与续费（月账单以租金为主项，优先于附属费用归类）
    if (items.some(i => /租金|物业费/.test(i.name || ''))) {
      let isNew = true;
      const c = bill.contractId ? await db.find('contracts', bill.contractId) : null;
      if (c && c.startDate && String(bill.period || '') !== String(c.startDate).slice(0, 7)) isNew = false;
      if (p.isRenew) isNew = false;
      return isNew ? 'xinqian_zu' : 'xufu_zu';
    }
    // 无租金时才是附属费用
    if (items.some(i => /保洁/.test(i.name || ''))) return 'taonei_baojie';
    if (items.some(i => /空调电费/.test(i.name || ''))) return 'kongtiao_dian';
    if (items.some(i => /照明电费|^电费$/.test(i.name || ''))) return 'zhaoming_dian';
    if (items.some(i => /水费/.test(i.name || ''))) return 'qita';
    if (items.length) return 'qita';
  }

  // 3) 无账单时按字段粗判
  if (cat === '租金' || cat === '物业费' || /租金|物业/.test(name)) {
    return p.isRenew ? 'xufu_zu' : 'xinqian_zu';
  }
  if (cat === '电费') return 'zhaoming_dian';
  if (cat === '保洁费') return 'taonei_baojie';
  if (cat === '水费') return 'qita';
  return 'qita';
}

function daysInMonth(month) {
  const [y, m] = String(month).split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

// ============ 表9「其他费用」六张台账 ============
/**
 * 依据真实文件（表9）其他费用.xlsx 的 6 个工作表：
 *   其他收入 / 其他支出 / 中介费 / 会议室收入 / 垫付收入 / 垫付支出
 *
 * 六张表的共同骨架是「按月分组 + 月度汇总」：
 *   月份 | 单元号 | 公司名称 | 金额 | 收支时间 | 途径明细 | 余款 | 备注
 * 中介费表多出「收款单位/人、单据编号、面积、费用总金额、已付金额、未付金额、发票」；
 * 会议室表多出「使用日期、使用时间、税票情况」。
 *
 * direction: 'in' 收入 / 'out' 支出
 * extraCols 为该表独有列（其余表共用基础列）
 */
const OTHER_KINDS = [
  {
    key: 'other_in', name: '其他收入', direction: 'in', sheet: '其他收入', color: 'green',
    head: ['月份', '单元号', '公司名称', '金额', '收入时间', '收入途径明细', '余款', '备注'],
    extraCols: [], catCode: 'qita'
  },
  {
    key: 'other_out', name: '其他支出', direction: 'out', sheet: '其他支出', color: 'red',
    head: ['月份', '单元号', '公司名称', '支出金额', '支出时间', '支出途径明细', '余款', '备注'],
    extraCols: [], catCode: 'qita_chu'
  },
  {
    key: 'agency', name: '中介费', direction: 'in', sheet: '中介费', color: 'blue',
    head: ['日期', '收款单位/人', '单据编号', '单元号', '面积', '费用总金额', '已付金额', '未付金额', '发票', '备注'],
    // 中介费按「费用总金额」计，已付/未付分列，天然带分期收款属性
    amountKey: 'totalAmount', extraCols: [
      { name: 'docNo', label: '单据编号' },
      { name: 'area', label: '面积(㎡)', type: 'number' },
      { name: 'paidAmount', label: '已付金额', type: 'money' },
      { name: 'unpaidAmount', label: '未付金额', type: 'money', read: true }
    ], catCode: 'zhongjie'
  },
  {
    key: 'meeting', name: '会议室收入', direction: 'in', sheet: '会议室收入', color: 'purple',
    head: ['月份', '单元号', '公司名称', '金额', '使用日期', '使用时间', '收入时间', '收入途径明细', '余款', '税票情况', '备注'],
    extraCols: [
      { name: 'useDate', label: '使用日期', type: 'date' },
      { name: 'useTime', label: '使用时间', placeholder: '如 09:00-12:00' },
      { name: 'taxStatus', label: '税票情况', placeholder: '已开普票 / 未开' }
    ], catCode: 'huiyishi'
  },
  {
    key: 'advance_in', name: '垫付收入', direction: 'in', sheet: '垫付收入', color: 'orange',
    head: ['月份', '单元号', '公司名称', '收入金额', '收入时间', '收入途径明细', '余款', '备注'],
    extraCols: [], catCode: 'qita'
  },
  {
    key: 'advance_out', name: '垫付支出', direction: 'out', sheet: '垫付支出', color: 'orange',
    head: ['月份', '单元号', '公司名称', '支出金额', '支出时间', '支出途径明细', '余款', '备注'],
    extraCols: [], catCode: 'dianfu_chu'
  }
];

const OTHER_KIND_MAP = {};
OTHER_KINDS.forEach(k => { OTHER_KIND_MAP[k.key] = k; });

/** 表9 台账里取金额（中介费用 totalAmount，其余用 amount） */
function otherAmount(k, row) {
  return num(row[(k && k.amountKey) || 'amount']);
}

/**
 * 预提款季度分段（表8 右侧「汇总表」的实际用法）
 *
 * 真实表8 把一个季度的支出按「7月 / 8月 / 9月」分段，每段一个小计，
 * 最后再来一个「总计」。预提款（yugao_chu）尤其依赖这个分段 ——
 * 因为预提是按季一次性计提、再逐月摊销的，看数必须能按月拆。
 *
 * @param {Array} expenses 全量支出记录
 * @param {Array<string>} months 月份数组（有序）
 * @returns 每个月的分段 + 合计
 */
function prepaidSegments(expenses, months) {
  const list = expenses || [];
  const rows = months.map(m => {
    const ms = list.filter(r => String(r.expDate || '').slice(0, 7) === m);
    const prepaid = ms.filter(r => r.expCat === '预提款支出');
    const actual = ms.filter(r => r.expCat !== '预提款支出');
    return {
      month: m,
      count: ms.length,
      prepaidCount: prepaid.length,
      prepaid: money(prepaid.reduce((s, r) => s + num(r.amount), 0)),
      actual: money(actual.reduce((s, r) => s + num(r.amount), 0)),
      total: money(ms.reduce((s, r) => s + num(r.amount), 0))
    };
  });
  const total = {
    month: '总计',
    count: list.length,
    prepaidCount: rows.reduce((s, r) => s + r.prepaidCount, 0),
    prepaid: money(rows.reduce((s, r) => s + num(r.prepaid), 0)),
    actual: money(rows.reduce((s, r) => s + num(r.actual), 0)),
    total: money(rows.reduce((s, r) => s + num(r.total), 0))
  };
  return { rows, total };
}

module.exports = {
  INCOME_CATS, EXPENSE_CATS, PAY_CHANNELS,
  OTHER_KINDS, OTHER_KIND_MAP, otherAmount, prepaidSegments,
  ESCALATE_TYPES, ESCALATE_PHRASES,
  parseEscalate, rentPriceOf,
  dailyIncome, incomeCodeOf, daysInMonth, round2
};
