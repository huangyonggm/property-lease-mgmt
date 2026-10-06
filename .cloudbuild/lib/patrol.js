'use strict';
/**
 * 巡更检查分析引擎（零第三方依赖）
 * 由 Python 版「巡更检查小工具」(patrol_tool/models.py + parser.py + analysis.py) 完整移植：
 *   - 点位表 / 记录表解析（兼容 .xls BIFF8、.xlsx、.csv，见 lib/xls.js）
 *   - 夜班时段归属：当天 18:30 ~ 次日 06:30，以「夜班起始日」为班次日
 *   - 漏检判定、日报、月度汇总、TOP 漏检点、人员统计
 * 纯函数设计，可同时供 PC / 移动端 / 定时任务复用
 */
const { num, pad, fmtDate, addDays } = require('./util');

/* ============================ 常量 ============================ */
// 夜班时段默认值。**不是硬编码**：可由调用方通过 opt 覆盖
// （原 Python 小工具的界面上就有「起始 / ~ 次日」两个输入框，此处保持同等能力）。
// 覆盖方式见 resolveWindow()。
const NIGHT_START_MIN = 18 * 60 + 30;   // 18:30
const NIGHT_END_MIN = 8 * 60 + 30;       // 次日 08:30（对齐巡更小工具口径，原为 06:30）

/* ==================== 夜班 5 时段划分（夜班专项口径） ====================
 *
 * 【为什么必须分时段】巡更考核的���义是「每晚每一轮都要巡满全部点位」。
 * 早期实现只把整个夜班的打卡并成一个集合去重（checked[code]=true 一次算过），
 * 分母也只按 点数 × 夜数 计算，等于把 5 轮巡更当 1 轮算——
 * 实测 3 月数据：这样算出来是 96.5%，而按 5 时段算是 60.5%。
 * 差距来自「后半夜基本没人巡」被整体抹平了：6 点半到 8 点半实际只完成 4.2%，
 * 1 点到 3 点有 9 个整夜零打卡，但整夜去重后这些夜看起来仍是「都巡过了」。
 *
 * 所以：分母 = 点数 × 时段数 × 夜数，且**每个时段独立去重**。
 * 口径原文：「同一**时段**同一巡检点打 2 次、3 次只记为 1 次有效」
 *   → 去重范围是「时段内」，绝不是「整夜内」。
 *
 * 时间边界精确到分钟区间（HH:MM 闭区间，含首含尾）：
 *   18点半到21点18:30:00-20:59:59
 *   21点到1点     21:00:00-00:59:59（跨零点）
 *   1点到3点      01:00:00-02:59:59（归属前一日夜班）
 *   3点到6点半    03:00:00-06:29:59（归属前一日夜班）
 *   6点半到8点半  06:30:00-08:29:59（归属前一日夜班）
 */
const NIGHT_SEGMENTS = [
  { name: '18点半到21点', ranges: [['18:30', '20:59', false]] },
  { name: '21点到1点', ranges: [['21:00', '23:59', false], ['00:00', '00:59', true]] },
  { name: '1点到3点', ranges: [['01:00', '02:59', true]] },
  { name: '3点到6点半', ranges: [['03:00', '06:29', true]] },
  { name: '6点半到8点半', ranges: [['06:30', '08:29', true]] }
];

/** 'HH:MM' → 分钟数 */
function hm2min(hm) {
  const m = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(String(hm || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 把 NIGHT_SEGMENTS 预编译成「分钟数 + 是否归属前一日」的扁平表 */
const SEGMENT_FLAT = [];
NIGHT_SEGMENTS.forEach(seg => {
  seg.ranges.forEach(r => {
    const lo = hm2min(r[0]), hi = hm2min(r[1]);
    if (lo === null || hi === null) return;
    SEGMENT_FLAT.push({ seg: seg.name, lo: lo, hi: hi, cross: !!r[2] });
  });
});
const SEGMENT_NAMES = NIGHT_SEGMENTS.map(s => s.name);

/**
 * 把打卡时间归属到「夜班时段」。
 * @param {Date|number} dt
 * @returns {{seg:string, shiftDate:string}|null}  落在夜班窗口外返回 null（白天 08:30-18:29）
 */
function assignSegment(dt) {
  const d = dt instanceof Date ? dt : new Date(dt);
  if (isNaN(d.getTime())) return null;
  const mins = d.getHours() * 60 + d.getMinutes();
  for (let i = 0; i < SEGMENT_FLAT.length; i++) {
    const s = SEGMENT_FLAT[i];
    if (mins >= s.lo && mins <= s.hi) {
      return { seg: s.seg, shiftDate: s.cross ? addDays(fmtDate(d), -1) : fmtDate(d) };
    }
  }
  return null;
}

/** 时段定义的展示文本，如「18点半到21点=18:30:00-20:59:59」 */
function segmentDescriptions() {
  return NIGHT_SEGMENTS.map(seg => seg.name + '=' + seg.ranges
    .map(r => {
      const p = (n) => String(n).padStart(2, '0');
      const lo = hm2min(r[0]), hi = hm2min(r[1]);
      return p(Math.floor(lo / 60)) + ':' + p(lo % 60) + ':00-' +
        p(Math.floor(hi / 60)) + ':' + p(hi % 60) + ':59';
    }).join('、')).join('；');
}

/** 默认窗口对象（18:30 ~ 次日 06:30），字段齐全，供 resolveWindow 兜底 */
function defaultWindow() {
  return {
    startMin: NIGHT_START_MIN, endMin: NIGHT_END_MIN,
    startH: Math.floor(NIGHT_START_MIN / 60), startM: NIGHT_START_MIN % 60,
    endH: Math.floor(NIGHT_END_MIN / 60), endM: NIGHT_END_MIN % 60
  };
}

/**
 * 解析夜班时段窗口 → { startMin, endMin, startH, startM, endH, endM }
 *
 * 兼容三种传法：
 *   ① 字符串 '18:30' / '6:30'
 *   ② { startMin: 1110, endMin: 390 }
 *   ③ { startH: 18, startM: 30, endH: 6, endM: 30 }
 *
 * 边界与容错（这一段是踩过的坑）：
 *   - endMin <= startMin 属正常（夜班跨日），不能判为非法
 *   - endMin == startMin 会导致「整点都算夜班」，这里明确拒绝并回退默认
 *   - 非法输入一律回退默认值，绝不抛异常 —— 时段配错不该让整个分析页崩掉
 */
function resolveWindow(w) {
  // null/undefined 必须在这里挡住：typeof null === 'object'，
  // 会穿透到下面的对象分支再报 "cannot read startMin of null"（曾踩过）。
  if (w === null || w === undefined || w === '') return defaultWindow();
  let startMin = null, endMin = null;

  if (typeof w === 'string' || typeof w === 'number') {
    // 只给了起始时间时（如 '18:30'），结束沿用默认
    const m = String(w).match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/);
    if (m) startMin = (+m[1]) * 60 + (+m[2]);
  } else if (typeof w === 'object') {
    if (num(w.startMin, -1) >= 0) startMin = num(w.startMin, 0);
    else if (num(w.startH, -1) >= 0) startMin = num(w.startH, 0) * 60 + num(w.startM, 0);
    else if (w.start) { const m = String(w.start).match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/); if (m) startMin = (+m[1]) * 60 + (+m[2]); }

    if (num(w.endMin, -1) >= 0) endMin = num(w.endMin, 0);
    else if (num(w.endH, -1) >= 0) endMin = num(w.endH, 0) * 60 + num(w.endM, 0);
    else if (w.end) { const m = String(w.end).match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/); if (m) endMin = (+m[1]) * 60 + (+m[2]); }
  }

  if (startMin === null || !(startMin >= 0 && startMin < 24 * 60)) startMin = NIGHT_START_MIN;
  if (endMin === null || !(endMin >= 0 && endMin < 24 * 60) || endMin === startMin) endMin = NIGHT_END_MIN;
  // 统一出口：startH/startM/endH/endM 必须始终存在，
  // 否则 windowText() 会渲染出 "undefined:undefined"（曾踩过）。
  return {
    startMin: startMin, endMin: endMin,
    startH: Math.floor(startMin / 60), startM: startMin % 60,
    endH: Math.floor(endMin / 60), endM: endMin % 60
  };
}

/** "18:30 ~ 次日 06:30" 形式的展示文本；对缺字段的裸对象做兜底 */
function windowText(w) {
  const p2 = (n) => String(Number(n) || 0).padStart(2, '0');
  const o = w || {};
  const sh = o.startH === undefined ? Math.floor((o.startMin || NIGHT_START_MIN) / 60) : o.startH;
  const sm = o.startM === undefined ? ((o.startMin || NIGHT_START_MIN) % 60) : o.startM;
  const eh = o.endH === undefined ? Math.floor((o.endMin === undefined ? NIGHT_END_MIN : o.endMin) / 60) : o.endH;
  const em = o.endM === undefined ? ((o.endMin === undefined ? NIGHT_END_MIN : o.endMin) % 60) : o.endM;
  return p2(sh) + ':' + p2(sm) + ' ~ 次日 ' + p2(eh) + ':' + p2(em);
}

const TIME_FORMATS = [
  /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})$/,
  /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T](\d{1,2}):(\d{2})$/,
  /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/
];

/* ============================ 基础解析 ============================ */
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    // 整数不补 .0；浮点保留原值（时间列若为 Excel 序列号会在 parseTime 处理）
    return String(v);
  }
  return String(v).trim();
}

function parseTime(v) {
  if (v === null || v === undefined || v === '') return null;
  // 已是 Date
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  if (!s) return null;
  for (let i = 0; i < TIME_FORMATS.length; i++) {
    const m = TIME_FORMATS[i].exec(s);
    if (m) {
      const y = +m[1], mo = +m[2], d = +m[3], h = i === 2 ? 0 : +m[4], mi = i === 2 ? 0 : +m[5], se = (i === 0 ? +m[6] : 0);
      const dt = new Date(y, mo - 1, d, h, mi, se);
      return isNaN(dt.getTime()) ? null : dt;
    }
  }
  // Excel 日期序列号（1900 基准，含 1900 闰年 bug 偏移）
  const n = Number(s);
  if (!isNaN(n) && n > 20000 && n < 80000) {
    const ms = (n - 25569) * 86400000;
    const dt = new Date(Math.round(ms));
    return isNaN(dt.getTime()) ? null : dt;
  }
  // 容错：'2026-07-01 08:25'
  const loose = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2}).{0,3}(\d{1,2}):(\d{2})/.exec(s);
  if (loose) return new Date(+loose[1], +loose[2] - 1, +loose[3], +loose[4], +loose[5], 0);
  return null;
}

function fmtDateTime(dt) {
  if (!dt) return '';
  return fmtDate(dt) + ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes()) + ':' + pad(dt.getSeconds());
}

// 楼层排序：18F > 17F > ... > 1F > -1 > -2 > 设备房（设备房排最后）
function pointSortKey(name) {
  const s = String(name || '');
  if (s.indexOf('设备房') >= 0) return 999;
  const m = /(-?\d+)\s*(?:F|f|楼)/.exec(s);
  if (m) return 999 - Number(m[1]);
  // 兼容「-1 西面步梯间」这类不带 F/楼 的地下层写法
  const m2 = /^(-?\d+)\s/.exec(s);
  if (m2) return 999 - Number(m2[1]);
  return 500;
}

/* ============================ 点位 / 人员 ============================ */
/**
 * 点位表的「表头别名」。同样是两套格式：
 *   整理过的标准表（巡更点位.xls）： 序号|卡号|类型|名称|备注|路线编号|路线内顺序
 *   维序设备原始表（Rpt_cardinfo）： 序号|地点名称|地点编码|空闲/否|备注
 *                                    ↑ 没有「类型」列，出现的行全是地点卡
 */
const PT_ALIASES = {
  seq: ['序号', '序', 'No', 'NO', '编号'],
  code: ['卡号', '地点编码', '巡点编码', '点位编码', '编码', '标签号'],
  type: ['类型', '卡类型', '卡片类型', '类别'],
  name: ['名称', '地点名称', '巡更点', '点位名称', '巡更地点', '位置', '地点'],
  remark: ['备注', '说明'],
  route: ['路线编号', '路线', '线路编号', '路线号'],
  order: ['路线内顺序', '路线顺序', '顺序', '内顺序'],
  state: ['空闲/否', '空闲', '状态', '是否空闲', '使用状态']
};
function matchPtHeader(text) {
  const s = String(text || '').replace(/\s/g, '');
  if (!s) return null;
  for (const key in PT_ALIASES) {
    for (const a of PT_ALIASES[key]) {
      const al = a.replace(/\s/g, '');
      if (s === al) return key;
      if (s.indexOf(al) >= 0 && al.length >= 2) return key;
    }
  }
  return null;
}

/**
 * 判断一行表头是不是「巡查记录表」的表头 —— 记录表绝不能当点位表解析。
 *
 * 【为什么必须显式排除】设备厂商导出的记录表，表头写的是
 *   序号 | 地点名称 | 地点编码 | 巡检时间 | 巡检员
 * 其中「地点名称」「地点编码」与点位表原始格式（Rpt_cardinfo）**字面完全相同**。
 * 两边别名重叠，光看「名称+编码」无法区分，一旦误判：
 *   parsePoints 会把 13669 条巡更流水全当成「点位」，
 *   再配上 mode='replace' 就会把已有的 35 个正常点位整个清空替换掉。
 *
 * 所以以「记录表专属列」作为否决项：出现「巡检时间」「巡检员」「巡更点」
 * 这类只属于流水表的列，直接判定这不是点位表。
 */
function looksLikeRecordHeader(row) {
  const joined = (row || []).map(c => String(c || '').replace(/\s/g, '')).join('|');
  return ['巡检时间', '巡检员', '巡查时间', '巡更时间', '签到时间', '刷卡时间',
    '打卡时间', '巡查员', '巡更员'].some(k => joined.indexOf(k) >= 0);
}

/**
 * 解析巡更点位表
 * @param {Array<Array>} rows  原始表格行
 * @returns {{points:Array, persons:Array, header:Array, mode:string}}
 */
function parsePoints(rows) {
  rows = rows || [];
  const points = [], persons = [];
  let header = null, hi = -1, mode = 'default';

  // ---- ① 找表头 ----
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const r = rows[i] || [];
    // 记录表专用否决：这张表是巡更流水，不是点位清单
    if (looksLikeRecordHeader(r)) break;
    const m = {};
    let hits = 0;
    r.forEach((c, ci) => {
      const k = matchPtHeader(c);
      if (k && m[k] === undefined) { m[k] = ci; hits++; }
    });
    // 认到「名称」+（编码 或 类型）才算点位表头。
    // 只有「序号 + 名称」两列时也放行：这份表虽然没有卡号列，
    // 但名称列足够定位点位，编码留空后续人工补录，
    // 总比整表识别不出来、用户以为工具坏了要好。
    if (m.name !== undefined && (m.code !== undefined || m.type !== undefined || m.seq !== undefined) && hits >= 2) {
      header = r.map(cellText); hi = i; mode = 'header';
      break;
    }
  }
  if (header) {
    const colOf = (key) => {
      for (let c = 0; c < header.length; c++) if (matchPtHeader(header[c]) === key) return c;
      return -1;   // 表头里没有这一项 → 留空，绝不按位置瞎猜
    };
    // 【重要】读到表头就以表头为唯一权威，不再用「缺省列号」补位。
    // 之前 code 缺省取 1，对「序号|地点名称」这种两列表，
    // 序号在 c0、名称在 c1 → code 落到名称列、name 也落到 c1，
    // 结果一行都识别不出来。现在缺哪列就是 -1（留空），
    // 靠名称成行、编码留待人工补录，至少不吞数据。
    var idx = {
      seq: colOf('seq'), code: colOf('code'), type: colOf('type'),
      name: colOf('name'), remark: colOf('remark'),
      route: colOf('route'), order: colOf('order')
    };
    // 一列不能兼两职（「空闲/否」这类列与别列撞车时以先到为准）
    const used = {};
    ['seq', 'code', 'type', 'name', 'remark', 'route', 'order'].forEach(k => {
      const v = idx[k];
      if (v === undefined || v < 0) return;
      if (used[v] !== undefined) { idx[k] = -1; return; }
      used[v] = k;
    });
  } else {
    // ---- ② 无表头：按内容推断（8 位十六进制列=编码，文本最多的列=名称）----
    const sample = rows.slice(0, 150);
    const maxCol = Math.max.apply(null, sample.map(r => (r || []).length).concat([0]));
    const st = [];
    for (let c = 0; c < maxCol; c++) st[c] = { code: 0, text: 0, uniq: {}, time: 0 };
    for (let i = 0; i < sample.length; i++) {
      const r = sample[i] || [];
      for (let c = 0; c < maxCol; c++) {
        const v = cellText(r[c]);
        if (!v) continue;
        if (parseTime(v)) { st[c].time++; continue; }          // ← 记录表否决依据
        if (/^[0-9A-Fa-f]{8}$/.test(v.replace(/\s/g, ''))) { st[c].code++; st[c].uniq[v] = 1; continue; }
        st[c].text++;
      }
    }
    // 【否决】样本里存在能解析出日期时间的列 → 这是巡查流水表，不是点位表。
    // 无表头时两类表的列长得几乎一样（编码 8 位十六进制 + 文本名称），
    // 唯一稳定的区分特征就是「有没有时间列」。
    let timeCol = -1, tv = 0;
    for (let c = 0; c < maxCol; c++) if (st[c].time > tv) { tv = st[c].time; timeCol = c; }
    if (tv > 0) return { points: [], persons: [], header: [], mode: 'is-record-table' };

    let codeCol = -1, cv = 0;
    for (let c = 0; c < maxCol; c++) if (st[c].code > cv) { cv = st[c].code; codeCol = c; }
    let nameCol = -1, nv = 0;
    for (let c = 0; c < maxCol; c++) {
      if (c === codeCol) continue;
      if (st[c].text > nv) { nv = st[c].text; nameCol = c; }
    }
    if (codeCol < 0 && nameCol < 0) return { points: [], persons: [], header: [], mode: 'unknown' };
    var idx = { seq: undefined, code: codeCol, type: -1, name: nameCol, remark: -1, route: -1, order: -1 };
    mode = 'inferred';
    hi = -1;
  }

  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const code = idx.code >= 0 ? cellText(r[idx.code]).replace(/\s/g, '') : '';
    const name = idx.name >= 0 ? cellText(r[idx.name]) : '';
    if (!code && !name) continue;
    // 行有效性：8 位编码（设备卡号）或长度 >= 2 的点位名称，二者至少有一个。
    // 注意别用「非纯数字」当判据 —— 若 idx.code 误落到序号列，
    // 「1」「2」「3」会被当编码，把 100 个序号行全部塞进点位表。
    const valid = /^[0-9A-Fa-f]{6,10}$/.test(code) || (name && name.length >= 2);
    if (!valid) continue;
    const type = idx.type >= 0 ? cellText(r[idx.type]) : '';
    // 人员卡：显式「类型=人员卡」，或无类型列但名称像人员（保安/保洁/夜班…）且没有点位编码
    if (type === '人员卡' || (type === '' && !code && /人员|保安|保洁|班|夜班|白班/.test(name))) {
      const shift = name.indexOf('夜班') >= 0 ? '夜班' : (name.indexOf('白班') >= 0 ? '白班' : '');
      persons.push({ code: code, name: name, shift: shift });
      continue;
    }
    // 无「类型」列的原始表：整张表都是地点卡
    points.push({
      code: code, name: name,
      remark: idx.remark >= 0 ? cellText(r[idx.remark]) : '',
      route: idx.route >= 0 ? cellText(r[idx.route]) : '',
      routeOrder: idx.order >= 0 ? num(r[idx.order], 0) : 0,
      sortKey: pointSortKey(name)
    });
  }
  points.sort((a, b) => (a.sortKey - b.sortKey) || (a.name < b.name ? -1 : 1));
  return { points: points, persons: persons, header: header || [], mode: mode };
}

/* ============================ 巡查记录 ============================ */

/**
 * 巡查记录表的「表头别名」。
 *
 * 同一物业在不同月份拿到的导出表头完全不一样（都是同一台维序设备导出的）：
 *   整理过的标准表（2026-07）： 序号 | 巡检时间 | 巡检器 | 巡点编码 | 人员  | 巡更点
 *   设备原始表（2026-03）： 序号 | 地点名称 | 地点编码 | 巡检时间 | 巡检员
 *                            ↑ 序号在 c3，名称 c4，编码 c5，时间 c9，人员 c13
 * 所以每个字段都要支持多个别名，且必须**按内容位置**兜底，
 * 不能只认死关键字（原 Python 工具用 pandas 也一样会在这里翻车）。
 */
const REC_ALIASES = {
  seq: ['序号', '序', 'No', 'NO', '编号', '行号'],
  time: ['巡检时间', '巡查时间', '巡更时间', '签到时间', '刷卡时间', '时间', '打卡时间'],
  device: ['巡检器', '巡检设备', '设备编号', '设备号', '机器编号', '控制器'],
  code: ['巡点编码', '地点编码', '卡号', '点位编码', '编码', '巡更点编码', '标签号'],
  person: ['人员', '巡检员', '巡更员', '巡查员', '姓名', '保安', '值班人', '巡检人'],
  name: ['巡更点', '地点名称', '巡更地点', '点位名称', '巡检地点', '位置', '地点', '名称']
};

function matchHeader(text) {
  const s = String(text || '').replace(/\s/g, '').replace(/[（(].*?[)）]/g, '');
  if (!s) return null;
  for (const key in REC_ALIASES) {
    for (const a of REC_ALIASES[key]) {
      const al = a.replace(/\s/g, '');
      if (s === al) return key;          // 完全相等优先，避免「巡检时间」被「时间」抢走
      if (s.indexOf(al) >= 0 && al.length >= 2) return key;
    }
  }
  return null;
}

/** 猜测一行是不是数据行：能解析出时间 且 至少有一项点标识（编码或名称） */
function looksLikeDataRow(row) {
  let timeHit = 0, idHit = 0;
  for (let c = 0; c < row.length; c++) {
    const v = cellText(row[c]);
    if (!v) continue;
    if (parseTime(v)) { timeHit++; continue; }
    // 8 位十六进制编码，如 008D9066
    if (/^[0-9A-Fa-f]{8}$/.test(v.replace(/\s/g, ''))) { idHit++; continue; }
    // 2~4 位纯数字（序号）
    if (/^\d{1,4}$/.test(v)) { idHit++; continue; }
  }
  return timeHit > 0 && idHit > 0;
}

/**
 * 解析巡查记录表
 *
 * 三层识别策略（任一层命中即可）：
 *   ① 表头识别   —— 前 60 行里找能映射到 seq/time/code/person/name 的行
 *   ② 内容推断   —— 没表头时按列内容特征推断（时间列 = 能解析出日期的列；编码列 = 8位十六进制最多的列…）
 *   ③ 默认列位   —— 都没有就用 7 月标准列位
 *
 * @param {Array<Array>} rows
 * @returns {{records:Array, header:Array, skipped:number, idx:object, mode:string}}
 */
function parseRecords(rows) {
  rows = rows || [];
  const records = [];
  let hi = -1, header = null, skipped = 0;

  // ---- ① 表头识别 ----
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const r = rows[i] || [];
    const map = {};
    let hits = 0;
    r.forEach((c, ci) => {
      const k = matchHeader(c);
      if (k && map[k] === undefined) { map[k] = ci; hits++; }
    });
    // 至少认到「时间」+ 一个点标识才算表头行
    if (map.time !== undefined && hits >= 2 && (map.code !== undefined || map.name !== undefined)) {
      header = r.map(cellText);
      hi = i;
      break;
    }
  }

  let idx = { seq: 1, time: 2, device: 3, code: 4, person: 5, name: 6 };
  let mode = 'default';
  if (header) {
    mode = 'header';
    // 【重要】读到表头就以表头为唯一权威，缺哪列置 -1（留空），不按位置瞎补。
    // 之前 device 缺省取 3，在 3 月原始表（无「巡检器」列）里恰好撞上「序号」列，
    // 导致设备号被写成 "1"/"13669"。缺列就留空，漏检分析不依赖设备号。
    const colOf = (key) => {
      for (let c = 0; c < header.length; c++) {
        if (matchHeader(header[c]) === key) return c;
      }
      return -1;
    };
    idx = {
      seq: colOf('seq'), time: colOf('time'), device: colOf('device'),
      code: colOf('code'), person: colOf('person'), name: colOf('name')
    };
    // 一列不能同时充当两个字段
    const used = {};
    ['seq', 'time', 'device', 'code', 'person', 'name'].forEach(k => {
      const v = idx[k];
      if (v === undefined || v < 0) return;
      if (used[v] !== undefined) { idx[k] = (k === 'seq' || k === 'device') ? -1 : undefined; return; }
      used[v] = k;
    });
  } else {
    // ---- ② 内容推断 ----
    const inferred = inferRecordColumns(rows);
    if (inferred) { idx = inferred; mode = 'inferred'; }
  }

  const startAt = hi >= 0 ? hi + 1 : 0;
  // 【兜底】认到表头但没认出「时间」列时，不能就这么认输 ——
  // 多半是表头写了个没收录的别名（如「上报时间」「巡查时刻」）。
  // 退回到内容推断，至少能按「哪列能解析出日期」把数据捞出来。
  if (mode === 'header' && (idx.time === undefined || idx.time < 0)) {
    const inferred = inferRecordColumns(rows.slice(hi + 1));
    if (inferred && inferred.time >= 0) {
      idx.time = inferred.time;
      if ((idx.code === undefined || idx.code < 0) && inferred.code >= 0) idx.code = inferred.code;
      if ((idx.name === undefined || idx.name < 0) && inferred.name >= 0) idx.name = inferred.name;
      if ((idx.person === undefined || idx.person < 0) && inferred.person >= 0) idx.person = inferred.person;
      mode = 'header+inferred';
    }
  }

  for (let i = startAt; i < rows.length; i++) {
    const r = rows[i] || [];
    if (mode !== 'header' && mode !== 'header+inferred' && hi < 0 && !looksLikeDataRow(r)) continue;
    if (idx.time === undefined || idx.time < 0) continue;

    const dt = parseTime(cellText(r[idx.time]));
    if (!dt) { skipped++; continue; }

    let seq;
    if (idx.seq !== undefined && idx.seq >= 0) {
      seq = Math.round(num(cellText(r[idx.seq]), NaN));
      if (isNaN(seq)) seq = records.length + 1;   // 序号列缺失/脏值不致命，用时间排序后的自然序号兜底
    } else {
      seq = records.length + 1;
    }

    const pointCode = idx.code >= 0 ? cellText(r[idx.code]).replace(/\s/g, '') : '';
    const pointName = idx.name >= 0 ? cellText(r[idx.name]) : '';
    // 时间和点位编码都没有的行是空行/分隔行，直接丢，不计 skipped
    if (!pointCode && !pointName) continue;

    records.push({
      seq: seq,
      time: fmtDateTime(dt),
      timeAt: dt.getTime(),
      device: idx.device >= 0 ? cellText(r[idx.device]) : '',
      pointCode: pointCode,
      person: idx.person >= 0 ? cellText(r[idx.person]) : '',
      pointName: pointName
    });
  }
  records.sort((a, b) => a.timeAt - b.timeAt);
  // 排序后重排 seq，保证与时间顺序一致
  records.forEach((x, i) => { x.seq = i + 1; });
  return { records: records, header: header || [], skipped: skipped, idx: idx, mode: mode };
}

/**
 * 无表头时按内容推断列位。
 * 判据：
 *   时间列 —— 该列能被 parseTime 成功解析的单元格数最多（且占比 > 30%）
 *   编码列 —— 形如 8 位十六进制且互不相同的单元格最多
 *   名称列 —— 非空文本最多、且不像时间的列里，与编码列不同列
 *   人员列 —— 在「非时间、非编码、非名称」里，中文姓名特征（2~4 个汉字）最多的列
 *   序号列 —— 纯 1..N 递增整数最多的列
 */
function inferRecordColumns(rows) {
  const sample = rows.slice(0, 200);
  if (!sample.length) return null;
  const maxCol = Math.max.apply(null, sample.map(r => (r || []).length));
  const colStat = [];
  for (let c = 0; c < maxCol; c++) {
    colStat[c] = { time: 0, code: 0, text: 0, cn: 0, seq: 0, nonEmpty: 0, uniqCode: {} };
  }
  let expectSeq = 1;
  for (let i = 0; i < sample.length; i++) {
    const r = sample[i] || [];
    for (let c = 0; c < maxCol; c++) {
      const v = cellText(r[c]);
      if (!v) continue;
      const s = colStat[c];
      s.nonEmpty++;
      if (parseTime(v)) { s.time++; continue; }
      if (/^[0-9A-Fa-f]{8}$/.test(v.replace(/\s/g, ''))) { s.code++; s.uniqCode[v] = 1; continue; }
      if (/^\d{1,6}$/.test(v)) { if (Number(v) === expectSeq) s.seq++; expectSeq++; continue; }
      s.text++;
      if (/^[一-龥·]{2,5}$/.test(v)) s.cn++;
    }
  }
  const N = sample.length;
  const best = (key, minRatio) => {
    let bi = -1, bv = 0;
    for (let c = 0; c < maxCol; c++) {
      const n = colStat[c][key];
      if (n > bv && n >= N * minRatio) { bv = n; bi = c; }
    }
    return bi;
  };
  const timeCol = best('time', 0.3);
  if (timeCol < 0) return null;                 // 连时间列都找不到，放弃推断
  const codeCol = best('code', 0.3);
  // 名称列：文本最多且不是时间/编码/序号列
  let nameCol = -1, nv = 0;
  for (let c = 0; c < maxCol; c++) {
    if (c === timeCol || c === codeCol) continue;
    if (colStat[c].text > nv) { nv = colStat[c].text; nameCol = c; }
  }
  // 人员列：中文姓名最多，且与上面三列都不同
  let personCol = -1, pv = 0;
  for (let c = 0; c < maxCol; c++) {
    if (c === timeCol || c === codeCol || c === nameCol) continue;
    if (colStat[c].cn > pv) { pv = colStat[c].cn; personCol = c; }
  }
  // 序号列：递增整数命中最多
  let seqCol = -1, sv = 0;
  for (let c = 0; c < maxCol; c++) {
    if (c === timeCol) continue;
    if (colStat[c].seq > sv) { sv = colStat[c].seq; seqCol = c; }
  }
  return {
    seq: sv >= N * 0.5 ? seqCol : undefined,
    time: timeCol, device: -1,
    code: codeCol >= 0 ? codeCol : -1,
    person: personCol >= 0 ? personCol : -1,
    name: nameCol >= 0 ? nameCol : -1
  };
}

/* ============================ 夜班归属 ============================ */
/**
 * 归属夜班班次日期。
 *
 * 判定逻辑（与 Python 版 analysis.py 一致，参数化后更通用）：
 *   夜班窗口 = [startMin, 24:00) ∪ [00:00, endMin]，且以**起始日**为班次日
 *     - 时刻 >= startMin            → 当日夜班
 *     - 时刻 <= endMin              → 前一日夜班
 *     - 其余                        → 白班，返回 null
 *
 * @param {object} record   { timeAt }
 * @param {object} [wOpt]   夜班时段（字符串 'HH:MM' 或对象，见 resolveWindow）
 */
function assignShiftDate(record, wOpt) {
  const dt = new Date(record.timeAt);
  if (isNaN(dt.getTime())) return null;
  const w = resolveWindow(wOpt);
  const mins = dt.getHours() * 60 + dt.getMinutes();
  const day = fmtDate(dt);
  if (mins >= w.startMin) return day;
  if (mins <= w.endMin) return addDays(day, -1);
  return null;
}

function isNight(record, wOpt) { return assignShiftDate(record, wOpt) !== null; }

/* ============================ 班次构建 ============================ */
/**
 * 构建夜班班次
 * @param {Array} records
 * @param {string} start 起始班次日（含）
 * @param {string} end   结束班次日（含）
 * @param {object} [wOpt] 夜班时段（默认 18:30 ~ 次日 06:30）
 */
function buildNightShifts(records, start, end, wOpt) {
  const map = {};
  records.forEach(r => {
    const sd = assignShiftDate(r, wOpt);
    if (!sd) return;
    if (start && sd < start) return;
    if (end && sd > end) return;
    (map[sd] || (map[sd] = [])).push(r);
  });
  return Object.keys(map).sort().map(d => ({ shiftDate: d, records: map[d] }));
}

/**
 * 白班班次：不属于夜班窗口的记录，按自然日归组
 * @param {object} [wOpt] 夜班时段（须与夜班口径一致，否则会重复或漏算）
 */
function buildDayShifts(records, start, end, wOpt) {
  const map = {};
  records.forEach(r => {
    if (assignShiftDate(r, wOpt)) return;           // 夜班记录排除
    const d = String(r.time || '').slice(0, 10);
    if (!d) return;
    if (start && d < start) return;
    if (end && d > end) return;
    (map[d] || (map[d] = [])).push(r);
  });
  return Object.keys(map).sort().map(d => ({ shiftDate: d, records: map[d] }));
}

/* ============================ 日报 ============================ */
/**
 * 点位名称归一化 —— 用于「卡号对不上时按名称兜底匹配」。
 *
 * 【为什么需要】同一家物业不同月份的卡号体系可能完全不一样：
 *   2026-03 设备导出：00190466 → "T1 11南侧"、"T1  负一"（带 T1 塔号前缀）
 *   2026-07 整理表  ：0004854438 → "18F东面步梯间"
 * 两套卡号交集为 0。设备中途换过/重新发卡后，只按卡号匹配会让
 * 覆盖率恒为 0%、漏检数虚高到全部点位 —— 报表完全不可用。
 * 所以在卡号匹配之外，再按「归一化后的点位名称」匹配一次。
 */
function normPointName(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/\s/g, '')                 // 去掉所有空白（含全角空格，"T1  负一" → "T1负一"）
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))  // 全角转半角
    .replace(/[－−—–]/g, '-')          // 各类减号统一
    .toUpperCase();
}

/**
 * @param {object} shift      {shiftDate, records}
 * @param {Array}  points     标准巡检点（地点卡）
 * @param {Array<string>} nightPersons 夜班人员名单（为空则不限）
 * @param {object} [opt]
 *   bySegment=true 时启用「夜班 5 时段」口径（默认）：
 *     · 每晚每时段各自独立判定应巡/实巡
 *     · 同一时段同一巡点打 2/3 次只记 1 次；跨时段打卡**各时段各算一次**
 *     · 分母 = 点数 × 5；漏巡明细带时段维度
 *   bySegment=false 时退回旧的整夜去重口径（仅供对比对照，默认不用）
 */
function dailyReport(shift, points, nightPersons, opt) {
  const bySegment = !(opt && opt.bySegment === false);
  const codes = points.map(p => p.code);
  const codeSet = {};
  codes.forEach(c => { codeSet[c] = true; });
  // 名称 → 卡号 反查表（一个名称只映射一个卡号，重复名称以先出现者为准）
  const nameToCode = {};
  points.forEach(p => {
    const k = normPointName(p.name);
    if (k && nameToCode[k] === undefined) nameToCode[k] = p.code;
  });

  // 时段桶：segName -> { checked:{}, persons:{} }；未启用时段时只有一个 '__night__' 桶
  const buckets = {};
  const personSet = {};
  const np = nightPersons && nightPersons.length ? nightPersons.slice() : null;
  let byNameHit = 0;

  shift.records.forEach(r => {
    let hitCode = null;
    if (r.pointCode && codeSet[r.pointCode]) {
      hitCode = r.pointCode;
    } else {
      // 卡号没命中 → 退化到按名称匹配（跨月换卡号时唯一能救的路径）
      const byName = nameToCode[normPointName(r.pointName)];
      if (byName) { hitCode = byName; byNameHit++; }
    }
    const asg = bySegment ? assignSegment(r.timeAt) : null;
    const segName = bySegment
      ? (asg ? asg.seg : '__out__')          // __out__ = 夜班窗口外（白天 08:30-18:29），不计入
      : '__night__';
    if (bySegment && !asg) return;          // 时段外记录整条不参与统计

    const b = buckets[segName] || (buckets[segName] = { checked: {}, persons: {} });
    // 【关键】只在本时段内去重：同一时段同一巡点打 2 次只记 1 次。
    // 不跨时段去重 —— 否则 5 轮巡更被当成 1 轮，完成率虚高到 96.5%（历史 bug）。
    if (hitCode) b.checked[hitCode] = true;
    if (r.person) b.persons[r.person] = true;

    if (np) { if (np.indexOf(r.person) >= 0) personSet[r.person] = true; }
    else if (r.person) personSet[r.person] = true;
  });

  const persons = Object.keys(personSet).sort();
  // 当晚实际出现过的全部人员（含未登记在人员卡里的）
  const allMap = {};
  shift.records.forEach(r => { if (r.person) allMap[r.person] = true; });
  const allPersons = Object.keys(allMap).sort();

  const times = shift.records.map(r => r.timeAt).sort((a, b) => a - b);
  const nameOf = {};
  points.forEach(p => { nameOf[p.code] = p.name || p.code; });

  /* ---------- 分时段明细（每段独立应巡/实巡/漏巡） ---------- */
  const segNames = bySegment ? SEGMENT_NAMES : ['__night__'];
  const rounds = segNames.map(segName => {
    const b = buckets[segName] || { checked: {}, persons: {} };
    const coveredCodes = Object.keys(b.checked);
    const missing = codes.filter(c => !b.checked[c]);
    const ps = Object.keys(b.persons).sort();
    return {
      round: segName,
      should: codes.length,
      covered: coveredCodes.length,
      rate: codes.length ? Math.round(coveredCodes.length / codes.length * 10000) / 100 : 0,
      missingCodes: missing,
      missingPoints: missing.map(c => nameOf[c] || c),
      persons: ps,
      personText: ps.join('、') || '整时段无记录'
    };
  });

  // 应巡/实巡汇总：分母 = 点数 × 时段数（不是只 ×1）
  const totalExpected = bySegment ? codes.length * rounds.length : codes.length;
  let totalActual = 0;
  if (bySegment) {
    rounds.forEach(x => { totalActual += x.covered; });
  } else {
    const b = buckets['__night__'] || { checked: {} };
    totalActual = Object.keys(b.checked).length;
  }

  // missed 汇总（按点去重，仅用于「本夜该点一次都没巡到」这类天级查询；
  // 时段级漏巡请用 rounds[].missingPoints）
  const missedSet = {};
  if (bySegment) {
    rounds.forEach(x => { x.missingCodes.forEach(c => { missedSet[c] = true; }); });
  } else {
    const b = buckets['__night__'] || { checked: {} };
    codes.forEach(c => { if (!b.checked[c]) missedSet[c] = true; });
  }
  const missed = Object.keys(missedSet);

  const completeRounds = rounds.filter(x => x.covered > 0 && x.covered === x.should).length;
  const activeRounds = rounds.filter(x => x.covered > 0).length;

  return {
    shiftDate: shift.shiftDate,
    persons: persons,
    personText: persons.join('、'),
    allPersons: allPersons,
    allPersonText: allPersons.join('、'),
    // checked：非时段口径下= 该夜巡到的点；时段口径下= 各时段巡到的点并集
    // （仅供展示/兼容旧字段，统计请用 totalActual 与 rounds[].covered）
    checked: (function () {
      const s = {};
      rounds.forEach(x => { x.missingCodes.forEach(c => { s[c] = true; }); });
      return codes.filter(c => !s[c]);
    })(),
    missed: missed,
    missedPoints: missed.map(c => nameOf[c] || c),
    totalExpected: totalExpected,
    totalActual: totalActual,
    totalMissed: totalExpected - totalActual,
    recordCount: shift.records.length,
    // 诊断用：本班次里「靠名称兜底匹配上」的记录条数。
    // 占比高说明点位卡号与记录卡号不是同一套，需要核查是否中途换过设备/重新发卡。
    matchedByName: byNameHit,
    coverageRate: totalExpected ? Math.round(totalActual / totalExpected * 10000) / 100 : 0,
    // 时段口径附加字段
    bySegment: bySegment,
    rounds: rounds,
    completeRounds: completeRounds,
    activeRounds: activeRounds,
    firstTime: times.length ? fmtDateTime(new Date(times[0])) : '',
    lastTime: times.length ? fmtDateTime(new Date(times[times.length - 1])) : '',
    records: shift.records
  };
}

/* ============================ 月度汇总 ============================ */
function monthlySummary(reports) {
  const totalNights = reports.length;
  const totalExpected = reports.reduce((a, r) => a + r.totalExpected, 0);
  const totalActual = reports.reduce((a, r) => a + r.totalActual, 0);
  const totalMissed = totalExpected - totalActual;
  // 巡满天数：时段口径下= 该夜所有时段都巡满；非时段口径下= 一次都没漏
  const perfect = reports.filter(r => r.totalMissed === 0).length;

  // 巡满天数/有打卡时段数（时段口径的额外指标）
  let totalCompleteRounds = 0, totalActiveRounds = 0, totalRounds = 0;
  reports.forEach(r => {
    if (!r.bySegment) return;
    totalCompleteRounds += r.completeRounds || 0;
    totalActiveRounds += r.activeRounds || 0;
    totalRounds += (r.rounds || []).length;
  });

  // 各时段完成率（时段口径）
  const segStat = {};
  if (SEGMENT_NAMES.length) SEGMENT_NAMES.forEach(n => { segStat[n] = { segment: n, expected: 0, covered: 0, zeroNights: 0, nights: 0 }; });
  reports.forEach(r => {
    (r.rounds || []).forEach(x => {
      const s = segStat[x.round];
      if (!s) return;
      s.expected += x.should; s.covered += x.covered; s.nights++;
      if (!x.covered) s.zeroNights++;
    });
  });
  const segments = Object.keys(segStat).map(k => {
    const s = segStat[k];
    s.missed = s.expected - s.covered;
    s.rate = s.expected ? Math.round(s.covered / s.expected * 10000) / 100 : 0;
    return s;
  });

  // TOP 漏检点
  // 【时段口径】按「点次」计：某点该夜漏 5 个时段就记 5 次，
  // 这样 TOP 排名反映真实漏巡量；跨夜累计则能看出哪几个点整月没巡过。
  const missCount = {};
  const missNights = {};
  reports.forEach(r => {
    (r.rounds || []).forEach(x => {
      x.missingPoints.forEach((nm, i) => {
        const c = x.missingCodes[i] || nm;
        if (!missCount[nm]) missCount[nm] = { code: c, name: nm, count: 0, nights: {} };
        missCount[nm].count++;
        missCount[nm].nights[r.shiftDate] = 1;
      });
    });
    // 兼容非时段口径（rounds 为空时退回 missedPoints）
    if (!r.bySegment) {
      (r.missedPoints || []).forEach((nm, i) => {
        const c = (r.missed || [])[i] || nm;
        if (!missCount[nm]) missCount[nm] = { code: c, name: nm, count: 0, nights: {} };
        missCount[nm].count++;
        missCount[nm].nights[r.shiftDate] = 1;
      });
    }
  });
  const topMissed = Object.keys(missCount).map(k => {
    const o = missCount[k];
    o.nightCount = Object.keys(o.nights).length;
    o.neverChecked = o.nightCount >= totalNights;   // 整夜一整月都没巡到
    delete o.nights;
    return o;
  }).sort((a, b) => (b.count - a.count) || (a.name < b.name ? -1 : 1));

  // 人员统计（按当晚实际出现的全部人员）
  const stats = {};
  const touch = p => (stats[p] || (stats[p] = { person: p, nights: 0, expected: 0, checked: 0, missed: 0, records: 0 }));
  reports.forEach(r => {
    const crew = (r.allPersons && r.allPersons.length) ? r.allPersons : (r.persons.length ? r.persons : ['未知']);
    crew.forEach(p => {
      const s = touch(p);
      s.nights++;
      s.expected += r.totalExpected;
      s.checked += r.totalActual;
      s.missed += r.totalMissed;
    });
  });
  // 打卡条数按人统计
  reports.forEach(r => {
    r.records.forEach(rec => { touch(rec.person || '未知').records++; });
  });
  const personStats = Object.keys(stats).map(k => {
    const s = stats[k];
    s.rate = s.expected ? Math.round(s.checked / s.expected * 10000) / 100 : 0;
    s.shift = (s.person || '').indexOf('夜班') >= 0 ? '夜班' : ((s.person || '').indexOf('白班') >= 0 ? '白班' : '未登记');
    return s;
  }).sort((a, b) => b.nights - a.nights || (a.person < b.person ? -1 : 1));

  return {
    totalNights: totalNights,
    totalExpected: totalExpected,
    totalActual: totalActual,
    totalMissed: totalMissed,
    perfectNights: perfect,
    coverageRate: totalExpected ? Math.round(totalActual / totalExpected * 10000) / 100 : 0,
    perfectRate: totalNights ? Math.round(perfect / totalNights * 10000) / 100 : 0,
    // ��段口径附加
    totalRounds: totalRounds,
    totalCompleteRounds: totalCompleteRounds,
    totalActiveRounds: totalActiveRounds,
    segments: segments,
    topMissed: topMissed,
    personStats: personStats
  };
}

/* ============================ 总入口 ============================ */
/**
 * @param {object} p
 *   points       标准巡检点数组（地点卡）
 *   records      巡查记录数组
 *   start/end    班次日期范围 YYYY-MM-DD（可选）
 *   mode         'night' 夜班（默认）| 'day' 白班
 *   nightPersons 夜班人员名单（可选，为空则不限人员）
 *   window       夜班时段（可选）：'18:30' 字符串，或 { startMin, endMin } / { startH,startM,endH,endM }
 *                不传则用默认 18:30 ~ 次日 08:30
 *   bySegment    夜班 5 时段口径（默认 true）；传false 退回整夜去重（仅用于对照）
 *   strictWindow true 时排除「窗口不完整」的夜班（数据首日的前一夜、末日的后一夜），
 *                口径原文：「仅纳入窗口完整落在数据范围内的夜班」。
 *                默认 true —— 避免最后一天夜班只有半段记录被算成大面积漏巡。
 * @returns {{daily:Array, monthly:object, mode:string, window:object, windowText:string}}
 */
function analyze(p) {
  const opt = p || {};
  const points = opt.points || [];
  const records = opt.records || [];
  const mode = opt.mode === 'day' ? 'day' : 'night';
  const w = resolveWindow(opt.window);
  const bySegment = opt.bySegment !== false;
  // 白班是自然日归组，不适用夜班时段口径
  const useSeg = (mode === 'night') && bySegment;
  const strict = opt.strictWindow !== false;

  let shifts = mode === 'day'
    ? buildDayShifts(records, opt.start, opt.end, w)
    : buildNightShifts(records, opt.start, opt.end, w);

  // 【窗口完整性】夜班窗口 = 班次日 18:30 ~ 次日 08:29:59。
  // 若这个窗口超出了实际数据的时间范围（数据首日之前 / 数据末日之后），
  // 该夜班就只有一个半段记录，纳进统计会凭空产生几十个假漏检 —— 必须排除。
  let dataMin = null, dataMax = null, excludedNights = [];
  if (useSeg && strict && records.length) {
    records.forEach(r => {
      const t = r.timeAt;
      if (typeof t !== 'number' || isNaN(t)) return;
      if (dataMin === null || t < dataMin) dataMin = t;
      if (dataMax === null || t > dataMax) dataMax = t;
    });
    if (dataMin !== null) {
      shifts = shifts.filter(sh => {
        // 夜班窗口 = 班次日 18:30 ~ **次日** 08:29:59
        // （结束时间在次日，跨天；这里最容易漏加一天，导致末日那夜被误判为「完整」）
        const winStart = new Date(sh.shiftDate + 'T18:30:00').getTime();
        const winEnd = new Date(sh.shiftDate + 'T00:00:00').getTime()
          + 24 * 3600000          // 次日
          + (8 * 60 + 30) * 60000 // 08:30
          - 1000;                 // 08:29:59
        const okStart = winStart >= dataMin;
        const okEnd = winEnd <= dataMax;
        if (!okStart || !okEnd) { excludedNights.push(sh.shiftDate); return false; }
        return true;
      });
    }
  }

  const crew = mode === 'day' ? opt.dayPersons : opt.nightPersons;
  const daily = shifts.map(s => dailyReport(s, points, crew, { bySegment: useSeg }));
  const monthly = monthlySummary(daily);
  return {
    daily: daily, monthly: monthly, mode: mode,
    window: w, windowText: windowText(w),
    bySegment: useSeg,
    segments: useSeg ? SEGMENT_NAMES : [],
    segmentText: useSeg ? segmentDescriptions() : '',
    excludedNights: excludedNights,
    dataStart: dataMin !== null ? fmtDate(new Date(dataMin)) : '',
    dataEnd: dataMax !== null ? fmtDate(new Date(dataMax)) : ''
  };
}

// 人员名单：按班次从人员卡筛选；人员卡缺失时从记录的「夜班-/白班-」前缀自动识别
function personNamesOf(persons, records, shift) {
  const set = {};
  (persons || []).forEach(x => {
    const nm = x.name || '';
    const sh = x.shift || (nm.indexOf('夜班') >= 0 ? '夜班' : nm.indexOf('白班') >= 0 ? '白班' : '');
    if (!shift || sh === shift) set[nm] = true;
  });
  if (!Object.keys(set).length && shift) {
    (records || []).forEach(r => { if ((r.person || '').indexOf(shift) >= 0) set[r.person] = true; });
  }
  return Object.keys(set);
}
function nightPersonNames(persons, records) { return personNamesOf(persons, records, '夜班'); }

module.exports = {
  NIGHT_START_MIN, NIGHT_END_MIN,
  NIGHT_SEGMENTS, SEGMENT_NAMES,
  assignSegment, segmentDescriptions, hm2min,
  resolveWindow, windowText, defaultWindowText: windowText(defaultWindow()),
  parseTime, fmtDateTime, pointSortKey,
  parsePoints, parseRecords, matchHeader, inferRecordColumns, REC_ALIASES,
  normPointName, looksLikeRecordHeader, matchPtHeader,
  assignShiftDate, isNight, buildNightShifts, buildDayShifts,
  dailyReport, monthlySummary, analyze, nightPersonNames, personNamesOf
};
