'use strict';
// 极简 HTTP 框架：路由 + JSON 解析 + 静态文件 + Cookie（零第三方依赖）
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.pdf': 'application/pdf', '.dwg': 'application/octet-stream', '.dxf': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8'
};

class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp('^' + pattern.replace(/\/:([\w]+)/g, (m, k) => { keys.push(k); return '/([^/]+)'; }) + '$');
    this.routes.push({ method: method.toUpperCase(), pattern, regex, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  del(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params };
      }
    }
    return null;
  }
}

function parseCookies(str) {
  const out = {};
  (str || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const max = 200 * 1024 * 1024; // 200MB，支持 base64 附件
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > max) { req.destroy(); reject(new Error('请求体过大')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (ct.indexOf('application/json') >= 0 || buf.length === 0) {
        try { resolve(buf.length ? JSON.parse(buf.toString('utf8')) : {}); }
        catch (e) { resolve({}); }
      } else if (ct.indexOf('application/x-www-form-urlencoded') >= 0) {
        const q = new URLSearchParams(buf.toString('utf8'));
        const o = {}; q.forEach((v, k) => o[k] = v); resolve(o);
      } else {
        resolve({ _raw: buf });
      }
    });
    req.on('error', reject);
  });
}

/**
 * 是否已经写过响应头。
 *
 * 【为什么需要】`can(req, res, perm)` 鉴权失败时**自己已经写了响应**
 * （deny() → json() → writeHead），而调用点常写成：
 *     if (!can(req, res, 'hr:manage')) return fail(res, '无权限');
 * 于是 fail 又调一次 writeHead →抛 ERR_HTTP_HEADERS_SENT：
 *     Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent
 * 这个异常发生在 async handler 里，会变成 **unhandledRejection**，
 * 日志里一片红，而前端早就已经收到 401 了 —— 排查时容易误以为是别的地方坏了。
 *
 * 全项目有 10 处这种写法（billing 4 / auth 2 / hr 2 / customer 2），
 * 逐个改成 `return;` 需要动10 个文件、容易漏，所以在这里做幂等保护：
 * 响应已发出时，fail/ok 直接静默返回。
 */
function headersSent(res) {
  return !res || res.headersSent || res.writableEnded;
}

function json(res, data, status) {
  // 响应已发出：不再重复 writeHead，否则抛 ERR_HTTP_HEADERS_SENT
  if (headersSent(res)) return;
  const body = JSON.stringify(data === undefined ? null : data);
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/* ===================== 附件 URL 实时重签 =====================
 *
 * 【为什么必须做这件事】
 * `lib/attstore.js` 的 put() 在七牛「私有桶」模式下返回的是**带签名的临时链接**
 * （`?e=<过期时间戳>&token=<AK>:<sign>`，默认 1 小时），而 `routes/ops.js:205`
 * 会把 put() 的返回值原样落库（`url: stored.url`）。于是库里存的 url 有两类坏形态：
 *   · 签名链接 → **1 小时后必然 401**（临时凭证被当成永久地址存了）
 *   · 纯基址  → 私有桶拒绝无签名请求；且七牛测试域名的证书不覆盖该域名，
 *               浏览器直接 ERR_TLS_CERT_ALTNAME_INVALID（「连接不是私密连接」）
 * 前端（components.js 的文件芯片、客户详情、发票列表票面列）又是**直接**用
 * `a.url` 打开的，所以表现为「附件点开打不开」。
 *
 * 【修法】库里已经存了 `key`，所以每次响应前按 key 把前端用的地址重写为
 * **本机的预览代理** `/api/attachment/file?key=…`（见 routes/ops.js）。
 * 为什么不直接用七牛签名直链：七牛私有空间的下载链接**一律返回
 * `Content-Disposition: attachment`**（实测即使在 URL 上附加
 * response-content-disposition=inline 并让它参与签名也无效），浏览器只会下载、
 * 不会内联显示 —— 发票 PDF 的 iframe 在线预览因此失效。
 * 走本机代理则：① 能内联预览；② 天然鉴权（未登录看不到敏感件）；③ 地址永不失效。
 *
 * 放在 ok() 这个全站唯一出口，一处改动覆盖所有页面，不必改 N 个路由。
 *
 * 【为什么必须返回新对象，绝不能就地改】
 * data 往往就是 db 内存缓存里的对象引用（本地 JSON 引擎 / TiDB 请求级缓存）。
 * 就地改会把这一秒生成的临时签名写回缓存，下一次 persist 就把它落库了 ——
 * 那正是我们要避免的事。所以只在命中附件对象时浅拷贝一个新对象。
 */
const ATT_DEPTH_MAX = 8;

/** 判断是否「可重签的附件对象」；是则返回它的 key，否则返回 null */
function attKeyOf(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  if (typeof x.key !== 'string' || !x.key) return null;
  if (x.storage === 'qiniu') return x.key;
  // 老记录没有 storage 字段：url 里带七牛域名（含被注释污染的脏域名，前缀仍能命中）也算
  const dom = process.env.QINIU_DOMAIN || '';
  if (dom && typeof x.url === 'string' && x.url.indexOf(dom) >= 0) return x.key;
  return null;
}

/** 附件预览地址（本机代理，见 routes/ops.js 的 /api/attachment/file） */
function previewUrlOf(key) {
  return '/api/attachment/file?key=' + encodeURIComponent(key);
}

function resignAttUrls(v, depth) {
  if (v === null || typeof v !== 'object' || depth > ATT_DEPTH_MAX) return v;
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map(x => { const n = resignAttUrls(x, depth + 1); if (n !== x) changed = true; return n; });
    return changed ? out : v;    // 无变化就沿用原引用，省内存/省 GC
  }
  const key = attKeyOf(v);
  if (key) {
    const p = previewUrlOf(key);
    if (v.url === p) return v;
    return Object.assign({}, v, { url: p });   // 浅拷贝：绝不动 db 缓存里的原对象
  }
  // 合同比对批次里的 { fileKey, fileUrl } 形态（routes/contractcmp.js）同样处理
  if (typeof v.fileKey === 'string' && v.fileKey) {
    const p = previewUrlOf(v.fileKey);
    if (v.fileUrl === p) return v;
    return Object.assign({}, v, { fileUrl: p });
  }
  let changed = false;
  const out = {};
  for (const k of Object.keys(v)) {
    const n = resignAttUrls(v[k], depth + 1);
    out[k] = n;
    if (n !== v[k]) changed = true;
  }
  return changed ? out : v;
}

function ok(res, data, extra) {
  const body = data === undefined ? null : resignAttUrls(data, 0);
  json(res, Object.assign({ ok: true, data: body }, extra || {}));
}
function fail(res, msg, status, extra) { json(res, Object.assign({ ok: false, msg: msg || '操作失败' }, extra || {}), status || 400); }

function sendFile(res, filepath, downloadName) {
  if (headersSent(res)) return;
  fs.readFile(filepath, (err, buf) => {
    if (headersSent(res)) return;               // 等异步读文件期间可能已被鉴权挡掉
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filepath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': (downloadName ? 'application/octet-stream' : (MIME[ext] || 'application/octet-stream')),
      'Content-Length': buf.length,
      'Content-Disposition': downloadName ? ('attachment; filename="' + encodeURIComponent(downloadName) + '"; filename*=UTF-8\'\'' + encodeURIComponent(downloadName)) : 'inline'
    });
    res.end(buf);
  });
}

function createServer(router, opt) {
  opt = opt || {};
  const staticDir = opt.staticDir;
  const before = opt.before || [];
  // 云端 db（TiDB）需要「请求级缓存」：一次请求内同一张表只查一次，
  // 循环里逐行查关联（N+1）不再走网络。本地 db 是内存读，不需要，也没有这两个方法。
  const db = opt.db || null;
  const server = http.createServer(async (req, res) => {
    if (db && typeof db.beginRequest === 'function') {
      db.beginRequest();
      // 响应结束（或连接中断）时释放。用 once + 幂等的 endRequest，避免重复释放。
      const release = () => { if (typeof db.endRequest === 'function') db.endRequest(); };
      res.once('finish', release);
      res.once('close', release);
    }
    const parsed = url.parse(req.url);
    const pathname = decodeURIComponent(parsed.pathname || '/');
    req.path = pathname;
    req.query = {};
    (parsed.query || '').split('&').forEach(p => {
      if (!p) return;
      const i = p.indexOf('=');
      const k = decodeURIComponent(i > 0 ? p.slice(0, i) : p);
      const v = i > 0 ? decodeURIComponent(p.slice(i + 1).replace(/\+/g, ' ')) : '';
      req.query[k] = v;
    });
    req.cookies = parseCookies(req.headers.cookie);

    for (const mw of before) {
      try {
        const r = await mw(req, res);
        if (r === false) return;
      } catch (e) { return fail(res, '中间件异常：' + e.message, 500); }
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' });
      res.end(); return;
    }

    const hit = router.match(req.method, pathname);
    if (hit) {
      req.params = hit.params;
      if (req.method !== 'GET') {
        try { req.body = await readBody(req); } catch (e) { return fail(res, e.message, 413); }
      } else req.body = {};
      try {
        await hit.handler(req, res, hit.params);
      } catch (e) {
        console.error('[ERR]', req.method, pathname, e);
        fail(res, '服务端异常：' + e.message, 500);
      }
      return;
    }

    if (staticDir) {
      let rel = pathname === '/' ? '/index.html' : pathname;
      const fp = path.join(staticDir, path.normalize(rel).replace(/^([/\\])+/, ''));
      if (fp.indexOf(staticDir) === 0 && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        return sendFile(res, fp, req.query.download ? path.basename(fp) : null);
      }
    }
    // SPA fallback —— 只对「看起来是页面路由」的请求回 index.html。
    //
    // 【重要】绝不能对 /api/* 回 index.html。
    // 以前没加这个判断时，某个路由文件忘了在 server.js 里 require，
    // 前端 POST 就会收到 text/html 的首页，res.json() 抛解析错误，
    // core.js 的 api() 兜底成 { ok:false, msg:'返回解析失败' }，
    // 调用方再 r.data.result 就炸成「Cannot read properties of undefined」——
    // 真实原因（路由未挂载）被完全吞掉，排查方向被误导到「文件没上传成功」这类无关假设。
    //
    // 现在 /api/* 未命中直接返回 404 JSON，msg 明确写出缺哪个方法+路径。
    if (pathname.indexOf('/api/') === 0 || pathname === '/api') {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: false,
        code: 404,
        msg: '接口不存在（路由未挂载？）：' + req.method + ' ' + pathname
      }));
      return;
    }
    if (staticDir) {
      const idx = path.join(staticDir, 'index.html');
      if (fs.existsSync(idx)) return sendFile(res, idx);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  });
  return server;
}

module.exports = { Router, createServer, json, ok, fail, sendFile, MIME };
