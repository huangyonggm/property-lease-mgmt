'use strict';
/**
 * 合同审批 · 模板比对服务
 *
 * 业务背景：招商部把签好的合同扫描件上报系统 → 自动与标准模板三方比对 →
 *             审批人在审批界面逐条看到差异 → 有差异不得点「通过」。
 *
 * 为什么要单独抽一个模块：
 *   比对逻辑要在三个地方被复用，抽出来才能保证「审批时看到的结论」
 *   和「合同列表点比对看到的结论」是同一套判定，不会出现两处口径不一致。
 *     ① routes/contract.js     合同创建时自动比对（createApproval 内挂载）
 *     ② routes/contractcmp.js  独立比对工具（已存在，复用 runCompare）
 *     ③ routes/approval.js     审批通过时的硬拦截校验（复核当前结论是否仍成立）
 */

const docparse = require('./docparse');
const cmp = require('./contractCompare');
const { uid, now } = require('./util');

/* ------------------------------------------------------------------ *
 *  一致性判定：唯一权威口径
 * ------------------------------------------------------------------ */

/** 严重度中文标签（前端表格与报告共用） */
const SEVERITY_LABEL = { high: '严重', medium: '建议', low: '提示' };

/** 差异类型中文名（把 14 种 type 翻成人话，审批人才看得懂） */
const TYPE_LABEL = {
  slot_empty: '填写缺失',
  slot_mismatch: '填写不符',
  slot_format: '格式不合规',
  slot_manual: '需人工确认',
  clause_missing: '条款缺失',
  clause_rewritten: '条款被改写',
  clause_extra: '多出条款',
  fixed_mismatch: '固定项不符',
  cn_money_mismatch: '大写金额不符',
  cn_money_unparsed: '大写金额无法解析',
  rent_not_found: '未找到租金',
  date_not_found: '未找到日期',
  area_not_found: '未找到面积',
  placeholder_left: '占位符残留'
};

/**
 * 是否构成「审批阻断」。
 *
 * 判定口径（用户明确要求：硬拦截，必须无差异才能通过）：
 *   - high > 0   → 阻断。必须修改（金额/日期/关键条款对不上）
 *   - medium > 0 → 阻断。合同是与系统数据或模板不一致
 *   - low 单独不阻断（占位符残留等提示项，允许带提示放行）
 *
 * 另外两种情况也阻断，但原因不同，必须区分清楚：
 *   - 未做比对（没有扫描件 / OCR 没配凭据）→ 不阻断，
 *     否则老合同（没附件）会永久卡住审批；改为在界面显著提示「未比对」
 *   - 比对本身失败 → 阻断，因为无法证明这份合同合规
 */
function verdictOf(result) {
  if (!result) return { verdict: 'none', block: false, level: 'none', reason: '未做模板比对' };
  if (result.needOcr) {
    return { verdict: 'needOcr', block: true, level: 'high', reason: '扫描件未能识别文字，无法核对模板一致性' };
  }
  if (result.ok === false) {
    return { verdict: 'error', block: true, level: 'high', reason: result.error || '比对失败' };
  }
  const st = result.stat || { high: 0, medium: 0, low: 0, total: 0 };
  if (st.high > 0) return { verdict: 'reject', block: true, level: 'high', reason: '有 ' + st.high + ' 处严重差异' };
  if (st.medium > 0) return { verdict: 'review', block: true, level: 'medium', reason: '有 ' + st.medium + ' 处建议修改项' };
  return { verdict: 'pass', block: false, level: 'ok', reason: st.total > 0 ? '仅有 ' + st.total + ' 处提示项' : '与模板完全一致' };
}

/**
 * 把比对结果压成审批单可存的结构（体积可控）。
 *
 * 只保留审批人真正要看的字段：严重度/项目/问题/模板要求/上报内容/证据。
 * 不塞 docText —— 那是几万字的原文，已在 contractCompares 表单独存档。
 */
function toCompareRecord(result, opt) {
  const o = opt || {};
  const v = verdictOf(result);
  const st = (result && result.stat) || { total: 0, high: 0, medium: 0, low: 0 };
  return {
    enabled: true,
    verdict: v.verdict,
    verdictText: v.reason,
    block: v.block,
    level: v.level,
    score: (result && result.score) || 0,
    stat: { total: st.total || 0, high: st.high || 0, medium: st.medium || 0, low: st.low || 0 },
    fileName: o.fileName || '',
    fileKey: o.fileKey || '',
    fileType: o.fileType || '',
    engine: (result && result.engine) || '',
    docChars: (result && result.docChars) || 0,
    ocr: (result && result.ocr) || null,
    warn: (result && result.warn) || [],
    at: now(),
    by: o.by || '',
    // 差异明细：审批界面逐条展示的核心数据
    diffs: ((result && result.diffs) || []).map(d => ({
      type: d.type,
      typeText: TYPE_LABEL[d.type] || d.type,
      severity: d.severity,
      severityText: SEVERITY_LABEL[d.severity] || d.severity,
      group: d.group || '',
      label: d.label || '',
      msg: d.msg || '',
      expected: d.expected == null ? '' : String(d.expected),
      actual: d.actual == null ? '' : String(d.actual),
      hint: d.hint || '',
      evidence: d.evidence || ''
    }))
  };
}

/** 「未做比对」的占位记录（老合同没附件时写这个，保证前端不用判空） */
function noneRecord(reason) {
  return {
    enabled: false,
    verdict: 'none', verdictText: reason || '未附合同扫描件，未做模板比对',
    block: false, level: 'none',
    score: 0, stat: { total: 0, high: 0, medium: 0, low: 0 },
    fileName: '', fileKey: '', fileType: '', engine: '', docChars: 0,
    ocr: null, warn: [], at: '', by: '', diffs: []
  };
}

/* ------------------------------------------------------------------ *
 *  执行比对
 * ------------------------------------------------------------------ */

/** 合同扫描件的扩展名白名单（与 contractcmp 路由保持一致） */
const DOC_EXT = ['docx', 'pdf', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'doc'];

/** 附件是否像一份合同正本（用来在 attachments 里挑出要比对的那个） */
function isContractScan(att) {
  if (!att) return false;
  const name = String(att.name || '');
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (DOC_EXT.indexOf(ext) < 0) return false;
  // 排除明显不是合同正本的文件名（营业执照/身份证/图纸等）
  if (/营业执照|身份证|资质|证书|图纸|CAD|平面图|户型/.test(name)) return false;
  return true;
}

/** 在附件里挑出最像合同正本的那份：优先 kind=contractScan，其次按文件名打分 */
function pickContractScan(list) {
  const arr = Array.isArray(list) ? list : [];
  const cands = arr.filter(isContractScan);
  if (!cands.length) return null;
  const byKind = cands.filter(a => a.kind === 'contractScan');
  const pool = byKind.length ? byKind : cands;
  let best = pool[0], bestScore = -1;
  for (const a of pool) {
    let s = 0;
    if (a.kind === 'contractScan') s += 10;
    if (/合同|协议|contract|租赁/.test(String(a.name || ''))) s += 5;
    if (/\.(pdf|docx)$/i.test(String(a.name || ''))) s += 2;   // 正本一般是 pdf/docx
    if (s > bestScore) { bestScore = s; best = a; }
  }
  return best;
}

/**
 * 对某个合同执行模板比对
 *
 * @param {object} ctx  { db, attStore, contract, rooms, att, opt }
 * @returns {Promise<{record, result, att, verdict}>}
 */
async function runCompare(ctx) {
  const { db, contract, att, opt } = ctx;
  const o = opt || {};
  const rooms = ctx.rooms || [];
  const attStore = ctx.attStore || null;

  // ① 没附件可读 → 未比对（不阻断，避免老合同卡住审批）
  if (!att) {
    const v = verdictOf(null);
    return { record: noneRecord(), result: null, att: null, verdict: v };
  }

  // ② 取回文件内容
  let buf = null;
  if (attStore && att.key) {
    try { buf = await attStore.read(att.key); }
    catch (e) { return { record: noneRecord('附件读取失败：' + e.message), result: null, att, verdict: verdictOf(null) }; }
  }
  if (!buf || !buf.length) {
    return { record: noneRecord('附件内容为空，无法比对'), result: null, att, verdict: verdictOf(null) };
  }

  // ③ 解析（图片 / 扫描 PDF 走 OCR）
  let doc;
  try {
    doc = await docparse.extractAsync(buf, att.name, { maxOcrPages: o.maxOcrPages });
  } catch (e) {
    const r = { ok: false, error: '文档解析失败：' + e.message, diffs: [] };
    return { record: toCompareRecord(r, { fileName: att.name, fileKey: att.key, by: o.by }), result: r, att, verdict: verdictOf(r) };
  }

  // ④ 比对
  const result = cmp.compare(doc, contract, rooms, { skipNumberCompare: !!o.skipNumberCompare });
  const record = toCompareRecord(result, {
    fileName: att.name, fileKey: att.key,
    fileType: (att.name.split('.').pop() || '').toLowerCase(), by: o.by
  });
  return { record, result, att, verdict: verdictOf(result) };
}

/**
 * 归档一条 contractCompares 记录（独立表，供复查/导出）
 * 失败不抛 —— 存档是加分项，不能因为存档失败影响审批创建
 */
async function archive(db, contract, att, result, record, userId) {
  try {
    const recId = uid('');
    await db.insert('contractCompares', {
      id: recId,
      contractId: contract.id, contractCode: contract.code,
      fileName: att ? att.name : '', fileKey: att ? att.key : '',
      fileUrl: att ? att.url : '',
      fileSize: att ? att.size : 0,
      fileType: record.fileType || '',
      score: record.score, verdict: record.verdict,
      total: record.stat.total, high: record.stat.high,
      medium: record.stat.medium, low: record.stat.low,
      diffs: record.diffs,
      warn: record.warn,
      docText: ((result && result.docText) || '').slice(0, 20000),
      comparedAt: record.at, comparedBy: userId || '',
      note: '审批流程自动比对'
    });
    return recId;
  } catch (e) {
    return '';
  }
}

module.exports = {
  runCompare, archive, toCompareRecord, noneRecord, verdictOf,
  pickContractScan, isContractScan,
  SEVERITY_LABEL, TYPE_LABEL, DOC_EXT
};
