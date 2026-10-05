'use strict';
/**
 * 零第三方依赖的 Excel 解析（仅使用 Node 内置模块）
 *   .xls  → OLE2(CFB) 复合文档 + BIFF8 记录解析
 *   .xlsx → ZIP(Stored/Deflate) + sharedStrings.xml / sheetN.xml
 *   .csv  → 直接按逗号分隔
 * 目标：物业巡更点位表 / 巡查记录表可直接上传，无需安装 Python 与 xlrd / openpyxl
 */
const zlib = require('zlib');

const ENDOFCHAIN = 0xFFFFFFFD;
const FREESECT = 0xFFFFFFFE;
const FATSECT = 0xFFFFFFFF;

/* ============================================================
 *  OLE2 / CFB 复合文档
 * ============================================================ */
class CFB {
  constructor(buf) {
    this.buf = buf;
    if (buf.length < 512) throw new Error('文件过小，不是有效的 OLE2 文档');
    const sig = buf.readUInt32LE(0);
    if (sig !== 0xE011CFD0) throw new Error('不是 Excel 97-2003(.xls) 格式：未找到 OLE2 签名');
    this.sectorSize = 1 << buf.readUInt16LE(30);   // 通常 512
    this.miniSectorSize = 1 << buf.readUInt16LE(32); // 64
    this.numFatSectors = buf.readUInt32LE(44);
    this.firstDirSector = buf.readUInt32LE(48);
    this.miniCutoff = buf.readUInt32LE(56) || 4096;
    this.firstMiniFatSector = buf.readUInt32LE(60);
    this.numMiniFatSectors = buf.readUInt32LE(64);
    this.firstDifatSector = buf.readUInt32LE(68);
    this.numDifatSectors = buf.readUInt32LE(72);
    this._buildFat();
    this._buildDir();
  }

  sectorOffset(n) { return (n + 1) * this.sectorSize; }

  _buildFat() {
    const buf = this.buf;
    const sectors = [];
    for (let i = 0; i < 109; i++) {
      const s = buf.readUInt32LE(76 + i * 4);
      if (s !== FREESECT && s !== 0xFFFFFFFF) sectors.push(s);
      else break;
    }
    // 额外的 DIFAT 扇区
    let dif = this.firstDifatSector;
    let guard = 0;
    while (dif !== ENDOFCHAIN && dif < 0xFFFFFFF0 && guard++ < 10000) {
      const off = this.sectorOffset(dif);
      const per = this.sectorSize / 4 - 1;
      for (let i = 0; i < per; i++) {
        const s = buf.readUInt32LE(off + i * 4);
        if (s === FREESECT || s === 0xFFFFFFFF) break;
        sectors.push(s);
      }
      dif = buf.readUInt32LE(off + per * 4);
    }
    const fat = new Int32Array(sectors.length * (this.sectorSize / 4));
    let k = 0;
    sectors.forEach(s => {
      const off = this.sectorOffset(s);
      for (let i = 0; i < this.sectorSize / 4; i++) fat[k++] = buf.readInt32LE(off + i * 4);
    });
    this.fat = fat;
  }

  // 沿 FAT 链读取一个流
  readChain(start, size) {
    if (start < 0 || size === 0) return Buffer.alloc(0);
    const out = Buffer.alloc(size);
    let s = start, w = 0, guard = 0;
    while (s !== ENDOFCHAIN && s >= 0 && w < size && guard++ < 100000) {
      const off = this.sectorOffset(s);
      if (off + this.sectorSize > this.buf.length) break;
      const n = Math.min(this.sectorSize, size - w);
      this.buf.copy(out, w, off, off + n);
      w += n;
      s = this.fat[s];
      if (s === undefined || s === FREESECT) break;
    }
    return w < size ? out.slice(0, w) : out;
  }

  _buildDir() {
    const data = this.readChain(this.firstDirSector, Math.max(this.sectorSize, 128 * 64));
    this.entries = [];
    for (let off = 0; off + 128 <= data.length; off += 128) {
      const type = data.readUInt8(off + 66);
      if (type !== 2 && type !== 5) continue; // 只要 stream / root
      const nameLen = data.readUInt16LE(off + 64);
      let name = '';
      if (nameLen > 2) name = data.toString('utf16le', off, off + Math.min(nameLen - 2, 64));
      this.entries.push({
        name: name, type: type,
        start: data.readInt32LE(off + 116),
        size: (data.length >= off + 128) ? Number(data.readBigUInt64LE(off + 120)) : 0
      });
    }
    // mini stream（用于 <4096 字节的小流）
    const root = this.entries.filter(e => e.type === 5)[0];
    if (root) this.miniStream = this.readChain(root.start, root.size);
    if (this.numMiniFatSectors > 0 && this.firstMiniFatSector > 0) {
      const m = this.readChain(this.firstMiniFatSector, this.numMiniFatSectors * this.sectorSize);
      const mf = new Int32Array(m.length / 4);
      for (let i = 0; i < mf.length; i++) mf[i] = m.readInt32LE(i * 4);
      this.miniFat = mf;
    }
  }

  getStream(name) {
    const e = this.entries.filter(x => x.name === name || x.name.indexOf(name) === 0)[0];
    if (!e) return null;
    if (e.size < this.miniCutoff && this.miniStream) {
      // MiniFAT 链
      const out = Buffer.alloc(e.size);
      let s = e.start, w = 0, guard = 0;
      while (s !== ENDOFCHAIN && s >= 0 && w < e.size && guard++ < 100000) {
        const off = s * this.miniSectorSize;
        if (off + this.miniSectorSize > this.miniStream.length) break;
        const n = Math.min(this.miniSectorSize, e.size - w);
        this.miniStream.copy(out, w, off, off + n);
        w += n;
        s = this.miniFat ? this.miniFat[s] : ENDOFCHAIN;
        if (s === undefined || s === FREESECT) break;
      }
      return out;
    }
    return this.readChain(e.start, e.size);
  }
}

/* ============================================================
 *  BIFF8 工作表解析
 * ============================================================ */
function utf16(buf, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = buf.readUInt16LE(off + i * 2);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// 解析 SST（共享字符串表）的一个分块，支持 CONTINUE 续接
// 关键点：CONTINUE 开头的 grbit 字节「只有在上一个分块恰好被字符串截断时才存在」，
// 若上一个分块刚好在字符串边界结束，则 CONTINUE 直接就是下一个字符串的 cch/flags。
function parseSst(data, pos, len, sst, state) {
  const end = pos + len;
  let p = pos;
  if (!state.started) {
    state.started = true;
    if (end - p >= 8) { state.total = data.readUInt32LE(p); p += 4; state.count = data.readUInt32LE(p); p += 4; }
  }
  while (p < end) {
    // 跳过富文本 runs / 注音尾部（可能跨块）
    if (state.tail > 0) {
      const t = Math.min(state.tail, end - p);
      p += t; state.tail -= t;
      if (state.tail > 0) return;
      continue;
    }
    // 续接上一个未完成的字符串
    if (state.remaining > 0) {
      const avail = end - p;
      if (avail <= 0) return;
      const take = Math.min(state.remaining, state.highByte ? (avail >> 1) : avail);
      if (take <= 0) return;
      if (state.highByte) { state.str += utf16(data, p, take); p += take * 2; }
      else { state.str += data.toString('latin1', p, p + take); p += take; }
      state.remaining -= take;
      if (state.remaining === 0) { sst.push(state.str); state.str = ''; }
      continue;
    }
    if (p + 3 > end) return;
    const cch = data.readUInt16LE(p); p += 2;
    const flags = data.readUInt8(p); p += 1;
    const highByte = (flags & 0x01) !== 0;
    const extSt = (flags & 0x04) !== 0;
    const rich = (flags & 0x08) !== 0;
    let cRun = 0, cbExtRst = 0;
    if (rich) { cRun = data.readUInt16LE(p); p += 2; }
    if (extSt) { cbExtRst = data.readUInt32LE(p); p += 4; }
    const need = highByte ? cch * 2 : cch;
    const take = Math.min(need, end - p);
    if (highByte) { state.str += utf16(data, p, take >> 1); p += (take >> 1) * 2; }
    else { state.str += data.toString('latin1', p, p + take); p += take; }
    const consumed = highByte ? (take >> 1) : take;
    if (consumed < cch) {
      state.remaining = cch - consumed;
      state.highByte = highByte;
      state.tail = cRun * 4 + cbExtRst;
      return;
    }
    p += cRun * 4 + cbExtRst;
    sst.push(state.str); state.str = '';
  }
}

// RK 值解码
/**
 * BIFF8 的 RK 记录是 4 字节压缩数：
 *   bit0 = fXyz（为 1 时结果要除以 100）
 *   bit1 = fInt（为 1 时剩下 30 位是有符号整数；为 0 时剩下 30 位是 IEEE754 double 的**高 32 位**）
 *
 * 【重要坑】fInt=0 时，那 30 位要放在 double 的**高 4 字节**（offset 4），低 4 字节补 0。
 * 之前错误地写到了低 4 字节（offset 0），把正常日期序列号 46128.587 读成 5.37e-315，
 * 导致设备厂商导出的 xls（用 RK 而非 LABELSST 存值）整列数值变成垃圾，
 * 表头序号列全是 5.29e-315，parseRecords 判定「序号非法」从而 0 条入库。
 * 7 月那份文件全部用 LABELSST，所以这个 bug 一直潜伏着。
 */
function rkValue(rk) {
  const cent = (rk & 0x01) !== 0;      // 是否除以 100
  const isInt = (rk & 0x02) !== 0;     // 1=整数 0=浮点
  let v;
  if (isInt) v = (rk & 0xFFFFFFFC) / 4;   // 用无符号算术右移语义，避免高位负数化
  else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(0, 0);
    b.writeUInt32LE(rk & 0xFFFFFFFC, 4);   // ← 必须放高 4 字节
    v = b.readDoubleLE(0);
  }
  return cent ? v / 100 : v;
}

function parseWorkbook(data) {
  const sst = [];
  const sstState = { started: false, str: '', remaining: 0, tail: 0, highByte: false, total: 0, count: 0 };
  const sheetMeta = [];          // BOUNDSHEET 元信息
  const sheets = [];             // 已完成的子流
  let cur = null;                // 当前子流 { name, cells, maxRow, maxCol }
  let pos = 0;
  let lastWasSst = false;
  let lastFormula = null;        // 上一个 FORMULA 单元格 {row,col}
  let guard = 0;

  function ensure() {
    if (cur) return cur;
    const meta = sheetMeta[sheets.length];
    cur = {
      name: (meta && meta.name) || ('Sheet' + (sheets.length + 1)),
      cells: new Map(), maxRow: -1, maxCol: -1
    };
    return cur;
  }
  function put(row, col, v) {
    const s = ensure();
    s.cells.set(row + ',' + col, v);
    if (row > s.maxRow) s.maxRow = row;
    if (col > s.maxCol) s.maxCol = col;
  }
  function flush() { if (cur) { sheets.push(cur); cur = null; } }

  while (pos + 4 <= data.length && guard++ < 5000000) {
    const id = data.readUInt16LE(pos);
    const len = data.readUInt16LE(pos + 2);
    const body = pos + 4;
    const end = body + len;
    if (end > data.length + 4) break;
    pos = end;

    if (id === 0x003C && lastWasSst) {            // CONTINUE（SST 续接）
      // 只有上一个分块被字符串截断时，CONTINUE 首字节才是 grbit（续接部分的 fHighByte）
      const cont = sstState.remaining > 0 || sstState.tail > 0;
      if (cont) sstState.highByte = (data.readUInt8(body) & 0x01) !== 0;
      parseSst(data, cont ? body + 1 : body, cont ? len - 1 : len, sst, sstState);
      continue;
    }
    lastWasSst = false;
    if (id !== 0x0007) lastFormula = null;        // 0x0007 STRING 是 FORMULA 的字符串缓存

    if (id === 0x0809) {          // BOF：子流开始
      const dt = data.readUInt16LE(body + 2);
      if (dt === 0x0010 || dt === 0x0020 || dt === 0x0040) { flush(); ensure(); }
      else if (dt === 0x0005) { flush(); }        // 全局流
    }
    else if (id === 0x000A) { flush(); }          // EOF：子流结束（不要 break，后面还有工作表）
    else if (id === 0x00FC) {   // SST 起始块
      sstState.started = false; sstState.str = ''; sstState.remaining = 0; sstState.tail = 0;
      parseSst(data, body, len, sst, sstState);
      lastWasSst = true;
    }
    else if (id === 0x0085) {     // BOUNDSHEET
      const nameLen = data.readUInt8(body + 6);
      const high = data.readUInt8(body + 7) & 0x01;
      const nm = high ? utf16(data, body + 8, nameLen) : data.toString('latin1', body + 8, body + 8 + nameLen);
      sheetMeta.push({ name: nm });
    }
    else if (id === 0x00FD) {     // LABELSST
      const row = data.readUInt16LE(body), col = data.readUInt16LE(body + 2);
      const isst = data.readUInt32LE(body + 6);
      put(row, col, sst[isst] === undefined ? '' : sst[isst]);
    }
    else if (id === 0x0204 || id === 0x00D6) {   // LABEL / RSTRING
      const row = data.readUInt16LE(body), col = data.readUInt16LE(body + 2);
      const cch = data.readUInt16LE(body + 6);
      const high = (data.readUInt8(body + 8) & 0x01) !== 0;
      put(row, col, high ? utf16(data, body + 9, cch) : data.toString('latin1', body + 9, body + 9 + cch));
    }
    else if (id === 0x0203) {     // NUMBER
      const row = data.readUInt16LE(body), col = data.readUInt16LE(body + 2);
      put(row, col, data.readDoubleLE(body + 6));
    }
    else if (id === 0x027E) {     // RK
      const row = data.readUInt16LE(body), col = data.readUInt16LE(body + 2);
      put(row, col, rkValue(data.readInt32LE(body + 6)));
    }
    else if (id === 0x00BD) {     // MULRK
      const row = data.readUInt16LE(body), colFirst = data.readUInt16LE(body + 2);
      const n = (len - 6) / 6;
      for (let i = 0; i < n; i++) put(row, colFirst + i, rkValue(data.readInt32LE(body + 4 + i * 6)));
    }
    else if (id === 0x0205) {     // BOOLERR
      const row = data.readUInt16LE(body), col = data.readUInt16LE(body + 2);
      put(row, col, data.readUInt8(body + 7) === 0 ? (data.readUInt8(body + 6) !== 0) : '#ERR');
    }
    else if (id === 0x0006) {     // FORMULA：取缓存数值
      const row = data.readUInt16LE(body), col = data.readUInt16LE(body + 2);
      lastFormula = { row: row, col: col };
      if (len >= 20 && data.readUInt16LE(body + 12) !== 0xFFFF) {
        try { put(row, col, data.readDoubleLE(body + 6)); } catch (e) { }
      }
    }
    else if (id === 0x0007 && lastFormula) {   // STRING：FORMULA 缓存字符串
      const cch = data.readUInt16LE(body);
      const high = (data.readUInt8(body + 2) & 0x01) !== 0;
      put(lastFormula.row, lastFormula.col, high ? utf16(data, body + 3, cch) : data.toString('latin1', body + 3, body + 3 + cch));
    }
  }
  flush();

  const out = sheets.map(s => {
    const rows = [];
    for (let r = 0; r <= s.maxRow; r++) {
      const arr = [];
      for (let c = 0; c <= s.maxCol; c++) {
        const v = s.cells.get(r + ',' + c);
        arr.push(v === undefined ? '' : v);
      }
      rows.push(arr);
    }
    return { name: s.name, rows: rows };
  }).filter(s => s.rows.length > 0);

  // 【重要】多 Sheet 时取「行数最多的那张」作为主表，与 parseXlsx 行为保持一致。
  //
  // 设备厂商（维序）导出的 xls 常把三张表塞进同一个工作簿：
  //   Rpt_cardinfo  = 点位/人员卡清单
  //   Rpt_downdata  = 巡更流水记录（真正的数据，往往上万行）
  //   Sheet1        = 排班表
  // BOUNDSHEET 的物理顺序不等于数据量顺序，之前固定取 out[0] 会拿到只有 109 行的
  // 点位表，导致「3月巡更记录」导入后一条记录都识别不出来。
  let main = out[0];
  if (main) out.forEach(s => { if (s.rows.length > main.rows.length) main = s; });

  return {
    name: (main || {}).name || 'Sheet1',
    rows: (main || {}).rows || [],
    sheetNames: out.map(s => s.name),
    sheets: out
  };
}

/* ============================================================
 *  xlsx（ZIP + XML，使用内置 zlib）
 * ============================================================ */
function unzip(buf) {
  // 扫描 End of Central Directory，取 central directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054B50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（未找到 ZIP 目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count && p < buf.length - 4; i++) {
    if (buf.readUInt32LE(p) !== 0x02014B50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // local header
    const lh = localOff;
    const lNameLen = buf.readUInt16LE(lh + 26);
    const lExtraLen = buf.readUInt16LE(lh + 28);
    const dataOff = lh + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataOff, dataOff + compSize);
    let content = raw;
    if (method === 8) content = zlib.inflateRawSync(raw);
    files[name] = content;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function colIndex(ref) {
  const m = String(ref).match(/^([A-Z]+)/);
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// 解析单个 sheet XML → 行数组
function parseSheetXml(xml, shared) {
  const rows = [];
  const rowBlocks = xml.match(/<row[\s\S]*?<\/row>|<row[^>]*\/>/g) || [];
  rowBlocks.forEach(rb => {
    const arr = [];
    const cells = rb.match(/<c\b[^>]*>[\s\S]*?<\/c>|<c\b[^>]*\/>/g) || [];
    cells.forEach(c => {
      const refM = c.match(/r="([A-Z]+\d+)"/);
      const idx = refM ? colIndex(refM[1]) : arr.length;
      const tM = c.match(/ t="([^"]+)"/);
      const type = tM ? tM[1] : 'n';
      let val = '';
      if (type === 'inlineStr') {
        val = ((c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
      } else {
        const vm = c.match(/<v>([\s\S]*?)<\/v>/);
        const rawV = vm ? vm[1] : '';
        val = (type === 's') ? (shared[Number(rawV)] || '') : rawV;
      }
      val = String(val).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      while (arr.length < idx) arr.push('');
      // 公式单元格带缓存值，直接用缓存值即可
      arr[idx] = (type === 'n' && val !== '' && !isNaN(Number(val))) ? Number(val) : val;
    });
    rows.push(arr);
  });
  const maxC = rows.reduce((a, r) => Math.max(a, r.length), 0);
  rows.forEach(r => { while (r.length < maxC) r.push(''); });
  return rows;
}

// 读 workbook.xml 拿到「显示名 → rId」的有序列表
// 注意：sheetId 与文件名 sheetN.xml 不一定对应（rId 才是），必须走 workbook.xml.rels 映射
function readWorkbookSheets(files) {
  const wbFile = Object.keys(files).filter(k => /xl\/workbook\.xml$/.test(k))[0];
  if (!wbFile) return null;
  const wb = files[wbFile].toString('utf8');
  const relFile = Object.keys(files).filter(k => /(^|\/)xl\/_rels\/workbook\.xml\.rels$/.test(k))[0] ||
    Object.keys(files).filter(k => /workbook\.xml\.rels$/.test(k))[0];
  // rId -> target
  const relMap = {};
  if (relFile) {
    const rx = files[relFile].toString('utf8');
    const rre = /<Relationship\b[^>]*\/>/g;
    let m;
    while ((m = rre.exec(rx))) {
      const id = /Id="([^"]+)"/.exec(m[0]);
      const tgt = /Target="([^"]+)"/.exec(m[0]);
      // Target 相对 xl/ 目录（如 worksheets/sheet2.xml），统一存成相对 xl/ 的路径
      if (id && tgt) relMap[id[1]] = tgt[1].replace(/^\/?xl\//, '').replace(/^\.\//, '').replace(/^\//, '');
    }
  }
  // <sheets> 内按出现顺序读 <sheet name= r:id=>
  const out = [];
  const sre = /<sheet\b[^>]*\/>/g;
  let sm;
  const sheetsBlock = (wb.match(/<sheets>[\s\S]*?<\/sheets>/) || [''])[0];
  while ((sm = sre.exec(sheetsBlock))) {
    const nm = /name="([^"]*)"/.exec(sm[0]);
    const rid = /r:id="([^"]+)"/.exec(sm[0]);
    let target = rid ? relMap[rid[1]] : null;
    if (!target) {
      // 回退：按序号猜 sheetN.xml
      const n = out.length + 1;
      target = 'worksheets/sheet' + n + '.xml';
    }
    out.push({ name: nm ? unescapeXml(nm[1]) : ('Sheet' + (out.length + 1)), target: target });
  }
  return out.length ? out : null;
}

function parseXlsx(buf) {
  const files = unzip(buf);
  const keys = Object.keys(files);
  // 共享字符串
  const shared = [];
  const ssFile = keys.filter(k => /sharedStrings\.xml$/.test(k))[0];
  if (ssFile) {
    const xml = files[ssFile].toString('utf8');
    const items = xml.match(/<si>[\s\S]*?<\/si>/g) || [];
    items.forEach(it => {
      const txt = (it.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
        .map(t => t.replace(/<[^>]+>/g, '')).join('');
      shared.push(unescapeXml(txt));
    });
  }

  // 工作表列表（按 workbook.xml 顺序，名字与显示名对齐）
  let sheetDefs = readWorkbookSheets(files);
  if (!sheetDefs) {
    // 没有 workbook.xml：退化为按 sheetN.xml 自然序
    const nums = keys.filter(k => /worksheets\/sheet(\d+)\.xml$/.test(k))
      .map(k => ({ n: Number(/sheet(\d+)\.xml$/.exec(k)[1]), k: k }))
      .sort((a, b) => a.n - b.n);
    sheetDefs = nums.map(x => ({ name: 'Sheet' + x.n, target: x.k.replace(/^xl\//, '') }));
  }

  const sheets = [];
  sheetDefs.forEach(sd => {
    // 注意：files 的「值」是 Buffer 内容，必须按「键名」取，不能用 || 链判值
    const candidates = ['xl/' + sd.target, sd.target, './' + sd.target];
    let fKey = null;
    for (const c of candidates) {
      if (Object.prototype.hasOwnProperty.call(files, c)) { fKey = c; break; }
    }
    if (!fKey) fKey = keys.filter(k => k.replace(/^xl\//, '').replace(/^\.\//, '') === sd.target)[0];
    if (!fKey) return;
    try {
      const rows = parseSheetXml(files[fKey].toString('utf8'), shared);
      sheets.push({ name: sd.name, rows: rows });
    } catch (e) { /* 单个 sheet 解析失败不影响其他 sheet */ }
  });
  if (!sheets.length) throw new Error('xlsx 中未找到可解析的工作表');

  // 兼容旧调用方：取「数据行最多的 sheet」作为主表（而不是无脑第一个）
  // 真实文件常见做法：第一个 sheet 是汇总/封面，明细在后面的 sheet
  let main = sheets[0];
  sheets.forEach(s => { if (s.rows.length > main.rows.length) main = s; });

  return {
    name: main.name,
    rows: main.rows,
    sheetNames: sheets.map(s => s.name),
    sheets: sheets              // 完整多表结构
  };
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/* ============================================================
 *  统一入口
 * ============================================================ */
function parseCsv(buf) {
  const txt = buf.toString('utf8').replace(/^\uFEFF/, '');
  const lines = txt.split(/\r?\n/).filter(l => l.trim() !== '');
  return { name: 'Sheet1', rows: lines.map(l => l.split(',').map(s => s.replace(/^"|"$/g, '').replace(/""/g, '"'))) };
}

/**
 * 读取表格：自动识别 xls / xlsx / csv
 * @param {Buffer} buf
 * @param {string} fileName
 * @returns {{name:string, rows:Array<Array>}}
 */
function readTable(buf, fileName) {
  const ext = String(fileName || '').toLowerCase().split('.').pop();
  if (ext === 'csv' || ext === 'txt') return parseCsv(buf);
  if (ext === 'xlsx') return parseXlsx(buf);
  // 默认按 xls 处理（BIFF8）
  if (buf.length > 8 && buf.readUInt32LE(0) === 0x04034B50) return parseXlsx(buf); // 实为 zip
  const cfb = new CFB(buf);
  const stream = cfb.getStream('Workbook') || cfb.getStream('Book');
  if (!stream) throw new Error('未找到 Workbook 数据流，文件可能已损坏');
  return parseWorkbook(stream);
}

module.exports = { CFB, parseWorkbook, parseXlsx, parseCsv, readTable, parseSst, rkValue };
