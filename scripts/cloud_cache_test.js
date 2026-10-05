'use strict';
/**
 * 云端缓存一致性自检（TiDB Cloud Serverless）
 *
 * 背景：lib/clouddb.js 加了「请求级缓存」根治 N+1 ——
 *   TiDB 单次查询往返约 195ms，业务代码里「循环里逐行查关联」的写法会被放大 200 倍。
 *   实测「月表格」单请求原本发 2049 条 SQL / 212 秒，缓存后降到 30 条 / 3.5 秒。
 *
 * 缓存最大的风险不是慢，而是「读到自己刚写之前的旧值」。
 * 所以这个脚本专门盯三件事：
 *   1. 一致性：开缓存与不开缓存，同一批查询结果必须逐字节相同
 *   2. 写后读：insert / update / remove 之后立刻读，必须读到新值（否则业务会算错账）
 *   3. 隔离性：缓存严格绑定单次请求，绝不跨请求残留（否则会读到别人写的脏数据）
 *
 * 用法：node scripts/cloud_cache_test.js
 * 注意：本脚本会在 customers 表临时插入 1 条测试数据，结束时必定删除；
 *      若中途抛错可能残留，可用 --clean 参数单独清理：
 *        node scripts/cloud_cache_test.js --clean
 */
require('../lib/env');
process.env.DB_MODE = 'cloud';

const { createDb } = require('../lib/app');
const db = createDb();

let pass = 0, fail = 0;
const failures = [];

function chk(label, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + label + (extra === undefined ? '' : '　' + extra)); }
  else { fail++; failures.push(label); console.log('  ✘ ' + label + (extra === undefined ? '' : '　' + extra)); }
}

const JUNK_RE = /tmp_cachetest|缓存自测/;

/** 清理历史残留（脚本异常中断时用） */
async function cleanJunk() {
  const cs = await db.all('customers');
  const junk = cs.filter(c => JUNK_RE.test(c.id + ' ' + c.name));
  for (const j of junk) await db.remove('customers', j.id);
  // contracts 同样可能被中断留下残 row
  const ts = await db.all('contracts');
  for (const t of ts.filter(x => JUNK_RE.test(x.id + ' ' + x.code))) await db.remove('contracts', t.id);
  return junk.length;
}

async function main() {
  if (process.argv.indexOf('--clean') >= 0) {
    const n = await cleanJunk();
    console.log('已清理残留测试数据 ' + n + ' 条，当前客户数 ' + (await db.all('customers')).length);
    return;
  }

  console.log('--- 云端缓存一致性自检 ---\n');

  // ===== 1. 开缓存 vs 不开缓存，全量读取结果必须完全一致 =====
  console.log('【一】开缓存 / 不开缓存 读取一致性');
  const tables = ['contracts', 'customers', 'rooms', 'bills', 'employees',
    'depts', 'posts', 'roles', 'meters', 'parking', 'invoices'];
  db.beginRequest();
  const cached = {};
  for (const t of tables) cached[t] = JSON.stringify(await db.all(t));
  db.endRequest();
  for (const t of tables) {
    const raw = JSON.stringify(await db.all(t));
    chk('全量读取一致 ' + t, raw === cached[t]);
  }

  // ===== 2. 缓存内 find 与整表数据一致 =====
  console.log('\n【二】缓存内 find 正确性');
  db.beginRequest();
  const contracts = await db.all('contracts');
  let mismatch = 0;
  for (const c of contracts.slice(0, 40)) {
    if (JSON.stringify(await db.find('contracts', c.id)) !== JSON.stringify(c)) mismatch++;
  }
  chk('缓存内 find 40 条全一致', mismatch === 0, '不一致 ' + mismatch + ' 条');
  chk('缓存内 find 不存在的 id 返回 null', (await db.find('contracts', '__not_exist__')) === null);
  db.endRequest();

  // ===== 3. 写后立刻读（最关键：缓存必须同步，否则会算错账） =====
  console.log('\n【三】写后立即读（缓存同步性）');
  const nid = 'tmp_cachetest_' + Date.now().toString(36);
  db.beginRequest();
  try {
    await db.all('customers');
    await db.insert('customers', { id: nid, name: '缓存自测客户', phone: '13900000000' });
    const got = await db.find('customers', nid);
    chk('insert 后 find 立刻读到', !!got && got.name === '缓存自测客户');
    chk('insert 后 all 能读到', (await db.all('customers')).some(x => x.id === nid));

    await db.update('customers', nid, { name: '缓存自测改名' });
    chk('update 后 find 读到新值', (await db.find('customers', nid)).name === '缓存自测改名');

    await db.remove('customers', nid);
    chk('remove 后 find 返回 null', (await db.find('customers', nid)) === null);
    chk('remove 后 all 不含该行', !(await db.all('customers')).some(x => x.id === nid));
  } finally {
    db.endRequest();
    // 清缓存后也应查不到 —— 确认是真删了，不只是缓存里的假象
    chk('清缓存后数据库里也查不到（真删除）', (await db.find('customers', nid)) === null);
    await cleanJunk();
  }

  // ===== 4. where / count 在缓存与非缓存下语义一致 =====
  // 注意：这里必须用库里真实存在的状态值。合同的 status 是「正常履约」而非「生效」，
  //      之前用错值导致两边都是 0，测不出差异（空跑的用例等于没测）。
  console.log('\n【四】where / count / page 语义一致性');
  const allContracts = await db.all('contracts');
  const realStatus = allContracts.length ? allContracts[0].status : null;
  chk('取到真实合同状态值', !!realStatus, JSON.stringify(realStatus));
  if (realStatus) {
    db.beginRequest();
    await db.all('contracts');
    const wFn = (await db.where('contracts', c => c.status === realStatus)).length;
    const wObj = (await db.where('contracts', { status: realStatus })).length;
    const cnt = (await db.count('contracts', { status: realStatus }));
    db.endRequest();
    const realFn = (await db.where('contracts', c => c.status === realStatus)).length;
    const realObj = (await db.where('contracts', { status: realStatus })).length;
    chk('where 函数条件 缓存/非缓存一致', wFn === realFn, wFn + ' vs ' + realFn);
    chk('where 对象条件 缓存/非缓存一致', wObj === realObj, wObj + ' vs ' + realObj);
    chk('count 与 where 结果一致', cnt === realObj, cnt + ' vs ' + realObj);
    chk('用例非空（确实测到了数据）', wFn > 0, '命中 ' + wFn + ' 条');
  }

  db.beginRequest();
  await db.all('contracts');
  const pg = await db.page('contracts', { page: 2, size: 10, sort: 'username' });
  db.endRequest();
  const pgReal = await db.page('contracts', { page: 2, size: 10, sort: 'username' });
  chk('page 第2页条数正确', pg.list.length === 10, 'total ' + pg.total);
  chk('page 内容与真实查询一致', JSON.stringify(pg.list) === JSON.stringify(pgReal.list));

  // ===== 5. N+1 自适应：反复 find 应转整表缓存 =====
  console.log('\n【五】N+1 自适应阈值');
  db.beginRequest();
  const rooms = await db.all('rooms');
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) await db.find('rooms', rooms[i % rooms.length].id);
  const dt = Date.now() - t0;
  chk('rooms 已被整表缓存', Array.isArray(db._cache && db._cache.get('rooms')));
  chk('60 次 find 耗时 < 1500ms（说明走了内存）', dt < 1500, dt + 'ms');
  db.endRequest();

  // ===== 6. 隔离性：缓存绝不跨请求残留 =====
  console.log('\n【六】请求隔离性');
  db.beginRequest();
  await db.all('roles');
  db.endRequest();
  chk('endRequest 后请求级缓存已释放', db._cache === null);
  db.beginRequest();
  chk('新请求缓存为空', db._cache.size === 0);
  db.endRequest();

  // ===== 7. 跨请求共享缓存：写后可见性 + 引用隔离 =====
  // 这组用例守护的是最危险的一类 bug：缓存「读到了旧数据」。
  // 实测踩过：insert 只 push 请求级缓存、没同步共享缓存，
  // 结果新请求读不到刚插入的行（业务上表现为「保存成功但列表不刷新」）。
  console.log('\n【七】跨请求共享缓存（写后可见性 / 引用隔离）');
  db.beginRequest();
  await db.all('contracts');
  db.endRequest();
  const cid = 'tmp_cachetest_c_' + Date.now().toString(36);
  try {
    await db.insert('contracts', { id: cid, code: 'TMP-C', customerId: 'tmp', status: '正常履约' });
    db.beginRequest();
    chk('insert 后新请求读得到', (await db.all('contracts')).some(x => x.id === cid));
    db.endRequest();

    await db.update('contracts', cid, { status: '逾期' });
    db.beginRequest();
    const row = (await db.all('contracts')).find(x => x.id === cid);
    chk('update 后新请求读到新值', !!row && row.status === '逾期', row ? row.status : '未找到');
    db.endRequest();

    // 引用隔离：业务代码常做 row.items.push / row.x = y，原地修改不能污染缓存
    db.beginRequest();
    const a1 = await db.all('contracts');
    if (a1.length && Array.isArray(a1[0].roomIds)) a1[0].roomIds.push('__污染测试__');
    a1[0].status = '__污染测试__';
    const a2 = await db.all('contracts');
    chk('修改返回值不污染缓存（顶层字段）', a2[0].status !== '__污染测试__');
    chk('修改返回值不污染缓存（数组字段）',
      !(a2[0].roomIds || []).indexOf('__污染测试__') >= 0);
    db.endRequest();
  } finally {
    await db.remove('contracts', cid);
    db.beginRequest();
    chk('remove 后新请求读不到', !(await db.all('contracts')).some(x => x.id === cid));
    db.endRequest();
    chk('数据库里也已真删除', (await db.all('contracts')).every(x => x.id !== cid));
  }

  console.log('\n== 结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项 ==');
  if (fail) { failures.forEach(f => console.log('   失败项：' + f)); process.exit(1); }
  process.exit(0);
}

main().catch(e => {
  console.error('\n自检异常中断：', e && e.stack || e);
  console.error('可能残留了一条测试数据，请执行：node scripts/cloud_cache_test.js --clean');
  process.exit(1);
});
