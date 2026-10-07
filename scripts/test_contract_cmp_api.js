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

  /* ============================================================
   *  6. 待审合同比对（合同尚未录入系统档案、尚无编号）
   * ============================================================ */
  console.log('=== 6. 待审合同比对（无系统档案） ===');

  // 6a. 不传 contractId / contractCode → 应走 pending，而不是报错
  const p1 = await req(server, 'POST', '/api/contract-compare/check', {
    fileName: '合同模板（含普票）.docx', dataBase64: tplBuf.toString('base64')
  }, ck);
  chk('不传合同标识 → 走待审模式（不再报错）', p1.s === 200 && p1.j.ok === true, p1.j.msg || ('HTTP ' + p1.s));
  chk('返回 mode=pending', p1.j.ok && p1.j.data.mode === 'pending' && p1.j.data.result.mode === 'pending',
      p1.j.ok ? p1.j.data.mode : '');
  chk('退回的 contract 为空壳', p1.j.ok && p1.j.data.contract && !p1.j.data.contract.id, '');
  const pr = (p1.j.data || {}).result || {};
  chk('有待审提示 notice', !!pr.notice, (pr.notice || '').slice(0, 24) + '…');
  chk('带出识别到的槽位值（extracted）', Array.isArray(pr.extracted) && pr.extracted.length >= 14,
      (pr.extracted || []).length + ' 项');
  const types = Object.keys(pr.stat.byType || {});
  chk('不含与系统数据比对产生的差异（slot_mismatch/slot_manual）',
      types.every(t => t !== 'slot_mismatch' && t !== 'slot_manual'), types.join(','));
  chk('不含 rent_not_found / date_not_found / area_not_found',
      types.every(t => t !== 'rent_not_found' && t !== 'date_not_found' && t !== 'area_not_found'), types.join(','));
  chk('模板类检查照常（仍检出占位符残留）', types.indexOf('placeholder_left') >= 0,
      types.join(','));
  chk('合同编号未填时不报「编号缺失」',
      !(pr.diffs || []).some(d => d.label === '合同编号'),
      (pr.diffs || []).filter(d => d.label === '合同编号').length + ' 条');

  // 6b. 填了编号的待审合同 → 仍做格式校验
  const miniNo = [
    '办公场所租赁合同',
    '合同编号：HT-ABC-001',
    '出租方（甲方）：湖北梦想之城物业服务有限公司',
    '承租方（乙方）：武汉测试科技有限公司',
    '乙方愿意承租甲方位于武汉市东西湖区宏图一路9号梦想之城T3-第6层03单元',
    '经双方确认该房屋的签约服务面积120平方米',
    '租赁期限为3年，自2026年1月1日起至2029年1月1日止',
    '固定月租金（含物业综合服务费）￥8000元（大写：捌仟元整）'
  ].join('\n');

  // 6c. 关联核查：拿系统里真实存在的在租房号，验证「同房号已签出」能报出来
  const liveCt = contracts.filter(c => ['正常履约', '逾期', '变更'].indexOf(c.status) >= 0 &&
    (c.roomCodes || []).length && /^([A-Za-z]\d{1,2}|\d{1,3}栋)-\d{1,2}-\d{1,2}$/.test(String(c.roomCodes[0])))[0] || null;
  chk('系统里有可用于关联核查的在租合同', !!liveCt,
      liveCt ? (liveCt.code + ' ' + liveCt.roomCodes[0]) : '（无匹配样本，跳过房号断言）');

  if (liveCt) {
    const mini = [
      '办公场所租赁合同',
      '出租方（甲方）：湖北梦想之城物业服务有限公司',
      '承租方（乙方）：' + liveCt.customerName,
      '乙方愿意承租甲方位于武汉市东西湖区宏图一路9号梦想之城T3-' + liveCt.roomCodes[0],
      '经双方确认该房屋的签约服务面积120平方米',
      '租赁期限为3年，自2026年1月1日起至2029年1月1日止',
      '固定月租金（含物业综合服务费）￥8000元（大写：捌仟元整）'
    ].join('\n');
    const p2 = await req(server, 'POST', '/api/contract-compare/check', {
      fileName: '待审合同.txt', dataBase64: Buffer.from(mini, 'utf8').toString('base64')
    }, ck);
    chk('待审比对（txt）成功', p2.j.ok === true, p2.j.msg || '');
    const rel = (p2.j.data || {}).related || {};
    chk('识别到房号', Array.isArray(rel.roomCodes) && rel.roomCodes.length >= 1,
        (rel.roomCodes || []).map(x => x.raw).join(','));
    chk('房号命中「系统中已存在」', Array.isArray(rel.rooms) && rel.rooms.length >= 1 && rel.rooms[0].exists === true,
        rel.rooms && rel.rooms[0] ? (rel.rooms[0].norm + ' exists=' + rel.rooms[0].exists + ' busy=' + rel.rooms[0].busy) : '');
    chk('房号命中「已被签出」（防重复签约）', Array.isArray(rel.rooms) && rel.rooms.length >= 1 && rel.rooms[0].busy === true,
        rel.rooms && rel.rooms[0] ? rel.rooms[0].busyBy : '');
    chk('承租方在系统里已有合同', Array.isArray(rel.customer) && rel.customer.length >= 1,
        (rel.customer || []).length + ' 份');
    chk('未填编号的待审合同不误报编号差异',
        !((p2.j.data || {}).result || {}).diffs?.some(d => d.label === '合同编号'), '');
  }

  // 6d. 待审存档（无合同可挂附件，只写比对记录）
  const p3 = await req(server, 'POST', '/api/contract-compare/save', {
    fileName: '待审合同.txt', dataBase64: Buffer.from(miniNo, 'utf8').toString('base64')
  }, ck);
  chk('待审存档成功', p3.s === 200 && p3.j.ok === true, p3.j.msg || ('HTTP ' + p3.s));
  chk('待审存档不产生附件对象', p3.j.ok && p3.j.data.attachment === null, '');
  chk('待审存档标记 pending=true', p3.j.ok && p3.j.data.pending === true, '');
  const recId = p3.j.ok ? p3.j.data.recordId : '';

  const led = await req(server, 'GET', '/api/contract-compare/records', null, ck);
  const ledList = (led.j.data || {}).list || [];
  const mine = ledList.find(x => x.id === recId);
  chk('台账能查到该待审记录', !!mine, mine ? ('pending=' + mine.pending) : '未找到');
  chk('台账把无合同的记录标为 pending', mine && mine.pending === true, '');
  chk('统计里含 pending 计数', typeof (led.j.data.stat || {}).pending === 'number',
      'pending=' + (led.j.data.stat || {}).pending);

  // 6e. 待审记录的报告导出
  const rep = await req(server, 'GET', '/api/contract-compare/report/' + recId, null, ck);
  chk('待审记录可导出报告', rep.s === 200 && /待审合同比对/.test(rep.raw || ''),
      'HTTP ' + rep.s + ' / ' + String(rep.raw || '').length + ' 字');

  // 清理测试写入
  if (recId) { try { await db.remove('contractCompares', recId); } catch (e) {} }
  const cleaned = await req(server, 'GET', '/api/contract-compare/records', null, ck);
  chk('测试记录已清理', !((cleaned.j.data || {}).list || []).some(x => x.id === recId), '');
  console.log('');

  console.log('========================================================');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('   - ' + f)); }
  console.log('========================================================');
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message, e.stack); process.exit(1); });
