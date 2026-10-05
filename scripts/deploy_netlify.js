'use strict';
/**
 * Netlify 部署（走官方 REST API，不依赖 npx netlify CLI）
 *
 * 为什么自己写：实测本机 `npx netlify deploy` 会**静默失败** ——
 * 无输出、无退出码、18~23 秒后什么都没发生，线上 /js/views7.js 仍返回
 * 2190 bytes 的 index.html（SPA fallback）而不是真实的 14581 bytes。
 * 用户偏好也是「给 API token 直接调官方 REST API，不靠截图/CLI 试探」。
 *
 * ══════════════════════════════════════════════════════════════
 * ⚠ 本脚本踩过的三个坑（2026-10-04，连续 3 次部署失败后定位）
 * ══════════════════════════════════════════════════════════════
 *
 * 坑 1：deploy 返回体里**没有 upload_url 字段**（旧版 API 有，新版已移除）。
 *   第一版写了
 *     const uploadBase = dep.upload_url || dep.deploy_ssl_url.replace(...)
 *   于是把**站点访问地址** https://main--property-lease.netlify.app
 *   当 API 基址拼 /files → 稳定 404。
 *
 * 坑 2：`POST /deploys/{id}/files`（批量提交哈希清单）**这个端点不存在**。
 *   查官方文档后确认：文件清单必须在**创建 deploy 的那一个请求里**就带上：
 *     POST /sites/{site_id}/deploys
 *     { "files": { "/index.html": "<sha1hex>" },
 *       "functions": { "api": "<sha256hex>" } }
 *   返回体里的 `required` / `required_functions` 才是「你还需要上传哪些」。
 *   静态文件用 **SHA1 hex**，函数用 **SHA256 hex**（官方明确要求，两者不同！）
 *
 * 坑 3：Netlify Functions 必须**先打成 zip**，且走独立端点：
 *     PUT /deploys/{id}/functions/{函数名}?runtime=js
 *   函数名**不带扩展名**（api，不是 api.js），且必须先 zip。
 *   把函数当普通静态文件传 → 线上 502。
 *
 * 坑 4（最隐蔽的一条，解释了此前「state=ready 但线上毫无变化」）：
 *   创建 deploy 时**不能传 branch 字段**。传了 branch:'main'，Netlify
 *   判定这是**分支部署**，只发布到 main--property-lease.netlify.app，
 *   生产域名 property-lease.netlify.app 纹丝不动 —— 状态 ready 但用户看不到。
 *   实测对照：历史上两次真正生效的部署 branch=null；带 branch:"main" 的那次
 *   state=ready、分支站 14581 bytes 正确，但生产站 index.html 仍是旧的
 *   2190 bytes。REST 直传的 deploy 不传 branch 即为生产部署。
 *
 * 完整流程（官方文档 https://docs.netlify.com/api/get-started）：
 *   ① POST /sites/{id}/deploys  带 files(SHA1) + functions(SHA256)  → 拿 deploy id
 *   ② PUT  /deploys/{id}/files/{path}          逐个传静态文件（只传 required 里的）
 *   ③ PUT  /deploys/{id}/functions/{name}?runtime=js   传 zip 后的函数
 *   ④ 轮询 GET /deploys/{id} 到 state=ready
 *
 * 用法：node scripts/deploy_netlify.js ["提交标题"]
 * 前置：node scripts/prepare_cloud_build.js 已生成 .cloudbuild/
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { zip } = require('./zipwrite');

const ROOT = path.join(__dirname, '..');
const CB = path.join(ROOT, '.cloudbuild');
const SITE_ID = JSON.parse(fs.readFileSync(path.join(ROOT, '.netlify', 'state.json'), 'utf8')).siteId;
const TOKEN = fs.readFileSync(path.join(ROOT, '.tmp_nl_token.txt'), 'utf8').trim();
const API = 'https://api.netlify.com/api/v1';

const sha1hex = b => crypto.createHash('sha1').update(b).digest('hex');
const sha256hex = b => crypto.createHash('sha256').update(b).digest('hex');

/** 递归收集文件（跳过 node_modules 与点文件） */
function collect(dir, base) {
  base = base || dir;
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules') continue;
    if (name.startsWith('.') && name !== '.well-known') continue;
    const fp = path.join(dir, name);
    const st = fs.statSync(fp);
    if (st.isDirectory()) out.push(...collect(fp, base));
    else out.push({ path: path.relative(base, fp).split(path.sep).join('/'), abs: fp, size: st.size });
  }
  return out;
}

async function req(url, method, body, contentType) {
  const opt = { method, headers: { 'Authorization': 'Bearer ' + TOKEN } };
  if (contentType) opt.headers['Content-Type'] = contentType;
  if (body !== undefined && body !== null) opt.body = body;
  const r = await fetch(url, opt);
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch (e) { /* 非 JSON */ }
  if (!r.ok) {
    const msg = (j && (j.message || j.error)) || t.slice(0, 300);
    throw new Error(method + ' ' + url.replace(API, '') + ' → ' + r.status + '　' + msg);
  }
  return { json: j, text: t };
}

(async () => {
  if (!TOKEN || TOKEN.length < 20) throw new Error('token 无效，请重新登录 Netlify CLI');
  const pubDir = path.join(CB, 'public');
  const fnDir = path.join(CB, 'netlify', 'functions');
  if (!fs.existsSync(pubDir)) throw new Error('.cloudbuild 不存在，先跑 node scripts/prepare_cloud_build.js');

  /* ---------- ① 组装静态文件清单（SHA1 hex，路径带前导 /） ---------- */
  const statics = collect(pubDir).map(f => ({ ...f, data: fs.readFileSync(f.abs) }));
  const filesDigest = {};
  for (const f of statics) filesDigest['/' + f.path] = sha1hex(f.data);
  // netlify.toml 属于部署配置，也要作为静态文件传上去（函数路由/redirects/schedule 都靠它）
  const tomlPath = path.join(CB, 'netlify.toml');
  if (fs.existsSync(tomlPath)) {
    const b = fs.readFileSync(tomlPath);
    statics.push({ path: 'netlify.toml', abs: tomlPath, size: b.length, data: b });
    filesDigest['/netlify.toml'] = sha1hex(b);
  }
  // 双保险：本地剔除敏感数据（绝不能进公网）
  const safe = statics.filter(f => !/^(data|uploads)\//.test(f.path));
  if (safe.length !== statics.length) console.log('   ⚠ 已剔除敏感文件 ' + (statics.length - safe.length) + ' 个');

  /* ---------- ② 组装函数清单（SHA256 hex，需先 zip） ---------- */
  const fnEntries = [];
  for (const f of collect(fnDir)) {
    const name = f.path.replace(/\.js$/, '');           // 函数名不带扩展名
    const buf = fs.readFileSync(f.abs);
    // 函数包必须含它 require 的全部依赖：整个 .cloudbuild 的非静态部分
    fnEntries.push({ name, src: f, buf });
  }
  // 收集依赖（lib/ routes/ node_modules/ package.json）打进同一个 zip
  const depFiles = [];
  for (const sub of ['lib', 'routes']) {
    const d = path.join(CB, sub);
    if (fs.existsSync(d)) for (const f of collect(d)) depFiles.push({ zipPath: sub + '/' + f.path, abs: f.abs });
  }
  const nmDir = path.join(CB, 'node_modules');
  if (fs.existsSync(nmDir)) {
    for (const f of collect(nmDir)) depFiles.push({ zipPath: 'node_modules/' + f.path, abs: f.abs });
  }
  for (const p of ['package.json']) {
    const fp = path.join(CB, p);
    if (fs.existsSync(fp)) depFiles.push({ zipPath: p, abs: fp });
  }

  const title = process.argv[2] || 'feat: 合同模板比对（三方比对）+ 零依赖 docx/pdf 解析';
  console.log('① 创建 deploy（静态 ' + safe.length + ' 文件 + 函数 ' + fnEntries.length + ' 个）…');
  const functionsDigest = {};
  for (const e of fnEntries) {
    // 每个函数单独打一个 zip：入口文件 + 全量依赖
    const entries = [
      { name: e.name + '.js', data: e.buf },
      ...depFiles.map(d => ({ name: d.zipPath, data: fs.readFileSync(d.abs) }))
    ];
    e.zipBuf = zip(entries);
    e.zipSize = e.zipBuf.length;
    functionsDigest[e.name] = sha256hex(e.zipBuf);
  }

  const dep = (await req(API + '/sites/' + SITE_ID + '/deploys', 'POST',
    // ⚠ 刻意不传 branch / draft —— 见文件头坑 4：传 branch 会退化成分支部署，不推生产
    JSON.stringify({ title, files: filesDigest, functions: functionsDigest }),
    'application/json')).json;
  const id = dep.id;
  console.log('   deploy id = ' + id);
  console.log('   required（需上传的静态文件）= ' + (dep.required || []).length +
    ' / ' + safe.length);
  console.log('   required_functions         = ' + (dep.required_functions || []).length);

  /* ---------- ③ 上传静态文件（只传 required 里的，Netlify 已有缓存的跳过） ---------- */
  const needSet = new Set(dep.required || []);
  const todo = needSet.size
    ? safe.filter(f => needSet.has(sha1hex(f.data)))
    : safe;                                  // 返回空数组时保守全传
  console.log('② 上传静态文件 ' + todo.length + ' 个 …');
  let n = 0;
  for (const f of todo) {
    const r = await req(API + '/deploys/' + id + '/files/' + encodeURIComponent(f.path),
      'PUT', f.data, 'application/octet-stream');
    n++;
    process.stdout.write('   ' + n + '/' + todo.length + '\r');
  }
  console.log('\n   静态文件上传完成');

  /* ---------- ④ 上传函数 zip ---------- */
  console.log('③ 上传函数包 …');
  for (const e of fnEntries) {
    const need = !dep.required_functions || dep.required_functions.length === 0 ||
      dep.required_functions.includes(functionsDigest[e.name]);
    if (!need) { console.log('   - ' + e.name + ' 已缓存，跳过'); continue; }
    await req(API + '/deploys/' + id + '/functions/' + encodeURIComponent(e.name) + '?runtime=js',
      'PUT', e.zipBuf, 'application/zip');
    console.log('   ✔ ' + e.name + '.js  ' +
      (e.zipSize / 1024).toFixed(0) + ' KB（' + (depFiles.length + 1) + ' 文件）');
  }

  /* ---------- ⑤ 等待生效 ---------- */
  console.log('④ 等待部署生效 …');
  let st = null;
  for (let i = 0; i < 90; i++) {
    st = (await req(API + '/deploys/' + id, 'GET')).json;
    process.stdout.write('   state=' + st.state + '\r');
    if (st.state === 'ready') { console.log(''); break; }
    if (st.state === 'error' || st.state === 'failed') {
      throw new Error('Netlify 报告部署失败：' + (st.error_message || st.state));
    }
    await new Promise(r => setTimeout(r, 2500));
  }

  console.log('\n' + (st.state === 'ready' ? '✔ 部署完成' : '⚠ 部署未就绪（state=' + st.state + '）'));
  console.log('  state = ' + st.state);
  console.log('  url   = ' + (st.deploy_ssl_url || st.deploy_url || ''));
  fs.writeFileSync(path.join(ROOT, '.tmp_last_deploy.json'), JSON.stringify({
    id, state: st.state, url: st.deploy_ssl_url, files: safe.length, functions: fnEntries.length
  }, null, 1));
  process.exit(st.state === 'ready' ? 0 : 2);
})().catch(e => { console.error('\n✘ 部署失败：' + e.message); process.exit(1); });
