'use strict';
/**
 * 七牛云配置与区域解析回归测试
 *
 * 【为什么有这个脚本】
 * 1. zone 键名坑：SDK 的 qiniu.zone 用 `Zone_z2` 而不是 `z2`，
 *    写成 qiniu.zone['z2'] 会得到 undefined → 区域静默失效。
 *    之前上传成功纯属侥幸（七牛会自动重定向），但 delete/acl 走 rsHost 会挂。
 * 2. 私有读语义：`getBucketInfo` 返回体里 **`private: 1` 才是私有读标志**，
 *    `protected` 是另一个不相关的字段（恒为 0）。曾因看 protected 误判
 *    「私有读没生效」，白跑一趟控制台。
 * 3. 协议降级：默认域名证书 altnames 只有 *.ctcdn.cn，HTTPS 必然失败。
 *
 * 用法：node scripts/test_qiniu_config.js
 * 只做静态/配置层校验，不需要网络；加 --live 会真连七牛验证读写。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'lib', 'env'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✘ ' + name + (extra ? '  ' + extra : '')); }
}

// ---------- 1. zone 键名 ----------
console.log('\n=== 1. 存储区域 zone 键名（曾静默失效的坑）===');
const qiniu = require('qiniu');
console.log('  SDK zone 表实际键名: ' + Object.keys(qiniu.zone).join(', '));

// 从 attstore 里抠出 zoneOf 与 REGION_MAP 复测，避免测试自己写一份假实现
const src = require('fs').readFileSync(path.join(ROOT, 'lib', 'attstore.js'), 'utf8');
const mapMatch = /const REGION_MAP = (\{[^}]*\})/.exec(src);
ok('attstore.js 里存在 REGION_MAP', !!mapMatch);
if (mapMatch) {
  const MAP = eval('(' + mapMatch[1] + ')');
  Object.keys(MAP).forEach(r => {
    const k = MAP[r];
    ok('区域 ' + r + ' -> ' + k, !!qiniu.zone[k],
      qiniu.zone[k] ? ('ioHost=' + qiniu.zone[k].ioHost) : 'SDK 里不存在此键');
  });
  ok('MAP 值全部使用 Zone_ 前缀', Object.values(MAP).every(v => /^Zone_/.test(v)));
}

// ---------- 2. .env 配置完整性 ----------
console.log('\n=== 2. .env 七牛配置 ===');
const need = ['QINIU_ACCESS_KEY', 'QINIU_SECRET_KEY', 'QINIU_BUCKET', 'QINIU_DOMAIN', 'QINIU_REGION'];
need.forEach(k => ok(k + ' 已配置', !!process.env[k],
  k === 'QINIU_SECRET_KEY' ? '(已隐藏)' : (process.env[k] || '')));
ok('ATT_STORAGE=qiniu', String(process.env.ATT_STORAGE).toLowerCase() === 'qiniu');
ok('QINIU_PRIVATE=1（私有桶走签名 URL）', String(process.env.QINIU_PRIVATE) === '1');

// ---------- 3. 签名 URL 长度 vs 数据库列宽 ----------
console.log('\n=== 3. 签名 URL 长度必须小于 attachments.url 列宽 ===');
const mac = new qiniu.auth.digest.Mac(process.env.QINIU_ACCESS_KEY || 'ak', process.env.QINIU_SECRET_KEY || 'sk');
const cfg = new qiniu.conf.Config();
const bm = new qiniu.rs.BucketManager(mac, cfg);
const sample = bm.privateDownloadUrl('http://' + (process.env.QINIU_DOMAIN || 'x.example.com'),
  '2026/10/a-fairly-long-realistic-file-name-for-estimation.png',
  Math.floor(Date.now() / 1000) + 3600);
console.log('  样例签名 URL 长度 = ' + sample.length + ' 字符');
ok('长度 < 512（与 fix_column_width.js 的列宽一致）', sample.length < 512);
ok('含签名参数 e= 与 token=', /[?&]e=\d+/.test(sample) && /[?&]token=/.test(sample));

// ---------- 4. 区域一致性实测（--live 才查）----------
// 【为什么要实测】QINIU_REGION 写错时，upload 会因七牛自动重定向而侥幸成功，
// 掩盖问题；但 stat / delete / 改 ACL 走 rsHost，会直接报
// error_code=IncorrectZone。必须真实探一次。
console.log('\n=== 4. 空间真实区域 vs QINIU_REGION（--live）===');
if (process.argv.includes('--live')) {
  const bm = new qiniu.rs.BucketManager(mac, new qiniu.conf.Config());
  const ZONES = ['Zone_z0', 'Zone_z1', 'Zone_z2', 'Zone_na0', 'Zone_as0'];
  (async () => {
    // 用一个几乎不可能存在的 key 探：返回 "no such file" 说明区域对了，
    // 返回 "incorrect zone" 说明区域错了。
    const probe = '__zone_probe__' + Date.now() + '.txt';
    let real = null;
    for (const zk of ZONES) {
      const c = new qiniu.conf.Config();
      c.zone = qiniu.zone[zk];
      const b = new qiniu.rs.BucketManager(mac, c);
      const r = await new Promise(res => b.stat(process.env.QINIU_BUCKET, probe, (e, s) => res(s || e)));
      const txt = JSON.stringify(r || {});
      if (!/incorrect zone/i.test(txt)) { real = zk.replace('Zone_', ''); break; }
    }
    ok('探测到空间真实区域 = ' + real, !!real);
    ok('QINIU_REGION 与实际一致（当前 ' + process.env.QINIU_REGION + '）',
      real === process.env.QINIU_REGION,
      real === process.env.QINIU_REGION ? '' : ('实际是 ' + real + '，需改 .env 与 Netlify 环境变量'));
  })().then(checkWidths).catch(e => { console.log('  ✘ 探测失败: ' + e.message); checkWidths(); });
} else {
  console.log('  （跳过，加 --live 才会连云端核对）');
  checkWidths();
}

function checkWidths() {
  console.log('\n=== 5. 云端 attachments 列宽 ===');
  if (!process.argv.includes('--live')) {
    console.log('  （跳过）');
    return done();
  }
  process.env.DB_MODE = 'cloud';
  const { run } = require(path.join(ROOT, 'lib', 'tidb'));
  run('SHOW COLUMNS FROM `attachments`', []).then(cols => {
    const w = {};
    cols.forEach(c => { w[String(c.Field).toLowerCase()] = c.Type; });
    ok('url   >= varchar(512)', /varchar\((\d+)\)/.test(w.url || '') && +w.url.match(/\d+/)[0] >= 512, w.url);
    ok('key   >= varchar(255)', /varchar\((\d+)\)/.test(w.key || '') && +w.key.match(/\d+/)[0] >= 255, w.key);
    ok('name  >= varchar(255)', /varchar\((\d+)\)/.test(w.name || '') && +w.name.match(/\d+/)[0] >= 255, w.name);
    done();
  }).catch(e => { console.log('  ✘ 云端查询失败: ' + e.message); done(); });
}

function done() {
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}
