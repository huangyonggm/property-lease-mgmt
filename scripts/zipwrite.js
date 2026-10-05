'use strict';
/**
 * 零依赖 ZIP 写入器（Node 内置 zlib.deflateRawSync + 手写 ZIP 头/中央目录）
 *
 * 为什么需要：Netlify 的文件上传 API 对 Netlify Functions 有硬性要求 ——
 * **必须先把函数打成一个 zip**（连同它 require 的全部依赖），再
 * PUT /api/v1/deploys/{id}/functions/{name}?runtime=js。
 * 而本机 `npx netlify deploy` 静默失败（无输出、无退出码、18~23 秒后什么都没发生），
 * 走不了 CLI 自带的打包逻辑；项目里也没有 archiver/jszip/yazl 可用。
 *
 * 这与 lib/docparse.js 的 readZip 是一对：那边解，这边压。
 *
 * ZIP 格式（本实现只写最常见的组合，全部走 deflate）：
 *   [文件头 ×N]  0x04034b50  30 字节定长头 + 文件名 + 压缩数据
 *   [中央目录 ×N]0x02014b50  46 字节定长头 + 文件名
 *   [EOCD]      0x06054b50  22 字节
 *
 * ⚠ 三个容易踩的字段：
 *   1. 「通用标志位」bit 11（0x0800）表示文件名是 UTF-8。中文路径必须置上，
 *      否则解压端按 GBK 解析会乱码。
 *   2. 「版本需要」统一写 20（2.0），deflate 方法写 8。
 *   3. CRC32 必须真算。Netlify 会校验，不给对会报 400。
 *      Node 没有内置 crc32，用查表法（0xEDB88320 多项式）现算一张 256 项表。
 */

const zlib = require('zlib');
const path = require('path');

/* ---------- CRC32（查表法，多项式 0xEDB88320） ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;   // 无符号
}

/* ---------- 时间转换：DOS 时间/日期 ---------- */
function dosTime(d) {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF
  };
}

/**
 * 打包成 zip
 * @param {Array<{name:string, data:Buffer|string, date?:Date}>} entries
 * @returns {Buffer}
 */
function zip(entries) {
  const chunks = [];        // 数据区
  const central = [];       // 中央目录项
  let offset = 0;           // 当前写入位置

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    // deflateRaw 压缩；压不小就退回 store（method 0）
    const deflated = zlib.deflateRawSync(raw, { level: 6 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const { time, date } = dosTime(e.date || new Date());

    // ---- 本地文件头 ----
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // 解压所需版本 2.0
    lh.writeUInt16LE(0x0800, 6);        // 通用标志：bit11 = 文件名 UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);  // 压缩后大小
    lh.writeUInt32LE(raw.length, 22);   // 原始大小
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);            // extra 长度

    chunks.push(lh, nameBuf, body);

    // ---- 中央目录项 ----
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031E, 4);        // 版本：2.0 + Unix(0x03) + zip64 兼容位
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);            // extra
    cd.writeUInt16LE(0, 32);            // 注释
    cd.writeUInt16LE(0, 34);            // 磁盘号
    cd.writeUInt16LE(0, 36);            // 内部属性
    cd.writeUInt32LE(0o644 << 16, 38);   // 外部属性 = Unix 权限 rw-r--r--
    cd.writeUInt32LE(offset, 42);        // 本地头偏移
    central.push(Buffer.concat([cd, nameBuf]));

    offset += 30 + nameBuf.length + body.length;
  }

  // ---- EOCD ----
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);       // 中央目录起始偏移
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, eocd]);
}

module.exports = { zip, crc32 };

// 冒烟：解回来看内容是否一致
if (require.main === module) {
  const { readZip } = require(path.join(__dirname, '..', 'lib', 'docparse'));
  const data = zip([
    { name: 'api.js', data: 'console.log("你好,世界");' },
    { name: 'lib/中文目录/子文件.txt', data: Buffer.from([0, 1, 2, 3, 255, 254, 253]) }
  ]);
  const tmp = path.join(require('os').tmpdir(), '_ziptest.zip');
  require('fs').writeFileSync(tmp, data);
  console.log('已写 ' + tmp);
  const files = readZip(data);
  console.log('zip 大小 ' + data.length + ' bytes，条目 ' + Object.keys(files).length);
  for (const name of Object.keys(files)) {
    const b = files[name];
    console.log('  ' + name.padEnd(24) + ' ' + b.length + ' bytes  ' +
      (b.length <= 40 ? JSON.stringify(b.toString('utf8')) : '(binary)'));
  }
}
