'use strict';
/**
 * 文档文本提取层（零依赖，Netlify Serverless 友好）
 *
 * 为什么零依赖：Netlify Functions 只能装纯 JS 包，原生模块（canvas/tesseract.node）
 * 装不上。所以 zip / pdf 解析全部用 Node 内置能力手搓：
 *   - docx  → zlib.inflateRawSync 解 zip + 正则取 OOXML 的 <w:t>
 *   - pdf   → zlib.inflateSync 解 FlateDecode + 解析 ToUnicode CMap 还原 CID 中文
 *              （实测本项目普票模板是 Adobe-Identity-UCS，映射表完整可还原）
 *   - 图片  → 无文本层，交给 OCR 通道（见 ocr.js），这里只负责识别与提示
 *
 * 统一出口：extract(buffer, filename) → { text, paras:[{text,bold}], kind, engine, warn[] }
 */
const zlib = require('zlib');

/* ---------------- zip（docx/xlsx/pptx 都是 zip） ---------------- */

/**
 * 读 zip 中央目录。
 * ⚠ 必须走中央目录（EOCD）而不是逐个扫本地头 —— docx 的流大小可能为 0（data descriptor 模式），
 * 逐个扫会拿到错误的偏移。
 */
function readZip(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 66000); // 注释+中央目录可能很大
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/docx 文件（找不到 EOCD）');
  const n = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let k = 0; k < n; k++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const lnameLen = buf.readUInt16LE(lho + 26);
    const lextraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lnameLen + lextraLen;
    const raw = buf.slice(dataStart, dataStart + csize);
    try {
      out[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    } catch (e) {
      out[name] = raw; // 存目录等场景返回原始字节，调用方自行判断
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

const XML_ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
function unescXml(s) {
  return String(s).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, m => XML_ENT[m])
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

/* ---------------- docx ---------------- */

/**
 * 从 word/document.xml 抽段落。
 * ⚠ 不能用 /<w:p[\s\S]*?<\/w:p>/ 直接切：段落里如果有嵌套结构（嵌套表格、批注锚点）
 * 会切错。改用「按 <w:p> 开边界 + 深度无关的正则」在真实项目里更稳，
 * 这里用逐段扫描 + 配平计数，兼容嵌套。
 */
function docxParas(xml) {
  const paras = [];
  // 逐个找 <w:p ...> 开标签，记录其真实结束位置
  const open = /<w:p(?:\s[^>]*)?>/g;
  let m;
  const starts = [];
  while ((m = open.exec(xml))) starts.push({ idx: m.index, tag: m[0] });
  for (let i = 0; i < starts.length; i++) {
    const seg = starts[i + 1] ? xml.slice(starts[i].idx, starts[i + 1].idx) : xml.slice(starts[i].idx);
    // 段内文本：w:t（跳过 pPr/rPr 里的属性；这些属性节点里没有 <w:t>，天然安全）
    const texts = [];
    const tre = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t\/>/g;
    let t;
    while ((t = tre.exec(seg))) {
      if (t[1] !== undefined) texts.push(unescXml(t[1]));
    }
    // 特殊元素
    if (/<w:tab\s*\/>/.test(seg)) texts.push('\t');
    if (/<w:br\s*\/>/.test(seg)) texts.push('\n');
    const bold = /<w:b(?:\s*\/|\s+[^>]*>)/.test(seg);
    // 表格里的段落要标记出来（比对表格内容时有用）
    const inTable = /<w:tbl[ >]/.test(seg) === false && starts[i].idx < (xml.lastIndexOf('<w:tbl>', starts[i].idx) + 1);
    paras.push({ text: texts.join(''), bold: bold, inTable: inTable });
  }
  return paras;
}

function extractDocx(buf, warn) {
  const files = readZip(buf);
  const doc = files['word/document.xml'];
  if (!doc) throw new Error('docx 缺少 word/document.xml');
  const xml = doc.toString('utf8');
  const paras = docxParas(xml);
  if (!paras.length) { warn.push('docx 里没抽到任何段落（可能是空文档或结构异常）'); }
  // 页眉页脚也可能有合同编号等关键信息
  ['word/header1.xml', 'word/footer1.xml'].forEach(h => {
    if (files[h]) {
      const hp = docxParas(files[h].toString('utf8'));
      hp.forEach(p => { if (p.text.trim()) paras.push({ text: p.text, bold: p.bold, inHeader: true }); });
    }
  });
  return {
    paras: paras,
    text: paras.map(p => p.text).join('\n'),
    engine: 'docx-ooml',
    tables: countTables(xml)
  };
}
function countTables(xml) {
  return (xml.match(/<w:tbl[ >]/g) || []).length;
}

/* ---------------- pdf ---------------- */

/** 收集 pdf 里所有 stream 的解压结果 */
function pdfStreams(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const i = buf.indexOf('stream', pos);
    if (i < 0) break;
    let s = i + 6;
    if (buf[s] === 13) s++;
    if (buf[s] === 10) s++;
    const e = buf.indexOf('endstream', s);
    if (e < 0) break;
    const raw = buf.slice(s, e);
    let data = null;
    try { data = zlib.inflateSync(raw); }
    catch (err) {
      try { data = zlib.inflateRawSync(raw); } catch (e2) { data = null; }
    }
    out.push({ start: i, raw: raw, data: data });
    pos = e + 9;
  }
  return out;
}

/** 解析 ToUnicode CMap → { cid: '字符' } */
function parseCMap(text) {
  const map = {};
  const bre = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = bre.exec(text))) {
    const pair = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let p;
    while ((p = pair.exec(m[1]))) {
      const cid = parseInt(p[1], 16);
      const hex = p[2];
      // UTF-16BE，每 4 位 hex 一个码位
      let s = '';
      for (let i = 0; i + 3 < hex.length + 1; i += 4) {
        const cp = parseInt(hex.substr(i, 4), 16);
        if (!isNaN(cp) && cp > 0) s += String.fromCharCode(cp);
      }
      if (s) map[cid] = s;
    }
  }
  const bcre = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bcre.exec(text))) {
    const rr = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g;
    let r;
    while ((r = rr.exec(m[1]))) {
      const lo = parseInt(r[1], 16), hi = parseInt(r[2], 16);
      if (r[3][0] === '<') {
        const baseHex = r[3].slice(1, -1);
        const base = parseInt(baseHex, 16);
        for (let c = lo; c <= hi && c - lo < 65535; c++) {
          map[c] = String.fromCharCode(base + (c - lo));
        }
      } else {
        const items = (r[3].match(/<[0-9A-Fa-f]+>/g) || []).map(s => parseInt(s.slice(1, -1), 16));
        items.forEach((cp, i) => { if (lo + i <= hi) map[lo + i] = String.fromCharCode(cp); });
      }
    }
  }
  return map;
}

/** 解码 PDF 字符串字面量 ( ... ) 里的转义 */
function pdfUnescape(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out.push(c); continue; }
    const n = s[++i];
    if (n === 'n') out.push('\n');
    else if (n === 'r') out.push('\r');
    else if (n === 't') out.push('\t');
    else if (n === 'b') out.push('\b');
    else if (n === 'f') out.push('\f');
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') oct += s[++i];
      out.push(String.fromCharCode(parseInt(oct, 8)));
    } else out.push(n);
  }
  return out.join('');
}

/** 从内容流里抽文本，cmap 把 CID 转回中文 */
function pdfTextFromContent(content, cmap) {
  const paras = [];
  let cur = '';
  // 1) 显式文本算子
  const tre = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\bTJ\b|\bTj\b|\bTD\b|\bTd\b|\bT\*\b|\bTD\b|'|"/g;
  let m;
  while ((m = tre.exec(content))) {
    const s = m[0];
    if (s[0] === '(') {
      cur += decodePdfStr(pdfUnescape(s.slice(1, -1)), cmap);
    } else if (s[0] === '<') {
      cur += decodePdfHex(s.slice(1, -1), cmap);
    } else if (s === 'Td' || s === 'TD' || s === 'T*' || s === "'" || s === '"') {
      if (cur.trim()) { paras.push({ text: cur, bold: false }); cur = ''; }
    }
  }
  if (cur.trim()) paras.push({ text: cur, bold: false });
  return paras;
}

function decodePdfStr(s, cmap) {
  // 双字节 CID：每 2 字节一个码（多数中文 PDF 是 Identity 编码）
  let out = '';
  if (cmap && Object.keys(cmap).length) {
    for (let i = 0; i < s.length; i += 2) {
      const cid = (s.charCodeAt(i) << 8) | (s.charCodeAt(i + 1) || 0);
      out += cmap[cid] !== undefined ? cmap[cid] : '';
    }
    if (out) return out;
  }
  return s;
}
function decodePdfHex(h, cmap) {
  const hex = h.replace(/\s+/g, '');
  let out = '';
  const step = (hex.length % 4 === 0) ? 4 : 2;
  for (let i = 0; i < hex.length; i += step) {
    const cid = parseInt(hex.substr(i, step), 16);
    out += cmap[cid] !== undefined ? cmap[cid] : '';
  }
  return out;
}

function extractPdf(buf, warn) {
  const streams = pdfStreams(buf);
  // 合并所有 ToUnicode CMap（多字体时并集；冲突时先出现的赢）
  const cmap = {};
  streams.forEach(s => {
    if (!s.data) return;
    const t = s.data.toString('latin1');
    if (t.indexOf('begincmap') < 0) return;
    const one = parseCMap(t);
    Object.keys(one).forEach(k => { if (cmap[k] === undefined) cmap[k] = one[k]; });
  });
  const cmapCount = Object.keys(cmap).length;
  if (!cmapCount) warn.push('PDF 未找到 ToUnicode 映射表（可能是纯图片扫描件，需要 OCR）');

  // 抽内容流：含 Tj/TJ 算子的
  const paras = [];
  streams.forEach(s => {
    if (!s.data) return;
    const t = s.data.toString('latin1');
    if (!/\bTJ\b|\bTj\b/.test(t)) return;
    if (/begincmap/.test(t)) return;   // 跳过 CMap 自身
    pdfTextFromContent(t, cmap).forEach(p => {
      if (p.text && p.text.trim()) paras.push(p);
    });
  });

  // 有些 PDF 每页独立字体，CID 从 0 重新开始 —— 若上面得到乱码，回退按 GBK 直解
  let text = paras.map(p => p.text).join('\n');
  if (!text.trim()) {
    warn.push('PDF 未抽到文本，疑似扫描件（纯图片），需走 OCR');
  }
  return { paras: paras, text: text, engine: 'pdf-cmap', cmapSize: cmapCount };
}

/* ---------------- 纯文本 / html ---------------- */
function extractTxt(buf) {
  let s = buf.toString('utf8');
  if (s.indexOf('�') >= 0) s = buf.toString('latin1'); // 可能是 GBK
  // 尝试 GBK
  if (s.indexOf('�') >= 0) {
    try { s = new TextDecoder('gbk').decode(buf); } catch (e) { /* 环境不支持就算了 */ }
  }
  const paras = s.split(/\r?\n/).map(t => ({ text: t.replace(/<[^>]+>/g, '').trim(), bold: false }))
    .filter(p => p.text);
  return { paras: paras, text: paras.map(p => p.text).join('\n'), engine: 'txt' };
}

/* ---------------- 统一入口 ---------------- */

const EXT = {
  docx: buf => extractDocx(buf, []),
  pdf: null, // 需要 warn 数组，特殊处理
  txt: extractTxt,
  md: extractTxt,
  jpg: null, png: null, jpeg: null, webp: null
};
/**
 * @param {Buffer} buf 文件内容
 * @param {string} filename 用于判断类型
 * @returns {{text,paras,kind,engine,warn,isImage}}
 */
function extract(buf, filename) {
  const warn = [];
  const name = String(filename || '');
  let kind = (name.split('.').pop() || '').toLowerCase();
  const isImage = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'].indexOf(kind) >= 0;
  if (isImage) {
    return {
      kind: 'image', isImage: true, paras: [], text: '',
      engine: 'none', warn: ['图片无文本层，需要 OCR'],
      mime: { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif' }[kind] || 'application/octet-stream'
    };
  }
  // 兜底按魔数判断（有些上传文件扩展名不对）
  if (buf.length > 2 && buf.readUInt16LE(0) === 0x4b50) kind = 'docx';
  else if (buf.slice(0, 5).toString('latin1') === '%PDF-') kind = 'pdf';
  try {
    if (kind === 'pdf') {
      const r = extractPdf(buf, warn);
      return { kind: 'pdf', isImage: false, paras: r.paras, text: r.text, engine: r.engine, warn, cmapSize: r.cmapSize };
    }
    if (kind === 'docx') {
      const w = [];
      const r = extractDocx(buf, w);
      return { kind: 'docx', isImage: false, paras: r.paras, text: r.text, engine: r.engine, warn: w.concat(warn), tables: r.tables };
    }
    const r = extractTxt(buf);
    return { kind: kind || 'txt', isImage: false, paras: r.paras, text: r.text, engine: r.engine, warn };
  } catch (e) {
    throw new Error('解析失败（' + kind + '）：' + e.message);
  }
}

/* ---------------- OCR 通道（异步，自动识别图片 / 扫描件） ---------------- */

let _ocr = null;
function ocr() {
  if (!_ocr) _ocr = require('./ocr');
  return _ocr;
}

/**
 * 判断这次解析是否「必须走 OCR」——即无文本层可用的场景：
 *   ① 图片（jpg/png/webp/bmp/gif）：天然没有文本层
 *   ② 扫描版 PDF：抽到 ToUnicode 但没抽到文字（纯图片页）
 *   ③ PDF 连 ToUnicode 都没有（cmapSize = 0）
 *
 * 注意判定顺序：先看「有没有抽到字」，再看「有没有 cmap」。
 * 有些 PDF 有 cmap 但正文是图片（部分页文字 + 部分页扫描），
 * 只要总体抽不到字就必须 OCR，不能因为 cmapSize > 0 就放过。
 */
function needsOcr(doc) {
  if (!doc) return false;
  if (doc.isImage) return true;
  if (doc.kind !== 'pdf') return false;
  const txt = String(doc.text || '').trim();
  if (txt.length >= 20) return false;   // 抽到足量文字就不用 OCR
  return true;
}

/** 判断是「图片」还是「扫描 PDF」，决定 OCR 调用参数 */
function ocrKindOf(doc, fileName) {
  if (doc && doc.isImage) return 'image';
  const name = String(fileName || '').toLowerCase();
  if (/\.(jpg|jpeg|png|webp|bmp|gif)$/.test(name)) return 'image';
  if (doc && doc.kind === 'pdf') return 'pdf';
  return 'image';
}

/**
 * 异步解析入口：抽不到文字时自动调 OCR。
 *
 * 与同步 extract() 的区别只有一处：多了 OCR 兜底，其余行为完全一致
 * （返回结构相同，paras/text/kind/warn 都齐），所以调用方可以无痛替换。
 *
 * 返回的 doc 额外带 ocr 字段（engine / avgConfidence / lowConfLines 等），
 * 供合同比对把「低置信度的行」标记为疑似识别误差，避免误判成合同写错。
 *
 * OCR 失败（未配凭据 / 超限 / 服务异常）不抛异常：
 * 退化成原来的 needOcr 语义，让上层照常提示人工处理。
 */
async function extractAsync(buf, fileName, opt) {
  const o = opt || {};
  const base = extract(buf, fileName);
  base.ocrTried = false;
  base.ocrOk = false;

  if (o.ocr === false) return base;       // 调用方显式关闭（opt.ocr === false）
  if (!needsOcr(base)) return base;        // 有文本层，不必浪费 OCR 额度
  if (!ocr().isConfigured()) {            // 未配凭据：保持 needOcr 语义
    base.warn = (base.warn || []).slice();
    base.warn.push('未配置腾讯云 OCR 凭据，图片/扫描件需人工录入或配置 TENCENT_SECRET_ID / TENCENT_SECRET_KEY');
    return base;
  }

  base.ocrTried = true;
  const kind = ocrKindOf(base, fileName);
  const r = await ocr().recognize(buf, fileName, { maxPages: o.maxOcrPages });

  if (!r.ok || !r.text) {
    base.warn = (base.warn || []).slice();
    base.warn.push('OCR 未成功（' + (r.code || '未知') + '）：' + (r.msg || '') +
      (kind === 'image' ? '' : '，该 PDF 可能是加密或结构异常，建议另存为 JPG 上传'));
    base.ocrError = { code: r.code || 'OCR_ERROR', msg: r.msg || '' };
    return base;
  }

  // OCR 成功：把识别文本当作正文，交回给比对引擎
  const paras = (r.lines || []).map(l => ({ text: l.text, bold: false, confidence: l.confidence }));
  base.text = r.text;
  base.paras = paras;
  base.isImage = false;                   // 有文本了，不再是「无文本层图片」
  base.engine = r.engine;
  base.ocrOk = true;
  base.ocr = {
    kind: kind,
    engine: r.engine,
    pageCount: r.pageCount || 0,
    pages: r.pages || [],
    partial: !!r.partial,
    avgConfidence: r.avgConfidence || 0,
    lowConfCount: r.lowConfCount || 0,
    lowConfLines: (r.lowConfLines || []).map(l => ({ text: l.text, confidence: l.confidence })),
    angle: r.angle || 0
  };
  // 低置信度必须显式警告：金额/日期识错会被比对引擎判成「合同金额不符」，
  // 审批人看到这条才知道要去核原件，而不是去改本来正确的合同。
  if (r.lowConfCount) {
    base.warn = (base.warn || []).slice();
    base.warn.push('OCR 有 ' + r.lowConfCount + ' 行置信度偏低（<80），涉及金额/日期的差异请以原件为准：' +
      r.lowConfLines.slice(0, 3).map(l => '「' + l.text.slice(0, 24) + '」').join(' '));
  }
  if (r.partial) {
    base.warn = (base.warn || []).slice();
    base.warn.push('PDF 部分页面 OCR 失败，识别结果可能不完整');
  }
  return base;
}

/** OCR 是否已配置（前端可据此提示用户去配凭据） */
function ocrConfigured() {
  try { return ocr().isConfigured(); } catch (e) { return false; }
}

module.exports = {
  extract, extractAsync, needsOcr, ocrConfigured,
  readZip, parseCMap, pdfStreams, docxParas, unescXml
};
