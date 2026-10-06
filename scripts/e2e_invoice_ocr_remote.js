'use strict';
/*
 * 公网端到端实测：登录 → 上传真实发票 PDF（bizType=invoice）→ 检查 OCR 回填
 * 用法: node scripts/e2e_invoice_ocr_remote.js <发票PDF路径> [baseUrl]
 * 账号可用环境变量覆盖: E2E_USER / E2E_PASS（默认 admin / 123456，即演示账号）
 * 会打印新附件 id，便于随后清理（本脚本不自动删，避免误删）
 */
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const BASE = process.argv[3] || process.env.E2E_BASE || 'http://8.148.29.148:8080';
const USER = process.env.E2E_USER || 'admin';
const PASS = process.env.E2E_PASS || '123456';
if (!file) { console.log('用法: node scripts/e2e_invoice_ocr_remote.js <发票PDF> [baseUrl]'); process.exit(1); }

const j = (o) => JSON.stringify(o, null, 2);

(async () => {
  // ---------- 1. 登录 ----------
  console.log('===== [1] 登录 ' + BASE + ' (' + USER + ') =====');
  const lr = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  });
  const raw = await lr.text();
  let lj; try { lj = JSON.parse(raw); } catch (e) { console.log('  登录返回非 JSON:', raw.slice(0, 200)); process.exit(2); }
  if (!lj.ok) { console.log('  ❌ 登录失败:', lj.msg); process.exit(2); }
  const sc = lr.headers.get('set-cookie') || '';
  const mm = sc.match(/plm_token=([^;]+)/);
  const token = (lj.data && lj.data.token) || (mm && mm[1]);
  console.log('  ✅ 登录成功  用户=' + (lj.data.user && lj.data.user.name) + '  token 来源=' + (lj.data.token ? 'body' : 'cookie'));

  // ---------- 2. 上传发票 ----------
  const buf = fs.readFileSync(file);
  const b64 = 'data:application/pdf;base64,' + buf.toString('base64');
  console.log('\n===== [2] 上传发票 ' + path.basename(file) + ' (' + (buf.length / 1024).toFixed(1) + 'KB) =====');
  const t0 = Date.now();
  const ur = await fetch(BASE + '/api/system/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': 'plm_token=' + token },
    body: JSON.stringify({ fileName: path.basename(file), dataBase64: b64, bizType: 'invoice' })
  });
  const uraw = await ur.text();
  console.log('  HTTP=' + ur.status + '  耗时=' + (Date.now() - t0) + 'ms');
  let uj; try { uj = JSON.parse(uraw); } catch (e) { console.log('  返回非 JSON:', uraw.slice(0, 300)); process.exit(3); }
  if (!uj.ok) { console.log('  ❌ 上传失败:', uj.msg); process.exit(3); }

  const data = uj.data || {};
  const att = data.saved || data.attachment || data;
  console.log('  附件 id   = ' + (att && att.id));
  console.log('  附件 key  = ' + (att && att.key));
  console.log('  附件 url  = ' + String((att && att.url) || '').slice(0, 90) + '…');

  // ---------- 3. OCR 结果 ----------
  console.log('\n===== [3] OCR 回填结果 =====');
  const ocr = uj.ocr || (data && data.ocr);
  const err = uj.ocr_error || (data && data.ocr_error);
  if (err) {
    console.log('  ❌ ocr_error = ' + err);
  } else if (ocr) {
    console.log('  ✅ 识别成功  engine=' + ocr.engine);
    const F = ['invoice_no', 'date', 'buyer', 'seller', 'tax_rate', 'tax_included', 'tax_excluded', 'tax'];
    F.forEach(k => console.log('      ' + k.padEnd(14) + ' = ' + JSON.stringify(ocr[k])));
    const missing = F.filter(k => ocr[k] === '' || ocr[k] === null || ocr[k] === undefined);
    console.log('  ' + (missing.length ? '⚠ 未识别到: ' + missing.join(', ') : '✅ 关键字段全部识别到'));
  } else {
    console.log('  ⚠ 响应里既无 ocr 也无 ocr_error，完整响应：');
    console.log('  ' + j(uj).slice(0, 800));
  }

  console.log('\n===== [4] 清理提示 =====');
  console.log('  待清理附件 id = ' + (att && att.id) + '  key = ' + (att && att.key));
  console.log('E2E_DONE');
})().catch(e => { console.log('❌ 异常: ' + e.message + '\n' + e.stack); process.exit(9); });
