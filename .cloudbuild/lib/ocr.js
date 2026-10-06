'use strict';
/**
 * 腾讯云文字识别 —— 零依赖，手签 TC3-HMAC-SHA256。
 *
 * 移植自 J:\建筑工程管理系统网页版\netlify\functions\api.js 的 tencentApiCall()。
 * 本项目在这一个文件里提供**两种**识别能力，按场景选用：
 *
 *   1) 通用文字识别（高精度）GeneralAccurateOCR —— recognize()
 *      返回 DetectedText[] 文本行数组，用于**合同/扫描件**抽取比对。
 *      招商部上报的合同是 A4 扫描件 / 手机拍的 JPG，不是发票版式，
 *      发票专用接口对整页合同基本识别不出东西，所以合同走这条。
 *
 *   2) 增值税发票专用 VatInvoiceOCR —— recognizeVatInvoice()
 *      返回结构化字段（发票号码/开票日期/价税合计/税率…），
 *      用于「新增发票时上传票面 PDF/图片 → 自动回填表单」。
 *      从一行行文字里正则抠发票字段又脆又容易串行（票面「金额」出现三次），
 *      用专用接口拿键值对稳定得多。
 *
 * 两者共用同一个 tencentApiCall() 签名函数（action 不同、version 相同）。
 *
 * 接口规格（2018-11-19）：
 *   ImageBase64  编码后 ≤ 10MB，支持 PNG / JPG / JPEG / BMP / PDF
 *   IsPdf        开启后可同时支持图片与 PDF
 *   PdfPageNumber PDF 页码，**仅支持单页**，多页必须循环调用
 *   返回         DetectedText[]（Text / Confidence / ItemPolygon）、Angle
 *   限频         默认 10 次/秒
 *
 * 设计原则（与本项目其他外部依赖一致）：
 *   OCR 是「增强能力」不是「前置依赖」——未配置凭据或调用失败时
 *   一律返回结构化的失败原因，绝不抛异常阻断合同上报主流程。
 */

const crypto = require('crypto');

const HOST = 'ocr.tencentcloudapi.com';
const SERVICE = 'ocr';
const VERSION = '2018-11-19';
const REGION = process.env.TENCENT_OCR_REGION || 'ap-guangzhou';

// 腾讯云限制：Base64 编码后不超过 10MB。留 8% 余量给编码膨胀，避免边界踩线
const MAX_BYTES = Math.floor(9.2 * 1024 * 1024);
// PDF 页数硬上限：防止几百页的合同把 10 次/秒的限频打满，超时无意义
const MAX_PDF_PAGES = 20;
// 单页默认限频 10 次/秒，串行调用时不必等待；但服务端偶发限频时要有退避
const PAGE_GAP_MS = 130;

/* ------------------------------------------------------------------ *
 *  TC3-HMAC-SHA256 手签
 * ------------------------------------------------------------------ */

/**
 * 调用腾讯云 API（手签，无需 aws-sdk / tc3 依赖）
 * @throws 仅在网络层或签名层失败时抛错；业务错误以 Error 抛出由上层归类
 */
async function tencentApiCall(action, payload, opt) {
  const o = opt || {};
  const secretId = o.secretId || process.env.TENCENT_SECRET_ID;
  const secretKey = o.secretKey || process.env.TENCENT_SECRET_KEY;
  if (!secretId || !secretKey) {
    const e = new Error('OCR_NO_CREDENTIAL: 未配置 TENCENT_SECRET_ID / TENCENT_SECRET_KEY');
    e.code = 'OCR_NO_CREDENTIAL';
    throw e;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const payloadStr = JSON.stringify(payload);
  const hashedPayload = crypto.createHash('sha256').update(payloadStr, 'utf8').digest('hex');
  const canonicalHeaders = 'content-type:application/json; charset=utf-8\nhost:' + HOST + '\n';
  const signedHeaders = 'content-type;host';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');
  const algorithm = 'TC3-HMAC-SHA256';
  const credentialScope = date + '/' + SERVICE + '/tc3_request';
  const stringToSign = [
    algorithm, String(timestamp), credentialScope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')
  ].join('\n');

  const kDate = crypto.createHmac('sha256', 'TC3' + secretKey).update(date, 'utf8').digest();
  const kService = crypto.createHmac('sha256', kDate).update(SERVICE, 'utf8').digest();
  const kSigning = crypto.createHmac('sha256', kService).update('tc3_request', 'utf8').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization = algorithm +
    ' Credential=' + secretId + '/' + credentialScope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;

  const res = await fetch('https://' + HOST, {
    method: 'POST',
    headers: {
      'Authorization': authorization,
      'Content-Type': 'application/json; charset=utf-8',
      'X-TC-Action': action,
      'X-TC-Version': VERSION,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Region': o.region || REGION
    },
    body: payloadStr
  });

  const json = await res.json();
  if (json.Response && json.Response.Error) {
    const err = json.Response.Error;
    const e = new Error(err.Code + ': ' + err.Message);
    e.code = err.Code;
    e.requestId = json.Response.RequestId || '';
    throw e;
  }
  return json.Response || {};
}

/* ------------------------------------------------------------------ *
 *  响应映射
 * ------------------------------------------------------------------ */

/**
 * DetectedText[] → { text, lines, avgConfidence, minConfidence, lowConfLines }
 *
 * 关键点：OCR 会把「」里的条款名、金额、日期识错，
 * 而合同比对面临的正是「金额/日期必须逐字对上」的场景。
 * 所以这里额外输出置信度，让比对引擎能把低置信度的行标为
 * 「疑似识别误差」而不是当成「合同真的写错了」——否则用户会
 * 去改本来正确的合同。
 */
function mapGeneral(resp) {
  const list = (resp && resp.DetectedText) || [];
  const lines = [];
  let confSum = 0;
  for (const it of list) {
    const t = String((it && it.Text) || '').replace(/\r/g, '').trim();
    if (!t) continue;
    // Confidence 是 0~100 的整数；腾讯云偶尔不给，视为 0
    const c = Number(it && it.Confidence);
    const conf = isFinite(c) ? c : 0;
    confSum += conf;
    lines.push({
      text: t,
      confidence: conf,
      polygon: (it && it.ItemPolygon) || null
    });
  }
  const text = lines.map(l => l.text).join('\n');
  const avg = lines.length ? confSum / lines.length : 0;
  // 置信度不足的行（<80 视为需人工确认）单独挑出来
  const lowConfLines = lines.filter(l => l.confidence < 80);
  return {
    text: text,
    lines: lines,
    lineCount: lines.length,
    avgConfidence: Math.round(avg * 10) / 10,
    lowConfLines: lowConfLines,
    lowConfCount: lowConfLines.length,
    angle: (resp && resp.Angle) || 0
  };
}

/* ------------------------------------------------------------------ *
 *  对外入口
 * ------------------------------------------------------------------ */

/** 是否具备 OCR 能力（凭据是否齐备） */
function isConfigured() {
  return !!(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 识别单张图片 / 单页 PDF
 * @param {Buffer} buf
 * @param {{isPdf?:boolean, page?:number}} o
 * @returns {Promise<{ok:boolean, ...}>} 永不抛异常
 */
async function recognizeOnce(buf, o) {
  const opt = o || {};
  if (!isConfigured()) {
    return { ok: false, code: 'OCR_NO_CREDENTIAL', msg: '未配置腾讯云 OCR 凭据（TENCENT_SECRET_ID / TENCENT_SECRET_KEY）' };
  }
  if (!buf || !buf.length) {
    return { ok: false, code: 'OCR_EMPTY', msg: '文件内容为空' };
  }
  if (buf.length > MAX_BYTES) {
    return {
      ok: false, code: 'OCR_TOO_LARGE',
      msg: '文件 ' + (buf.length / 1024 / 1024).toFixed(1) + 'MB 超出识别上限 ' + (MAX_BYTES / 1024 / 1024).toFixed(1) + 'MB'
    };
  }

  const isPdf = !!opt.isPdf;
  const payload = {
    ImageBase64: buf.toString('base64'),
    IsPdf: isPdf,
    // 图片类型传 PdfPageNumber 无意义，但腾讯云会忽略，这里只在 PDF 时带
    IsWords: false,
    EnableDetectSplit: true,
    EnableRotateDetect: true
  };
  if (isPdf) payload.PdfPageNumber = Math.max(1, opt.page || 1);

  try {
    const resp = await tencentApiCall('GeneralAccurateOCR', payload, opt);
    const m = mapGeneral(resp);
    if (!m.text) {
      return { ok: false, code: 'OCR_NO_TEXT', msg: '未识别到任何文字（图片可能是空白或纯图形）', ...m };
    }
    return { ok: true, ...m };
  } catch (e) {
    // 未检测到文本：这是「预期内的业务结果」，不是故障，不该重试
    if (e.code === 'FailedOperation.ImageNoText') {
      return { ok: false, code: 'OCR_NO_TEXT', msg: '未检测到文本', noRetry: true };
    }
    // 限频：串行调用仍可能撞上，退避一次后重试
    if (e.code === 'RequestLimitExceeded' && opt.retry !== false) {
      await sleep(1200);
      return recognizeOnce(buf, Object.assign({}, opt, { retry: false }));
    }
    return { ok: false, code: e.code || 'OCR_ERROR', msg: e.message || String(e) };
  }
}

/**
 * 统一入口：图片识别 / PDF 多页逐页识别
 *
 * PDF 多页说明：腾讯云 GeneralAccurateOCR 的 PdfPageNumber **仅支持单页**，
 * 所以必须循环调用。这里串行 + 限速，避免 10 次/秒 的限频被瞬时打满。
 *
 * @param {Buffer} buf
 * @param {string} fileName 用于判断是不是 PDF
 * @param {{maxPages?:number}} o
 * @returns {Promise<{ok, text, lines, pages, avgConfidence, lowConfLines, code, msg}>}
 */
async function recognize(buf, fileName, o) {
  const opt = o || {};
  const name = String(fileName || '');
  let isPdf = /\.pdf$/i.test(name);
  if (!isPdf && buf && buf.length > 4 && buf.slice(0, 5).toString('latin1') === '%PDF-') isPdf = true;

  if (!isPdf) {
    const r = await recognizeOnce(buf, opt);
    if (r.ok) {
      return {
        ok: true, engine: 'tencent-general-accurate', kind: 'image',
        text: r.text, lines: r.lines, pageCount: 1, pages: [{ page: 1, ok: true, chars: r.text.length }],
        avgConfidence: r.avgConfidence, lowConfLines: r.lowConfLines, lowConfCount: r.lowConfCount,
        angle: r.angle
      };
    }
    // 图片失败时明确告诉调用方「是不是根本没配凭据」，方便前端提示
    return {
      ok: false, engine: 'tencent-general-accurate', kind: 'image',
      text: '', lines: [], pageCount: 0, pages: [],
      code: r.code, msg: r.msg, lowConfCount: 0
    };
  }

  // ---- PDF 路径 ----
  const maxPages = Math.max(1, Math.min(opt.maxPages || MAX_PDF_PAGES, MAX_PDF_PAGES));
  const allLines = [];
  const pages = [];
  let confSum = 0, confN = 0, angle = 0;
  let firstErr = null;

  for (let p = 1; p <= maxPages; p++) {
    if (p > 1) await sleep(PAGE_GAP_MS);
    const r = await recognizeOnce(buf, Object.assign({}, opt, { isPdf: true, page: p }));
    if (r.ok) {
      pages.push({ page: p, ok: true, chars: r.text.length, avgConfidence: r.avgConfidence });
      r.lines.forEach(l => { allLines.push(l); confSum += l.confidence; confN++; });
      if (r.angle) angle = r.angle;
    } else {
      pages.push({ page: p, ok: false, code: r.code, msg: r.msg });
      if (!firstErr) firstErr = r;
      // 没配凭据 / 文件过大：后续页必然同样失败，直接停
      if (r.code === 'OCR_NO_CREDENTIAL' || r.code === 'OCR_TOO_LARGE') break;
      // 这一页没文字（空白页/纯盖章页）不算致命，继续下一页
      if (r.code === 'OCR_NO_TEXT' || r.noRetry) continue;
      // 其他错误（限频重试后仍失败等）也继续，尽量多拿几页
    }
  }

  if (!allLines.length) {
    const r = firstErr || { code: 'OCR_NO_TEXT', msg: 'PDF 所有页面均未识别到文字（可能是空白件）' };
    return {
      ok: false, engine: 'tencent-general-accurate', kind: 'pdf',
      text: '', lines: [], pageCount: pages.length, pages: pages,
      code: r.code, msg: r.msg, lowConfCount: 0
    };
  }

  // 多页之间加分页标记，便于比对引擎定位「第 3 页的租金条款」
  let text = '';
  let li = 0;
  pages.forEach(pg => {
    if (!pg.ok || !pg.chars) return;
    const take = allLines.slice(li, li + pg.chars);
    li += pg.chars;
    text += '【第 ' + pg.page + ' 页】\n' + take.map(l => l.text).join('\n') + '\n';
  });

  const lowConfLines = allLines.filter(l => l.confidence < 80);
  return {
    ok: true, engine: 'tencent-general-accurate', kind: 'pdf',
    text: text.replace(/\n+$/, ''), lines: allLines,
    pageCount: pages.filter(p => p.ok).length, pages: pages,
    avgConfidence: confN ? Math.round((confSum / confN) * 10) / 10 : 0,
    lowConfLines: lowConfLines, lowConfCount: lowConfLines.length,
    angle: angle,
    // 部分页失败但整体有文字：ok=true 但要如实告知，避免审批人误以为全文都识别了
    partial: pages.some(p => !p.ok)
  };
}

/* ------------------------------------------------------------------ *
 *  增值税发票专用识别（VatInvoiceOCR）
 * ------------------------------------------------------------------ *
 *
 * 【为什么要单独一套，不复用 recognize()】
 *   GeneralAccurateOCR 返回的是「文本行数组」（DetectedText），
 *   适合合同比对（要逐字比金额/日期）；但发票要的是**结构化字段**
 *   （发票号码 / 开票日期 / 价税合计 / 税率），从文本行里正则抠字段
 *   又脆又容易串行（一张票上「金额」出现三次：合计金额、价税合计大小写）。
 *   VatInvoiceOCR 直接返回 VatInvoiceInfos[{Name,Value}] 键值对，稳定得多。
 *
 * 【限制】
 *   · 只认**增值税发票版式**：不是发票的图（合同/收据/白纸）识别不到，
 *     会返回 FailedOperation.ImageNoText，属于预期结果，不是故障。
 *   · PDF 仅支持**单页**（PdfPageNumber:1）—— 发票本来就一页，
 *     多页 PDF 也只认第 1 页，避免循环调用把限频打满。
 *   · base64 编码后 ≤ 10MB，换算回原图约 7MB；这里按 7MB 卡，
 *     与参考项目 J:\建筑工程管理系统网页版 的实际生产取值一致。
 *
 * 【设计原则】与本文件其余部分一致 —— 永不抛异常。失败一律返回
 *   { ok:false, code, msg }，调用方（附件上传）据此挂 ocr_error，
 *   **绝不让识别失败影响附件本身的上传**。
 */

// base64 后 ≤10MB ⇒ 原图 ≤ 7.5MB，取 7MB 留余量（比通用识别的 9.2MB 更保守）
const MAX_VAT_BYTES = 7 * 1024 * 1024;

/** 键名归一化：全角括号 → 半角，去空白。腾讯云偶尔返回「价税合计（小写）」 */
function _vatNormKey(s) {
  return String(s || '').replace(/（/g, '(').replace(/）/g, ')').replace(/\s+/g, '').trim();
}

/** VatInvoiceInfos[{Name,Value}] → { 归一化键名: 值 } */
function _vatIndex(resp) {
  const infos = (resp && resp.VatInvoiceInfos) || [];
  const m = {};
  for (const it of infos) {
    const k = _vatNormKey(it && it.Name);
    const v = String((it && it.Value) || '').trim();
    if (k && m[k] === undefined) m[k] = v;
  }
  return m;
}

/** 按候选键名依次取值（第一个非空命中），容忍 OCR 输出键名的细微差异 */
function _vatPick(m, names) {
  for (const n of names) {
    const k = _vatNormKey(n);
    if (m[k] !== undefined && m[k] !== '') return m[k];
  }
  return '';
}

/** 「No 12345678」/「№ 12345678」→「12345678」 */
function _vatCleanNo(s) {
  return String(s || '').replace(/^(?:No|NO|no|№|#)\s*/i, '').replace(/\s/g, '').trim();
}

/** 「2019年04月25日」/「2019-4-5」/「20190425」→「2019-04-25」；识别不到返回 '' */
function _vatNormDate(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  const m = t.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  const m2 = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m2) return m2[1] + '-' + m2[2] + '-' + m2[3];
  return '';
}

/**
 * 「13%」→ 13；「0.13」→ 13（比例形式换算）；「9」→ 9
 * 注意判别顺序：带 % 的按原数取，不带 % 且 0<n≤1 才当比例。
 * 否则「1%」（小规模）会被错算成 100。
 */
function _vatRate(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  const n = parseFloat(t.replace(/[^\d.]/g, ''));
  if (isNaN(n)) return '';
  if (!/%/.test(t) && n > 0 && n <= 1) return Math.round(n * 1000) / 10;
  return n;
}

/** 「¥1,130.00」→ 1130；非法返回 ''（不返回 0，0 会被误当成真实金额） */
function _vatMoney(s) {
  const t = String(s || '').replace(/[^\d.\-]/g, '');
  if (!t) return '';
  const n = parseFloat(t);
  return isNaN(n) ? '' : n;
}

/**
 * VatInvoiceOCR 响应 → 业务字段
 * @returns {{invoice_no,date,buyer,buyer_tax_no,seller,seller_tax_no,tax_rate,tax_included,tax_excluded,tax,raw}}
 *
 * 字段取舍说明：
 *   · 本系统记录的是**开给别人**的销项发票 ⇒ 票面上的「购买方」= 客户，
 *     映射到表单的「发票抬头」(title)；「销售方」= 本公司，仅留档不填表单。
 *   · tax_included（价税合计·小写）对应表单「开票金额」—— 本项目
 *     beforeInsert 的税额算式 `amount - amount/(1+税率)` 正是**含税**口径。
 */
function mapVatInvoice(resp) {
  const m = _vatIndex(resp);
  return {
    invoice_no: _vatCleanNo(_vatPick(m, ['发票号码', '发票号'])),
    date: _vatNormDate(_vatPick(m, ['开票日期', '开票时间'])),
    buyer: _vatPick(m, ['购买方名称', '购买方', '购方名称', '购方']),
    buyer_tax_no: _vatPick(m, ['购买方纳税人识别号', '购买方纳税人识别码', '纳税人识别号']),
    buyer_bank: _vatPick(m, ['购买方开户行及账号', '购买方开户行及帐号']),
    buyer_addr: _vatPick(m, ['购买方地址电话', '购买方地址、电话']),
    seller: _vatPick(m, ['销售方名称', '销售方', '销方名称', '销方']),
    seller_tax_no: _vatPick(m, ['销售方纳税人识别号', '销售方纳税人识别码']),
    tax_rate: _vatRate(_vatPick(m, ['税率', '税率(%)', '税率（%）'])),
    tax_included: _vatMoney(_vatPick(m, ['价税合计(小写)', '价税合计（小写）', '小写金额', '价税合计'])),
    tax_excluded: _vatMoney(_vatPick(m, ['合计金额', '金额合计', '金额'])),
    tax: _vatMoney(_vatPick(m, ['合计税额', '税额合计', '税额'])),
    raw: m
  };
}

/**
 * 识别增值税发票（图片 / 单页 PDF）
 * @param {Buffer} buf
 * @param {string} mime      用于判断是否 PDF
 * @param {string} [fileName] 兜底判断是不是 PDF（有些上传不带 mime）
 * @param {{retry?:boolean}} [o] retry:false 表示「限频只重试一次」
 * @returns {Promise<{ok:boolean, code?:string, msg?:string, ...fields}>} 永不抛异常
 */
async function recognizeVatInvoice(buf, mime, fileName, o) {
  const opt = o || {};
  if (!isConfigured()) {
    return { ok: false, code: 'OCR_NO_CREDENTIAL', msg: '未配置腾讯云 OCR 凭据（TENCENT_SECRET_ID / TENCENT_SECRET_KEY）' };
  }
  if (!buf || !buf.length) {
    return { ok: false, code: 'OCR_EMPTY', msg: '文件内容为空' };
  }
  if (buf.length > MAX_VAT_BYTES) {
    return {
      ok: false, code: 'OCR_TOO_LARGE',
      msg: '文件 ' + (buf.length / 1024 / 1024).toFixed(1) + 'MB 超出发票识别上限 ' + (MAX_VAT_BYTES / 1024 / 1024).toFixed(1) + 'MB'
    };
  }

  let isPdf = /pdf/i.test(mime || '') || /\.pdf$/i.test(String(fileName || ''));
  // 有些客户端把 PDF 的 mime 丢成 octet-stream，用文件头兜底
  if (!isPdf && buf.length > 4 && buf.slice(0, 5).toString('latin1') === '%PDF-') isPdf = true;

  const payload = {
    ImageBase64: buf.toString('base64'),
    IsPdf: isPdf,
    PdfPageNumber: 1            // 发票只有一页；VatInvoiceOCR 仅支持单页
  };

  try {
    const resp = await tencentApiCall('VatInvoiceOCR', payload, {});
    const m = mapVatInvoice(resp);
    // 一张票一个字段都没认出来 —— 图可能不是发票版式，如实返回而不是给一堆空串
    if (!m.invoice_no && !m.date && m.tax_included === '') {
      return { ok: false, code: 'OCR_NOT_INVOICE', msg: '未识别到发票要素（图片可能不是增值税发票，或过于模糊）', ...m };
    }
    return { ok: true, engine: isPdf ? 'tencent-vat-invoice-pdf' : 'tencent-vat-invoice', ...m };
  } catch (e) {
    if (e.code === 'FailedOperation.ImageNoText') {
      return { ok: false, code: 'OCR_NO_TEXT', msg: '未检测到发票文字（图片可能不是发票版式）', noRetry: true };
    }
    if (e.code === 'RequestLimitExceeded' && opt.retry !== false) {
      await sleep(1200);
      return recognizeVatInvoice(buf, mime, fileName, { retry: false });
    }
    return { ok: false, code: e.code || 'OCR_ERROR', msg: e.message || String(e) };
  }
}

module.exports = {
  recognize,        // 统一入口（图片 / PDF 多页，通用文字识别）
  recognizeOnce,    // 单页（内部用，测试方便）
  recognizeVatInvoice, // 增值税发票专用识别（结构化字段）
  isConfigured,     // 凭据是否齐备
  tencentApiCall,   // 底层签名（测试用）
  mapGeneral,       // 响应映射（测试用）
  mapVatInvoice,    // 发票响应映射（测试用）
  MAX_BYTES, MAX_PDF_PAGES, MAX_VAT_BYTES
};
