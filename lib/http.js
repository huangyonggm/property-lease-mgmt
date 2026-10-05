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

function json(res, data, status) {
  const body = JSON.stringify(data === undefined ? null : data);
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function ok(res, data, extra) { json(res, Object.assign({ ok: true, data: data === undefined ? null : data }, extra || {})); }
function fail(res, msg, status, extra) { json(res, Object.assign({ ok: false, msg: msg || '操作失败' }, extra || {}), status || 400); }

function sendFile(res, filepath, downloadName) {
  fs.readFile(filepath, (err, buf) => {
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
