'use strict';
/**
 * 公网接口测速（可直接跑：node scripts/speed_public.js [次数]）
 *
 * 【为什么要写这个脚本】
 * 测性能时最容易被误导的两件事：
 *   1. **单次采样**：Netlify 是横向扩容的 Serverless，同一接口连续请求
 *      可能落到不同 Lambda 实例，各实例缓存独立。第一个请求往往是冷启动
 *      （10~18 秒），第二个就 2 秒。只测一次会得出「还是很慢」的错误结论。
 *   2. **本地 ≠ 公网**：本地起 server 直连 TiDB，绕过了 Lambda 唤醒、
 *      TLS 握手、跨网往返。只看本地数字同样会误判。
 *
 * 所以正确姿势是：
 *   ① 本地 vs 公网对照，找出「公网额外开销」（实测约 1.4 秒，属正常网络往返）
 *   ② 公网连续采样 ≥10 次，看**中位数**而不是单次值
 *
 * 用法：
 *   node scripts/speed_public.js          # 10 次
 *   node scripts/speed_public.js 20       # 20 次
 *   node scripts/speed_public.js 10 /api/contract/contracts?size=20   # 指定接口
 */

const BASE = process.env.PLM_BASE || 'https://property-lease.netlify.app';
const USER = process.env.PLM_USER || 'admin';
const PASS = process.env.PLM_PASS || '123456';

const DEFAULT_PATHS = [
  ['驾驶舱', '/api/report/dashboard'],
  ['房源管理', '/api/property/rooms?size=20'],
  ['合同管理', '/api/contract/contracts?size=20'],
  ['工单巡检', '/api/ops/workorders?size=20'],
  ['巡更记录', '/api/patrol/records?size=50'],
  ['账单', '/api/finance/bills?size=20'],
  ['客户档案', '/api/customer/customers?size=20'],
  ['员工', '/api/hr/employees?size=20'],
  ['发票', '/api/invoice/invoices?size=20']
];

function hit(pathname, cookie) {
  return new Promise(resolve => {
    const c = new AbortController();
    const to = setTimeout(() => c.abort(), 60000);
    const t0 = Date.now();
    fetch(BASE + pathname, { headers: { cookie }, signal: c.signal })
      .then(r => { clearTimeout(to); r.text().then(() => resolve({ ms: Date.now() - t0, st: r.status })); })
      .catch(e => { clearTimeout(to); resolve({ ms: Date.now() - t0, st: 0, err: e.name }); });
  });
}
function med(a) { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

(async () => {
  const n = Number(process.argv[2]) || 10;
  const only = process.argv[3];
  const paths = only ? [['指定', only]] : DEFAULT_PATHS;

  const lr = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  });
  const lj = await lr.json();
  if (!lj.ok || !lj.data || !lj.data.token) {
    console.error('登录失败：', JSON.stringify(lj).slice(0, 200));
    process.exit(1);
  }
  const ck = 'plm_token=' + lj.data.token;
  console.log('目标：' + BASE);
  console.log('账号：' + USER + '（' + (lj.data.user && lj.data.user.roleName || '-') + '）');
  console.log('采样：每接口 ' + n + ' 次，看中位数\n');

  const rows = [];
  for (const [name, p] of paths) {
    // 先打一次预热，不计入统计（避免把冷启动算进中位数）
    await hit(p, ck);
    const ms = [];
    let bad = 0;
    for (let i = 0; i < n; i++) {
      const r = await hit(p, ck);
      if (r.st !== 200) bad++;
      ms.push(r.ms);
    }
    rows.push({ name, p, med: med(ms), min: Math.min(...ms), max: Math.max(...ms), bad, all: ms });
  }

  console.log('接口'.padEnd(12) + '中位数'.padStart(9) + '最快'.padStart(9) + '最慢'.padStart(9) + '   失败');
  console.log('-'.repeat(54));
  rows.forEach(r => {
    const flag = r.med > 5000 ? '慢' : r.med > 3000 ? '中' : '快';
    console.log(
      r.name.padEnd(10) +
      (flag + ' ' + r.med + 'ms').padStart(11) +
      (r.min + 'ms').padStart(9) +
      (r.max + 'ms').padStart(9) +
      (r.bad ? '   ' + r.bad + '/' + n + ' 失败' : '')
    );
  });
  const worst = rows.slice().sort((a, b) => b.med - a.med)[0];
  console.log('\n最慢：' + worst.name + ' 中位数 ' + worst.med + 'ms');
  if (worst.max > 8000) {
    console.log('  提示：最慢值 ' + worst.max + 'ms 通常是「闲置后首次唤醒」（Lambda + TiDB 双重启），');
    console.log('       看中位数才有意义。netlify.toml 已配 functions."api".schedule = "*/5 * * * *" 预热。');
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e && e.message); process.exit(1); });
