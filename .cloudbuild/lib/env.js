/**
 * 极简 .env 加载器（零依赖）。
 *
 * 为什么需要：
 *   云端部署时环境变量由 Netlify 注入，但本地要连 TiDB 做验证时没有这些变量。
 *   不加载 .env 的话，本地一跑 lib/clouddb 就报「DATABASE_URL 未配置」，
 *   没法在提交云端之前先验证一遍云端逻辑。
 *
 * 规则：
 *   - 只在「变量尚未存在」时写入，绝不覆盖已有的真实环境变量
 *     （Netlify/命令行传进来的优先级最高）
 *   - 已存在的进程不会被重复 require，所以 require 缓存天然保证只解析一次
 *   - 支持 # 注释、export KEY=VALUE 前缀、空行
 */
'use strict';
const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  const p = file || path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return false;
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return false; }

  let n = 0;
  text.split(/\r?\n/).forEach(line => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const m = s.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return;
    const key = m[1];
    let val = m[2].trim();
    // 去掉行尾注释（仅当值未被引号包裹时，避免误删 URL 里的 #）
    if (val[0] !== '"' && val[0] !== "'") {
      const hash = val.indexOf(' #');
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    // 剥掉成对的引号
    if ((val[0] === '"' && val[val.length - 1] === '"') ||
        (val[0] === "'" && val[val.length - 1] === "'")) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) { process.env[key] = val; n++; }
  });
  return n;
}

const loaded = loadEnv(process.env.ENV_FILE || undefined);
if (loaded) console.log('[env] 已从 .env 载入 ' + loaded + ' 个变量');
else if (process.env.ENV_QUIET !== '1') console.log('[env] 未找到 .env（云端部署由 Netlify 注入，无需此文件）');

module.exports = { loadEnv };