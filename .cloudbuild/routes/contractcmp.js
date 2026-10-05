'use strict';
/**
 * 合同模板比对（招商部上报合同 vs 标准模板 vs 系统数据）
 *
 * 业务场景：招商部把签好的合同（PDF / 图片 / DOCX）上报，
 *          物业要核对这份合同是不是按标准模板来的、有没有被改动。
 *          本路由做三方比对并把差异标注出来：
 *            ① 上报的合同文本  vs  标准模板（条款有没有删/改）
 *            ② 上报的合同文本  vs  系统里录入的数据（金额/日期/面积对不对得上）
 *
 * 接口：
 *   GET  /api/contract-compare/template          取标准模板基线（前端渲染清单）
 *   POST /api/contract-compare/check             上传文件做比对（不落库，仅返回结果）
 *   POST /api/contract-compare/save              比对通过后把文件存为合同附件
 *   GET  /api/contract-compare/history/:id       某合同的历次比对记录
 *   GET  /api/contract-compare/report/:id        导出 Markdown 比对报告
 *   POST /api/contract-compare/batch             批量比对某合同的全部附件
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

    // 取系统合同
    let ct = null;
    if (b.contractId) {
      ct = await db.find('contracts', b.contractId);
      if (!ct) return fail(res, '合同不存在：' + b.contractId);
    } else if (b.contractCode) {
      const all = await db.where('contracts');
      ct = all.find(c => String(c.code) === String(b.contractCode).trim());
      if (!ct) return fail(res, '按合同编号找不到合同：' + b.contractCode);
    } else {
      return fail(res, '请指定 contractId 或 contractCode');
    }

    // 解析文档
    let doc;
    try { doc = docparse.extract(up.buf, up.fileName); }
    catch (e) { return fail(res, e.message); }

    const rooms = await roomsOf(db, ct);
    const result = cmp.compare(doc, ct, rooms, { skipNumberCompare: !!b.skipNumberCompare });

    // 记录审计
    audit.routeLog(db, req, '合同管理', '合同模板比对', {
      detail: (ct.code || '') + ' / ' + up.fileName + ' → ' +
        (result.needOcr ? '需OCR' : (result.verdict === 'pass' ? '通过' : result.verdict === 'review' ? '需复核' : '不通过')) +
        '（差异 ' + (result.stat ? result.stat.total : 0) + ' 项）'
    });

    ok(res, {
      contract: { id: ct.id, code: ct.code, customerName: ct.customerName },
      file: { name: up.fileName, size: up.buf.length, ext: up.ext },
      result: result
    });
  });

  /* ---------- 3. 比对后存为合同附件 ---------- */
  router.post('/api/contract-compare/save', async (req, res) => {
    if (!can(req, res, 'contract:manage')) return;
    const b = req.body || {};
    const up = readUpload(b);
    if (up.err) return fail(res, up.err);
    const ct = await db.find('contracts', b.contractId);
    if (!ct) return fail(res, '合同不存在：' + b.contractId);

    let doc;
    try { doc = docparse.extract(up.buf, up.fileName); }
    catch (e) { return fail(res, e.message); }
    const rooms = await roomsOf(db, ct);
    const result = cmp.compare(doc, ct, rooms, { skipNumberCompare: !!b.skipNumberCompare });

    // 图片 / 扫描件：没有文本层也允许存档，但要标记
    const a = await att();
    const ext = up.ext === 'doc' ? 'docx' : up.ext;   // 旧 .doc 一律按 docx 解析会失败，存档仍按原扩展名
    const key = 'contract/' + String(ct.id) + '/cmp_' + uid('') + '.' + up.ext;
    const stored = await a.put(key, up.buf, { mime: up.mime || '' });

    // 挂到合同附件
    const list = Array.isArray(ct.attachments) ? ct.attachments.slice() : [];
    const attObj = {
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

    // 完整差异明细另存（便于后续复查/导出）
    const recId = uid('');
    await db.insert('contractCompares', {
      id: recId,
      contractId: ct.id, contractCode: ct.code,
      fileName: up.fileName, fileKey: stored.key, fileUrl: stored.url,
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
      note: b.note || ''
    });

    audit.routeLog(db, req, '合同管理', '合同模板比对存档', {
      detail: (ct.code || '') + ' / ' + up.fileName + ' → 得分 ' + (result.score || 0) +
        '，差异 ' + (result.stat ? result.stat.total : 0) + ' 项'
    });

    ok(res, { attachment: attObj, recordId: recId, result: result });
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
        fileName: r.fileName, fileType: r.fileType, score: r.score, verdict: r.verdict,
        total: r.total, high: r.high, medium: r.medium, low: r.low,
        comparedAt: r.comparedAt, note: r.note
      }));
    const stat = {
      total: list.length,
      pass: list.filter(r => r.verdict === 'pass').length,
      review: list.filter(r => r.verdict === 'review').length,
      reject: list.filter(r => r.verdict === 'reject').length,
      needOcr: list.filter(r => r.verdict === 'needOcr').length
    };
    ok(res, { list: list, stat: stat });
  });
};
