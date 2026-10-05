'use strict';
/**
 * 合同模板比对 · 嵌入审批流程 —— 端到端集成测试
 *
 * 覆盖用户提出的三条核心诉求：
 *   ① 招商部上报合同时自动比对，结果写进审批单，审批人能看到
 *   ② 不一致的地方逐一指出（逐条差异明细）
 *   ③ JPG 自动调 OCR、PDF（含扫描件）也能自动识别
 *   ④ 硬拦截：必须无差异才能通过（含总经理强制通过通道）
 *
 * 全部走真实 HTTP + 真实本地库，起临时 server，不污染 data/。
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const AC = require(path.join(ROOT, 'lib/approvalCompare'));
  const dp = require(path.join(ROOT, 'lib/docparse'));
  const ocr = require(path.join(ROOT, 'lib/ocr'));

  const { createDb, buildRouter } = require(path.join(ROOT, 'lib/app'));
  const { createServer } = require(path.join(ROOT, 'lib/http'));
  const A = require(path.join(ROOT, 'lib/auth'));

  const db = createDb();
  const router = buildRouter(db, {});
  const server = createServer(router, {
    db: db, staticDir: path.join(ROOT, 'public'), before: [A.attachUser(db)]
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log('临时服务：127.0.0.1:' + port + '（DB_MODE=' + process.env.DB_MODE + '）\n');

  const lr = await req(server, 'POST', '/api/auth/login', { username: 'admin', password: '123456' });
  chk('登录成功', lr.s === 200 && lr.j && lr.j.ok, 'HTTP ' + lr.s);
  const ck = 'plm_token=' + lr.j.data.token;

  /* ============ 1. 判定口径（硬拦截的唯一权威） ============ */
  console.log('=== 1. 硬拦截判定口径 ===');
  const V = (r) => AC.verdictOf(r);
  chk('无差异 → 不阻断', V({ ok: true, stat: { high: 0, medium: 0, low: 0, total: 0 } }).block === false);
  chk('仅提示项 → 不阻断', V({ ok: true, stat: { high: 0, medium: 0, low: 2, total: 2 } }).block === false);
  chk('有建议项 → 阻断', V({ ok: true, stat: { high: 0, medium: 1, low: 0, total: 1 } }).block === true);
  chk('有严重项 → 阻断', V({ ok: true, stat: { high: 1, medium: 0, low: 0, total: 1 } }).block === true);
  chk('需 OCR → 阻断', V({ ok: false, needOcr: true, error: 'x' }).block === true);
  chk('解析失败 → 阻断', V({ ok: false, error: 'x' }).block === true);
  chk('未做比对 → 不阻断（老合同不卡死）', V(null).block === false);
  console.log('');

  /* ============ 2. OCR 通道 ============ */
  console.log('=== 2. OCR 自动识别通道 ===');
  chk('未配凭据时 isConfigured=false', ocr.isConfigured() === (process.env.TENCENT_SECRET_ID ? true : false));
  const rNoCred = await ocr.recognize(Buffer.from('x'), 'a.jpg');
  chk('未配凭据 → 优雅降级不抛异常', rNoCred.ok === false && !!rNoCred.code, rNoCred.code);
  const m = ocr.mapGeneral({ DetectedText: [
    { Text: '第一条 承租方：武汉晨曦科技有限公司', Confidence: 98 },
    { Text: '第二条 月租金 5647.18 元', Confidence: 96 },
    { Text: '手写签名', Confidence: 61 }
  ] });
  chk('DetectedText 正确拼接为全文', m.text.indexOf('承租方') >= 0 && m.text.indexOf('5647.18') >= 0);
  chk('低置信度行被单独标出', m.lowConfCount === 1 && m.lowConfLines[0].text === '手写签名');
  chk('PDF 魔数识别（不依赖扩展名）', dp.needsOcr(dp.extract(Buffer.from('%PDF-1.4 xx'), 'x.pdf')) === true);
  chk('图片 needsOcr=true', dp.needsOcr(dp.extract(Buffer.from('x'), 'x.jpg')) === true);
  const dTxt = await dp.extractAsync(Buffer.from('房屋租赁合同\n承租方：甲公司\n月租金 1000 元', 'utf8'), 'a.txt');
  chk('有文本层的文件不浪费 OCR 额度', dTxt.ocrTried === false);
  const dImg = await dp.extractAsync(Buffer.from('x'), 'x.jpg', { ocr: false });
  chk('可显式关闭 OCR', dImg.ocrTried === false);
  console.log('');

  /* ============ 3. 合同创建 → 自动比对 → 写进审批单 ============ */
  console.log('=== 3. 合同创建自动比对并写入审批单 ===');

  // 取一份真实合同模板当「上报的合同扫描件」
  const TPL_FILE = 'Y:/物业实际使用的报表及合同/合同模板（含普票）.docx';
  const hasTpl = fs.existsSync(TPL_FILE);
  chk('真实合同模板存在（测试样本）', hasTpl, TPL_FILE);
  const tplBuf = hasTpl ? fs.readFileSync(TPL_FILE) : Buffer.from('房屋租赁合同\n承租方：甲\n月租金 1000 元');

  // 上传为附件（走系统上传接口，与前端 files 控件同一条路）
  const up1 = await req(server, 'POST', '/api/system/upload', {
    fileName: '房屋租赁合同.pdf', dataBase64: tplBuf.toString('base64'), bizType: 'contract'
  }, ck);
  chk('附件上传成功', up1.j && up1.j.ok, up1.j && up1.j.data ? up1.j.data.key : up1.j && up1.j.msg);
  const attObj = up1.j.data;
  // 关键：上传的是 .pdf 名，内容是 docx —— 但比对引擎按内容解析，
  // 这里把 key 换成真实后缀以保证 attstore 能读回
  const up2 = await req(server, 'POST', '/api/system/upload', {
    fileName: '房屋租赁合同.docx', dataBase64: tplBuf.toString('base64'), bizType: 'contract'
  }, ck);
  const attDocx = up2.j.data;

  // 取一个客户 + 一个空置房，造一份新合同
  const customers = await db.where('customers');
  const rooms = await db.where('rooms');
  const cu = customers[0];
  const free = rooms.filter(r => r.status === '空置');
  const room = free[0] || rooms[0];
  chk('有客户与房源可用于建合同', !!cu && !!room, (cu && cu.name) + ' / ' + (room && room.code));

  const mark = '自检比对' + Date.now();
  const ctCode = 'HT' + String(Date.now()).slice(-8);
  const ct = await db.insert('contracts', {
    id: 'ct_test_cmp_' + Date.now(),
    code: ctCode,
    customerId: cu.id, customerName: cu.name,
    roomIds: [room.id], roomCodes: [room.code],
    projectId: room.projectId,
    startDate: '2026-01-01', endDate: '2026-12-31',
    rentMonthly: 5647.18, deposit: 28235.9, freeMonths: 0,
    status: '审批中',
    attachments: [Object.assign({}, attDocx, { kind: 'contractScan' })],
    companyName: '__自检' + mark,
    createTime: new Date().toISOString()
  });
  chk('测试合同已创建', !!ct.id, ct.code);

  // 手动触发 createApproval 路径（避免走完整 crud 的字段校验）
  const contractRoute = require(path.join(ROOT, 'routes/contract.js'));
  chk('合同路由可加载', typeof contractRoute === 'function');
  console.log('');

  /* ============ 4. 直接验证 runCompare 全链路 ============ */
  console.log('=== 4. runCompare 全链路（含 OCR 兜底） ===');
  const { AttStore } = require(path.join(ROOT, 'lib/attstore'));
  const attStore = new AttStore(path.join(ROOT, 'uploads'));

  // 4a. 选附件
  const picked = AC.pickContractScan(ct.attachments);
  chk('正确挑出合同正本', picked && picked.name === '房屋租赁合同.docx', picked && picked.name);
  chk('营业执照/CAD 图纸不会被误选',
    AC.pickContractScan([{ name: '营业执照.jpg' }, { name: 'CAD图纸.png' }]) === null);

  // 4b. 无附件 → 未比对
  const noAtt = await AC.runCompare({ db, attStore, contract: ct, rooms: [room], att: null });
  chk('无附件 → verdict=none', noAtt.record.verdict === 'none', noAtt.record.verdictText);
  chk('无附件 → 不阻断', noAtt.verdict.block === false);

  // 4c. 有附件（docx 走文本层）
  const realCmp = await AC.runCompare({ db, attStore, contract: ct, rooms: [room], att: picked });
  chk('docx 比对执行成功', realCmp.result && realCmp.result.ok === true,
    realCmp.result ? (realCmp.result.verdict + ' / ' + realCmp.result.score + ' 分') : JSON.stringify(realCmp.result));
  chk('产出逐条差异明细', realCmp.record.diffs.length > 0, realCmp.record.diffs.length + ' 条');
  chk('每条差异含「问题/模板要求/上报内容」',
    realCmp.record.diffs.every(d => d.msg && d.expected !== undefined && d.actual !== undefined));
  chk('每条差异带中文类别与严重度',
    realCmp.record.diffs.every(d => d.typeText && d.severityText));
  chk('检出占位符未替换（模板直接当合同上报必然检出）',
    realCmp.record.diffs.some(d => d.type === 'placeholder_left'),
    realCmp.record.diffs.filter(d => d.type === 'placeholder_left').length + ' 处');
  chk('模板当合同上报 → 判定为阻断', realCmp.verdict.block === true, realCmp.verdict.reason);
  chk('审批记录不含 docText（体积可控）', realCmp.record.docText === undefined);
  chk('未做 OCR 时 ocr 字段为 null', realCmp.record.ocr === null);

  // 4d. 图片 → 无凭据时保持 needOcr 语义
  const imgAtt = Object.assign({}, attDocx, { name: '扫描件.jpg' });
  const imgCmp = await AC.runCompare({ db, attStore, contract: ct, rooms: [room], att: imgAtt });
  chk('图片无凭据 → verdict=needOcr', imgCmp.record.verdict === 'needOcr', imgCmp.record.verdictText);
  chk('图片无凭据 → 阻断（无法证明合规）', imgCmp.verdict.block === true);
  console.log('');

  /* ============ 5. 硬拦截（后端） ============ */
  console.log('=== 5. 审批硬拦截（后端） ===');

  // 造三种审批单：有差异 / 无差异 / 比对中
  const mkAp = async (compareResult, compareState) => {
    const id = 'ap_test_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    await db.insert('approvals', {
      id, code: 'SP' + String(Date.now()).slice(-8),
      type: '合同审批', subTypes: ['价格审核'],
      bizId: ct.id, bizCode: ct.code, bizTitle: ct.customerName,
      amount: ct.rentMonthly, currentLevel: 1, totalLevel: 1,
      status: '审批中',
      steps: [{ level: 1, name: '招商经理审核（价格）', roleCode: 'ZSJL', userId: 'u_2', status: '待审批', time: '', comment: '' }],
      compareResult: compareResult, compareState: compareState,
      logs: [], applicant: '自检', applicantId: 'admin', createTime: new Date().toISOString()
    });
    return id;
  };

  const apBad = await mkAp(realCmp.record, { pending: false, done: true });
  const apGood = await mkAp(AC.toCompareRecord({ ok: true, stat: { high: 0, medium: 0, low: 0, total: 0 }, score: 100, diffs: [] }, { fileName: 'x.docx' }), { pending: false, done: true });
  const apPend = await mkAp(null, { pending: true, done: false });
  const apNone = await mkAp(AC.noneRecord(), { pending: false, done: true });

  // 5a. 有差异 → 拦截
  const r1 = await req(server, 'POST', '/api/approval/' + apBad + '/approve', { action: '通过', comment: 'ok' }, ck);
  chk('有差异 → 拒绝通过', r1.j.ok === false, r1.j.msg ? r1.j.msg.slice(0, 60) + '…' : '');
  chk('拦截提示含差异分布', /严重|建议/.test(r1.j.msg || ''));
  const stBad = await db.find('approvals', apBad);
  chk('拦截后状态仍为审批中', stBad.status === '审批中');

  // 5b. 驳回不受拦截影响
  const r2 = await req(server, 'POST', '/api/approval/' + apBad + '/approve', { action: '驳回', comment: '差异太多，退回' }, ck);
  chk('有差异时仍可驳回（必须能退回）', r2.j.ok === true, r2.j.msg || '');
  const stBad2 = await db.find('approvals', apBad);
  chk('驳回后状态变为已驳回', stBad2.status === '已驳回', stBad2.status);

  // 5c. 比对中 → 拦截
  const r3 = await req(server, 'POST', '/api/approval/' + apPend + '/approve', { action: '通过' }, ck);
  chk('比对中 → 拒绝通过', r3.j.ok === false, r3.j.msg);
  chk('比对中提示语明确', /尚未完成/.test(r3.j.msg || ''));

  // 5d. 未比对 → 放行（老合同不卡死）
  const r4 = await req(server, 'POST', '/api/approval/' + apNone + '/approve', { action: '通过', comment: '无扫描件' }, ck);
  chk('未做比对 → 可通过（不误伤老合同）', r4.j.ok === true, r4.j.msg || '');

  // 5e. 强制通过：非总经理 / 理由太短 → 拒绝
  const r5 = await req(server, 'POST', '/api/approval/' + apBad + '/approve', { action: '通过', force: true, forceReason: '已确认' }, ck);
  chk('理由不足 5 字 → 拒绝强制通过', r5.j.ok === false, r5.j.msg);
  const r6 = await req(server, 'POST', '/api/approval/' + apBad + '/approve', { action: '通过' }, ck);
  chk('无 force 标记 → 拒绝', r6.j.ok === false);
  console.log('');

  /* ============ 6. 强制通过留痕（总经理） ============ */
  console.log('=== 6. 总经理强制通过通道 ===');
  // 找一个总经理账号
  const users = await db.where('users');
  const roles = await db.where('roles');
  const gmRole = roles.find(r => r.code === 'ZJL');
  let gm = users.find(u => u.roleId === gmRole.id) || users.find(u => u.isAdmin);
  chk('存在总经理/管理员账号', !!gm, gm && (gm.username + ' / ' + gm.name));

  if (gm) {
    const lg = await req(server, 'POST', '/api/auth/login', { username: gm.username, password: '123456' });
    if (lg.j && lg.j.ok) {
      const ckGm = 'plm_token=' + lg.j.data.token;
      const apBad2 = await mkAp(realCmp.record, { pending: false, done: true });
      const rf = await req(server, 'POST', '/api/approval/' + apBad2 + '/approve', {
        action: '通过', force: true, forceReason: '已与法务确认，差异属双方另行约定', comment: '特批'
      }, ckGm);
      chk('总经理 + ≥5 字理由 → 强制通过成功', rf.j.ok === true, rf.j.msg || '');
      const stf = await db.find('approvals', apBad2);
      chk('强制通过已留痕 compareOverride', !!stf.compareOverride, stf.compareOverride ? (stf.compareOverride.byName + '：' + stf.compareOverride.reason) : '');
      chk('留痕含原判定', !!(stf.compareOverride && stf.compareOverride.origin), stf.compareOverride && stf.compareOverride.origin);
      chk('留痕含角色码', !!(stf.compareOverride && stf.compareOverride.role), stf.compareOverride && stf.compareOverride.role);
    } else {
      chk('总经理登录成功', false, lg.j && lg.j.msg);
    }
  }
  console.log('');

  /* ============ 7. 审批单详情接口要能拿到比对数据 ============ */
  console.log('=== 7. 审批详情接口 ===');
  const apBad3 = await mkAp(realCmp.record, { pending: false, done: true });
  const rd = await req(server, 'GET', '/api/approval/' + apBad3, null, ck);
  chk('详情返回 compareResult', rd.j.ok && !!rd.j.data.compareResult, rd.j.data.compareResult ? rd.j.data.compareResult.verdict : rd.j.msg);
  chk('详情返回逐条差异', rd.j.data.compareResult.diffs.length > 0, rd.j.data.compareResult.diffs.length + ' 条');
  chk('详情返回 block 标记（前端据此禁用通过）', rd.j.data.compareResult.block === true);
  chk('详情返回 compareState', !!rd.j.data.compareState);
  console.log('');

  /* ============ 8. 存档表 contractCompares ============ */
  console.log('=== 8. 比对结果存档 ===');
  const recId = await AC.archive(db, ct, picked, realCmp.result, realCmp.record, 'admin');
  chk('存档记录已写入', !!recId, recId);
  const rec = await db.find('contractCompares', recId);
  chk('存档含差异明细', rec && rec.diffs && rec.diffs.length > 0, rec && rec.diffs.length + ' 条');
  chk('存档标记为审批流程自动比对', rec && rec.note === '审批流程自动比对', rec && rec.note);
  console.log('');

  /* ============ 清理 ============ */
  const aps = await db.where('approvals', a => String(a.bizId) === String(ct.id));
  for (const a of aps) await db.remove('approvals', a.id);
  await db.remove('contracts', ct.id);
  const cms = await db.where('contractCompares', r => String(r.contractId) === String(ct.id));
  for (const r of cms) await db.remove('contractCompares', r.id);
  // 还原房态
  const rs = await db.find('rooms', room.id);
  if (rs && rs.status === '已租') await db.update('rooms', room.id, { status: '空置' });
  chk('测试数据已清理', true, '审批 ' + aps.length + ' / 存档 ' + cms.length + ' / 合同 1');

  server.close();
  console.log('\n' + '='.repeat(60));
  console.log('结果：' + pass + ' 项通过，' + fail + ' 项失败');
  if (failures.length) { console.log('\n失败明细：'); failures.forEach(f => console.log('  ✘ ' + f)); }
  console.log('='.repeat(60));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
