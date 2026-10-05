'use strict';
/**
 * 合同模板比对 —— 接口冒烟测试（本地模式，不写数据）
 * 起一个临时 server，用真实 HTTP 打接口，验证路由挂载/参数/返回结构
 */
process.env.DB_MODE = process.env.CMP_LIVE ? 'cloud' : 'local';
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0; const failures = [];
function chk(label, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + label + (extra === undefined ? '' : '　' + extra)); }
  else { fail++; failures.push(label + (extra ? '　' + extra : '')); console.log('  ✘ ' + label + (extra ? '　' + extra : '')); }
}

const { createDb, buildRouter } = require(path.join(ROOT, 'lib/app'));
const { createServer } = require(path.join(ROOT, 'lib/http'));
const A = require(path.join(ROOT, 'lib/auth'));
const dp = require(path.join(ROOT, 'lib/docparse'));

function req(server, method, url, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: url,
      headers: Object.assign(
        data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
        cookie ? { Cookie: cookie } : {})
    }, res => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve({ s: res.statusCode, j: JSON.parse(b) }); } catch (e) { resolve({ s: res.statusCode, raw: b }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const db = createDb();
  const router = buildRouter(db, {});
  // 用项目自己的 createServer；before 必须带 A.attachUser，否则所有接口 401
  const server = createServer(router, {
    db: db,
    staticDir: path.join(ROOT, 'public'),
    before: [A.attachUser(db)]
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log('临时服务已起：127.0.0.1:' + port + '（DB_MODE=' + process.env.DB_MODE + '）\n');

  // 登录拿 cookie
  const lr = await req(server, 'POST', '/api/auth/login', { username: 'admin', password: '123456' });
  chk('登录成功', lr.s === 200 && lr.j && lr.j.ok, 'HTTP ' + lr.s);
  const token = lr.j.data.token;
  const ck = 'plm_token=' + token;
  console.log('');

  // 1. 模板基线
  console.log('=== 1. GET /api/contract-compare/template ===');
  const t = await req(server, 'GET', '/api/contract-compare/template', null, ck);
  chk('HTTP 200', t.s === 200, String(t.s));
  const tpl = (t.j.data || {});
  chk('返回模板元信息', tpl.meta && tpl.meta.title === '办公场所租赁合同', tpl.meta && tpl.meta.title);
  chk('槽位清单非空（≥14）', (tpl.slots || []).length >= 14, (tpl.slots || []).length + ' 个槽位');
  chk('章节清单 16 个', (tpl.sections || []).length === 16, (tpl.sections || []).length + ' 个');
  chk('关键条款清单（≥18）', (tpl.keyClauses || []).length >= 18, (tpl.keyClauses || []).length + ' 条');
  console.log('');

  // 2. 上传比对
  console.log('=== 2. POST /api/contract-compare/check ===');
  const contracts = await db.where('contracts');
  const ct = contracts.find(c => c.status === '正常履约') || contracts[0];
  chk('有可用测试合同', !!ct, ct.code + ' ' + ct.customerName);

  // 2a. 缺参数
  const bad1 = await req(server, 'POST', '/api/contract-compare/check', { dataBase64: 'x' }, ck);
  chk('缺 contractId → 报错而非崩溃', bad1.s === 400 || bad1.j.ok === false, bad1.j.msg || ('HTTP ' + bad1.s));

  // 2b. 空内容
  const bad2 = await req(server, 'POST', '/api/contract-compare/check', { contractId: ct.id, dataBase64: '' }, ck);
  chk('空文件 → 报错', bad2.j.ok === false, bad2.j.msg || '');

  // 2c. 不支持类型
  const bad3 = await req(server, 'POST', '/api/contract-compare/check',
    { contractId: ct.id, fileName: 'a.exe', dataBase64: Buffer.from('x').toString('base64') }, ck);
  chk('不支持的扩展名 → 报错', bad3.j.ok === false, bad3.j.msg || '');

  // 2d. 超大文件（只测判定逻辑，用超小 fake Content-Length 不现实，改测 30MB 限制存在）
  const ok1 = await req(server, 'POST', '/api/contract-compare/check',
    { contractId: ct.id, fileName: 'notfound.docx', dataBase64: Buffer.from('not a docx').toString('base64') }, ck);
  chk('伪造 docx → 解析报错而非崩溃', ok1.s === 200 || ok1.j.ok === false, ok1.j.msg || 'HTTP ' + ok1.s);

  // 2e. 真实模板比对（会报大量差异，这是预期的）
  const tplBuf = fs.readFileSync('Y:/物业实际使用的报表及合同/合同模板（含普票）.docx');
  const r2 = await req(server, 'POST', '/api/contract-compare/check', {
    contractId: ct.id, fileName: '合同模板（含普票）.docx',
    dataBase64: tplBuf.toString('base64')
  }, ck);
  chk('真实 docx 比对成功', r2.s === 200 && r2.j.ok, 'HTTP ' + r2.s);
  const res2 = r2.j.data && r2.j.data.result;
  chk('返回判定与得分', res2 && typeof res2.score === 'number' && !!res2.verdict,
      res2 ? (res2.verdict + ' / ' + res2.score + ' 分 / ' + res2.stat.total + ' 项差异') : '');
  chk('每条差异都带 label/msg/severity', res2 && res2.diffs.every(d => d.label && d.msg && d.severity),
      (res2 ? res2.diffs.length : 0) + ' 条全带字段');
  chk('检出模板占位符未填', res2 && res2.diffs.some(d => d.type === 'placeholder_left'),
      (res2 ? res2.diffs.filter(d => d.type === 'placeholder_left').length : 0) + ' 处');

  // 2f. 图片（无文本层）
  const r3 = await req(server, 'POST', '/api/contract-compare/check', {
    contractId: ct.id, fileName: '扫描件.jpg', dataBase64: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 74, 70, 73, 70]).toString('base64')
  }, ck);
  chk('图片 → 返回 needOcr 提示', r3.j.ok && r3.j.data.result.needOcr === true, r3.j.data.result.error || '');
  console.log('');

  // 3. 台账接口
  console.log('=== 3. 台账 / 报告接口 ===');
  const rec = await req(server, 'GET', '/api/contract-compare/records', null, ck);
  chk('GET /records 返回列表与统计', rec.s === 200 && rec.j.data && Array.isArray(rec.j.data.list),
      '记录 ' + (rec.j.data ? rec.j.data.list.length : '?') + ' 条');
  chk('统计含 pass/review/reject/needOcr', rec.j.data.stat &&
      ['pass', 'review', 'reject', 'needOcr'].every(k => typeof rec.j.data.stat[k] === 'number'),
      JSON.stringify(rec.j.data.stat));

  const his = await req(server, 'GET', '/api/contract-compare/history/' + ct.id, null, ck);
  chk('GET /history/:id 正常', his.s === 200, 'HTTP ' + his.s);

  const hisBad = await req(server, 'GET', '/api/contract-compare/history/ct_not_exist', null, ck);
  chk('不存在的合同 → 报错', hisBad.j.ok === false, hisBad.j.msg || '');

  // 4. 权限
  console.log('\n=== 4. 权限控制 ===');
  const noAuth = await req(server, 'GET', '/api/contract-compare/template', null, null);
  chk('未登录访问 → 拒绝', noAuth.s === 401 || noAuth.j.ok === false, 'HTTP ' + noAuth.s);
  console.log('');

  // 5. 三种格式同一份内容
  console.log('=== 5. docx / txt / pdf 三种输入 ===');
  const doc = dp.extract(tplBuf, 't.docx');
  const asTxt = await req(server, 'POST', '/api/contract-compare/check', {
    contractId: ct.id, fileName: 't.txt', dataBase64: Buffer.from(doc.text, 'utf8').toString('base64')
  }, ck);
  chk('txt 输入可解析', asTxt.j.ok && asTxt.j.data.result.paraCount > 100,
      asTxt.j.data.result ? asTxt.j.data.result.paraCount + ' 段' : '');
  const pdfBuf = fs.readFileSync('Y:/物业实际使用的报表及合同/普票模板.pdf');
  const asPdf = await req(server, 'POST', '/api/contract-compare/check', {
    contractId: ct.id, fileName: '普票模板.pdf', dataBase64: pdfBuf.toString('base64')
  }, ck);
  chk('pdf 输入可解析', asPdf.j.ok, asPdf.j.ok ? (asPdf.j.data.result.docChars + ' 字') : asPdf.j.msg);
  chk('pdf 中文还原正确', asPdf.j.ok && /发票|号码|日期/.test(asPdf.j.data.result.docText),
      (asPdf.j.data.result.docText || '').slice(0, 30));
  console.log('');

  console.log('========================================================');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('   - ' + f)); }
  console.log('========================================================');
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message, e.stack); process.exit(1); });
