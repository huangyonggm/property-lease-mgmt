'use strict';
/**
 * 物业不动产租赁管理系统 - 服务端入口
 * 零第三方依赖：仅使用 Node.js 内置模块（http / fs / path / crypto）
 * 启动： node server.js  [端口]
 */
const path = require('path');
const fs = require('fs');
// 先加载 .env（本地连云端/云端配置验证时用；Netlify 注入的变量优先级更高，不会被覆盖）
require('./lib/env');

const ROOT = __dirname;
// 数据目录可用环境变量覆盖，便于同一台机器跑多套互不干扰的实例
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'));
const EXPORT_DIR = path.resolve(process.env.EXPORT_DIR || path.join(ROOT, 'exports'));
const PUBLIC_DIR = path.join(ROOT, 'public');

const DB = require('./lib/db');
const { Router, createServer, ok, fail, sendFile, MIME } = require('./lib/http');
const A = require('./lib/auth');
const { seed, seedPatrol } = require('./lib/seed');
const instance = require('./lib/instance');

const PORT = Number(process.argv[2] || process.env.PORT || 8080);

/* ---------- 单实例锁：同一数据目录只允许一个服务进程 ---------- */
let lock = null;
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  lock = instance.acquire(DATA_DIR, PORT);
} catch (e) {
  console.error('\n[FATAL] ' + e.message + '\n');
  process.exit(1);
}

const db = new DB(DATA_DIR);
[UPLOAD_DIR, EXPORT_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// 初始化演示数据。
// 刻意做成 async IIFE 而不是顶层 try/catch：
//   这些初始化函数都要查库（云端 db 是 async），写成同步 try/catch 会把
//   返回的 Promise 当同步结果处理 —— 初始化其实还没完成就往下走，
//   而且任何异步失败都被 try/catch 静默吞掉，表现为「数据莫名其妙少了一截」。
(async function initDemo() {
  try {
    const seeded = seed(db);
    if (seeded) console.log('[INIT] 已生成演示数据');
    // 已存在的数据库补种巡更演示数据（幂等）
    await seedPatrol(db, false);
    // 老版本库补发巡更权限点（幂等）
    await migratePatrolPerms(db);
    // 老版本库补发收入台账权限点（幂等，仅补齐不削减）
    await migrateIncomePerms(db);
    // 补种收入台账演示数据（停车费 / 上期尾款 / 支出 / 水电充值台账，幂等）
    await seedIncomeDemo(db);
    // 恢复历史登录会话（多电脑场景：服务重启后不必全员重新登录）
    await A.loadSessions(db);
  } catch (e) {
    console.error('[INIT] 初始化演示数据失败：', e.message);
  }
})();

const router = new Router();

/* ---------- 老版本库补发「巡更检查」权限点（幂等，仅补齐不削减） ---------- */
async function migratePatrolPerms(db) {
  const add = {
    r_gczg: ['patrol:view', 'patrol:manage', 'patrol:import', 'patrol:analyze', 'patrol:export'],
    r_kfjl: ['patrol:view', 'patrol:analyze'],
    r_kfzy: ['patrol:view'], r_zszy: ['patrol:view']
  };
  let changed = 0;
  // for...of：循环体要 await 查角色与更新权限（云端 db 是 async）
  for (const rid of Object.keys(add)) {
    const role = await db.find('roles', rid);
    if (!role) continue;
    const cur = (role.perms || []).slice();
    const miss = add[rid].filter(p => cur.indexOf(p) < 0);
    if (!miss.length) continue;
    await db.update('roles', rid, { perms: cur.concat(miss) });
    changed++;
  }
  if (changed) console.log('[INIT] 已为 ' + changed + ' 个角色补发巡更权限');
}

/* ---------- 老版本库补发「收入台账」权限点（幂等，仅补齐不削减） ---------- */
async function migrateIncomePerms(db) {
  const add = {
    r_zsjl: ['income:view'],
    r_kfjl: ['income:view'],
    r_cwjl: ['income:view', 'income:manage', 'income:export', 'income:import'],
    r_kj: ['income:view', 'income:export'],
    r_cn: ['income:view', 'income:manage'],
    r_jxfp: ['income:view'],
    r_cnfp: ['income:view', 'income:export'],
    r_zjl: ['income:view', 'income:export']
  };
  let changed = 0;
  // for...of：循环体要 await 查角色与更新权限
  for (const rid of Object.keys(add)) {
    const role = await db.find('roles', rid);
    if (!role) continue;
    const cur = (role.perms || []).slice();
    const miss = add[rid].filter(p => cur.indexOf(p) < 0);
    if (!miss.length) continue;
    await db.update('roles', rid, { perms: cur.concat(miss) });
    changed++;
  }
  if (changed) console.log('[INIT] 已为 ' + changed + ' 个角色补发收入台账权限');
}

/* ---------- 收入台账演示数据（幂等：已有数据则跳过） ---------- */
async function seedIncomeDemo(db) {
  const I2 = require('./lib/income');
  const U = require('./lib/util');
  let added = 0;

  if ((await db.all('parking')).length === 0) {
    const custs = (await db.all('customers'));
    const rooms = (await db.all('rooms'));
    const plates = ['鄂A·8H7K2', '鄂A·6M3P9', '鄂A·2X5T8', '鄂A·9L4N6', '鄂A·1K7R3', '鄂A·5B2W8',
      '鄂A·3D6Y1', '鄂A·7F9S4', '鄂A·4G1H5', '鄂A·8J2K7', '鄂A·6P4M9', '鄂A·1T5X3'];
    const rows = [], items = [];
    for (let i = 0; i < 46; i++) {
      const cu = custs[Math.floor(Math.random() * custs.length)] || {};
      const rm = rooms[Math.floor(Math.random() * rooms.length)] || {};
      const isTemp = Math.random() < 0.22;                    // 约 1/5 是临时停车
      const price = isTemp ? (Math.random() < 0.5 ? 10 : 15) : 396;   // 月租 396（合同价）
      const carCount = isTemp ? 1 : (Math.random() < 0.7 ? 1 : 2);
      const qty = 1;
      const day = 1 + Math.floor(Math.random() * 28);
      const payDate = '2026-08-' + String(day).padStart(2, '0');
      const amount = U.money(price * carCount * qty);
      const base = {
        id: U.uid('pk'), unitNo: rm.roomNo || '', companyName: cu.name || '',
        plateNo: plates[i % plates.length], carCount: carCount, price: price, qty: qty,
        amount: amount, payDate: payDate,
        channel: ['转账', '现金', '其他'][Math.floor(Math.random() * 3)],
        remain: Math.random() < 0.12 ? U.money(-amount / 3) : 0,     // 少量欠款
        startDate: '2026-01-01', endDate: '2026-12-31',
        parkType: isTemp ? '临时停车' : '月租车位',
        incomeCat: isTemp ? 'linshi_tingche' : 'yuezu_tingche',
        invoiceNo: Math.random() < 0.35 ? '0' + (42000000 + Math.floor(Math.random() * 999999)) : '',
        createTime: U.now(), createBy: '系统演示'
      };
      rows.push(base);
      items.push(Object.assign({}, base, { id: U.uid('pi') }));
    }
    db.replace('parking', rows);
    db.replace('parkingItems', items);
    added++;
  }

  if ((await db.all('arrears')).length === 0) {
    const custs = (await db.all('customers'));
    const rooms = (await db.all('rooms'));
    const summaries = ['2026年5月房租尾款', '2026年6月物业费尾款', '2026年4月电费尾款',
      '2026年6月空调费尾款', '2026年3月停车费尾款', '2026年5月水费尾款', '免租期折算尾款'];
    const rows = [];
    for (let i = 0; i < 14; i++) {
      const cu = custs[Math.floor(Math.random() * custs.length)] || {};
      const rm = rooms[Math.floor(Math.random() * rooms.length)] || {};
      const amount = U.money(200 + Math.random() * 3800);
      const settled = Math.random() < 0.35 ? '已结清' : '未结清';
      rows.push({
        id: U.uid('ar'), unitNo: rm.roomNo || '', companyName: cu.name || '',
        summary: summaries[i % summaries.length], amount: amount,
        incomeDate: '2026-07-' + String(1 + Math.floor(Math.random() * 28)).padStart(2, '0'),
        balance: settled === '已结清' ? 0 : amount,
        channel: ['转账', '现金', '其他'][Math.floor(Math.random() * 3)],
        period: '2026-0' + (1 + Math.floor(Math.random() * 7)),
        settled: settled, createTime: U.now(), createBy: '系统演示', remark: ''
      });
    }
    db.replace('arrears', rows);
    added++;
  }

  if ((await db.all('expenses')).length === 0) {
    const custs = (await db.all('customers'));
    const rooms = (await db.all('rooms'));
    const items8 = [
      { cat: '物业费用支出', sum: '电梯维保月度分摊', payee: '电梯维保公司' },
      { cat: '物业费用支出', sum: '公共区域绿化养护', payee: '绿化养护公司' },
      { cat: '物业费用支出', sum: '消防系统年检', payee: '消防检测公司' },
      { cat: '日常费用支出', sum: '办公耗材采购', payee: '办公用品商行' },
      { cat: '日常费用支出', sum: '水电维修材料', payee: '建材批发商' },
      { cat: '日常费用支出', sum: '清洁用品及保洁外包', payee: '保洁服务公司' },
      { cat: '日常费用支出', sum: '安防监控维护', payee: '安防服务商' },
      { cat: '预提款支出', sum: '季度物业费预提', payee: '' },
      { cat: '招商费用支出', sum: '招商代理佣金', payee: '招商代理机构' },
      { cat: '其他支出', sum: '办公用房租金支出', payee: '房东' },
      { cat: '垫付支出', sum: '代租户垫付维修费', payee: '维修单位' },
      { cat: '垫付支出', sum: '代租户垫付水电费', payee: '物业服务中心' }
    ];
    const rows = [];
    for (let i = 0; i < 52; i++) {
      const it = items8[Math.floor(Math.random() * items8.length)];
      const cu = custs[Math.floor(Math.random() * custs.length)] || {};
      const rm = rooms[Math.floor(Math.random() * rooms.length)] || {};
      const isAdv = it.cat === '垫付支出';
      rows.push({
        id: U.uid('ex'), expCat: it.cat,
        expDate: '2026-08-' + String(1 + Math.floor(Math.random() * 28)).padStart(2, '0'),
        summary: it.sum, amount: U.money(180 + Math.random() * 5600),
        channel: ['转账', '现金', '其他'][Math.floor(Math.random() * 3)],
        payee: it.payee, unitNo: isAdv ? (rm.roomNo || '') : '', companyName: isAdv ? (cu.name || '') : '',
        period: '2026-08', createTime: U.now(), createBy: '系统演示', remark: ''
      });
    }
    db.replace('expenses', rows);
    added++;
  }

  if ((await db.all('recharges')).length === 0) {
    const rooms = (await db.all('rooms'));
    const rows = [];
    let order = 1705980;
    for (let i = 0; i < 78; i++) {
      const rm = rooms[Math.floor(Math.random() * rooms.length)] || {};
      const floor = (rm.floor || '').toString().replace(/[^\d]/g, '') || '8';
      const isRefund = Math.random() < 0.18;
      const amt = isRefund ? -U.money(20 + Math.random() * 380) : U.money(50 + Math.random() * 1450);
      order += Math.floor(Math.random() * 7);
      const d = 28 - Math.floor(i / 3);
      rows.push({
        id: U.uid('rc'),
        time: '2026-08-' + String(Math.max(1, d)).padStart(2, '0') + ' ' +
          String(8 + Math.floor(Math.random() * 10)).padStart(2, '0') + ':' +
          String(Math.floor(Math.random() * 60)).padStart(2, '0') + ':' +
          String(Math.floor(Math.random() * 60)).padStart(2, '0'),
        meterNo: String(order),
        accountNo: rm.roomNo || '',
        userName: rm.roomNo || '',
        phone: '',
        installAddr: floor + '楼',
        chargeType: Math.random() < 0.85 ? '现金' : '转账',
        operator: 'YQ',
        amount: amt,
        operation: isRefund ? '退费' : '充值',
        orderNo: 'E' + String(order) + '2608' + String(10000 + Math.floor(Math.random() * 89999)),
        remark: isRefund ? '挪' + Math.abs(amt) + '元至相邻表' : '',
        createTime: U.now()
      });
    }
    db.replace('recharges', rows);
    added++;
  }

  // 表9「其他费用」六张台账（对应真实文件（表9）其他费用.xlsx 的 6 个工作表）
  if ((await db.all('otherItems')).length === 0) {
    const custs = (await db.all('customers'));
    const rooms = (await db.all('rooms'));
    const rows = [];
    const pick = n => custs[Math.floor(Math.random() * custs.length)] || {};
    const pickRoom = () => rooms[Math.floor(Math.random() * rooms.length)] || {};
    const day = m => '2026-' + m + '-' + String(1 + Math.floor(Math.random() * 27)).padStart(2, '0');
    const months = ['07', '08', '09'];

    for (const m of months) {
      // 其他收入：保洁部废品变卖 / 押金退差等零星
      for (let i = 0; i < 3; i++) {
        rows.push({
          id: U.uid('oi'), kind: '其他收入', occurDate: day(m),
          unitNo: '', companyName: '保洁部', amount: U.money(80 + Math.random() * 460),
          channel: ['转账', '现金', '其他'][Math.floor(Math.random() * 3)],
          remain: 0, remark: '废品变卖', createTime: U.now(), createBy: '系统演示'
        });
      }
      // 其他支出：办公用房租金、零星杂费
      for (let i = 0; i < 2; i++) {
        rows.push({
          id: U.uid('oi'), kind: '其他支出', occurDate: day(m),
          unitNo: '', companyName: '', amount: U.money(200 + Math.random() * 1800),
          channel: '转账', payee: '房东', remain: 0,
          remark: Math.random() < 0.5 ? '办公用房租金' : '零星杂费',
          createTime: U.now(), createBy: '系统演示'
        });
      }
      // 中介费：房屋中介佣金，带单据编号/面积/已付未付
      for (let i = 0; i < 2; i++) {
        const total = U.money(3000 + Math.random() * 12000);
        const paid = Math.random() < 0.6 ? total : U.money(Math.round(total / 2));
        rows.push({
          id: U.uid('oi'), kind: '中介费', occurDate: day(m),
          companyName: pick().name, docNo: 'ZJ' + m + String(1000 + Math.floor(Math.random() * 8999)),
          area: U.money(80 + Math.random() * 260), totalAmount: total, paidAmount: paid,
          amount: paid, unpaidAmount: U.money(total - paid), channel: '转账', remain: 0,
          remark: '房屋中介佣金', createTime: U.now(), createBy: '系统演示'
        });
      }
      // 会议室收入：场地出租，带使用日期/时段/税票情况
      for (let i = 0; i < 2; i++) {
        const cu = pick();
        rows.push({
          id: U.uid('oi'), kind: '会议室收入', occurDate: day(m),
          companyName: cu.name, unitNo: pickRoom().roomNo || '',
          amount: U.money(400 + Math.random() * 1600), useDate: day(m),
          useTime: ['09:00-12:00', '14:00-17:00', '全天'][Math.floor(Math.random() * 3)],
          taxStatus: Math.random() < 0.7 ? '已开普票' : '未开',
          channel: ['转账', '现金'][Math.floor(Math.random() * 2)], remain: 0,
          remark: '会议室场地出租', createTime: U.now(), createBy: '系统演示'
        });
      }
      // 垫付收入 / 垫付支出：代收代付，必然挂单元号与公司名
      for (let i = 0; i < 2; i++) {
        const cu = pick(), rm = pickRoom();
        rows.push({
          id: U.uid('oi'), kind: '垫付收入', occurDate: day(m),
          companyName: cu.name, unitNo: rm.roomNo || '',
          amount: U.money(300 + Math.random() * 2200), channel: '转账', remain: 0,
          remark: '代收代付款返还', createTime: U.now(), createBy: '系统演示'
        });
        rows.push({
          id: U.uid('oi'), kind: '垫付支出', occurDate: day(m),
          companyName: cu.name, unitNo: rm.roomNo || '',
          amount: U.money(300 + Math.random() * 2200), channel: '转账', payee: '维修单位', remain: 0,
          remark: '代租户垫付维修费', createTime: U.now(), createBy: '系统演示'
        });
      }
    }
    db.replace('otherItems', rows);
    added++;
  }

  // 给存量收款单打上收入科目标记，让收入日报能出数
  // 注意：收款单日期字段是 date（历史数据），incomeCat 每次启动按最新逻辑重算
  const pays = (await db.all('payments'));
  let tagged = 0;
  pays.forEach(p => {
    // incomeCatLocked = true 的人工指定科目不覆盖
    if (p.incomeCatLocked) return;
    p.incomeCat = I2.incomeCodeOf(p, db);
    if (!p.date && p.payDate) p.date = p.payDate;     // 统一日期字段名
    tagged++;
  });
  if (tagged) db.replace('payments', pays);

  // 演示数据：把当月（近 30 天）的收款单日期归到当前月，保证收入日报有数据可看
  const cm = U.monthOf(U.today());
  let spread = 0;
  pays.forEach((p, i) => {
    const d = String(p.date || '');
    if (d.slice(0, 7) === cm) return;
    if (i % 3 !== 0) return;                           // 三分之一的收款单挪到当月
    const day = 1 + (i % 28);
    p.date = cm + '-' + String(day).padStart(2, '0');
    p.payDate = p.date;
    p.incomeCat = I2.incomeCodeOf(p, db);
    spread++;
  });
  if (spread) db.replace('payments', pays);

  if (added) console.log('[INIT] 收入台账演示数据：' + added + ' 个集合已补种');
  if (tagged) console.log('[INIT] 已为 ' + tagged + ' 笔收款单标记收入科目' + (spread ? '，其中 ' + spread + ' 笔归入当月 ' + cm : ''));
  return added;
}

/* ---------- 健康检查 ---------- */
router.get('/api/health', async (req, res) => {
  ok(res, { status: 'ok', time: new Date().toISOString(), collections: db.stats() });
});

/* ---------- 业务路由 ---------- */
const ctx = { rootDir: ROOT, dataDir: DATA_DIR, uploadDir: UPLOAD_DIR, exportDir: EXPORT_DIR };
require('./routes/auth')(db, router);
require('./routes/property')(db, router);
require('./routes/customer')(db, router);
require('./routes/contract')(db, router);
// 合同模板比对（/api/contract-compare/*）。
// 【别再漏挂】这个文件一度没被 require，导致所有 contract-compare 请求落到 SPA 兜底返回
// HTML，前端 res.json() 解析失败 → data={ok:false} → r.data 为 undefined →
// 报「Cannot read properties of undefined (reading 'result')」，看起来像上传失败，实际是路由不存在。
// 与七牛云上传毫无关系。
require('./routes/contractcmp')(db, router, ctx);
require('./routes/billing')(db, router);
require('./routes/invoice')(db, router);
require('./routes/approval')(db, router);
require('./routes/ops')(db, router, ctx);
require('./routes/report')(db, router, ctx);
require('./routes/hr')(db, router, ctx);
require('./routes/patrol')(db, router, ctx);
require('./routes/income')(db, router, ctx);

/* ---------- 上传/导出文件访问 ---------- */
function serveDir(prefix, dir) {
  return async function (req, res) {
    if (req.path.indexOf(prefix) !== 0) return true;
    const rel = req.path.slice(prefix.length);
    const fp = path.join(dir, decodeURIComponent(rel).replace(/^([/\\])+/, ''));
    if (fp.indexOf(dir) !== 0 || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      res.writeHead(404); res.end('Not Found'); return false;
    }
    sendFile(res, fp, req.query.download ? path.basename(fp) : null);
    return false;
  };
}

const server = createServer(router, {
  staticDir: PUBLIC_DIR,
  db: db,                          // 云端模式下启用请求级缓存（本地 db 无此方法，自动跳过）
  before: [
    serveDir('/uploads/', UPLOAD_DIR),
    serveDir('/exports/', EXPORT_DIR),
    A.attachUser(db)
  ]
});

function lanIPs() {
  const out = [];
  const nis = require('os').networkInterfaces();
  Object.keys(nis).forEach(k => (nis[k] || []).forEach(it => {
    if (it.family === 'IPv4' && !it.internal) out.push(it.address);
  }));
  return out;
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error('\n[FATAL] 端口 ' + PORT + ' 已被占用。请换一个端口启动，例如：node server.js 8090\n');
  } else {
    console.error('\n[FATAL] 服务启动失败：' + e.message + '\n');
  }
  if (lock) lock.release();
  process.exit(1);
});

// 【坑】Windows 上 `localhost` 优先解析成 IPv6 的 ::1（ping localhost 返回 ::1 就是证据）。
// 只监听 '0.0.0.0' 的话，浏览器访问 http://localhost:PORT 会报 ERR_CONNECTION_REFUSED，
// 而 curl 127.0.0.1 却正常 —— 看起来像「服务挂了」，实际服务好得很。
// 监听 '::' 开启 IPv6 双栈（Node 在 Windows 上 ipv6Only 默认 false，IPv4 也能连）。
const HOST = process.env.HOST || '::';
server.listen(PORT, HOST, () => {
  const line = '='.repeat(62);
  const ips = lanIPs();
  console.log('\n' + line);
  console.log('  物业不动产租赁管理系统  已启动');
  console.log(line);
  console.log('  本机地址  ： http://localhost:' + PORT + '/   （双栈，IPv4/IPv6 均可）');
  console.log('             http://127.0.0.1:' + PORT + '/   （备用，localhost 异常时用这个）');
  if (ips.length) {
    console.log('  局域网地址： http://' + ips[0] + ':' + PORT + '/     ← 其他电脑用浏览器打开这个');
    if (ips.length > 1) console.log('             http://' + ips.slice(1).join(':PORT/  http://') + ':' + PORT + '/');
  } else {
    console.log('  局域网地址： 未检测到内网网卡（当前仅本机可访问）');
  }
  console.log('  移动端地址 ： ' + (ips.length ? 'http://' + ips[0] + ':' + PORT + '/m.html' : 'http://localhost:' + PORT + '/m.html'));
  console.log('  数据目录   ： ' + DATA_DIR + (process.env.DATA_DIR ? '（环境变量指定）' : ''));
  console.log('  附件目录   ： ' + UPLOAD_DIR);
  console.log('  锁文件     ： ' + (lock ? lock.file : '未启用'));
  console.log(line);
  console.log('  演示账号（密码统一 123456）：');
  console.log('    admin        / 123456  系统管理员（全部权限）');
  console.log('    zhaoshang    / 123456  招商经理（价格审核）');
  console.log('    caiwu        / 123456  财务经理（租金审核 / 薪资）');
  console.log('    chunafp      / 123456  出纳发票（开票）');
  console.log('    gongcheng    / 123456  工程主管（巡检抄表 / 巡更检查 / 考勤）');
  console.log('    renshi       / 123456  人事专员（人事薪酬全权）');
  console.log('    kefu         / 123456  客服主管（催收退租）');
  console.log(line);
  console.log('  提示：其他电脑访问请确认防火墙已放行 TCP ' + PORT + ' 端口。');
  console.log(line + '\n');
  if (process.argv.indexOf('--open') >= 0 || process.env.OPEN_BROWSER === '1') {
    try {
      require('child_process').exec('start http://localhost:' + PORT + '/');
    } catch (e) { }
  }
});

process.on('uncaughtException', e => console.error('[uncaught]', e));
process.on('unhandledRejection', e => console.error('[unhandled]', e));

module.exports = server;
