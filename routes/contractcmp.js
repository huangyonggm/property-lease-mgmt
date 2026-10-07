'use strict';
/**
 * 合同模板比对（招商部上报合同 vs 标准模板 vs 系统数据）
 *
 * 业务场景：招商部把签好的合同（PDF / 图片 / DOCX）上报，
 *          物业要核对这份合同是不是按标准模板来的、有没有被改动。
 *
 * 两种比对方式：
 *   archive（系统合同比对）—— 合同已在系统里有档案（有编号）
 *             ① 上报的合同文本  vs  标准模板（条款有没有删/改）
 *             ② 上报的合同文本  vs  系统里录入的数据（金额/日期/面积对不对得上）
 *   pending（待审合同比对）—— 合同还没录入系统、还没有编号
 *             合同里本来就没有可比对的系统数据，所以只做：
 *             ① 合同文本 vs 标准模板（条款/章节有没有删改）
 *             ② 各槽位填写完整性 + 格式合规 + 占位符是否残留 + 金额大小写是否自洽
 *             ③ 关联核查：文本里的 编号/承租方/房号 拿去系统里查
 *                （编号撞车？同房号是否已被签出？承租方是否已有合同？）
 *
 * 接口：
 *   GET  /api/contract-compare/template          取标准模板基线（前端渲染清单）
 *   POST /api/contract-compare/check             上传文件做比对（不落库，仅返回结果）
 *                                                不传 contractId/contractCode = 待审比对
 *   POST /api/contract-compare/save              存档（有合同则挂附件；待审则只留比对记录）
 *   GET  /api/contract-compare/history/:id       某合同的历次比对记录
 *   GET  /api/contract-compare/report/:id        导出 Markdown 比对报告
 *   POST /api/contract-compare/batch             批量比对某合同的全部附件
 *   GET  /api/contract-compare/records           全部比对记录（含待审）
 */
const path = require('path');
const { ok, fail } = require('../lib/http');
const { can } = require('../lib/crud');
const { uid, now } = require('../lib/util');
const audit = require('../lib/audit');
const docparse = require('../lib/docparse');
const cmp = require('../lib/contractCompare');
const TPL = require('../lib/contractTemplate');

const MAX_SIZE = 30 * 1024 * 1024;         // 30MB
const ALLOW_EXT = ['docx', 'pdf', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'txt', 'md', 'doc'];

/** 解析上传的 base64 文件 */
function readUpload(body) {
  const b = body || {};
  if (!b.dataBase64) return { err: '缺少文件内容（dataBase64）' };
  const m = String(b.dataBase64).match(/^data:([^;]+);base64,(.*)$/);
  const data = m ? m[2] : b.dataBase64;
  let buf;
  try { buf = Buffer.from(data, 'base64'); }
  catch (e) { return { err: 'base64 解码失败：' + e.message }; }
  if (!buf.length) return { err: '文件内容为空' };
  if (buf.length > MAX_SIZE) {
    return { err: '文件过大（' + (buf.length / 1024 / 1024).toFixed(1) + 'MB），上限 ' + (MAX_SIZE / 1024 / 1024) + 'MB' };
  }
  const fileName = b.fileName || 'upload.bin';
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (ALLOW_EXT.indexOf(ext) < 0) {
    return { err: '不支持的文件类型 .' + ext + '，仅支持：' + ALLOW_EXT.join(' / ') };
  }
  return { buf: buf, fileName: fileName, ext: ext, mime: m ? m[1] : '' };
}

/** 取合同涉及的房间（用于推楼层/地址） */
async function roomsOf(db, ct) {
  const ids = Array.isArray(ct.roomIds) ? ct.roomIds : [];
  if (!ids.length) return [];
  const list = await db.where('rooms', { id: ids });
  return list || [];
}

/* ------------------------------------------------------------------ *
 *  待审合同「关联核查」
 *
 *  待审合同本身没进系统，但它记载的 编号 / 承租方 / 房号 都是系统里的既有对象。
 *  这三样里有系统才知道的信息，光看合同文本看不出来：
 *    ① 编号撞车 —— 手写的编号和系统里某份合同重了
 *    ② 承租方已有合同 —— 是续签 / 换房 / 还是完全新客户
 *    ③ 房号已被签出 —— 同一个房号重复签约（最危险，租金会收重/收漏）
 *  只作「参考信息」呈现，一律不参与差异判定，避免误伤正常业务。
 * ------------------------------------------------------------------ */

/** 房号归一：11栋-8-04 / 11-8-04 / T3-6-03 → 11-8-04 / t3-6-03 */
function normRoom(s) {
  return String(s || '').replace(/[\s　]/g, '').replace(/[－—–_]/g, '-').replace(/栋|幢/g, '').toLowerCase();
}

/** 人名/公司名归一：只去空白与全角空格，不做别的（避免把不同公司归一成同一个） */
function normName(s) {
  return String(s || '').replace(/[\s　]/g, '').replace(/[（(]/g, '(').replace(/[）)]/g, ')').toLowerCase();
}

/** 从合同正文里捞房号（房号在文本里没有固定字段，只能按形态识别） */
function extractRoomCodes(text) {
  const t = String(text || '');
  const out = [];
  const seen = {};
  const res = [
    /([A-Za-z]\d{1,2})\s*[-－—–]\s*(\d{1,2})\s*[-－—–]\s*(\d{1,2})/g,      // T3-6-03
    /(\d{1,3})\s*栋\s*[-－—–]?\s*(\d{1,2})\s*[-－—–]\s*(\d{1,2})/g          // 11栋-8-04 / 11栋8-04
  ];
  res.forEach(re => {
    let m;
    while ((m = re.exec(t))) {
      const raw = m[0].replace(/[\s　]/g, '');
      const n = normRoom(raw);
      if (seen[n]) continue;
      seen[n] = 1;
      out.push({ raw: raw, norm: n });
      if (out.length >= 10) break;
    }
  });
  return out;
}

/** 关联合同摘要（只带台账里要显示的几个字段，避免把整条合同甩给前端） */
function brief(c) {
  return {
    id: c.id, code: c.code, customerName: c.customerName || '',
    roomCodes: c.roomCodes || [], status: c.status || '',
    startDate: c.startDate || '', endDate: c.endDate || '',
    rentMonthly: c.rentMonthly || 0
  };
}

/** 在租/占用的合同状态（用来判「房号是不是已经被签出去了」） */
const BUSY_STATUS = ['正常履约', '逾期', '变更', '审批中'];

async function findRelated(db, doc, result) {
  const itemOf = k => ((result && result.extracted) || []).find(e => e.key === k) || { value: '' };
  const code = String(itemOf('contractCode').value || '').trim();
  const customer = String(itemOf('lesseeName').value || '').trim();
  const roomCodes = extractRoomCodes(doc.text || '');
  const all = (await db.where('contracts')) || [];
  const out = { code: [], customer: [], rooms: [], roomCodes: roomCodes };

  // ① 编号撞车（编号位置仍是占位符 / 无编号时不用查）
  if (code && code !== '(无编号)' && code.indexOf('*') < 0) {
    out.code = all.filter(c => String(c.code) === code).map(brief);
  }

  // ② 承租方在系统里已有的合同（最近的 8 份）
  const key = normName(customer);
  if (key.length >= 2) {
    out.customer = all.filter(c => {
      const n = normName(c.customerName);
      if (!n) return false;
      return n === key || n.indexOf(key) >= 0 || key.indexOf(n) >= 0;
    }).sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')))
      .slice(0, 8).map(brief);
  }

  // ③ 房号：系统里是否存在、是否已被占用
  out.rooms = roomCodes.map(rc => {
    const hit = all.filter(c => (c.roomCodes || []).some(x => normRoom(x) === rc.norm));
    const live = hit.filter(c => BUSY_STATUS.indexOf(c.status) >= 0);
    return {
      raw: rc.raw, norm: rc.norm,
      exists: hit.length > 0,
      contracts: hit.slice(0, 6).map(brief),
      busy: live.length > 0,
      busyBy: live.length ? (live[0].code + '　' + (live[0].customerName || '')) : ''
    };
  });

  return out;
}

module.exports = function (db, router, opt) {
  const uploadDir = (opt && opt.uploadDir) || path.join((opt && opt.rootDir) || process.cwd(), 'uploads');
  let _att = null;
  async function att() {
    if (!_att) {
      const { AttStore } = require('../lib/attstore');
      _att = new AttStore(uploadDir);
    }
    return _att;
  }

  /* ---------- 1. 取标准模板基线 ---------- */
  router.get('/api/contract-compare/template', async (req, res) => {
    if (!can(req, res, 'contract:view')) return;
    ok(res, {
      meta: TPL.TEMPLATE_META,
      slots: TPL.SLOTS.map(s => ({
        key: s.key, label: s.label, type: s.type, required: !!s.required,
        severity: s.severity, dbField: s.dbField || null, unit: s.unit || null,
        patternHint: s.patternHint || null
      })),
      sections: TPL.CLAUSES.filter(c => c.mode === 'title').map(c => ({
        id: c.id, label: c.label, severity: c.severity
      })),
      keyClauses: TPL.CLAUSES.filter(c => c.mode === 'fuzzy').map(c => ({
        id: c.id, label: c.label, expect: c.expect, severity: c.severity, group: c.group
      })),
      fixedItems: TPL.FIXED_ITEMS.map(f => ({ key: f.key, label: f.label, severity: f.severity }))
    });
  });

  /* ---------- 2. 上传比对（不落库） ---------- */
  router.post('/api/contract-compare/check', async (req, res) => {
    if (!can(req, res, 'contract:view')) return;
    const b = req.body || {};
    const up = readUpload(b);
    if (up.err) return fail(res, up.err);

    // 取系统合同。三种情况：
    //   ① 传了 contractId / contractCode → 与系统档案比对（原有口径）
    //   ② 两个都没传 → 「待审合同比对」：合同还没录进系统、还没有编号，
    //      没有系统数据可比，只做「标准模板一致性 + 填写完整性 + 格式合规」，
    //      另加一轮「关联核查」（编号撞车 / 承租方已有合同 / 房号是否已被签出）。
    //      ⚠ 2026-10-07 之前这里直接 reject，招商部新签的合同必须先录入系统才能比对，
    //        与业务真实顺序（先审合同、后录档案）相反。
    let ct = null, mode = 'archive';
    if (b.contractId) {
      ct = await db.find('contracts', b.contractId);
      if (!ct) return fail(res, '合同不存在：' + b.contractId);
    } else if (b.contractCode) {
      const all = await db.where('contracts');
      ct = all.find(c => String(c.code) === String(b.contractCode).trim());
      if (!ct) return fail(res, '按合同编号找不到合同：' + b.contractCode);
    } else {
      mode = 'pending';
      // 空壳：待审合同在系统里没有任何记录，引擎据此走"不与系统比"的分支
      ct = { id: '', code: '', customerName: '', roomIds: [], roomCodes: [], attachments: [] };
    }

    // 解析文档
    let doc;
    try { doc = docparse.extract(up.buf, up.fileName); }
    catch (e) { return fail(res, e.message); }

    const rooms = mode === 'pending' ? [] : await roomsOf(db, ct);
    const result = cmp.compare(doc, ct, rooms, {
      skipNumberCompare: !!b.skipNumberCompare,
      mode: mode
    });

    const out = {
      mode: mode,
      contract: mode === 'pending'
        ? { id: '', code: '', customerName: '' }
        : { id: ct.id, code: ct.code, customerName: ct.customerName },
      file: { name: up.fileName, size: up.buf.length, ext: up.ext },
      result: result
    };

    // 待审合同：拿文本里的 编号/承租方/房号 去系统里查一圈（防重复签约）。
    // 查不到不影响比对结论，所以整段吞异常。
    if (mode === 'pending') {
      try { out.related = await findRelated(db, doc, result); }
      catch (e) { out.related = null; }
    }

    // 记录审计
    audit.routeLog(db, req, '合同管理', mode === 'pending' ? '待审合同比对' : '合同模板比对', {
      detail: (mode === 'pending' ? '（待审·未录入系统）' : (ct.code || '')) + ' / ' + up.fileName + ' → ' +
        (result.needOcr ? '需OCR' : (result.verdict === 'pass' ? '通过' : result.verdict === 'review' ? '需复核' : '不通过')) +
        '（差异 ' + (result.stat ? result.stat.total : 0) + ' 项）'
    });

    ok(res, out);
  });

  /* ---------- 3. 比对后存档 ---------- */
  // 有合同档案 → 文件存为合同附件 + 写 contractCompares；
  // 待审合同（无档案）→ 没有合同可挂附件，只写 contractCompares 留档，
  //   contractId 存空串，台账/历史靠「contractId 为空」识别为「待审比对」。
  router.post('/api/contract-compare/save', async (req, res) => {
    if (!can(req, res, 'contract:manage')) return;
    const b = req.body || {};
    const up = readUpload(b);
    if (up.err) return fail(res, up.err);

    const pending = !b.contractId && !b.contractCode;
    let ct = null;
    if (!pending) {
      if (b.contractId) ct = await db.find('contracts', b.contractId);
      else {
        const all = await db.where('contracts');
        ct = all.find(c => String(c.code) === String(b.contractCode).trim());
      }
      if (!ct) return fail(res, '合同不存在：' + (b.contractId || b.contractCode));
    } else {
      ct = { id: '', code: '', customerName: '', roomIds: [], roomCodes: [], attachments: [] };
    }

    let doc;
    try { doc = docparse.extract(up.buf, up.fileName); }
    catch (e) { return fail(res, e.message); }
    const rooms = pending ? [] : await roomsOf(db, ct);
    const result = cmp.compare(doc, ct, rooms, {
      skipNumberCompare: !!b.skipNumberCompare,
      mode: pending ? 'pending' : 'archive'
    });

    // 待审模式不落附件（没有合同可挂），只留档比对结论
    let attObj = null;
    if (!pending) {
      // 图片 / 扫描件：没有文本层也允许存档，但要标记
      const a = await att();
      const key = 'contract/' + String(ct.id) + '/cmp_' + uid('') + '.' + up.ext;
      const stored = await a.put(key, up.buf, { mime: up.mime || '' });
      const list = Array.isArray(ct.attachments) ? ct.attachments.slice() : [];
      attObj = {
        id: uid(''), name: up.fileName, key: stored.key, url: stored.url,
        size: up.buf.length, mime: up.mime || '', kind: 'contractScan',
        uploadedAt: now(), uploadedBy: (req.user && req.user.id) || '',
        compare: {
          at: now(), score: result.score || 0,
          verdict: result.needOcr ? 'needOcr' : (result.verdict || 'unknown'),
          total: result.stat ? result.stat.total : 0,
          high: result.stat ? result.stat.high : 0,
          medium: result.stat ? result.stat.medium : 0,
          low: result.stat ? result.stat.low : 0
        }
      };
      list.push(attObj);
      await db.update('contracts', ct.id, { attachments: list });
    }

    // 完整差异明细另存（便于后续复查/导出）
    const recId = uid('');
    const codeOfDoc = ((result.extracted || []).find(e => e.key === 'contractCode') || {}).value || '';
    await db.insert('contractCompares', {
      id: recId,
      contractId: ct.id || '',
      contractCode: ct.code || (pending ? String(codeOfDoc === '(无编号)' ? '' : codeOfDoc) : ''),
      fileName: up.fileName, fileKey: attObj ? attObj.key : '', fileUrl: attObj ? attObj.url : '',
      fileSize: up.buf.length, fileType: up.ext,
      score: result.score || 0,
      verdict: result.needOcr ? 'needOcr' : (result.verdict || 'unknown'),
      total: result.stat ? result.stat.total : 0,
      high: result.stat ? result.stat.high : 0,
      medium: result.stat ? result.stat.medium : 0,
      low: result.stat ? result.stat.low : 0,
      diffs: result.diffs || [],
      warn: result.warn || [],
      docText: (result.docText || '').slice(0, 20000),
      comparedAt: now(),
      comparedBy: (req.user && req.user.id) || '',
      note: b.note || (pending ? '待审合同比对（未录入系统档案）' : '')
    });

    audit.routeLog(db, req, '合同管理', pending ? '待审合同比对存档' : '合同模板比对存档', {
      detail: (ct.code || '（待审·未录入系统）') + ' / ' + up.fileName + ' → 得分 ' + (result.score || 0) +
        '，差异 ' + (result.stat ? result.stat.total : 0) + ' 项'
    });

    ok(res, { attachment: attObj, recordId: recId, pending: pending, mode: pending ? 'pending' : 'archive', result: result });
  });

  /* ---------- 4. 某合同的比对历史 ---------- */
  router.get('/api/contract-compare/history/:id', async (req, res) => {
    if (!can(req, res, 'contract:view')) return;
    const ct = await db.find('contracts', req.params.id);
    if (!ct) return fail(res, '合同不存在');
    const all = await db.where('contractCompares');
    const list = all
      .filter(r => String(r.contractId) === String(ct.id))
      .sort((a, b) => String(b.comparedAt).localeCompare(String(a.comparedAt)))
      .map(r => ({
        id: r.id, fileName: r.fileName, fileType: r.fileType, fileSize: r.fileSize,
        score: r.score, verdict: r.verdict, total: r.total,
        high: r.high, medium: r.medium, low: r.low,
        comparedAt: r.comparedAt, note: r.note
      }));
    ok(res, { contractId: ct.id, code: ct.code, list: list });
  });

  /* ---------- 5. 导出 Markdown 报告 ---------- */
  router.get('/api/contract-compare/report/:id', async (req, res) => {
    if (!can(req, res, 'contract:view')) return;
    const rec = await db.find('contractCompares', req.params.id);
    if (!rec) return fail(res, '比对记录不存在');
    const ct = await db.find('contracts', rec.contractId);
    const md = cmp.toReport({
      diffs: rec.diffs || [], needOcr: rec.verdict === 'needOcr',
      verdict: rec.verdict, score: rec.score,
      mode: rec.contractId ? 'archive' : 'pending',
      stat: { total: rec.total, high: rec.high, medium: rec.medium, low: rec.low }
    }, ct || { code: rec.contractCode }, rec.fileName);

    const fname = 'contract-compare-' + (rec.contractCode || rec.id) + '-' + String(rec.comparedAt).slice(0, 10) + '.md';
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + encodeURIComponent(fname) + '"'
    });
    res.end(md);
  });

  /* ---------- 6. 批量比对某合同全部附件 ---------- */
  router.post('/api/contract-compare/batch', async (req, res) => {
    if (!can(req, res, 'contract:view')) return;
    const b = req.body || {};
    const ct = await db.find('contracts', b.contractId);
    if (!ct) return fail(res, '合同不存在：' + b.contractId);
    const rooms = await roomsOf(db, ct);
    const list = Array.isArray(ct.attachments) ? ct.attachments : [];
    if (!list.length) return fail(res, '该合同没有附件');

    // 一次取回所有附件内容再逐个比对（避免 N 次往返）
    const a = await att();
    const out = [];
    for (const f of list) {
      let buf = null;
      try {
        if (f.dataBase64) buf = Buffer.from(f.dataBase64, 'base64');
        else if (f.key) buf = await a.read(f.key);
      } catch (e) { /* 取不到就跳过 */ }
      if (!buf) { out.push({ id: f.id, name: f.name, error: '无法读取文件内容' }); continue; }
      let doc;
      try { doc = docparse.extract(buf, f.name); }
      catch (e) { out.push({ id: f.id, name: f.name, error: e.message }); continue; }
      const r = cmp.compare(doc, ct, rooms, {});
      out.push({
        id: f.id, name: f.name,
        score: r.score, verdict: r.needOcr ? 'needOcr' : r.verdict,
        total: r.stat ? r.stat.total : 0, high: r.stat ? r.stat.high : 0
      });
    }
    ok(res, { contractId: ct.id, code: ct.code, count: out.length, list: out });
  });

  /* ---------- 7. 全部比对记录（监督台账） ---------- */
  router.get('/api/contract-compare/records', async (req, res) => {
    if (!can(req, res, 'contract:view')) return;
    const q = (req.query && req.query.q) || '';
    const verdict = (req.query && req.query.verdict) || '';
    const all = await db.where('contractCompares');
    let list = all;
    if (verdict) list = list.filter(r => r.verdict === verdict);
    if (q) {
      const k = String(q).toLowerCase();
      list = list.filter(r => String(r.contractCode || '').toLowerCase().indexOf(k) >= 0 ||
                             String(r.fileName || '').toLowerCase().indexOf(k) >= 0);
    }
    list = list.sort((a, b) => String(b.comparedAt).localeCompare(String(a.comparedAt)))
      .map(r => ({
        id: r.id, contractId: r.contractId, contractCode: r.contractCode,
        // 待审比对没有合同档案，contractId 存的是空串 —— 台账据此打「待审」标记
        pending: !r.contractId,
        fileName: r.fileName, fileType: r.fileType, score: r.score, verdict: r.verdict,
        total: r.total, high: r.high, medium: r.medium, low: r.low,
        comparedAt: r.comparedAt, note: r.note
      }));
    const stat = {
      total: list.length,
      pass: list.filter(r => r.verdict === 'pass').length,
      review: list.filter(r => r.verdict === 'review').length,
      reject: list.filter(r => r.verdict === 'reject').length,
      needOcr: list.filter(r => r.verdict === 'needOcr').length,
      pending: list.filter(r => r.pending).length
    };
    ok(res, { list: list, stat: stat });
  });
};
