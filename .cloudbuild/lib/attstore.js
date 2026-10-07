'use strict';
/**
 * 附件存储抽象层（本地磁盘 / 七牛云对象存储 双模式）
 *
 * 由环境变量 ATT_STORAGE 切换：
 *   local（默认）→ 写本机 uploads/，适合开发与本地自托管
 *   qiniu        → 上传到七牛云 Kodo，适合 Netlify Serverless
 *                  （Serverless 本地磁盘重启即丢，附件会全部失效）
 *
 * 对上层 routes/ops.js、routes/patrol.js 暴露的接口与原来完全一致：
 *   put(key, buffer, mime) → { key, url }
 *   url(key)                → 访问地址
 *   del(key)                → 删除
 *
 * 七牛云实现参照 J:\建筑工程管理系统网页版 的成熟做法：
 *   公开桶直接返回 URL；私有桶用 SDK 生成带时效的签名下载 URL。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv', '.txt': 'text/plain',
  '.dwg': 'application/octet-stream', '.dxf': 'application/octet-stream',
  '.rar': 'application/octet-stream', '.zip': 'application/octet-stream'
};

/**
 * 存储区域 → qiniu SDK 里的 zone 键名。
 *
 * 【踩过的坑】qiniu SDK 的 zone 表用的是 **`Zone_z0` / `Zone_z2` 这种带前缀的键**，
 * 并没有 `z0` / `z2` 这种短键：
 *     Object.keys(qiniu.zone) = ['Zone','Zone_z0','Zone_cn_east_2','Zone_z1',
 *                                'Zone_z2','Zone_na0','Zone_as0','getZoneInfo']
 * 所以 `qiniu.zone['z2']` 返回 undefined —— 区域设置**静默失效**，
 * 一直用的是 SDK 默认 z0。之前上传能成功是七牛会自动重定向到 z2，属于侥幸，
 * 删文件/改 ACL 这类走 rsHost 的操作在非默认区域就会失败。
 * 正确写法见 zoneOf()。
 */
const REGION_MAP = { z0: 'Zone_z0', z1: 'Zone_z1', z2: 'Zone_z2', na0: 'Zone_na0', as0: 'Zone_as0', 'cn-east-2': 'Zone_cn_east_2' };

function zoneOf(qiniu, region) {
  const key = REGION_MAP[String(region || '').trim()];
  return key ? qiniu.zone[key] : null;
}

function useQiniu() {
  return String(process.env.ATT_STORAGE || '').toLowerCase() === 'qiniu';
}

let _qiniu = null;
function getQiniu() {
  if (_qiniu) return _qiniu;
  const qiniu = require('qiniu');
  const ak = process.env.QINIU_ACCESS_KEY;
  const sk = process.env.QINIU_SECRET_KEY;
  const bucket = process.env.QINIU_BUCKET;
  if (!ak || !sk || !bucket) throw new Error('七牛云配置缺失：请设置 QINIU_ACCESS_KEY / QINIU_SECRET_KEY / QINIU_BUCKET');
  const config = new qiniu.conf.Config();
  const region = process.env.QINIU_REGION;
  const z = region ? zoneOf(qiniu, region) : null;
  if (z) config.zone = z;
  else if (region) {
    console.warn('[attstore] QINIU_REGION="' + region + '" 无法识别（可用：' +
      Object.keys(REGION_MAP).join(' / ') + '），已回退 SDK 默认区域 z0（华东）。');
  }
  _qiniu = { qiniu, mac: new qiniu.auth.digest.Mac(ak, sk), config, bucket, region };
  if (region && z) {
    console.log('[attstore] 七牛空间 ' + bucket + ' 区域=' + region +
      '（' + z.ioHost + '）');
  }
  return _qiniu;
}

function qiniuUpload(key, buffer) {
  return new Promise((resolve, reject) => {
    try {
      const { qiniu, mac, config, bucket } = getQiniu();
      const token = new qiniu.rs.PutPolicy({ scope: bucket }).uploadToken(mac);
      const extra = new qiniu.form_up.PutExtra();
      extra.mimeType = MIME_BY_EXT[path.extname(key).toLowerCase()] || 'application/octet-stream';
      // 直接传 Buffer：FormUploader.put(uploadToken, key, body, putExtra, cb) 的
      // body 参数就接受 Buffer/Blob/stream。
      //
      // 【踩过的坑】原来这里写的是：
      //   const stream = qiniu.form_up.StreamPipe.create(buffer, extra.mimeType);
      //   uploader.putStream(token, key, stream, extra, cb)
      // 但 qiniu npm 包的 form_up 里**只有 FormUploader 和 PutExtra，
      // 根本没有 StreamPipe**（已实测：Object.keys(qiniu.form_up) === ['FormUploader','PutExtra']）。
      // 所以任何上传都会抛 "Cannot read properties of undefined (reading 'create')"，
      // 也就是 ATT_STORAGE=qiniu 模式下**从来没有真正上传成功过**。
      new qiniu.form_up.FormUploader(config).put(token, key, buffer, extra,
        (err, ret) => (err ? reject(err) : resolve(ret)));
    } catch (e) { reject(e); }
  });
}

/**
 * 把七牛的「区域不匹配」错误翻译成人能看懂的提示。
 *
 * 【为什么需要】qiniu SDK 的 delete/stat 走 rsHost，区域填错时返回的是
 * `{"error":"incorrect zone","error_code":"IncorrectZone"}`。
 * 这个错有两个恶劣之处：
 *   1. SDK 把它塞在**成功回调**的 body 里而不是 err 参数，
 *      所以 `if (err)` 判不出来，代码会以为成功了 —— 删除静默不生效。
 *   2. 错误文案只有 "incorrect zone"，完全看不出是哪个变量填错。
 */
function qiniuErr(e, what) {
  const raw = (e && (e.error || e.message)) || String(e || '');
  const txt = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (/incorrect\s*zone/i.test(txt)) {
    return new Error('七牛空间区域不匹配（' + what + ' 失败）：QINIU_REGION="' +
      (process.env.QINIU_REGION || '(未设置)') + '" 与空间实际所在区域不符。' +
      '请跑 node scripts/test_qiniu_config.js --live 探测真实区域后改正。');
  }
  return e instanceof Error ? e : new Error(txt || ('七牛 ' + what + ' 失败'));
}

function qiniuDelete(key) {
  return new Promise((resolve, reject) => {
    try {
      const { qiniu, mac, config, bucket } = getQiniu();
      const bm = new qiniu.rs.BucketManager(mac, config);
      bm.delete(bucket, key, (err, body) => {
        // 注意：区域错时 err 为 null、body 才是错误体，必须一起判
        const t = (body && (body.error || body.error_code)) || '';
        if (err) return reject(qiniuErr(err, '删除 ' + key));
        if (t) return reject(qiniuErr(t, '删除 ' + key));
        resolve();
      });
    } catch (e) { reject(e); }
  });
}

/**
 * 探测 QINIU_DOMAIN 是否支持 HTTPS。
 *
 * 【为什么需要探测 —— 七牛云默认域名的证书陷阱】
 * 七牛默认域名形如 `tmcv69nvd.hd-bkt.clouddn.com`，它的 HTTPS 证书
 * 只覆盖 `*.ctcdn.cn`（实测报错：Hostname/IP does not match certificate's
 * altnames: DNS:*.ctcdn.cn），**并不覆盖默认域名本身**。
 * 也就是说：用默认域名时 HTTPS 必然失败，只有 HTTP 能通。
 * 而 HTTP 是明文，健康证/身份证走明文不合规。
 *
 * 解决：首次探测一次，HTTPS 不可用就整体降级到 HTTP 并记住结果。
 * 一旦绑定了自定义域名（如 plm.hubeiyunzhibo.top）且证书正常，
 * 把 QINIU_FORCE_HTTPS 设为 1 即可强制走 HTTPS。
 *
 * 探测结果缓存在模块变量里，不会每个请求都去握手一次。
 */
let _proto = null;   // null=未探测  'https' / 'http'
async function qiniuProto() {
  if (process.env.QINIU_FORCE_HTTPS === '1') return 'https';
  if (process.env.QINIU_FORCE_HTTP === '1') return 'http';
  if (_proto) return _proto;
  _proto = 'https';
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 8000);
    // 探测用一个必然不存在的 key：私有桶会返回 401/403（说明 TLS 通了），
    // 证书不匹配则抛 fetch failed。
    const probe = 'https://' + (process.env.QINIU_DOMAIN || '') + '/__proto_probe__.txt';
    await fetch(probe, { signal: ctl.signal });
    clearTimeout(to);          // 能拿到任何 HTTP 响应 = TLS 握手成功
  } catch (e) {
    if (e && e.name === 'AbortError') { /* 超时也算 TLS 握手成功 */ }
    _proto = 'http';
    console.warn('[attstore] QINIU_DOMAIN 的 HTTPS 证书不匹配，已降级到 HTTP。' +
      '健康证/身份证等敏感附件建议绑定自定义域名（如 plm.hubeiyunzhibo.top）并设 QINIU_FORCE_HTTPS=1。');
  }
  return _proto;
}

function qiniuUrl(key) {
  // 防御性清洗：万一环境变量被 systemd EnvironmentFile 把行内注释带进来
  // （见 2026-10-06 那次事故），这里也保证签不出「域名+注释」的脏 URL。
  const d = String(process.env.QINIU_DOMAIN || '').split('#')[0].trim();
  if (!d) return key;                 // 未配域名时只返回 key，由前端拼
  if (process.env.QINIU_PRIVATE !== '1') return 'https://' + d + '/' + key;
  const { qiniu, mac, config } = getQiniu();
  const expire = Number(process.env.QINIU_URL_EXPIRE || 3600);
  const deadline = Math.floor(Date.now() / 1000) + expire;
  // 协议优先级：显式 FORCE 环境变量 > 已探测结果 > 默认 https
  //
  // 【为什么要读 FORCE 环境变量】lib/http.js 的 ok() 会**同步**按 key 重签附件 URL，
  // 那里没法 await 异步的协议探测（qiniuProto）；而探测前 _proto 仍是 null，
  // 会签出 https —— 七牛测试域名的证书不覆盖该域名，浏览器直接报
  // 「连接不是私密连接」(ERR_TLS_CERT_ALTNAME_INVALID)。
  // 所以未绑自定义域名时，用 QINIU_FORCE_HTTP=1 固定走 http。
  const forced = process.env.QINIU_FORCE_HTTPS === '1' ? 'https'
    : (process.env.QINIU_FORCE_HTTP === '1' ? 'http' : null);
  const p = forced || (_proto === 'http' ? 'http' : 'https');
  return new qiniu.rs.BucketManager(mac, config).privateDownloadUrl(p + '://' + d, key, deadline);
}

/**
 * 生成本地模式的安全存储 key（防目录穿越）
 * 七牛模式下 key 只用 basename，不含本地目录概念
 */
function safeKey(name, dir) {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).replace(/[^\w.\u4e00-\u9fa5-]/g, '_');
  return dir ? path.posix.join(String(dir).replace(/\\/g, '/'), base) : base;
}

class AttStore {
  constructor(uploadDir) {
    this.uploadDir = uploadDir || path.join(__dirname, '..', 'uploads');
    this.mode = useQiniu() ? 'qiniu' : 'local';
  }

  /** 写入附件，返回 { key, url, name, size, mime, storage } */
  async put(name, buffer, opt) {
    opt = opt || {};
    const key = safeKey(opt.key || name, opt.dir);
    const mime = opt.mime || MIME_BY_EXT[path.extname(key).toLowerCase()] || 'application/octet-stream';

    if (this.mode === 'qiniu') {
      await qiniuUpload(key, buffer);
      await qiniuProto();          // 先探测协议，再生成 URL，避免签出不可用的 https 地址
      return {
        key, name: path.basename(key), size: buffer.length, mime,
        url: qiniuUrl(key), storage: 'qiniu'
      };
    }
    const fp = path.join(this.uploadDir, key.replace(/\//g, path.sep));
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, buffer);
    return {
      key, name: path.basename(key), size: buffer.length, mime,
      url: '/uploads/' + key.split('/').map(encodeURIComponent).join('/'),
      storage: 'local'
    };
  }

  /** 访问地址（本地模式由 server.js 的静态目录处理，这里原样返回 key） */
  url(key) {
    if (this.mode === 'qiniu') return qiniuUrl(key);
    return '/uploads/' + String(key).split('/').map(encodeURIComponent).join('/');
  }

  async del(key) {
    if (this.mode === 'qiniu') { await qiniuDelete(key); return true; }
    const fp = path.join(this.uploadDir, String(key).replace(/\//g, path.sep));
    if (!fp.startsWith(this.uploadDir)) return false;
    if (!fs.existsSync(fp)) return false;
    fs.unlinkSync(fp);
    return true;
  }

  /** 读回内容（导出/下载用） */
  async read(key) {
    if (this.mode === 'qiniu') {
      await qiniuProto();          // 同 put：先确保 URL 协议正确
      const u = qiniuUrl(key);
      const r = await fetch(u);
      if (!r.ok) throw new Error('从对象存储读取失败：' + r.status);
      return Buffer.from(await r.arrayBuffer());
    }
    const fp = path.join(this.uploadDir, String(key).replace(/\//g, path.sep));
    if (!fs.existsSync(fp)) return null;
    return fs.readFileSync(fp);
  }
}

module.exports = { AttStore, MIME_BY_EXT, useQiniu };