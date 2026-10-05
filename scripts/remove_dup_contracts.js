/**
 * 级联删除 HT20261000* 这 24 份重复测试合同及其全部关联数据
 *
 * ⚠⚠ 破坏性操作。用法：
 *   node scripts/remove_dup_contracts.js --check    干跑，只看影响面
 *   node scripts/remove_dup_contracts.js            真删（先自动备份）
 *
 * 背景：这 24 份合同是 2026-10-03 一次性误灌的重复测试数据
 *   （同租户「幻弓」/ 同房间 T3-9-07 / 同面积 322㎡ / 编号 HT2026100001~0024 连续 /
 *     状态全「变更」），并连带生成了 24 笔账单、23 笔收款、24 条提醒、24 条审批。
 *   全部关联数据 createTime 同为 2026-10-03，与合同同批。
 *
 * 匹配方式：严格按 contractId（数组按元素比对）匹配关联数据，
 *   **不做字符串子串匹配** —— 早期版本用 substring 会误伤同租户的真合同。
 */
require('../lib/env');
process.env.DB_MODE = 'cloud';
const fs = require('fs');
const path = require('path');
const { createDb } = require('../lib/app');
const { money } = require('../lib/util');

const PATTERN = /^HT20261000/;
const BK = path.join(__dirname, '..', 'backups');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const DO = process.argv.indexOf('--check') < 0;

/** 严格匹配：字段值命中 ids 或 codes 之一即算（支持数组字段） */
function matchRef(row, ids, codes) {
  const keys = ['contractId', 'contractCode', 'refId', 'relatedId', 'bizId', 'roomId'];
  return keys.some(k => {
    const v = row[k];
    if (v === undefined || v === null || v === '') return false;
    if (Array.isArray(v)) return v.map(String).some(x => ids.indexOf(String(x)) >= 0);
    const s = String(v);
    return ids.indexOf(s) >= 0 || codes.indexOf(s) >= 0;
  });
}

(async () => {
  const db = createDb();
  const allContracts = await db.where('contracts');
  const target = allContracts.filter(c => PATTERN.test(String(c.code || '')));

  console.log('=== 1. 待删清单 ===');
  console.log('  合同 ' + target.length + ' 份  编号 ' +
    target.map(c => c.code).sort()[0] + ' ~ ' + target.map(c => c.code).sort().pop());
  console.log('  租户 ' + [...new Set(target.map(c => c.customerName))].join(' / ') +
    '  房间 ' + [...new Set(target.map(c => (c.roomCodes || []).join(',')))].join(' / '));
  console.log('  状态 ' + JSON.stringify(target.reduce((o, c) => { o[c.status] = (o[c.status] || 0) + 1; return o; }, {})));
  console.log('  面积合计 ' + money(target.reduce((s, c) => s + Number(c.area || 0), 0)) + ' ㎡' +
    '  月租合计 ' + money(target.reduce((s, c) => s + Number(c.rentMonthly || 0), 0)) + ' 元');

  const ids = target.map(c => String(c.id));
  const codes = target.map(c => String(c.code));

  // ---- 关联数据 ----
  console.log('\n=== 2. 关联数据（按 contractId 精确匹配）===');
  const plan = { contracts: target };
  const TABLES = ['bills', 'payments', 'reminders', 'approvals', 'workorders', 'invoices', 'deposits'];
  for (const t of TABLES) {
    let rows = [];
    try { rows = await db.where(t); } catch (e) { continue; }
    if (!rows || !rows.length) { plan[t] = []; continue; }
    const h = rows.filter(r => matchRef(r, ids, codes));
    plan[t] = h;
    if (h.length) {
      const amtKey = ['totalAmount', 'amount', 'rent', 'value'].find(k => h.some(r => r[k] !== undefined));
      const sum = amtKey ? money(h.reduce((s, r) => s + Number(r[amtKey] || 0), 0)) : '-';
      console.log('  ' + t.padEnd(11) + String(h.length).padStart(4) + ' 行' +
        (amtKey ? '  ' + amtKey + ' 合计 ' + sum : '') +
        '  createTime ' + JSON.stringify(h.reduce((o, r) => {
          const d = String(r.createTime).slice(0, 10); o[d] = (o[d] || 0) + 1; return o;
        }, {})));
    } else {
      console.log('  ' + t.padEnd(11) + '   0 行');
    }
  }
  const totalRows = TABLES.reduce((s, t) => s + plan[t].length, 0);
  console.log('  合计待删关联行 ' + totalRows + ' 行（+ 合同 ' + target.length + ' 行）');

  // ---- 备份 ----
  console.log('\n=== 3. 备份 ===');
  const bk = {
    savedAt: new Date().toISOString(),
    reason: '一次性误灌的重复测试合同（同租户幻弓/同房间 T3-9-07/同面积322㎡/编号连续/全部 createTime=2026-10-03）及其全部关联数据',
    tables: TABLES.reduce((o, t) => { if (plan[t].length) o[t] = plan[t].length; return o; }, { contracts: target.length }),
    data: { contracts: target }
  };
  TABLES.forEach(t => { if (plan[t].length) bk.data[t] = plan[t]; });
  if (!fs.existsSync(BK)) fs.mkdirSync(BK, { recursive: true });
  const bkFile = path.join(BK, 'dup-contracts-cascade-' + STAMP + '.json');
  fs.writeFileSync(bkFile, JSON.stringify(bk, null, 2), 'utf8');
  console.log('  ✔ ' + path.relative(path.join(__dirname, '..'), bkFile) +
    '  (' + (fs.statSync(bkFile).size / 1024).toFixed(1) + ' KB，含全部 ' + totalRows + ' 行关联数据)');

  if (!DO) {
    console.log('\n（--check 干跑结束，未执行删除。去掉 --check 即执行）');
    return;
  }

  // ---- 删除：先删子表，最后删合同 ----
  console.log('\n=== 4. 执行删除（先子表后主表）===');
  const deleted = {};
  for (const t of TABLES) {
    if (!plan[t].length) { deleted[t] = 0; continue; }
    let ok = 0, fail = 0;
    for (const r of plan[t]) {
      try { await db.remove(t, r.id); ok++; }
      catch (e) { fail++; console.log('  ✘ ' + t + '/' + (r.code || r.id) + ' → ' + e.message); }
    }
    deleted[t] = ok;
    console.log('  ' + t.padEnd(11) + ' 成功 ' + ok + ' / 失败 ' + fail);
  }
  let cok = 0, cfail = 0;
  for (const c of target) {
    try { await db.remove('contracts', c.id); cok++; }
    catch (e) { cfail++; console.log('  ✘ ' + c.code + ' → ' + e.message); }
  }
  deleted.contracts = cok;
  console.log('  ' + 'contracts'.padEnd(11) + ' 成功 ' + cok + ' / 失败 ' + cfail);

  // ---- 验证 ----
  console.log('\n=== 5. 删除后验证 ===');
  const afterC = await db.where('contracts');
  const leftC = afterC.filter(c => PATTERN.test(String(c.code || '')));
  console.log('  合同总数 ' + allContracts.length + ' → ' + afterC.length +
    '   残留 ' + leftC.length + (leftC.length ? ' ✘' : ' ✔'));
  for (const t of TABLES) {
    const rows = await db.where(t);
    const h = rows.filter(r => matchRef(r, ids, codes));
    console.log('  ' + t.padEnd(11) + ' 残留引用 ' + h.length + (h.length ? ' ✘' : ' ✔'));
  }

  const ACT = ['正常履约', '变更'];
  const rooms = await db.where('rooms');
  const pjs = await db.where('projects');
  console.log('\n  各项目出租率（活跃口径）：');
  pjs.forEach(pj => {
    const rs = rooms.filter(r => String(r.projectId) === String(pj.id));
    const cs = afterC.filter(c => String(c.projectId) === String(pj.id));
    const area = money(rs.reduce((s, r) => s + Number(r.area || 0), 0));
    const rentArea = money(cs.filter(c => ACT.indexOf(c.status) >= 0).reduce((s, c) => s + Number(c.area || 0), 0));
    const pct = area > 0 ? Math.round(rentArea / area * 1000) / 10 : 0;
    const vacant = rs.filter(r => String(r.status) === '空置').length;
    const conflict = cs.filter(c => ACT.indexOf(c.status) >= 0)
      .filter(c => (c.roomIds || []).some(id => String((rooms.find(r => String(r.id) === String(id)) || {}).status) === '空置')).length;
    console.log('    ' + String(pj.name).padEnd(12) + ' 房源' + String(rs.length).padStart(4) +
      ' 空置' + String(vacant).padStart(3) + ' 合同' + String(cs.length).padStart(4) +
      ' 出租率' + String(pct).padStart(6) + '%' + (conflict ? '  ⚠ 空置房被活跃合同引用 ' + conflict : ''));
  });

  const rmap = {}; rooms.forEach(r => { rmap[String(r.id)] = r; });
  let bad = 0, mis = 0;
  afterC.forEach(c => {
    (c.roomIds || []).forEach(id => { if (!rmap[String(id)]) bad++; });
    const rSum = money((c.roomIds || []).reduce((s, id) => s + Number((rmap[String(id)] || {}).area || 0), 0));
    if (Math.abs(rSum - money(c.area)) > 0.01) mis++;
  });
  console.log('\n  合同→房间引用完整性 ' + (afterC.length - bad) + '/' + afterC.length + (bad ? ' ✘' : ' ✔'));
  console.log('  合同面积 vs 房间面积一致 ' + (afterC.length - mis) + '/' + afterC.length + (mis ? ' ✘' : ' ✔'));
  console.log('\n  备份文件：' + path.relative(path.join(__dirname, '..'), bkFile));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message, e.stack); process.exit(1); });
