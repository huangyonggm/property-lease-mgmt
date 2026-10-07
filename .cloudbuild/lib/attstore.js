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

/**
 * 本地镜像目录。
 *
 * 【为什么要有「镜像」这一层】
 * 七牛是附件唯一的实体存放处 → 一旦欠费 / 密钥轮换 / 服务抖动，
 * 全站附件（健康证、身份证、合同扫描件、发票）立刻集体打不开，
 * 而库里只剩一个 key，自己手上什么也没有。镜像就是「自己手里也留一份」。
 *
 * 【为什么不能镜像到 uploads/】
 * ⚠ 这是本次的关键决定。`server.js` 里 `/uploads/` 是 `before` 中间件中的
 * `serveDir('/uploads/', UPLOAD_DIR)`，它**排在 `A.attachUser()` 之前** ——
 * 也就是说 /uploads/<文件名> 是**零鉴权**直接吐文件的。
 * 把健康证、身份证镜像进去 = 把「必须登录才能看」的敏感件
 * 降级成「知道文件名就能下载」，等于亲手拆掉鉴权。
 * 所以镜像目录必须是一个**不被任何 serveDir 覆盖**的独立目录，
 * 读取一律走已鉴权的 /api/attachment/file 代理。
 *
 * 由 ATT_MIRROR_DIR 启用（不设 = 不镜像，保持原行为）。
 */
function mirrorBase() {
  const d = String(process.env.ATT_MIRROR_DIR || '').split('#')[0].trim();
  return d ? path.resolve(d) : null;
}

function useMirror() {
  return useQiniu() && !!mirrorBase();
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
    // 本地镜像目录（ATT_MIRROR_DIR）；null = 不镜像，保持原行为
    this.mirrorDir = useMirror() ? mirrorBase() : null;
  }

  /* ================= 本地镜像 =================
   *
   * 【为什么要镜像】七牛是附件唯一实体存放处，欠费 / 密钥轮换 / 服务抖动
   * 会让全站附件（健康证、身份证、合同扫描件、发票）集体打不开，而自己手上什么都没有。
   *
   * 【为什么绝不镜像到 uploads/】`server.js` 里 `/uploads/` 由 `before` 中间件
   * `serveDir('/uploads/', UPLOAD_DIR)` 直出，**排在 `A.attachUser()` 之前**，即
   * 零鉴权 —— 任何知道文件名的人都能下载。把敏感件镜像进去等于亲手拆掉鉴权。
   * 所以镜像目录必须不被任何 serveDir 覆盖，读取只走已鉴权的 /api/attachment/file。
   */

  /** key → 镜像目录下的绝对路径；key 非法（穿越）时返回 null */
  mirrorPath(key) {
    if (!this.mirrorDir) return null;
    const safe = String(key || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!safe || safe.indexOf('..') >= 0 || safe.indexOf('\0') >= 0) return null;
    const fp = path.join(this.mirrorDir, safe.replace(/\//g, path.sep));
    if (fp !== this.mirrorDir && fp.indexOf(this.mirrorDir + path.sep) !== 0) return null;
    return fp;
  }

  /** 写镜像。**任何失败都只 warn，绝不向上抛** —— 镜像坏了不能连带把上传搞失败 */
  mirrorWrite(key, buffer) {
    const fp = this.mirrorPath(key);
    if (!fp) return false;
    try {
      const dir = path.dirname(fp);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 先写 .tmp 再 rename：避免读取方读到写了一半的文件
      // mode 0600：镜像里是健康证/身份证/合同扫描件这类敏感件，
      // 目录已经是 0700，文件再收一道，防止日后目录权限被放松时连带泄露
      const tmp = fp + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, buffer, { mode: 0o600 });
      fs.renameSync(tmp, fp);
      return true;
    } catch (e) {
      console.warn('[attstore] 镜像写入失败（不影响主上传）：' + key + ' → ' + (e && e.message));
      return false;
    }
  }

  mirrorRead(key) {
    const fp = this.mirrorPath(key);
    if (!fp || !fs.existsSync(fp)) return null;
    try { return fs.readFileSync(fp); } catch (e) { return null; }
  }

  /** 删镜像；本来就不存在也算成功 */
  mirrorDelete(key) {
    const fp = this.mirrorPath(key);
    if (!fp || !fs.existsSync(fp)) return true;
    try { fs.unlinkSync(fp); return true; }
    catch (e) { console.warn('[attstore] 镜像删除失败：' + key + ' → ' + (e && e.message)); return false; }
  }

  /** 镜像占用统计（系统概况页展示用）；未启用镜像时返回 null */
  mirrorStats() {
    if (!this.mirrorDir) return null;
    let files = 0, bytes = 0;
    const walk = d => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else { try { files++; bytes += fs.statSync(p).size; } catch (x) { /* 跳过 */ } }
      }
    };
    const exists = fs.existsSync(this.mirrorDir);
    if (exists) walk(this.mirrorDir);
    return { dir: this.mirrorDir, files, bytes, exists };
  }

  /** 写入附件，返回 { key, url, name, size, mime, storage } */
  async put(name, buffer, opt) {
    opt = opt || {};
    const key = safeKey(opt.key || name, opt.dir);
    const mime = opt.mime || MIME_BY_EXT[path.extname(key).toLowerCase()] || 'application/octet-stream';

    if (this.mode === 'qiniu') {
      await qiniuUpload(key, buffer);
      // 双写：云端成功后同步落一份本地镜像（ATT_MIRROR_DIR 未设则跳过）
      if (this.mirrorDir) this.mirrorWrite(key, buffer);
      await qiniuProto();          // 先探测协议，再生成 URL，避免签出不可用的 https 地址
      return {
        key, name: path.basename(key), size: buffer.length, mime,
        url: qiniuUrl(key), storage: 'qiniu',
        mirrored: !!this.mirrorDir
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
    if (this.mode === 'qiniu') {
      let cloudErr = null;
      try { await qiniuDelete(key); } catch (e) { cloudErr = e; }
      this.mirrorDelete(key);     // 云端删成功与否，本地副本都跟着清掉，避免留孤儿
      if (cloudErr) throw cloudErr;
      return true;
    }
    const fp = path.join(this.uploadDir, String(key).replace(/\//g, path.sep));
    if (!fp.startsWith(this.uploadDir)) return false;
    if (!fs.existsSync(fp)) return false;
    fs.unlinkSync(fp);
    return true;
  }

  /**
   * 读回内容（预览代理 / 导出用）。
   *
   * 【顺序】本地镜像优先 → 未命中再回源七牛 → 回源成功顺手回填镜像。
   * 三个好处：① 预览走本机磁盘，省一次外网往返（3.5MB 的工单照片差别明显）；
   * ② 七牛抖动/欠费时附件照样能打开；③ 老附件首次被访问就自动补齐镜像。
   */
  async read(key) {
    const local = this.mirrorRead(key);
    if (local) return local;

    if (this.mode === 'qiniu') {
      await qiniuProto();          // 同 put：先确保 URL 协议正确
      const u = qiniuUrl(key);
      const r = await fetch(u);
      if (!r.ok) throw new Error('从对象存储读取失败：' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (this.mirrorDir) this.mirrorWrite(key, buf);   // 回填；失败只 warn
      return buf;
    }
    const fp = path.join(this.uploadDir, String(key).replace(/\//g, path.sep));
    if (!fs.existsSync(fp)) return null;
    return fs.readFileSync(fp);
  }
}

module.exports = { AttStore, MIME_BY_EXT, useQiniu, useMirror, mirrorBase };