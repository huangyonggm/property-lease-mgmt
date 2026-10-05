'use strict';
/**
 * 合同比对引擎
 *
 * 目标：招商部上报的合同（PDF/图片/DOCX）与
 *      ① 系统里已录入的合同数据
 *      ② 物业的标准模板（contractTemplate.js）
 * 三方比对，把"改动的地方"自动标注出来。
 *
 * 三层比对：
 *   L1 槽位比对   —— 6 个可变槽位（编号/甲乙方/面积/租期/租金/保证金）逐项核对
 *                     既比"合同文本填了啥"，也比"与系统数据是否一致"
 *   L2 条款比对   —— 16 章节 + 18 核心条款：有没有漏、有没有被改写
 *   L3 数值交叉  —— 合同文本里的金额/面积/日期 与 系统数据 互校
 *
 * 差异分级：high（必须改）/ medium（应改）/ low（提示）
 * 每条差异都带 evidence（证据），前端要能显示"哪句不一样"。
 */
const { money, num } = require('./util');
const { SLOTS, CLAUSES, FIXED_ITEMS, NOISE, SEVERITY_ORDER } = require('./contractTemplate');

/* ---------------- 文本归一 ---------------- */

/** 归一：去空白、全角转半角、常见异体字统一 —— 比对前必做，否则全是假差异 */
function norm(s) {
  if (s === undefined || s === null) return '';
  let t = String(s);
  t = t.replace(/[\s\u3000]+/g, '');            // 所有空白（含全角空格）
  t = t.replace(/[﹣–—―]/g, '-');                 // 各种横线
  t = t.replace(/[（]/g, '(').replace(/[）]/g, ')');
  t = t.replace(/[，]/g, ',').replace(/[。]/g, '.')
       .replace(/[：]/g, ':').replace(/[；]/g, ';')
       .replace(/[？]/g, '?').replace(/[！]/g, '!');
  t = t.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  t = t.replace(/[Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  t = t.replace(/ /g, '');
  t = t.replace(/[○Ｏ]/g, '0');
  return t;
}
/** 保留空格的宽松归一（用于展示，不用于判定） */
function normLoose(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/[\u3000]+/g, ' ').replace(/[ 　]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** 阿拉伯小写数字 */
const CN_NUM = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
/** 中文大写数字（合同金额必须用大写，规范用壹贰叁…） */
const CN_NUM_UP = {
  零: 0, 〇: 0, 壹: 1, 贰: 2, 貳: 2, 叁: 3, 參: 3, 肆: 4, 伍: 5, 陆: 6, 陸: 6,
  柒: 7, 捌: 8, 玖: 9, 壹: 1
};
const CN_UNIT = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 10000, 萬: 10000, 亿: 100000000, 億: 100000000 };
/** 角分处理：1.23 元 */

/**
 * 中文大写金额 → 数字
 * ⚠ 必须同时支持小写「一二三」与大写「壹贰叁」两套数字 ——
 *   合同实务两种都有人写，只认一套会漏判（第一版就栽在这，返回 null 静默跳过校验）。
 * @returns {number|null} 解析不了就返回 null（调用方必须当"无法核对"处理，不能当 0）
 */
function cnToNum(cn) {
  // 关键：先按「元/圆」把整数部分与角分开
  // 「壹佰贰拾叁元肆角伍分」→ 整数「壹佰贰拾叁」+ 小数「肆角伍分」
  // 若先把「元」删掉，就分不清「叁」是整数位还是角的前导 → 吞位
  let s0 = String(cn === undefined || cn === null ? '' : cn)
    .replace(/[\s圆圆整正]/g, '')
    .replace(/[人民币￥¥]/g, '');
  if (!s0) return null;
  if (/[0-9]/.test(s0)) {
    const m = s0.match(/[0-9][0-9,]*(?:\.[0-9]+)?/);
    return m ? num(m[0].replace(/,/g, '')) : null;
  }
  const yuanIdx = s0.search(/[元]/);
  const intPart = yuanIdx >= 0 ? s0.slice(0, yuanIdx) : s0;
  const fracPart = yuanIdx >= 0 ? s0.slice(yuanIdx + 1) : '';

  // 整数部分：节权累加
  const parseIntPart = str => {
    if (!str) return null;
    let total = 0, section = 0, cur = 0, seen = false;
    for (const ch of str) {
      const d = CN_NUM_UP[ch] !== undefined ? CN_NUM_UP[ch]
              : (CN_NUM[ch] !== undefined ? CN_NUM[ch] : undefined);
      if (d !== undefined) { cur = d; seen = true; continue; }
      const u = CN_UNIT[ch];
      if (u !== undefined) {
        if (u >= 10000) { section = (section + cur) * u; total += section; section = 0; cur = 0; }
        else { section += (cur === 0 ? 1 : cur) * u; cur = 0; }
        seen = true; continue;
      }
      return null;   // 非法字符
    }
    return seen ? total + section + cur : null;
  };
  const intVal = parseIntPart(intPart);
  if (intVal === null) return null;

  // 角分部分：形如「肆角伍分」「零角伍分」
  let jiao = 0, fen = 0, fcur = 0, fseen = false;
  for (const ch of fracPart) {
    if (ch === '角') { jiao += (fcur || 0); fseen = true; fcur = 0; continue; }
    if (ch === '分') { fen += (fcur || 0); fseen = true; fcur = 0; continue; }
    const d = CN_NUM_UP[ch] !== undefined ? CN_NUM_UP[ch] : CN_NUM[ch];
    if (d !== undefined) { fcur = d; fseen = true; continue; }
  }
  const frac = jiao * 0.1 + fen * 0.01;

  const val = intVal + frac;
  if (intVal === 0 && !fseen) return null;   // 什么都没解析到 → 失败
  return Math.round(val * 100) / 100;         // 「零元整」= 0 是合法金额
}

/* ---------------- 从合同文本抽取槽位值 ---------------- */

/** 从某段文本里按锚句定位，抽取实值（模板里是 ******，实际合同里是真值） */
function extractSlot(paras, slot) {
  const joined = paras.map(p => p.text);
  // 找到含 anchor 的那一段（可能 anchor 在前、值在后）
  let hostIdx = -1;
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] && norm(joined[i]).indexOf(norm(slot.anchor)) >= 0) { hostIdx = i; break; }
  }
  if (hostIdx < 0) {
    // anchor 退化：按 subAnchor 找
    if (slot.subAnchor) {
      for (let i = 0; i < joined.length; i++) {
        if (norm(joined[i]).indexOf(norm(slot.subAnchor)) >= 0) { hostIdx = i; break; }
      }
    }
  }
  if (hostIdx < 0) return { found: false, raw: '', host: -1, evidence: '未在合同中找到「' + slot.anchor + '」所在段落' };

  const after = normLoose(joined[hostIdx]).split(normLoose(slot.anchor)).slice(1).join(normLoose(slot.anchor)).trim();
  let raw = '';
  // scope:'sentence' —— 锚句里可能有多个同类值（如「自X起至Y日止」有两个日期），
  // 用 nth 指定取第几个，避免永远取第一个。
  const nth = slot.nth || 1;
  switch (slot.type) {
    case 'money': {
      // ￥**** 元（大写：****元整）
      const m = after.match(/[￥¥]?\s*([\d,]+(?:\.\d+)?)\s*元?/) ||
                after.match(/([\d,]+(?:\.\d+)?)\s*元/);
      raw = m ? m[1].replace(/,/g, '') : '';
      break;
    }
    case 'area': {
      const m = after.match(/([\d,]+(?:\.\d+)?)\s*平方米/) || after.match(/面积\s*([\d,]+(?:\.\d+)?)/);
      raw = m ? m[1].replace(/,/g, '') : '';
      break;
    }
    case 'date': {
      const all = [];
      const re1 = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
      let m1;
      while ((m1 = re1.exec(after))) {
        all.push(m1[1] + '-' + String(m1[2]).padStart(2, '0') + '-' + String(m1[3]).padStart(2, '0'));
      }
      // 也接受 2026-01-13 形式
      const re2 = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g;
      let m2;
      while ((m2 = re2.exec(after))) {
        const v = m2[1] + '-' + String(m2[2]).padStart(2, '0') + '-' + String(m2[3]).padStart(2, '0');
        if (all.indexOf(v) < 0) all.push(v);
      }
      raw = all[nth - 1] || '';
      break;
    }
    case 'int': {
      const m = after.match(/(\d+)\s*年/);
      raw = m ? m[1] : '';
      break;
    }
    case 'location': {
      // 模板：T3﹣第***层***单元
      // ⚠ 房号格式是「楼栋-楼层-房号」（T3-10-04），楼层是**第 2 段**不是第 3 段。
      //   第一版取了第 3 段（房号 10），结果「第3层04单元」对不上合同里的「第10层04单元」。
      const m = after.match(/第\s*([0-9０-９一二三四五六七八九十]+)\s*层/) ||
                after.match(/T3-?第?\s*([0-9]+)\s*层/);
      if (m) raw = String(m[1]).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
      break;
    }
    default: {
      // 纯文本：优先从 subAnchor 所在段取值（如「承租方（乙方）：XXX」后面独立成段的
      //   「法定代表人：YYY」「联系方式：ZZZ」），否则从 anchor 段取。
      //   ⚠ 不能一律用 anchor 段 —— 那样甲乙方四行会全取成公司名（第一版就這樣错的）。
      let src = joined[hostIdx];
      if (slot.subAnchor) {
        for (let i = hostIdx; i < Math.min(hostIdx + 4, joined.length); i++) {
          if (norm(joined[i]).indexOf(norm(slot.subAnchor)) >= 0) { src = joined[i]; break; }
        }
      }
      let v = normLoose(src).split(normLoose(slot.subAnchor || slot.anchor))
        .slice(1).join(normLoose(slot.subAnchor || slot.anchor)).trim();
      // 到下一个已知标签为止
      const stop = /法定代表人|联系方式|承租方|出租方|签署|日期|电话|地址/.exec(v);
      raw = (stop ? v.slice(0, stop.index) : v).trim();
      raw = raw.replace(/[：:\s]+$/, '').trim();
      if (raw.length > 60) raw = raw.slice(0, 60);
    }
  }
  return {
    found: !!raw, raw: raw, host: hostIdx,
    evidence: normLoose(joined[hostIdx]).slice(0, 120)
  };
}

/** 抽取合同里所有金额（用于 L3 交叉校验） */
function extractAllMoney(text) {
  const t = normLoose(text);
  const out = [];
  const re = /(?:￥|¥)?\s*([0-9][0-9,，]*(?:\.[0-9]{1,2})?)\s*元/g;
  let m;
  while ((m = re.exec(t))) {
    const v = num(m[1].replace(/[,，]/g, ''));
    if (v) out.push({ value: v, at: m.index, context: t.slice(Math.max(0, m.index - 20), m.index + 20) });
  }
  return out;
}
/** 抽取所有"大写"金额 */
function extractCnMoney(text) {
  const t = normLoose(text);
  // ⚠ 字符集必须同时含小写(零一二三四五六七八九十百千万)与大写(零壹贰叁肆伍陆柒捌玖拾佰仟萬億)数字，
  //   还要含单位(角分元整) —— 第一版只写了大写数字+部分单位，
  //   导致「五千六百四十七元整」这种（数字用小写）的正常写法一个都匹配不到，
  //   静默返回空数组 → 大小写一致性校验形同虚设。
  const CH = '零〇一二三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟萬億元角分整圆壹贰叁肆伍陆柒捌玖拾佰仟';
  const re = new RegExp('大写[:：]?\\s*[' + CH + '0-9.,￥¥]{2,40}', 'g');
  const out = [];
  let m;
  while ((m = re.exec(t))) {
    const raw = m[0].replace(/^大写[:：]?\s*/, '');
    const v = cnToNum(raw);
    out.push({ raw: raw, value: v, at: m.index, context: t.slice(Math.max(0, m.index - 10), m.index + 46) });
  }
  return out;
}
/** 抽取所有日期 */
function extractAllDates(text) {
  const t = normLoose(text);
  const out = [];
  const re = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  let m;
  while ((m = re.exec(t))) {
    out.push({
      value: m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0'),
      at: m.index, context: t.slice(Math.max(0, m.index - 20), m.index + 20)
    });
  }
  return out;
}

/** 取 pos 位置所在的「（…）」括号内容（含括号）；找不到返回 null */
function bracketOf(text, pos) {
  const open = text.lastIndexOf('（', pos);
  if (open < 0) return null;
  // 也要兼容半角
  const open2 = text.lastIndexOf('(', pos);
  const o = Math.max(open, open2);
  if (o < 0) return null;
  const closeIdx = text.indexOf('）', pos);
  const closeIdx2 = text.indexOf(')', pos);
  const c = closeIdx < 0 ? closeIdx2 : (closeIdx2 < 0 ? closeIdx : Math.min(closeIdx, closeIdx2));
  if (c < 0) return null;
  if (c <= o) return null;
  return text.slice(o, c + 1);
}

/* ---------------- L1 槽位比对 ---------------- */

function cmpSlot(slot, doc, contract, rooms) {
  const got = extractSlot(doc.paras, slot);
  const diffs = [];
  const expectRaw = buildExpect(slot, contract, rooms);

  // (a) 占位符没填 / 没找到
  if (!got.found) {
    // 区分「模板占位符原样留着」和「整段缺失」
    const isPlaceholder = /\*\*\*/.test(normLoose(got.evidence));
    diffs.push({
      type: 'slot_empty', severity: slot.severity || 'medium',
      label: slot.label,
      msg: isPlaceholder ? '占位符未填写（仍是 ******）' : '合同中未找到该项内容',
      expected: expectRaw.display, actual: isPlaceholder ? '******' : '(缺失)',
      evidence: got.evidence
    });
    return diffs;
  }

  // (b) 与系统数据比
  if (expectRaw.value !== null && expectRaw.value !== undefined && expectRaw.value !== '') {
    const ok = compareByType(slot.type, got.raw, expectRaw.value);
    if (!ok.equal) {
      diffs.push({
        type: 'slot_mismatch', severity: slot.severity || 'medium',
        label: slot.label,
        msg: '合同文本与系统数据不一致',
        expected: expectRaw.display, actual: got.raw,
        hint: expectRaw.hint,
        evidence: got.evidence
      });
    }
  } else {
    // 系统无对应数据 → 只报"有值"，交人工确认
    if (expectRaw.display === null) {
      diffs.push({
        type: 'slot_manual', severity: 'low', label: slot.label,
        msg: '合同文本有值，但系统无对应字段，需人工确认',
        expected: '(系统无此字段)', actual: got.raw, evidence: got.evidence
      });
    }
  }

  // (c) 格式合规
  if (slot.pattern && !slot.pattern.test(got.raw.replace(/\s/g, ''))) {
    diffs.push({
      type: 'slot_format', severity: 'medium', label: slot.label,
      msg: '格式不符合模板约定', expected: slot.patternHint || slot.pattern.source,
      actual: got.raw, evidence: got.evidence
    });
  }
  return diffs;
}

/** 构造期望值（含推导逻辑） */
function buildExpect(slot, ct, rooms) {
  const D = (v) => v === undefined || v === null || v === '' ? null : v;
  switch (slot.key) {
    case 'contractCode': {
      const code = D(ct.code);
      return { value: code, display: code || '(系统无)', hint: '系统合同编号与模板前缀规则可能不同，注意核对' };
    }
    case 'location': {
      // 房号格式「楼栋-楼层-房号」（T3-10-04）→ 楼层是第 2 段、单元/房号是第 3 段
      const codes = (ct.roomCodes || []).join(',');
      const seg = String(codes).split(',')[0].split('-');
      if (seg.length < 2) return { value: null, display: null };
      const floor = seg[1];
      const unit = seg[2] || seg[1];
      return {
        value: floor,
        display: '第' + floor + '层' + unit + '单元',
        hint: '房号 ' + codes + '（楼栋-楼层-房号）'
      };
    }
    case 'rentYears': {
      if (!ct.startDate || !ct.endDate) return { value: null, display: null };
      const s = new Date(ct.startDate), e = new Date(ct.endDate);
      const years = Math.round((e - s) / (365.25 * 86400000));
      return { value: String(years), display: years + ' 年（' + ct.startDate + ' ~ ' + ct.endDate + '）' };
    }
    case 'lesseeAddress': {
      // 模板：乙方地址：武汉市东西湖区…梦想之城T3栋****室
      // 系统没有单独的"送达地址"字段，用房号近似比对（只比"栋__室"这一段）
      const codes = (ct.roomCodes || []).join(',');
      const room = rooms && rooms.find(r => r && String(r.code) === codes.split(',')[0]);
      if (!room) return { value: null, display: null };
      const unit = String(room.code).split('-').pop();
      return { value: unit, display: 'T3栋' + unit + '室（房号 ' + room.code + '）', hint: '房号 ' + room.code };
    }
    default: {
      const f = slot.dbField;
      if (!f) return { value: null, display: null };
      const v = D(ct[f]);
      if (v === null) return { value: null, display: null };
      if (slot.type === 'money') return { value: money(num(v)), display: money(num(v)) + ' 元' };
      return { value: v, display: String(v) };
    }
  }
}

/** 按类型比对，返回 {equal, note} */
function compareByType(type, actual, expect) {
  const a = String(actual === undefined || actual === null ? '' : actual).trim();
  const e = String(expect === undefined || expect === null ? '' : expect).trim();
  switch (type) {
    case 'money':
    case 'area': {
      const av = num(a.replace(/[,，]/g, '')), ev = num(e.replace(/[,，]/g, ''));
      if (isNaN(av) || isNaN(ev)) return { equal: a === e, note: '非数字' };
      // 金额容差 0.01（分），面积容差 0.01
      const tol = 0.011;
      return { equal: Math.abs(av - ev) <= tol, note: av === ev ? '' : '差 ' + money(av - ev) };
    }
    case 'date': {
      const norm2 = x => String(x).replace(/[年月]/g, '-').replace(/日/, '').replace(/\s+/g, '').replace(/-+$/, '');
      return { equal: norm2(a) === norm2(e), note: '' };
    }
    case 'int': {
      return { equal: num(a) === num(e), note: '' };
    }
    default: {
      const an = norm(a), en = norm(e);
      if (an === en) return { equal: true, note: '' };
      // 宽松：包含关系（合同里常带后缀，如"武汉晨曦科技有限公司" vs "晨曦科技"）
      if (an.length >= 2 && en.length >= 2 && (an.indexOf(en) >= 0 || en.indexOf(an) >= 0)) {
        return { equal: true, note: '部分匹配' };
      }
      return { equal: false, note: '' };
    }
  }
}

/* ---------------- L2 条款比对 ---------------- */

/** 最长公共子序列比（对条款改写敏感，比编辑距离更适合中文） */
function lcsRatio(a, b) {
  a = norm(a); b = norm(b);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  // 长文本用双字符 bag 加速
  if (a.length > 200 || b.length > 200) {
    const bag = s => { const m = {}; for (let i = 0; i < s.length - 1; i++) { const g = s.substr(i, 2); m[g] = (m[g] || 0) + 1; } return m; };
    const ba = bag(a), bb = bag(b);
    let inter = 0, ta = 0, tb = 0;
    Object.keys(ba).forEach(k => { ta += ba[k]; inter += Math.min(ba[k], bb[k] || 0); });
    Object.keys(bb).forEach(k => { tb += bb[k]; });
    return ta && tb ? (2 * inter) / (ta + tb) : 0;
  }
  const n = a.length, m = b.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return (2 * dp[n][m]) / (n + m);
}

function cmpClauses(doc) {
  const diffs = [];
  const text = doc.text;
  const ntext = norm(text);
  const paras = doc.paras.filter(p => p.text && norm(p.text));

  // (a) 章节标题缺失
  CLAUSES.filter(c => c.mode === 'title').forEach(c => {
    const hit = paras.some(p => c.match.test(normLoose(p.text).trim()));
    if (!hit) {
      diffs.push({
        type: 'clause_missing', severity: c.severity, label: c.label,
        msg: '标准模板的章节标题未出现（可能被删除或改名）',
        expected: c.label, actual: '(未找到)', clauseId: c.id
      });
    }
  });

  // (b) 核心条款缺失 / 被改写
  CLAUSES.filter(c => c.mode === 'fuzzy').forEach(c => {
    if (!c.must.test(ntext)) {
      // 区分「整段删除」与「文字被改」：找该条款最相似的段落
      let best = { r: 0, p: null };
      paras.forEach(p => {
        const r = lcsRatio(c.expect, p.text);
        if (r > best.r) best = { r, p };
      });
      const rewritten = best.r >= 0.45;
      diffs.push({
        type: rewritten ? 'clause_rewritten' : 'clause_missing',
        severity: c.severity,
        label: c.label,
        msg: rewritten
          ? '条款内容被改写（相似度 ' + Math.round(best.r * 100) + '%）'
          : '标准模板的关键条款缺失',
        expected: c.expect, actual: best.p ? normLoose(best.p.text).slice(0, 160) : '(未找到)',
        similarity: rewritten ? Math.round(best.r * 100) : 0,
        clauseId: c.id, group: c.group
      });
    }
  });

  // (c) 固定项
  FIXED_ITEMS.forEach(f => {
    let ok = false;
    if (f.expect) ok = ntext.indexOf(norm(f.expect)) >= 0;
    if (f.must) ok = f.must.test(ntext);
    if (!ok) {
      let best = { r: 0, p: null };
      if (f.expect) {
        paras.forEach(p => {
          const r = lcsRatio(f.expect, p.text);
          if (r > best.r) best = { r, p };
        });
      }
      diffs.push({
        type: 'fixed_mismatch', severity: f.severity, label: f.label,
        msg: best.r > 0.3 ? '固定内容被改写' : '标准模板的固定内容缺失',
        expected: f.expect || (f.must && f.must.source) || f.label,
        actual: best.p ? normLoose(best.p.text).slice(0, 120) : '(未找到)',
        similarity: Math.round(best.r * 100)
      });
    }
  });

  // (d) 多余章节：合同里有、模板里没有的加粗标题
  const tplTitles = CLAUSES.filter(c => c.mode === 'title').map(c => norm(c.label));
  paras.filter(p => p.bold).forEach(p => {
    const t = normLoose(p.text).trim();
    if (!t || t.length > 30) return;
    if (!/^[一二三四五六七八九十]+、/.test(t)) return;
    const nt = norm(t);
    if (tplTitles.some(x => nt.indexOf(x) >= 0 || x.indexOf(nt) >= 0)) return;
    diffs.push({
      type: 'clause_extra', severity: 'medium', label: '多出的章节：' + t,
      msg: '标准模板中没有这一章节（擅自增加条款）',
      expected: '(模板无此章节)', actual: t
    });
  });

  return diffs;
}

/* ---------------- L3 数值交叉校验 ---------------- */

function cmpNumbers(doc, contract) {
  const diffs = [];
  const text = doc.text;

  // (a) 大写与小写金额是否一致
  // ⚠ 配对规则（踩过两次坑才定下来）：
  //   ① 窗口 ±60 字符 → 会把邻近的「物业费 9.9 元」也拉进来，同一处篡改报 3 条重复
  //   ② 只看「（大写：X）」括号内 → 找不到，因为模板里小写金额在括号**外**：
  //      「…￥********元（大写：***********元整）」← 小写在左括号之前
  //   正确做法：取「大写」左侧最近的那个金额（距离 0~30 字内），
  //   这样既锁定同一笔金额，又不会跨到别的句子。
  const cnList = extractCnMoney(text);
  cnList.forEach(cn => {
    if (cn.value === null) {
      diffs.push({
        type: 'cn_money_unparsed', severity: 'low', label: '大写金额无法解析',
        msg: '中文大写金额未能解析，请人工核对', expected: cn.raw, actual: cn.raw
      });
      return;
    }
    const left = text.slice(Math.max(0, cn.at - 40), cn.at);
    const leftMoney = extractAllMoney(left);
    if (!leftMoney.length) return;                  // 没有对应小写金额，跳过（不误报）
    const m = leftMoney[leftMoney.length - 1];      // 左侧最近的那个
    if (Math.abs(money(num(m.value)) - cn.value) > 0.02) {
      diffs.push({
        type: 'cn_money_mismatch', severity: 'high', label: '金额大小写不一致',
        msg: '大写金额与小写金额对不上（可能是篡改）',
        expected: '大写「' + cn.raw + '」= ' + money(cn.value) + ' 元',
        actual: '小写 ' + m.value + ' 元',
        evidence: cn.context
      });
    }
  });

  // (b) 合同里的月租金与系统是否一致（合同文本必须出现系统金额）
  const moneyList = extractAllMoney(text);
  const sysRent = money(num(contract.rentMonthly));
  if (sysRent > 0) {
    const has = moneyList.some(m => Math.abs(money(num(m.value)) - sysRent) <= 0.02);
    if (!has) {
      diffs.push({
        type: 'rent_not_found', severity: 'high', label: '合同中找不到系统记录的月租金',
        msg: '合同全文未出现系统记录的月租金 ' + sysRent + ' 元',
        expected: sysRent + ' 元',
        actual: moneyList.length ? '合同中出现的金额：' + moneyList.slice(0, 6).map(m => m.value).join('、') : '(合同中无金额)',
        evidence: moneyList.length ? moneyList[0].context : ''
      });
    }
  }

  // (c) 合同里的起止日期与系统是否一致
  const dateList = extractAllDates(text);
  [['startDate', '起租日'], ['endDate', '到期日']].forEach(([f, label]) => {
    const v = contract[f];
    if (!v) return;
    const has = dateList.some(d => d.value === String(v).slice(0, 10));
    if (!has) {
      diffs.push({
        type: 'date_not_found', severity: 'high', label: '合同中找不到系统记录的' + label,
        msg: '合同全文未出现系统记录的' + label + ' ' + v,
        expected: String(v).slice(0, 10),
        actual: dateList.length ? '合同中出现的日期：' + dateList.slice(0, 6).map(d => d.value).join('、') : '(合同中无日期)',
        evidence: dateList.length ? dateList[0].context : ''
      });
    }
  });

  // (d) 合同里的面积与系统是否一致
  const sysArea = num(contract.area);
  if (sysArea > 0) {
    const re = /([\d,]+(?:\.\d+)?)\s*平方米/g;
    let m; const areas = [];
    while ((m = re.exec(normLoose(text)))) areas.push(num(m[1].replace(/,/g, '')));
    const has = areas.some(a => Math.abs(a - sysArea) <= 0.01);
    if (!has) {
      diffs.push({
        type: 'area_not_found', severity: 'high', label: '合同中找不到系统记录的面积',
        msg: '合同全文未出现系统记录的签约面积 ' + sysArea + ' ㎡',
        expected: sysArea + ' ㎡',
        actual: areas.length ? '合同中出现的面积：' + areas.slice(0, 6).join('、') + ' ㎡' : '(合同中无面积)'
      });
    }
  }

  return diffs;
}

/* ---------------- 占位符残留检查 ---------------- */

function checkLeftoverPlaceholders(doc) {
  const diffs = [];
  doc.paras.forEach((p, i) => {
    if (/\*{2,}/.test(p.text)) {
      diffs.push({
        type: 'placeholder_left', severity: 'high',
        label: '第 ' + (i + 1) + ' 段仍有未填占位符',
        msg: '模板占位符 ****** 未替换成实际内容',
        expected: '实际值', actual: (p.text.match(/\*{2,}/g) || []).join(''),
        evidence: normLoose(p.text).slice(0, 140),
        paraIndex: i
      });
    }
    if (/_{3,}/.test(p.text)) {
      diffs.push({
        type: 'placeholder_left', severity: 'medium',
        label: '第 ' + (i + 1) + ' 段有下划线空位未填',
        msg: '下划线空位未填写', expected: '实际值',
        actual: p.text.trim().slice(0, 60), evidence: normLoose(p.text).slice(0, 140), paraIndex: i
      });
    }
  });
  return diffs;
}

/* ---------------- 主入口 ---------------- */

/**
 * @param {object} doc       docparse.extract 的结果
 * @param {object} contract  系统里的合同记录
 * @param {Array}  rooms     合同涉及的房间（用于推楼层/地址）
 * @param {object} opt       { skipNumberCompare: 合同编号格式与系统规则不同，只做非空检查 }
 */
function compare(doc, contract, rooms, opt) {
  opt = opt || {};
  if (!doc) return { ok: false, error: '没有可解析的文档' };
  if (doc.isImage) {
    return {
      ok: false, needOcr: true,
      error: '图片格式无文本层，需要先做 OCR 文字识别',
      kind: 'image', paras: [], diffs: []
    };
  }
  if (!doc.text || !norm(doc.text)) {
    return { ok: false, error: '未能从文档中提取到任何文字（可能是扫描件，需 OCR）', kind: doc.kind, diffs: [] };
  }

  let diffs = [];
  // L1 槽位
  SLOTS.forEach(s => {
    const opt2 = (s.key === 'contractCode' && opt.skipNumberCompare)
      ? Object.assign({}, s, { pattern: null }) : s;
    diffs = diffs.concat(cmpSlot(opt2, doc, contract, rooms));
  });
  // L2 条款
  diffs = diffs.concat(cmpClauses(doc));
  // L3 数值
  diffs = diffs.concat(cmpNumbers(doc, contract));
  // 占位符残留
  diffs = diffs.concat(checkLeftoverPlaceholders(doc));

  diffs = diffs.filter(Boolean);
  // 去重（同 label 同 actual 只留一条）
  const seen = {};
  diffs = diffs.filter(d => {
    const k = (d.type || '') + '|' + (d.label || '') + '|' + (d.actual || '');
    if (seen[k]) return false;
    seen[k] = 1; return true;
  });
  // 排序：严重度 → 类型
  diffs.sort((a, b) => {
    const s = (SEVERITY_ORDER[a.severity] !== undefined ? SEVERITY_ORDER[a.severity] : 9) -
              (SEVERITY_ORDER[b.severity] !== undefined ? SEVERITY_ORDER[b.severity] : 9);
    if (s !== 0) return s;
    return String(a.type).localeCompare(String(b.type));
  });

  const stat = {
    total: diffs.length,
    high: diffs.filter(d => d.severity === 'high').length,
    medium: diffs.filter(d => d.severity === 'medium').length,
    low: diffs.filter(d => d.severity === 'low').length,
    byType: diffs.reduce((o, d) => { o[d.type] = (o[d.type] || 0) + 1; return o; }, {})
  };
  const score = scoreOf(stat);
  return {
    ok: true,
    kind: doc.kind, engine: doc.engine,
    docText: doc.text, docChars: doc.text.length, paraCount: doc.paras.length,
    warn: doc.warn || [],
    needOcr: false,
    diffs: diffs, stat: stat, score: score,
    verdict: stat.high > 0 ? 'reject' : (stat.medium > 0 ? 'review' : 'pass')
  };
}

/** 0~100 分：high 扣 8 分，medium 扣 3 分，low 扣 1 分 */
function scoreOf(stat) {
  const s = 100 - stat.high * 8 - stat.medium * 3 - stat.low * 1;
  return Math.max(0, s);
}

/** 导出成人类可读报告 */
function toReport(result, contract, docName) {
  const L = [];
  L.push('# 合同模板比对报告');
  L.push('');
  L.push('- 合同：' + (contract.code || '(无编号)') + '　' + (contract.customerName || ''));
  L.push('- 上报文件：' + (docName || '(未命名)'));
  L.push('- 结论：' + (result.verdict === 'pass' ? '通过' : result.verdict === 'review' ? '需人工复核' : '不通过'));
  L.push('- 得分：' + result.score + ' / 100');
  L.push('- 差异：共 ' + result.stat.total + ' 项（严重 ' + result.stat.high +
    ' / 中 ' + result.stat.medium + ' / 提示 ' + result.stat.low + '）');
  L.push('');
  if (result.needOcr) { L.push('⚠ ' + result.error); return L.join('\n'); }
  const groups = {};
  result.diffs.forEach(d => {
    const g = d.group || (d.severity === 'high' ? '必须修改' : d.severity === 'medium' ? '建议修改' : '提示');
    (groups[g] = groups[g] || []).push(d);
  });
  Object.keys(groups).forEach(g => {
    L.push('## ' + g);
    groups[g].forEach((d, i) => {
      L.push('');
      L.push((i + 1) + '. **' + d.label + '**　`[' + d.severity + ']`');
      L.push('   - 问题：' + d.msg);
      L.push('   - 模板要求：' + (d.expected || '-'));
      L.push('   - 上报内容：' + (d.actual || '-'));
      if (d.hint) L.push('   - 提示：' + d.hint);
      if (d.evidence) L.push('   - 证据：' + d.evidence);
    });
    L.push('');
  });
  return L.join('\n');
}

module.exports = { compare, norm, normLoose, lcsRatio, extractSlot, extractAllMoney, extractCnMoney, extractAllDates, cnToNum, toReport, scoreOf };
