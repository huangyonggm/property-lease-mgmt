'use strict';
/**
 * 建表 + 数据迁移：本地 data/*.json → TiDB Cloud
 *
 * 用法：
 *   node scripts/migrate_to_cloud.js --schema     只建表
 *   node scripts/migrate_to_cloud.js --data       只导数据（表已存在）
 *   node scripts/migrate_to_cloud.js --all        建表 + 导数据
 *   node scripts/migrate_to_cloud.js --check      只连库做连通性自检
 *
 * 幂等：表用 CREATE TABLE IF NOT EXISTS；数据按 id 主键 upsert，
 *       同一份数据重复导不会产生重复行。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// 读 .env（不引第三方 dotenv，手写解析）
function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!m) return;
    let v = m[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  });
}
loadEnv();

const { run, scalar, ping, parseDbUrl } = require('../lib/tidb');
const META = require(path.join(ROOT, 'exports', 'schema.json'));
const DATA = path.join(ROOT, 'data');

const args = process.argv.slice(2);
const has = k => args.indexOf(k) >= 0;

async function createSchema() {
  const sql = fs.readFileSync(path.join(ROOT, 'exports', 'schema.sql'), 'utf8');
  const stmts = sql.split(/;\s*\n/).map(s => s.trim()).filter(s => s && /CREATE TABLE IF NOT EXISTS/i.test(s));
  console.log('建表 ' + stmts.length + ' 张…');

  // TiDB Serverless 首次连接要 10~30s 唤醒，第一条语句容易超时失败。
  // 建完必须核对实际表数，缺的立刻补建 —— 否则「脚本说成功、实际缺表」，
  // 这种静默半成品状态最难排查。
  const ensure = async (s) => {
    const name = (s.match(/CREATE TABLE IF NOT EXISTS `([^`]+)`/i) || [])[1];
    try {
      await run(s, []);
      return { name, ok: true };
    } catch (e) {
      return { name, ok: false, err: e.message };
    }
  };

  let ok = 0;
  for (const s of stmts) {
    const r = await ensure(s);
    if (r.ok) { ok++; process.stdout.write('  ✔ ' + r.name + '\n'); }
    else console.log('  ✘ ' + r.name + ' → ' + r.err);
  }

  // 校验：把缺的表再补建一遍
  try {
    const r = await run('SHOW TABLES', []);
    const have = r.map(x => Object.values(x)[0]);
    const missing = META.tables.filter(t => have.indexOf(t) < 0);
    if (missing.length) {
      console.log('校验发现缺失 ' + missing.length + ' 张表，补建中…');
      for (const t of missing) {
        const s = stmts.filter(x => x.indexOf('`' + t + '`') >= 0)[0];
        if (!s) continue;
        const r2 = await ensure(s);
        console.log('  ' + (r2.ok ? '✔ 补建 ' : '✘ 仍失败 ') + t + (r2.ok ? '' : ' → ' + r2.err));
        if (r2.ok) ok++;
      }
      const r3 = await run('SHOW TABLES', []);
      const have2 = r3.map(x => Object.values(x)[0]);
      const still = META.tables.filter(t => have2.indexOf(t) < 0);
      console.log('最终表数 ' + have2.length + '/' + META.tables.length + (still.length ? '，仍缺：' + still.join(', ') : '，全部就绪'));
    } else {
      console.log('校验通过，表数 ' + have.length + '/' + META.tables.length);
    }
  } catch (e) {
    console.log('校验失败：' + e.message);
  }
  console.log('建表完成 ' + ok + '/' + stmts.length);
}

async function migrateData(only) {
  const files = fs.readdirSync(DATA).filter(f => f.endsWith('.json') && f[0] !== '.');
  const tables = only || META.tables;
  let total = 0;
  for (const name of tables) {
    const f = path.join(DATA, name + '.json');
    if (!fs.existsSync(f)) { console.log('  跳过 ' + name + '（本地无文件）'); continue; }
    let rows;
    try { rows = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) { console.log('  跳过 ' + name + '（解析失败：' + e.message + '）'); continue; }
    if (!Array.isArray(rows) || !rows.length) { console.log('  跳过 ' + name + '（空）'); continue; }
    const CloudDB = require('../lib/clouddb');
    const db = new CloudDB();
    const t0 = Date.now();
    try {
      await db.replace(name, rows);      // 先清表再灌，保证与本地完全一致
      const ms = Date.now() - t0;
      total += rows.length;
      console.log('  ✔ ' + name.padEnd(20) + String(rows.length).padStart(5) + ' 条  ' + ms + 'ms');
    } catch (e) {
      console.log('  ✘ ' + name + ' → ' + e.message);
    }
  }
  console.log('迁移完成，共 ' + total + ' 条');
}

async function check() {
  const info = parseDbUrl(process.env.DATABASE_URL || '');
  if (!process.env.DATABASE_URL) {
    console.log('未配置 DATABASE_URL。请复制 .env.example 为 .env 并填入 TiDB 连接串。');
    return;
  }
  console.log('目标：用户 ' + info.username + ' @ 主机 ' + info.host + ' 库 ' + info.database);
  const t0 = Date.now();
  const r = await ping();
  console.log('连通 OK（' + r.ms + 'ms）');
  console.log('库现有表数：');
  try {
    const rs = await run('SHOW TABLES', []);
    console.log('  ' + rs.length + ' 张');
    rs.forEach(x => console.log('    ' + Object.values(x)[0]));
  } catch (e) {
    console.log('  读取失败：' + e.message);
  }
}

(async () => {
  try {
    if (has('--check')) { await check(); return; }
    if (!process.env.DATABASE_URL) {
      console.log('未配置 DATABASE_URL。\n请复制 .env.example 为 .env，填入 TiDB Cloud Serverless 连接串后重试。');
      process.exit(1);
    }
    if (has('--schema') || has('--all')) await createSchema();
    if (has('--data') || has('--all')) await migrateData();
  } catch (e) {
    console.error('失败：', e.message);
    process.exit(1);
  }
})();