'use strict';
/**
 * 由本地 json 数据反推 TiDB 建表脚本 + 字段白名单
 *
 * 用法：
 *   node scripts/gen_schema.js              用本地 data/*.json 估算列宽
 *   node scripts/gen_schema.js --online     以线上 TiDB 的真实数据为准（推荐）
 *
 * 产出：
 *   exports/schema.sql        建表 DDL（40 张表）
 *   exports/schema.json       TABLES / COLS / NUMERIC / INTEGER / JSONS 白名单
 *                             （netlify/functions/api.js 直接 require 这个文件）
 *
 * 设计原则（重要）：
 *   宁可把字段定成宽松的类型，也不能因为类型推断错而丢数据。
 *   财务台账里一条金额变成 '' 或 null 的代价比「列类型不精确」大得多。
 *   因此规则是：
 *     · 数组/对象        → TEXT（读写时 JSON.stringify / parse）
 *     · 同一字段类型混杂 → TEXT
 *     · 全整数           → BIGINT
 *     · 有小数           → DOUBLE
 *     · 布尔             → TINYINT(1)
 *     · 字符串           → VARCHAR(N)（必须可建索引，见下）
 *
 * 为什么字符串必须用 VARCHAR 而不是 TEXT —— 真实教训：
 *   最初所有字符串列都建成 TEXT，结果 **TEXT 列不能建索引**
 *   （MySQL/TiDB 报 Error 1170: BLOB/TEXT column used in key specification
 *   without a key length）。列表页的 ORDER BY / WHERE 只能全表扫描，
 *   实测公网列表接口慢到 30 秒超时。
 *
 * 为什么需要 --online：
 *   列宽是从**样本数据**估的，而本地 data/*.json 的样本天然偏短。
 *   实测 sessions.ip 本地全是 '127.0.0.1'（9 字符）→ 估成 VARCHAR(32)，
 *   而云端真实值是 51 字符的 IPv6+代理链
 *   （'2409:8a4c:...:14e8, 47.128.162.4'）→ 迁移时直接 Data Too Long 失败。
 *   所以列宽必须以线上真实数据为准。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'exports');

function probe() {
  const files = fs.readdirSync(DATA).filter(f => f.endsWith('.json') && f[0] !== '.');
  const out = {};
  for (const f of files) {
    const name = f.replace(/\.json$/, '');
    let a = [];
    try { a = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); }
    catch (e) { console.warn('  跳过解析失败：' + f); continue; }
    if (!Array.isArray(a)) continue;
    const keys = [], types = {}, seen = {};
    for (const r of a) {
      if (!r || typeof r !== 'object') continue;
      for (const k of Object.keys(r)) {
        if (!seen[k]) { seen[k] = 1; keys.push(k); } else seen[k]++;
        const v = r[k];
        let t = (v === null || v === undefined) ? 'null'
          : Array.isArray(v) ? 'array'
            : typeof v === 'object' ? 'object'
              : typeof v;
        (types[k] = types[k] || {})[t] = (types[k][t] || 0) + 1;
      }
    }
    out[name] = { count: a.length, keys, types, rows: a };
  }
  return out;
}

/**
 * 单列可容纳的最大字符数。
 * 依据：utf8mb4 下 VARCHAR(n) 的 n 指「字符数」不是字节数，所以中文不会被截断。
 */
const VARCHAR_MAX = 500;

/**
 * 从样本数据里估一个够用的 VARCHAR 长度。
 * 取实际最大值的 1.4 倍再向上取整到 32 的倍数，留出后续新增数据的余量；
 * 上限 VARCHAR_MAX —— 太长的（如备注、changeLog）仍用 TEXT 更合适。
 *
 * ⚠️ 样本来源的坑（真实踩过）：
 *   样本取自本地 data/*.json，而**云端数据可能比本地更长**。
 *   实测 sessions.ip 在云端存了 IPv6 + 代理链「2409:8a4c:...:14e8, 47.128.162.4」
 *   共 51 字符，而本地样本该字段为空 → 按本地估算成 VARCHAR(32)，
 *   迁移时直接报 Error 1406 Data Too Long。
 *   所以：只要该列在本地样本里「没有非空样本」，一律给足 VARCHAR_MAX，
 *   宁可列宽一点，也不要在迁移时炸掉。
 */
function varcharLen(rows, k, onlineMax) {
  // 优先用线上真实数据的最大长度（--online 模式）
  if (onlineMax && typeof onlineMax[k] === 'number' && onlineMax[k] > 0) {
    const target = Math.min(Math.ceil(onlineMax[k] * 1.4), VARCHAR_MAX);
    return Math.max(32, Math.ceil(target / 32) * 32);
  }
  let max = 0;
  for (const r of rows) {
    const v = r[k];
    if (typeof v !== 'string' || !v.length) continue;
    if (v.length > max) max = v.length;
    if (max >= 2000) break;          // 已超上限，不必再量
  }
  // 本地样本里该列没有任何非空字符串 → 无法判断云端会有多长，给足上限。
  // 注意必须用「非空」判断而不是「样本条数」：data/sessions.json 里 ua 是空串，
  // 样本条数 > 0 但最大长度 = 0，若按条数判断就会估成 VARCHAR(32)，
  // 而云端真实值可能几十上百字符。
  if (max === 0) return VARCHAR_MAX;
  const target = Math.min(Math.ceil(max * 1.4), VARCHAR_MAX);
  return Math.max(32, Math.ceil(target / 32) * 32);
}

/**
 * 从线上 TiDB 读「每列最大字符长度」。
 * 这样列宽就以生产数据的真实情况为准，不会因本地样本偏短而炸迁移。
 */
async function onlineMaxLens() {
  require('../lib/env');
  process.env.DB_MODE = 'cloud';
  const CloudDB = require('../lib/clouddb');
  const { run } = require('../lib/tidb');
  const db = new CloudDB();
  const META = require(path.join(OUT, 'schema.json'));
  const tables = Array.isArray(META.tables) ? META.tables : Object.keys(META.tables || {});
  const out = {};
  let done = 0;
  for (const t of tables) {
    let cols;
    try { cols = await run('SHOW COLUMNS FROM `' + t + '`', []); }
    catch (e) { continue; }
    const textCols = cols.filter(c => /^(text|varchar)/i.test(c.Type)).map(c => c.Field);
    if (!textCols.length) { done++; continue; }
    // 一次问出所有文本列的最大字符长度
    const exprs = textCols.map(c => 'MAX(CHAR_LENGTH(`' + c + '`)) AS `' + c + '`').join(', ');
    try {
      const r = await run('SELECT ' + exprs + ' FROM `' + t + '`', []);
      const row = r[0] || {};
      const m = {};
      textCols.forEach(c => { m[c] = Number(row[c] || 0); });
      out[t] = m;
      done++;
      process.stdout.write('\r  扫描线上数据 ' + done + '/' + tables.length + ' 张表…');
    } catch (e) { /* 表不存在或无数据，跳过 */ }
  }
  process.stdout.write('\n');
  void db;
  return out;
}

function columnType(k, ts, rows, onlineMax) {
  // 数组/对象必须用 TEXT（要存 JSON 文本），这类列也不参与索引
  if (ts.array || ts.object) return { sql: 'TEXT', json: true };
  const real = Object.keys(ts).filter(x => x !== 'null');
  // 类型混杂 → 只能 TEXT（原来也是这样，保持不变）
  if (real.length !== 1) return { sql: 'TEXT', text: true };
  const t0 = real[0];
  if (t0 === 'number') {
    const vals = [];
    for (const r of rows) { if (typeof r[k] === 'number') vals.push(r[k]); if (vals.length >= 80) break; }
    const allInt = vals.every(v => Number.isInteger(v));
    return allInt ? { sql: 'BIGINT', num: true, int: true } : { sql: 'DOUBLE', num: true };
  }
  if (t0 === 'boolean') return { sql: 'TINYINT(1)', bool: true };
  // ---- 字符串：必须用 VARCHAR，不能用 TEXT ----
  // TEXT 列在 MySQL/TiDB 里「不能建索引」（Error 1170: BLOB/TEXT column used in key
  // specification without a key length），导致列表页的 ORDER BY / WHERE 只能全表扫描。
  // 实测这正是云端列表接口慢到 30 秒超时的根因。
  // VARCHAR(utf8mb4) 可建索引，排序过滤都能走索引，且列宽可控。
  if (t0 === 'string') {
    const n = varcharLen(rows, k, onlineMax);
    // 超长文本（备注/日志/变更历史）保留 TEXT，避免无意义的宽索引
    if (n >= VARCHAR_MAX) return { sql: 'TEXT', text: true };
    return { sql: 'VARCHAR(' + n + ')', str: true };
  }
  return { sql: 'TEXT' };
}

async function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const P = probe();
  const tables = Object.keys(P).sort();

  const sql = [];
  const online = process.argv.indexOf('--online') >= 0;
  const onlineLens = online ? await onlineMaxLens() : {};
  sql.push('-- 物业不动产租赁管理系统 · TiDB 建表脚本');
  sql.push('-- 表数 ' + tables.length + '，由 scripts/gen_schema.js 于 ' + new Date().toISOString().slice(0, 10) + ' 自动生成');
  sql.push('-- 列宽估算来源：' + (online ? '线上 TiDB 真实数据（--online）' : '本地 data/*.json 样本'));
  sql.push('-- 字段类型策略：数组/对象/类型混杂 → TEXT；全整数 → BIGINT；有小数 → DOUBLE；布尔 → TINYINT(1)；字符串 → VARCHAR(n)');
  sql.push('-- 字符串必须用 VARCHAR 而非 TEXT：TEXT 不能建索引，会让列表页排序退化为全表扫描');
  sql.push('-- 全部字段对读写双方开放白名单校验，杜绝任意 SQL 注入');
  sql.push('');

  const COLS = {}, NUMERIC = new Set(), INTEGER = new Set(), BOOLS = new Set(), JSONS = new Set(), PK = {};

  /**
   * 主键策略
   * 绝大多数集合用 id；但 sessions 例外 —— 它天然以 token 为主键，数据里没有 id。
   * 若仍强行建 id PRIMARY KEY，插入时会报
   *「Field 'id' doesn't have a default value」，且这��表永远导不进数据。
   */
  const PK_OVERRIDE = { sessions: 'token' };

  for (const t of tables) {
    const { keys, types, rows, count } = P[t];
    const pk = PK_OVERRIDE[t] || 'id';
    const cols = [];
    if (keys.indexOf(pk) >= 0) {
      cols.push({ k: pk, sql: 'VARCHAR(128) NOT NULL' });
    } else {
      cols.push({ k: pk, sql: 'VARCHAR(128) NOT NULL' });
    }
    for (const k of keys) {
      if (k === pk) continue;
      if (k === 'id' && pk !== 'id') continue;   // sessions 丢弃无主键的 id
      const info = columnType(k, types[k] || {}, rows, onlineLens[t]);
      cols.push({ k, sql: info.sql });
      if (info.num) { NUMERIC.add(k); if (info.int) INTEGER.add(k); }
      if (info.bool) BOOLS.add(k);
      if (info.json) JSONS.add(k);
    }
    sql.push('CREATE TABLE IF NOT EXISTS `' + t + '` (');
    sql.push(cols.map(c => '  `' + c.k + '` ' + c.sql + (c.k === pk ? ' PRIMARY KEY' : '')).join(',\n'));
    sql.push(') DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;');
    sql.push('');
    COLS[t] = cols.map(c => c.k);
    PK[t] = pk;
  }

  const meta = {
    tables,
    cols: COLS,
    pk: PK,
    numeric: Array.from(NUMERIC),
    integer: Array.from(INTEGER),
    bool: Array.from(BOOLS),
    json: Array.from(JSONS),
    counts: tables.reduce((m, t) => { m[t] = P[t].count; return m; }, {})
  };

  fs.writeFileSync(path.join(OUT, 'schema.sql'), sql.join('\n'), 'utf8');
  fs.writeFileSync(path.join(OUT, 'schema.json'), JSON.stringify(meta, null, 1), 'utf8');

  console.log('表数        : ' + tables.length);
  console.log('总记录      : ' + tables.reduce((s, t) => s + P[t].count, 0));
  console.log('数值列      : ' + NUMERIC.size + '（其中整数列 ' + INTEGER.size + '）');
  console.log('JSON 序列化列: ' + JSONS.size + ' 个字段，涉及 ' + tables.filter(t => COLS[t].some(c => {
    const info = columnType(c, P[t].types[c] || {}, P[t].rows);
    return info.json;
  })).length + ' 张表');
  console.log('产出        : exports/schema.sql, exports/schema.json');
}

// main 改成 async 后必须 catch：--online 模式会连库，不 catch 会变成
// 未捕获 Promise  rejection，报错信息还很难读
main().catch(e => { console.error('生成失败：', e && e.message || e); process.exit(1); });