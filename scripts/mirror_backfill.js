'use strict';
/**
 * 把存量附件从七牛回填到「本地镜像」目录。
 *
 * 【为什么要单独跑一次】
 * 镜像只在 `AttStore.put()` 里双写，也就是**开启镜像之后新上传的才有**；
 * 之前已经存在七牛里的老附件，本地是空的。要么等它们被访问时自动回填
 * （`read()` 回源成功会顺手写镜像），要么用这个脚本一次性全量补齐。
 * 想确认「七牛真出事时我手里到底有没有全量备份」，就得跑这个。
 *
 * 【用法】
 *   本地：  node scripts/mirror_backfill.js
 *   服务器：cd /opt/wuye && ATT_MIRROR_DIR=/opt/wuye/att-mirror node scripts/mirror_backfill.js
 *   加 --dry 只看会做什么，不写文件
 *
 * 凭据从 `.env` 读取（ATT_STORAGE=qiniu / QINIU_* / QINIU_DOMAIN）。
 * **只读七牛、只写镜像目录，不改动任何业务数据文件。**
 */
require('../lib/env');            // 自动加载 .env（已存在的环境变量优先，不会被覆盖）
const fs = require('fs');
const path = require('path');
const { AttStore, useQiniu, mirrorBase } = require('../lib/attstore');

const DRY = process.argv.indexOf('--dry') >= 0;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));

function human(b) {
  if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

(async () => {
  console.log('===== 附件本地镜像回填 =====');
  console.log('  模式        ：' + (useQiniu() ? 'qiniu（主存储=七牛云）' : 'local（本机 uploads/，无需镜像）'));
  console.log('  镜像目录    ：' + (mirrorBase() || '(未设置 ATT_MIRROR_DIR)'));
  console.log('  数据目录    ：' + DATA_DIR + (DRY ? '   [DRY-RUN：只报告不写入]' : ''));

  if (!useQiniu()) {
    console.log('\n  当前不是七牛模式，本地就是主存储，无需回填。退出。');
    return;
  }
  if (!mirrorBase()) {
    console.log('\n  未设置 ATT_MIRROR_DIR，镜像未启用。请先设置后再跑（例如：');
    console.log('    ATT_MIRROR_DIR=/opt/wuye/att-mirror node scripts/mirror_backfill.js ）');
    process.exit(2);
  }

  const file = path.join(DATA_DIR, 'attachments.json');
  if (!fs.existsSync(file)) {
    console.log('\n  找不到 ' + file + '，无法回填。');
    process.exit(2);
  }

  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.log('\n  attachments.json 解析失败：' + e.message); process.exit(2); }

  const store = new AttStore(path.resolve(process.env.UPLOAD_DIR || path.join(ROOT, 'uploads')));

  // 只处理「有 key 且主存储在七牛」的记录；本地记录本来就在本机，不属于回填范围
  const targets = list.filter(a => a && typeof a.key === 'string' && a.key && (a.storage === 'qiniu' || !a.storage));
  console.log('  附件记录    ：' + list.length + ' 条，其中需回填 ' + targets.length + ' 条\n');

  let okN = 0, skipN = 0, failN = 0, bytes = 0;
  const fails = [];

  for (const a of targets) {
    const mf = store.mirrorPath(a.key);
    if (mf && fs.existsSync(mf)) {
      let sz = 0; try { sz = fs.statSync(mf).size; } catch (e) { }
      skipN++; bytes += sz;
      console.log('  [已有] ' + a.key + '  ' + human(sz));
      continue;
    }
    if (DRY) { console.log('  [待写] ' + a.key + '  ' + human(a.size || 0)); okN++; continue; }
    try {
      // read() 会先查镜像（此时必然 miss）→ 回源七牛 → 顺手写镜像
      const buf = await store.read(a.key);
      if (!buf || !buf.length) throw new Error('取回内容为空');
      okN++; bytes += buf.length;
      const sizeNote = (a.size && buf.length !== a.size) ? '  ⚠ 大小与记录不符（记录 ' + a.size + '）' : '';
      console.log('  [回填] ' + a.key + '  ' + human(buf.length) + sizeNote);
    } catch (e) {
      failN++; fails.push(a.key + ' → ' + (e && e.message));
      console.log('  [失败] ' + a.key + '  ' + (e && e.message));
    }
  }

  const st = store.mirrorStats();
  console.log('\n===== 结果 =====');
  console.log('  回填成功 ' + okN + ' / 已存在 ' + skipN + ' / 失败 ' + failN);
  console.log('  本次涉及字节 ' + human(bytes));
  if (st) console.log('  镜像目录当前 ' + st.files + ' 个文件，共 ' + human(st.bytes) + '（' + st.dir + '）');
  if (fails.length) {
    console.log('  失败明细：');
    fails.forEach(f => console.log('    - ' + f));
  }
  process.exit(failN ? 1 : 0);
})().catch(e => { console.log('脚本异常：' + (e && e.stack || e)); process.exit(3); });
