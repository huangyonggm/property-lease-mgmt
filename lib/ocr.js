'use strict';
/**
 * 腾讯云通用文字识别（高精度版）—— 零依赖，手签 TC3-HMAC-SHA256。
 *
 * 移植自 J:\建筑工程管理系统网页版\netlify\functions\api.js 的 tencentApiCall()，
 * 差别在于：那边是「增值税发票专用」（VatInvoiceOCR，返回结构化字段），
 * 这边改成「通用文档识别」（GeneralAccurateOCR，返回 DetectedText 文本行数组）。
 *
 * 为什么要通用版：
 *   招商部上报的合同是 A4 扫描件 / 手机拍的 JPG，不是发票版式。
 *   发票专用接口只认发票的固定字段区，对整页合同基本识别不出东西。
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

module.exports = {
  recognize,        // 统一入口（图片 / PDF 多页）
  recognizeOnce,    // 单页（内部用，测试方便）
  isConfigured,     // 凭据是否齐备
  tencentApiCall,   // 底层签名（测试用）
  mapGeneral,       // 响应映射（测试用）
  MAX_BYTES, MAX_PDF_PAGES
};
