'use strict';
/**
 * 把线上 TiDB 的 TEXT 列改成 VARCHAR（可建索引），并为高频排序字段建索引。
 *
 * ═══ 为什么必须做这件事 ═══
 * 最初的建表脚本（scripts/gen_schema.js）把**所有字符串列都建成 TEXT**，
 * 造成两个严重后果：
 *
 *   1. TEXT 列**不能建索引**（MySQL/TiDB 报 Error 1170
 *      "BLOB/TEXT column used in key specification without a key length"）。
 *      于是列表页的 ORDER BY / WHERE 只能全表扫描 + filesort。
 *   2. TEXT 的排序走 utf8mb4_bin 字节序，中文排序结果不符合业务预期。
 *
 * 实测（公网真实环境）：
 *   一次合同列表请求，共享缓存冷时发 68 条 SQL / 4583ms；
 *   缓存热时只发 1 条 / 166ms —— 差 27 倍。
 *   而 page() 本身的单条 SQL 只要 90~213ms，慢的根因是全表扫描 + 无索引排序。
 *
 * ═══ 怎么做 ═══
 * MySQL/TiDB 不支持 ALTER COLUMN 改类型，采用「建新表 → 拷数据 → 换名」：
 *   1. 按新 schema 建 `<表名>__new`
 *   2. INSERT ... SELECT 从旧表拷数据
 *   3. DROP 旧表，RENAME 新表
 *   4. 建索引
 *
 * 风险控制：
 *   - 逐表执行，任一步失败立即停，绝不继续破坏后续表
 *   - 全程只读旧表 + 写新表，旧数据在 RENAME 前始终完好
 *   - 迁移前自动备份该表全部行到本地 data/_migrate_backup_<表>.json
 *
 * 用法：
 *   node scripts/alter_text_to_varchar.js            # 预演，不改库
 *   node scripts/alter_text_to_varchar.js --apply     # 真执行
 */
require('../lib/env');
process.env.DB_MODE = 'cloud';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { run } = require('../lib/tidb');
const CloudDB = require('../lib/clouddb');

const APPLY = process.argv.indexOf('--apply') >= 0;
const BACKUP_DIR = path.join(ROOT, 'data', '_migrate_backup');

const esc = s => '`' + String(s).replace(/`/g, '``') + '`';

/** 读出当前线上某张表的结构 */
async function showColumns(table) {
  const r = await run('SHOW COLUMNS FROM ' + esc(table), []);
  return r.map(x => ({
    field: x.Field,
    type: x.Type,
    null: x.Null === 'YES',
    key: x.Key
  }));
}

/** 该列是否需要从 TEXT 改成 VARCHAR（只处理纯 text 类型） */
function needVarchar(col) {
  return /^text$/i.test(col.type.trim());
}

/**
 * 从 schema.sql 里取出某张表的「列名 → SQL 类型」映射。
 * 用按行解析而不是正则匹配整个 CREATE TABLE —— 正则要处理反引号/换行/转义，
 * 实测很容易踩坑（esc() 产生的双反引号与文件实际内容不匹配，导致整表匹配失败）。
 */
function newTypesFromSchema(table) {
  const sql = fs.readFileSync(path.join(ROOT, 'exports', 'schema.sql'), 'utf8');
  const lines = sql.split(/\r?\n/);
  const startAt = lines.findIndex(l =>
    new RegExp('^CREATE TABLE IF NOT EXISTS\\s+`' + table + '`\\s*\\(', 'i').test(l.trim()));
  if (startAt < 0) return null;
  const out = {};
  for (let i = startAt + 1; i < lines.length; i++) {
    const line = String(lines[i]).replace(/\r$/, '').trim();
    // 结尾形态有两种：');' 与 ') DEFAULT CHARSET=utf8mb4 ...;'
    if (/^\)\s*(DEFAULT\b.*)?;\s*$/i.test(line)) break;
    const c = line.match(/^`([^`]+)`\s+([A-Za-z]+(?:\([^)]*\))?)/);
    if (c) out[c[1]] = c[2];
  }
  return out;
}

/**
 * 取 schema.sql 里某张表的完整建表语句（按行定位，避免正则匹配整块内容）。
 *
 * 实测踩过的三个坑：
 *   1. 文件是 CRLF 换行，不去掉 \r 则 `line.trim() === ');'` 永不成立，
 *      循环会跑到文件末尾拼出残缺 SQL（报 parser 语法错误）。
 *   2. 结尾不是 `);` 而是 `) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;`，
 *      只认 `);` 会漏。
 *   3. 表名替换用 replace + '$1' 会被反引号/替换符二次解释，改用 indexOf + 切片。
 */
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
    // 命中任一结尾形态即收尾：');' 或 ') DEFAULT CHARSET=...;'
    if (/^\)\s*(DEFAULT\b.*)?;\s*$/i.test(line.trim())) return buf.join('\n');
  }
  return null;   // 没找到正常结尾 → 解析失败，宁可不做也不能拼出残缺 SQL
}

/** 某表某列的 SQL 类型（来自 schema.sql） */
const _typeCache = {};
function typeOf(table, col) {
  const k = table + '.' + col;
  if (!_typeCache[k]) {
    const m = newTypesFromSchema(table);
    _typeCache[k] = (m && m[col]) || 'VARCHAR(255)';
  }
  return _typeCache[k];
}

/**
 * 用「放宽后的列宽」重建建表语句。
 * @param colsToWiden 需要放宽的列名数组
 * @param width 新的 VARCHAR 宽度
 */
function buildStmt(table, tmpName, overrides) {
  const stmt = createStmtFromSchema(table);
  if (!stmt) throw new Error('schema.sql 里找不到建表语句');
  const lines = stmt.split('\n');
  const out = lines.map(line => {
    const c = String(line).trim().match(/^`([^`]+)`\s+VARCHAR\(\d+\)/);
    if (!c) return line;
    const col = c[1];
    const w = (overrides && overrides[col]) || typeOf(table, col);
    return line.replace(/VARCHAR\(\d+\)/, w);
  });
  let s = out.join('\n');
  const at = s.indexOf('`' + table + '`');
  if (at < 0) throw new Error('建表语句里找不到表名 ' + table);
  s = s.slice(0, at) + '`' + tmpName + '`' + s.slice(at + table.length + 2);
  return s;
}

/**
 * 找出实际数据超长的列，并给出放宽后的类型。
 * 直接问数据库「每列最大字符长度」，比逐列试探快得多。
 *
 * 若一条超长列都没找到（理论上不该发生，报错信息可能不含列名），
 * 就把所有 VARCHAR 列统一放宽到 atLeast —— 宁可列宽大一点，也不能卡在这里。
 */
async function widenLongColumns(table, commonCols, atLeast) {
  const overrides = {};
  try {
    const exprs = commonCols.map(c => 'MAX(CHAR_LENGTH(`' + c + '`)) AS `' + c + '`').join(', ');
    const r = await run('SELECT ' + exprs + ' FROM ' + esc(table), []);
    const row = r[0] || {};
    for (const c of commonCols) {
      const maxLen = Number(row[c] || 0);
      const cur = String(typeOf(table, c));
      const curN = Number((cur.match(/VARCHAR\((\d+)\)/) || [])[1] || 0);
      if (maxLen > curN) {
        const target = Math.min(Math.max(Math.ceil(maxLen * 1.4), atLeast, 64), 1000);
        const rounded = Math.ceil(target / 32) * 32;
        overrides[c] = 'VARCHAR(' + rounded + ')';
        console.log('    · 列 ' + c + ' 实际最长 ' + maxLen + ' 字符 → 放宽到 VARCHAR(' + rounded + ')');
      }
    }
  } catch (e) {
    console.log('    · 探测超长列失败（' + e.message.slice(0, 40) + '），改为统一放宽');
  }
  // 兜底：一列都没放宽 → 全部 VARCHAR 列统一放到 atLeast
  if (!Object.keys(overrides).length) {
    for (const c of commonCols) {
      if (/^varchar/i.test(String(typeOf(table, c)))) {
        overrides[c] = 'VARCHAR(' + Math.min(Math.max(atLeast, 64), 1000) + ')';
      }
    }
    console.log('    · 未能定位具体列，' + Object.keys(overrides).length + ' 个 VARCHAR 列统一放宽');
  }
  return overrides;
}

(async () => {
  const db = new CloudDB();
  // schema.json 的 tables 是「数组」，必须直接用；Object.keys 会得到索引 0..n
  const META = require(path.join(ROOT, 'exports', 'schema.json'));
  const tables = Array.isArray(META.tables) ? META.tables.slice() : Object.keys(META.tables || {});

  console.log('目标：把线上 TEXT 列改为 VARCHAR 并建索引');
  console.log('模式：' + (APPLY ? '【真执行】' : '【预演，加 --apply 才改库】'));
  console.log('');

  const plan = [];
  for (const t of tables) {
    let cols;
    try { cols = await showColumns(t); }
    catch (e) { console.log('  跳过 ' + t + '：' + e.message.slice(0, 50)); continue; }

    const newT = newTypesFromSchema(t);
    if (!newT) { console.log('  跳过 ' + t + '：schema.sql 里没有该表'); continue; }

    const toFix = cols.filter(c => needVarchar(c) && /^varchar/i.test(newT[c.field] || ''));
    if (!toFix.length) continue;
    plan.push({ table: t, toFix: toFix.map(c => c.field), newT: newT, cols: cols });
  }

  console.log('需要改结构的表：' + plan.length + ' 张\n');
  let totalCols = 0;
  plan.forEach(p => {
    totalCols += p.toFix.length;
    console.log('  ' + p.table.padEnd(16) + p.toFix.length + ' 列：' + p.toFix.slice(0, 6).join(', ') +
      (p.toFix.length > 6 ? ' …' : ''));
  });
  console.log('\n合计 ' + totalCols + ' 列要从 TEXT 改成 VARCHAR');
  if (!APPLY) {
    console.log('\n这是预演。加 --apply 执行实际迁移。');
    return;
  }

  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  console.log('\n=== 开始迁移 ===\n');
  let done = 0;
  for (const p of plan) {
    const t = p.table;
    try {
      // ① 备份（表结构 + 全量数据），出错时人工可恢复
      const rows = await db.all(t);
      const bk = path.join(BACKUP_DIR, t + '.json');
      fs.writeFileSync(bk, JSON.stringify(rows, null, 0), 'utf8');

      // ② 建新表（用 schema.sql 的新定义：VARCHAR）
      const tmp = t + '__new';
      await run('DROP TABLE IF EXISTS ' + esc(tmp), []);
      await run(buildStmt(t, tmp), []);

      // ③ 拷数据：只搬新旧表都有的列（避免类型/列数不匹配）
      const newCols = Object.keys(p.newT);
      const oldCols = p.cols.map(c => c.field);
      const common = newCols.filter(c => oldCols.indexOf(c) >= 0);
      if (!common.length) throw new Error('没有可共有的列');
      const colList = common.map(esc).join(', ');
      // 拷贝时可能遇到 Data Too Long：说明本地样本估的列宽不够（本地 data/*.json
      // 比云端短，例如 sessions.ip 在云端是 51 字符的 IPv6+代理链，本地样本为空）。
      // 策略：自动把出问题的列放宽到 VARCHAR(500) 再重建新表重试一次，
      // 而不是让整个迁移失败 —— 迁移卡在一张表上会阻塞后面所有表。
      let copied = false;
      for (let attempt = 0; attempt <= 2 && !copied; attempt++) {
        try {
          await run('INSERT INTO ' + esc(tmp) + ' (' + colList + ') SELECT ' + colList + ' FROM ' + esc(t), []);
          copied = true;
        } catch (e) {
          const m = (e && e.message || '').match(/field len (\d+), data len (\d+)/);
          if (!m || attempt === 2) throw e;
          const need = Math.min(Number(m[2]) + 64, 1000);
          console.log('    · 列宽不足（data len ' + m[2] + '），放宽到 ' + need + ' 后重试');
          // 找出具体是哪一列：逐列比对长度
          await run('DROP TABLE IF EXISTS ' + esc(tmp), []);
          const widened = widenLongColumns(t, common, need);
          await run(buildStmt(t, tmp, widened), []);
        }
      }

      // ④ 换名
      await run('DROP TABLE ' + esc(t), []);
      await run('RENAME TABLE ' + esc(tmp) + ' TO ' + esc(t), []);

      done++;
      console.log('  ✔ ' + t.padEnd(16) + common.length + ' 列已迁移（备份 ' + rows.length + ' 行）');
    } catch (e) {
      console.log('  ✘ ' + t.padEnd(16) + '失败：' + e.message.slice(0, 80));
      console.log('    该表旧数据未被改动（DROP 只在拷贝成功后才执行）');
      process.exit(1);   // 任一表失败即停，避免连锁破坏
    }
  }
  console.log('\n成功迁移 ' + done + ' / ' + plan.length + ' 张表');
  console.log('备份目录：' + BACKUP_DIR);
  console.log('\n下一步：node scripts/tidb_add_indexes.js');
  process.exit(0);
})().catch(e => { console.error('异常：', e && e.stack || e); process.exit(1); });
