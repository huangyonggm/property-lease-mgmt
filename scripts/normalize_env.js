'use strict';
/*
 * .env 规范化：把「行内注释」提到上一行，避免 systemd EnvironmentFile 把注释当值。
 *
 * 【为什么需要】
 * /etc/systemd/system/wuye.service 用了 EnvironmentFile=/opt/wuye/.env。
 * systemd **不剥行内注释**，于是：
 *     QINIU_DOMAIN=tmcv69nvd.hd-bkt.clouddn.com    # 七牛默认域名…
 * 注入进程后变成
 *     QINIU_DOMAIN = "tmcv69nvd.hd-bkt.clouddn.com    # 七牛默认域名…"
 * 而 lib/env.js 只在「变量未定义」时写入，脏值反而胜出 →
 * 附件 URL 被拼成 `https://<域名>   # 注释/key`，预览失效；
 * QINIU_URL_EXPIRE 同理变成 "3600   # …"，Number() 得 NaN，签名 URL 失效。
 *
 * 规则（与 lib/env.js 完全一致，确保两边解析结果相同）：
 *   - 仅当值未被引号包裹时，按第一个 ` #` 切分
 *   - 注释内容移到该行**上一行**，写成 `# …`（systemd 与 lib/env.js 都会忽略整行）
 *   - 备份为 .env.bak.<时间戳>
 *
 * 用法: node scripts/normalize_env.js [.env 路径]
 */
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || path.join(__dirname, '..', '.env');
if (!fs.existsSync(target)) { console.log('未找到 ' + target); process.exit(1); }

const text = fs.readFileSync(target, 'utf8');
const lines = text.split(/\r?\n/);
const out = [];
let changed = 0;

lines.forEach((line) => {
  const s = line.trim();
  const m = s.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) { out.push(line); return; }
  const key = m[1];
  const raw = m[2];
  let val = raw.trim();
  let comment = '';
  if (val.startsWith('#')) {
    // KEY=          # 说明文字   → 整行都是注释，值留空
    comment = val;
    val = '';
  } else if (val[0] !== '"' && val[0] !== "'") {
    const h = val.indexOf(' #');
    if (h >= 0) { comment = val.slice(h + 1).trim(); val = val.slice(0, h).trim(); }
  }
  if (comment) {
    out.push('# ' + comment.replace(/^#+\s*/, ''));
    out.push(key + '=' + val);
    changed++;
    console.log('  规范化 ' + key + '：' + (val ? '剥掉行内注释（注释已上移）值长度=' + val.length : '整行为注释，值置空'));
  } else {
    // 无注释的行原样保留，避免误改含 # 的值（如密码）
    out.push(line);
  }
});

// 收尾：去掉结尾多余空行，保证以单个换行结束
while (out.length && out[out.length - 1].trim() === '') out.pop();

const bak = target + '.bak.' + Date.now();
fs.copyFileSync(target, bak);
fs.writeFileSync(target, out.join('\n') + '\n');
try { fs.chmodSync(target, 0o600); } catch (e) {}

console.log('[normalize_env] 共规范化 ' + changed + ' 行；备份 → ' + bak);
console.log('[normalize_env] 新文件 ' + fs.statSync(target).size + ' 字节，' + out.length + ' 行');
