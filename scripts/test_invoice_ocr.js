'use strict';
/**
 * 自测：新增发票「上传票面 PDF/图片 → 自动识别回填」服务端全链路
 *
 * 为什么要打桩 fetch：
 *   本机没有配腾讯云 OCR 凭据（.env 里 TENCENT_SECRET_ID/KEY 为空），
 *   真实调用只会返回 AuthFailure。所以在进程内把 globalThis.fetch 换掉，
 *   让它返回一条**真实的 VatInvoiceOCR 响应结构**（VatInvoiceInfos 键值对），
 *   从而验证：请求参数（action/version/IsPdf/PdfPageNumber）对不对、
 *   响应映射对不对、ok(res, rec, {ocr}) 的响应封装对不对。
 *
 * 存储用 local（临时目录），不往七牛云桶里写测试垃圾。
 *
 * 用法：node tmp/test_invoice_ocr.js
 */
/**
 * ⚠ 跑在哪个库上：
 *   本脚本走 `createDb()` + `.env`（当前 .env 是 DB_MODE=cloud）→ **TiDB 云端库**，
 *   与 Netlify Functions 同一条代码路径。
 *   注意本机 `server.js` 是**写死** `new DB(DATA_DIR)`（本地 data/*.json），
 *   所以「浏览器里点出来的数据」和本脚本操作的不是同一份，排查时别混淆。
 *   脚本会在结束前删掉自己造的发票/附件（含临时目录里的本地文件）。
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

process.env.DB_MODE = 'cloud';            // 与线上同一条代码路径（TiDB）
process.env.ATT_STORAGE = 'local';        // 测试期间不写对象存储
const UPLOAD_DIR = path.join(ROOT, 'tmp', '_upload_test');
require(path.join(ROOT, 'lib', 'env'));

const { createDb, buildRouter } = require(path.join(ROOT, 'lib', 'app'));
const A = require(path.join(ROOT, 'lib', 'auth'));

let PASS = 0, FAIL = 0;
function chk(name, cond, extra) {
  if (cond) { PASS++; console.log('  ✓ ' + name); }
  else { FAIL++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
}

class MiniRes {
  constructor() { this.statusCode = 200; this.headers = {}; this.chunks = []; this.writableEnded = false; }
  setHeader(k, v) { this.headers[k] = v; }
  getHeader(k) { return this.headers[k]; }
  writeHead(c, h) { this.statusCode = c; if (h) Object.assign(this.headers, h); return this; }
  write(c) { if (c) this.chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); return true; }
  end(c) { if (c) this.write(c); this.writableEnded = true; return this; }
  body() { return Buffer.concat(this.chunks).toString('utf8'); }
  json() { try { return JSON.parse(this.body()); } catch (e) { return null; } }
}

function makeReq(method, fullPath, cookie, body) {
  const u = new URL(fullPath, 'http://x');
  const query = {}; u.searchParams.forEach((v, k) => { query[k] = v; });
  return {
    method, path: u.pathname, url: fullPath,
    headers: cookie ? { cookie } : {},
    cookies: cookie ? { plm_token: String(cookie).split('=')[1] } : {},
    query, body: body || {}, params: {},
    get: k => (cookie && k.toLowerCase() === 'cookie') ? cookie : undefined
  };
}

// ---- 一份「真实的」腾讯云 VatInvoiceOCR 响应（取自接口文档的字段名） ----
const FAKE_VAT_RESP = {
  RequestId: 'req-test-0001',
  VatInvoiceInfos: [
    { Name: '发票代码', Value: '011002100311' },
    { Name: '发票号码', Value: 'No 12345678' },
    { Name: '开票日期', Value: '2026年09月15日' },
    { Name: '校验码', Value: '12345 67890 12345 67890' },
    { Name: '购买方名称', Value: '武汉某某科技有限公司' },
    { Name: '购买方纳税人识别号', Value: '91420100MA4K1234XX' },
    { Name: '销售方名称', Value: '湖北云之博建筑工程有限公司' },
    { Name: '销售方纳税人识别号', Value: '91420100MA4K5678YY' },
    { Name: '税率', Value: '9%' },
    { Name: '合计金额', Value: '¥10,000.00' },
    { Name: '合计税额', Value: '¥900.00' },
    // 故意用**全角括号**：验证键名归一化（真实票面/接口两种写法都出现过）
    { Name: '价税合计（小写）', Value: '￥10900.00' }
  ]
};

const realFetch = globalThis.fetch;
let fetchCalls = [];

(async () => {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const db = createDb();
  const ctx = { rootDir: ROOT, dataDir: path.join(ROOT, 'data'), uploadDir: UPLOAD_DIR, exportDir: path.join(ROOT, 'exports') };
  const router = buildRouter(db, ctx);

  async function dispatch(req) {
    const res = new MiniRes();
    db.beginRequest();
    try {
      const m = router.match(req.method, req.path);
      if (!m) { res.writeHead(404); res.end(JSON.stringify({ ok: false, msg: 'no route' })); return res; }
      req.params = m.params;
      await A.attachUserAsync(db, req);
      await m.handler(req, res, m.params);
      if (!res.writableEnded) res.end();
      return res;
    } finally { db.endRequest(); }
  }

  // ---- 登录 ----
  const lr = await dispatch(makeReq('POST', '/api/auth/login', null, { username: 'admin', password: '123456' }));
  const token = (lr.json() || { data: {} }).data.token;
  if (!token) { console.error('登录失败:', lr.body().slice(0, 300)); process.exit(1); }
  const cookie = 'plm_token=' + token;
  console.log('已登录 admin\n');

  const PDF = Buffer.from('%PDF-1.4\n% test invoice stub\n%%EOF\n', 'latin1');
  const dataUrl = 'data:application/pdf;base64,' + PDF.toString('base64');

  /* ================= 场景 1：已配置凭据 → 识别成功并回填字段 ================= */
  console.log('【场景 1】bizType=invoice + 已配置凭据 → 应返回 ocr 结构化字段');
  process.env.TENCENT_SECRET_ID = 'AKID_TEST_FAKE';
  process.env.TENCENT_SECRET_KEY = 'SK_TEST_FAKE';
  fetchCalls = [];
  globalThis.fetch = async (url, opt) => {
    fetchCalls.push({ url: String(url), action: opt.headers['X-TC-Action'], version: opt.headers['X-TC-Version'], body: JSON.parse(opt.body) });
    return { json: async () => ({ Response: FAKE_VAT_RESP }) };
  };

  let res1 = await dispatch(makeReq('POST', '/api/system/upload', cookie, {
    fileName: '电子发票.pdf', dataBase64: dataUrl, bizType: 'invoice'
  }));
  let j1 = res1.json() || {};
  chk('HTTP 200 + ok=true', res1.statusCode === 200 && j1.ok === true, j1);
  chk('调用的是 VatInvoiceOCR', fetchCalls.length === 1 && fetchCalls[0].action === 'VatInvoiceOCR', fetchCalls.map(c => c.action));
  chk('version=2018-11-19', fetchCalls[0] && fetchCalls[0].version === '2018-11-19', fetchCalls[0] && fetchCalls[0].version);
  chk('识别出 PDF：IsPdf=true / PdfPageNumber=1',
    fetchCalls[0] && fetchCalls[0].body.IsPdf === true && fetchCalls[0].body.PdfPageNumber === 1,
    fetchCalls[0] && fetchCalls[0].body);
  chk('附件记录照常返回（data.url 非空）', !!(j1.data && j1.data.url), j1.data);
  chk('响应顶层带 ocr 对象', !!j1.ocr, Object.keys(j1));
  const o = j1.ocr || {};
  chk('发票号码清洗掉「No 」前缀 → 12345678', o.invoice_no === '12345678', o.invoice_no);
  chk('开票日期归一化为 2026-09-15', o.date === '2026-09-15', o.date);
  chk('价税合计(小写) 全角括号也能取到 → 10900', o.tax_included === 10900, o.tax_included);
  chk('税率 9%（带 % 不换算）', o.tax_rate === 9, o.tax_rate);
  chk('不含税合计 10000 / 税额 900', o.tax_excluded === 10000 && o.tax === 900, [o.tax_excluded, o.tax]);
  chk('购买方名称 → buyer（对应表单发票抬头）', o.buyer === '武汉某某科技有限公司', o.buyer);
  chk('购买方纳税人识别号 → buyer_tax_no', o.buyer_tax_no === '91420100MA4K1234XX', o.buyer_tax_no);
  chk('ocr 未混进附件记录（rec 里没有 ocr 字段）', !(j1.data && j1.data.ocr), j1.data && Object.keys(j1.data));

  const attId1 = j1.data && j1.data.id;
  const attFile1 = j1.data && j1.data.key;

  /* ================= 场景 2：未配置凭据 → 优雅降级 ================= */
  console.log('\n【场景 2】bizType=invoice + 未配置凭据 → 附件成功、只给 ocr_error');
  delete process.env.TENCENT_SECRET_ID;
  delete process.env.TENCENT_SECRET_KEY;
  globalThis.fetch = realFetch;
  const res2 = await dispatch(makeReq('POST', '/api/system/upload', cookie, {
    fileName: 'fapiao.png', dataBase64: 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'), bizType: 'invoice'
  }));
  const j2 = res2.json() || {};
  chk('附件仍上传成功 ok=true', j2.ok === true, j2);
  chk('有 data（附件记录）', !!j2.data, j2.data);
  chk('无 ocr 字段', !j2.ocr, j2.ocr);
  chk('ocr_error 明确提示未配置凭据', /未配置腾讯云 OCR 凭据/.test(String(j2.ocr_error)), j2.ocr_error);

  /* ================= 场景 3：非发票 bizType 不触发识别 ================= */
  console.log('\n【场景 3】bizType=other → 不调 OCR（避免给普通附件白付识别费）');
  process.env.TENCENT_SECRET_ID = 'AKID_TEST_FAKE';
  process.env.TENCENT_SECRET_KEY = 'SK_TEST_FAKE';
  fetchCalls = [];
  globalThis.fetch = async (url, opt) => {
    fetchCalls.push({ action: opt.headers['X-TC-Action'] });
    return { json: async () => ({ Response: FAKE_VAT_RESP }) };
  };
  const res3 = await dispatch(makeReq('POST', '/api/system/upload', cookie, {
    fileName: '合同附件.pdf', dataBase64: dataUrl, bizType: 'other'
  }));
  const j3 = res3.json() || {};
  chk('未调用任何 OCR 接口', fetchCalls.length === 0, fetchCalls);
  chk('响应无 ocr / ocr_error 字段', !j3.ocr && !j3.ocr_error, Object.keys(j3));

  /* ================= 场景 4：发票落库 + attachments JSON 往返 ================= */
  console.log('\n【场景 4】新增发票携带 attachments → 落库 / 读回保持一致');
  const cuRes = await dispatch(makeReq('GET', '/api/customer/customers?size=1', cookie));
  const cust = ((cuRes.json() || {}).data || {}).list || [];
  if (!cust.length) { console.log('  ! 没有客户数据，跳过场景 4'); }
  else {
    const code = 'TESTOCR' + Date.now();
    const payload = {
      code: code, customerId: cust[0].id, customerName: cust[0].name,
      type: '增值税普票', category: '租金', invoiceNo: '12345678',
      invoiceDate: '2026-09-15', amount: 10900, taxRate: 9,
      attachments: [j1.data, j2.data]
    };
    const cr = await dispatch(makeReq('POST', '/api/invoice/invoices', cookie, payload));
    const cj = cr.json() || {};
    chk('新增发票返回 ok=true', cj.ok === true, cj);
    const row = cj.data || {};
    chk('attachments 落库为数组且长度=2', Array.isArray(row.attachments) && row.attachments.length === 2, row.attachments);
    chk('attachments[0].url 保留', !!(row.attachments && row.attachments[0] && row.attachments[0].url), row.attachments && row.attachments[0]);
    chk('税额按含税价税合计反算 900', Math.abs(Number(row.taxAmount) - 900) < 0.01, row.taxAmount);

    // 从数据库重新读一遍（走的是 SELECT，验证 JSON 文本 → 数组的还原）
    const rd = await dispatch(makeReq('GET', '/api/invoice/invoices?keyword=' + encodeURIComponent(code), cookie));
    const list = ((rd.json() || {}).data || {}).list || [];
    chk('搜索能查到该发票', list.length === 1, list.length);
    chk('重读后 attachments 仍是 2 个对象的数组', !!(list[0] && Array.isArray(list[0].attachments) && list[0].attachments.length === 2),
      list[0] && list[0].attachments);

    // 清理
    if (row.id) await dispatch(makeReq('DELETE', '/api/invoice/invoices/' + row.id, cookie));
    const after = await dispatch(makeReq('GET', '/api/invoice/invoices?keyword=' + encodeURIComponent(code), cookie));
    chk('测试发票已删除', (((after.json() || {}).data || {}).list || []).length === 0);
  }

  /* ================= 清理附件与临时文件 ================= */
  globalThis.fetch = realFetch;
  for (const id of [attId1, (j2.data || {}).id, (j3.data || {}).id]) {
    if (id) { try { await db.remove('attachments', id); } catch (e) { } }
  }
  for (const k of [attFile1, (j2.data || {}).key, (j3.data || {}).key]) {
    if (!k) continue;
    const f = path.join(UPLOAD_DIR, path.basename(k));
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { }
  }
  try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch (e) { }

  console.log('\n============================');
  console.log('通过 ' + PASS + ' 项，失败 ' + FAIL + ' 项');
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('测试脚本异常：', e && e.stack || e); process.exit(1); });
