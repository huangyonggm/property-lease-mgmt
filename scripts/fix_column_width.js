'use strict';
/**
 * 线上列宽修正（MySQL/TiDB 不支持 ALTER COLUMN 改类型，走「建新表 → 拷数据 → 换名」）
 *
 * 【为什么需要这个脚本】
 * 附件接七牛云后，attachments.url 存的是**签名 URL**：
 *   http://<七牛绑定域名>/xxx.png?e=1791075451&token=<QINIU_ACCESS_KEY>:<签名>&sign=...
 *   （示例已脱敏：真实 AccessKey/SecretKey 一律走 .env 的 QINIU_ACCESS_KEY / QINIU_SECRET_KEY，不入库）
 * 长度 200~300 字符，而原列宽是 VARCHAR(64) → 上传必然报
 *   Error 1406 (22001): Data too long for column 'url' at row 1
 *
 * 根因：gen_schema.js 是按**本地样本**估列宽的。本地 attachments 只有几条
 * `/uploads/xxx.png` 短路径（20 字符），于是估成 64。
 * 云端一旦接入对象存储，URL 形态完全变了 —— 这类「按本地样本估列宽」的坑
 * 在 TEXT→VARCHAR 迁移时已踩过一次（sessions.ip），这里是同一类问题的第二次。
 *
 * 用法：
 *   node scripts/fix_column_width.js            # 按 WIDTHS 修正
 *   node scripts/fix_column_width.js --check    # 只查不���
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'lib', 'env'));
process.env.DB_MODE = 'cloud';
const { run } = require(path.join(ROOT, 'lib', 'tidb'));

/**
 * 需要放宽的列。
 * 数值是新列宽。原则：宁可给足，也不要在生产上再撞一次 Data Too Long。
 *   url  512 —— 七牛签名 URL 含 domain + key + e + token + sign，实测 200~300
 *   key  255 —— 同上，且 key 里可能带目录前缀
 *   name 255 —— 原始文件名（"2026年10月考勤汇总表(最终版).xlsx" 这类）
 */
const WIDTHS = {
  attachments: { url: 512, key: 255, name: 255 }
};

const BACKUP = path.join(ROOT, 'data', '_migrate_backup');

function esc(id) { return '`' + String(id).replace(/`/g, '``') + '`'; }

/** 从 exports/schema.sql 里抽出某张表的 CREATE 语句 */
function createStmtFromSchema(table) {
  const sql = fs.readFileSync(path.join(ROOT, 'exports', 'schema.sql'), 'utf8');
  const lines = sql.split(/\r?\n/);
  const head = new RegExp('^CREATE TABLE IF NOT EXISTS\\s+`' + table + '`\\s*\\(', 'i');
  const startAt = lines.findIndex(l => head.test(String(l).trim()));
  if (startAt < 0) return null;
  const buf = [String(lines[startAt]).replace(/\r$/, '')];
  for (let i = startAt + 1; i < lines.length; i++) {
    const line = String(lines[i]).replace(/\r$/, '');
    buf.push(line);
    if (/^\)\s*(DEFAULT\b.*)?;\s*$/i.test(line.trim())) return buf.join('\n');
  }
  return null;
}

/** 把 CREATE 语句里的表名换成新表名（用 indexOf+切片，避免正则二次解释） */
function renameTable(stmt, from, to) {
  const marker = '`' + from + '`';
  const at = stmt.indexOf(marker);
  if (at < 0) return stmt;
  return stmt.slice(0, at) + '`' + to + '`' + stmt.slice(at + marker.length);
}

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

(async () => {
  const checkOnly = process.argv.includes('--check');

  for (const table of Object.keys(WIDTHS)) {
    const want = WIDTHS[table];
    console.log('\n=== ' + table + ' ===');

    // 1. 读现状
    const cols = await run('SHOW COLUMNS FROM ' + esc(table), []);
    const cur = {};
    cols.forEach(c => { cur[c.Field] = c.Type; });
    const diff = [];
    for (const k of Object.keys(want)) {
      const m = new RegExp('^varchar\\((\\d+)\\)', 'i').exec(cur[k] || '');
      const have = m ? Number(m[1]) : 0;
      if (have < want[k]) diff.push({ col: k, from: have, to: want[k] });
      else console.log('  ✔ ' + pad(k, 8) + cur[k] + '（已足够）');
    }
    if (!diff.length) { console.log('  无需修改'); continue; }
    diff.forEach(d => console.log('  → ' + pad(d.col, 8) + d.from + ' 需放宽到 ' + d.to));

    if (checkOnly) continue;

    // 2. 备份全量数据
    try {
      fs.mkdirSync(BACKUP, { recursive: true });
      const rows = await run('SELECT * FROM ' + esc(table), []);
      const fp = path.join(BACKUP, table + '.widthfix.json');
      fs.writeFileSync(fp, JSON.stringify(rows, null, 0), 'utf8');
      console.log('  已备份 ' + rows.length + ' 行 → data/_migrate_backup/' + path.basename(fp));
    } catch (e) {
      console.error('  备份失败，中止：', e.message);
      process.exit(1);
    }

    // 3. 拷贝数据到新列宽的表
    const tmp = table + '__wf';
    let stmt = createStmtFromSchema(table);
    if (!stmt) { console.error('  exports/schema.sql 里找不到 ' + table + '，中止'); process.exit(1); }
    stmt = renameTable(stmt, table, tmp);

    await run('DROP TABLE IF EXISTS ' + esc(tmp), []);
    await run(stmt, []);

    const colList = cols.map(c => '`' + c.Field + '`').join(',');
    let copied = false;
    for (let attempt = 0; attempt <= 2 && !copied; attempt++) {
      try {
        await run('INSERT INTO ' + esc(tmp) + ' (' + colList + ') SELECT ' + colList + ' FROM ' + esc(table), []);
        copied = true;
      } catch (e) {
        const m = (e && e.message || '').match(/field len (\d+), data len (\d+)/);
        if (!m || attempt === 2) { console.error('  拷贝失败：', e.message); process.exit(1); }
        // 还有别的列也超宽 —— 提示但不自动改，避免误伤
        console.error('  另一列超宽：' + e.message + '（请在 WIDTHS 里补上）');
        process.exit(1);
      }
    }
    const n = await run('SELECT COUNT(*) c FROM ' + esc(tmp), []);
    console.log('  新表已拷入 ' + n[0].c + ' 行');

    // 4. 换名（只有拷贝成功才执行）
    await run('DROP TABLE ' + esc(table), []);
    await run('RENAME TABLE ' + esc(tmp) + ' TO ' + esc(table), []);
    console.log('  ✔ 已替换');

    // 5. 验证
    const after = await run('SHOW COLUMNS FROM ' + esc(table), []);
    after.forEach(c => { if (want[c.Field] !== undefined) console.log('  验证 ' + pad(c.Field, 8) + c.Type); });
  }

  console.log('\n完成。');
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.message); process.exit(1); });
