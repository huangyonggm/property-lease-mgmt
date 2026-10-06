'use strict';
/*
 * 腾讯云 OCR 凭据 + 发票识别 真机探针
 * 用法: node scripts/probe_tencent_ocr.js <发票文件路径> [credentials.env]
 * 凭据优先级: 命令行给的 env 文件 > 已存在的 process.env
 */
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const credFile = process.argv[3] || 'C:/putty/_tencent_ocr.env';

if (!file) { console.log('用法: node scripts/probe_tencent_ocr.js <发票文件> [凭据文件]'); process.exit(1); }

// 1) 载入凭据
if (fs.existsSync(credFile)) {
  const txt = fs.readFileSync(credFile, 'utf8');
  txt.split(/\r?\n/).forEach(line => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[2]) process.env[m[1]] = m[2];
  });
  console.log('[1] 已从' + credFile + '载入凭据');
} else {
  console.log('[1] 未找到凭据文件，使用环境变量');
}
const sid = process.env.TENCENT_SECRET_ID || '';
const skey = process.env.TENCENT_SECRET_KEY || '';
const region = process.env.TENCENT_OCR_REGION || '(未设，默认 ap-guangzhou)';
console.log('    TENCENT_SECRET_ID  长度=' + sid.length + ' 前6位=' + sid.slice(0, 6) + '…');
console.log('    TENCENT_SECRET_KEY 长度=' + skey.length);
console.log('    TENCENT_OCR_REGION = ' + region);

if (!sid || !skey) { console.log('\n❌ 凭据为空，无法探测'); process.exit(2); }

// 2) 读文件
if (!fs.existsSync(file)) { console.log('\n❌ 文件不存在: ' + file); process.exit(3); }
const buf = fs.readFileSync(file);
const ext = path.extname(file).toLowerCase();
const mime = ext === '.pdf' ? 'application/pdf'
           : ext === '.png' ? 'image/png'
           : 'image/jpeg';
console.log('\n[2] 测试文件: ' + path.basename(file));
console.log('    大小=' + (buf.length / 1024).toFixed(1) + 'KB  mime=' + mime);

const OCR = require('../lib/ocr.js');

(async () => {
  console.log('\n[3] 调用 recognizeVatInvoice ...');
  const t0 = Date.now();
  let r;
  try {
    r = await OCR.recognizeVatInvoice(buf, mime, path.basename(file), {
      secretId: sid, secretKey: skey
    });
  } catch (e) {
    console.log('    ❌ 抛异常: ' + e.message);
    process.exit(4);
  }
  const ms = Date.now() - t0;
  console.log('    耗时 ' + ms + 'ms');
  console.log('    原始返回: ' + JSON.stringify(r, null, 2).slice(0, 1500));
  console.log('\n[4] 结论');
  if (r && r.ok) {
    console.log('    ✅ 凭据有效，识别成功');
    const d = r.data || {};
    const keys = Object.keys(d);
    console.log('    识别字段: ' + (keys.length ? keys.join(', ') : '(空)'));
    keys.forEach(k => console.log('      ' + k + ' = ' + JSON.stringify(d[k])));
  } else {
    const msg = (r && (r.msg || r.error)) || '(无)';
    console.log('    ❌ 失败: ' + msg);
    if (/AuthFailure|Signature|SecretIdNotFound|InvalidSecretId/i.test(msg)) {
      console.log('    → 判定: 凭据本身无效/被禁用');
    } else if (/未配置/.test(msg)) {
      console.log('    → 判定: 代码没读到凭据（参数未生效）');
    } else {
      console.log('    → 判定: 凭据可通过鉴权（否则会报 AuthFailure），失败原因见上');
    }
  }
})();
