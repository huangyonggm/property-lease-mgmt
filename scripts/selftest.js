'use strict';
// 自检脚本：登录后逐项验证各模块接口（含写操作），输出通过/失败清单
const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1', PORT = Number(process.argv[2] || 8080);
let COOKIE = '';

/** 读本地 data/<n>.json（自检连的是本机服务，数据也在本地） */
function req0(n) {
  try {
    const p = path.join(__dirname, '..', 'data', n + '.json');
    if (!fs.existsSync(p)) return null;
    const r = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(r) ? r : (r.list || null);
  } catch (e) { return null; }
}

function req(method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = Object.assign({ 'Content-Type': 'application/json' }, data ? { 'Content-Length': Buffer.byteLength(data) } : {});
    // 显式传入的 Cookie 优先（多账号场景），否则用全局登录态
    const ck = (extraHeaders && extraHeaders.Cookie) || COOKIE;
    if (ck) headers.Cookie = ck;
    if (extraHeaders) Object.keys(extraHeaders).forEach(k => { if (k !== 'Cookie') headers[k] = extraHeaders[k]; });
    const r = http.request({
      hostname: HOST, port: PORT, path: path, method: method, headers: headers
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { }
        resolve({ status: res.statusCode, headers: res.headers, raw: raw, json: json, body: json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

let pass = 0, fail = 0;
const fails = [];
async function check(name, fn) {
  try {
    const r = await fn();
    if (r) { pass++; console.log('  ✔ ' + name); }
    else { fail++; fails.push(name); console.log('  ✘ ' + name); }
  } catch (e) { fail++; fails.push(name + '（异常：' + e.message + '）'); console.log('  ✘ ' + name + ' 异常：' + e.message); }
}

/* ================================================================
 * 自检残留清理（2026-10-04 加）
 *
 * 【为什么必须清】自检里有大量**写操作**测试：新建合同、生成账单、
 * 收款登记、抄表录入、生成巡检……而这个脚本原先**完全没有清理逻辑**，
 * 于是「跑一次自检 = 往库里灌一批测试数据」。
 *
 * 实际后果（已发生，不是假设）：
 *   某次自检里「新建合同」用的第一个客户恰好是演示数据「幻弓」，
 *   第一个空置房恰好是 T3-9-07（322㎡），
 *   于是每跑一次自检就多一份「幻弓 / T3-9-07」合同。
 *   累计 62 份 × 322㎡ = 19964㎡，而 T3 全部面积才 19365㎡ ——
 *   面积占用率算出 103%，系统里的 T3 出租率显示 144%，全是这批垃圾的锅。
 *
 * 【为什么不能靠删接口】本项目 CRUD 只有新增/改/查，**没有 delete 端点**。
 * 所以清理直接操作 data/*.json（自检本来就跑在本机、连的是 127.0.0.1）。
 *
 * 【清理口径】按「自检产生物」的三个特征精确匹配，不做模糊子串：
 *   ① 合同编号 HT20261000xx（自检专用号段）
 *   ② 变更原因/备注含「自检」二字
 *   ③ 客户名等于 __自检xx__ 这类显式标记
 * 关联表（账单/收款/提醒/审批）按 contractId 精确跟随删除。
 *
 * 审计日志 logs **不清** —— 那是操作痕迹，本该保留。
 */
const CLEAN = {
  // 脏数据判定：任一命中即视为自检产物
  isTest: (row) => {
    const s = JSON.stringify(row);
    if (/^HT20261000\d*$/.test(String(row.code || ''))) return true;      // ① 自检号段
    if (/自检/.test(s)) return true;                                       // ② 自检字样
    if (/^__自检/.test(String(row.companyName || ''))) return true;        // ③ 显式标记
    if (/^__自检/.test(String(row.name || ''))) return true;               // 客户名标记
    return false;
  },
  // 按 contractId / contractCode 精确跟随（数组字段逐元素匹配）
  refHit: (row, ids, codes) => {
    for (const k of ['contractId', 'contractCode', 'refId', 'relatedId', 'bizId', 'roomId']) {
      const v = row[k];
      if (typeof v === 'string' && (ids.has(v) || codes.has(v))) return true;
    }
    for (const k of ['roomIds', 'roomCodes']) {
      const v = row[k];
      if (Array.isArray(v) && v.some(x => ids.has(x) || codes.has(x))) return true;
    }
    return false;
  },
  run() {
    const fsx = require('fs');
    const dataDir = path.join(__dirname, '..', 'data');
    const read = n => {
      const p = path.join(dataDir, n + '.json');
      if (!fsx.existsSync(p)) return null;
      const r = JSON.parse(fsx.readFileSync(p, 'utf8'));
      return Array.isArray(r) ? r : (r.list || null);
    };
    const write = (n, a) => fsx.writeFileSync(path.join(dataDir, n + '.json'), JSON.stringify(a, null, 1));

    const cts = read('contracts');
    if (!cts) return { total: 0, note: '本地无 contracts.json（云端模式跳过）' };
    const bad = cts.filter(CLEAN.isTest);
    if (!bad.length) return { total: 0, note: '无残留' };
    const ids = new Set(bad.map(c => c.id));
    const codes = new Set(bad.map(c => c.code).filter(Boolean));

    // 备份优先
    try {
      const bak = { contracts: bad };
      for (const t of ['bills', 'payments', 'reminders', 'approvals']) {
        const rows = read(t);
        if (rows) bak[t] = rows.filter(r => CLEAN.refHit(r, ids, codes));
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const bdir = path.join(__dirname, '..', 'backups');
      if (!fsx.existsSync(bdir)) fsx.mkdirSync(bdir, { recursive: true });
      fsx.writeFileSync(path.join(bdir, 'selftest-residue-' + stamp + '.json'), JSON.stringify(bak, null, 1));
    } catch (e) { /* 备份失败不阻断清理，但会告警 */ }

    let n = 0;
    // 先子表后主表
    for (const t of ['bills', 'payments', 'reminders', 'approvals']) {
      const rows = read(t);
      if (!rows) continue;
      const keep = rows.filter(r => !CLEAN.refHit(r, ids, codes));
      if (keep.length !== rows.length) { write(t, keep); n += rows.length - keep.length; }
    }
    const keepC = cts.filter(c => !ids.has(c.id));
    write('contracts', keepC);
    n += cts.length - keepC.length;
    return { total: n, contracts: bad.length, note: '已清理' };
  }
};

(async () => {
  console.log('== 物业不动产租赁管理系统 自检 ==\n');

  // 登录
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: '123456' });
  const setCookie = login.headers['set-cookie'] || [];
  COOKIE = setCookie.map(s => s.split(';')[0]).join('; ');
  console.log('登录：' + (login.json && login.json.ok ? '成功（' + login.json.data.user.name + '）' : '失败 ' + login.raw));
  if (!login.json || !login.json.ok) process.exit(1);

  console.log('\n[1] 组织与权限');
  await check('部门列表', async () => (await req('GET', '/api/org/depts')).json.ok);
  await check('岗位列表', async () => (await req('GET', '/api/org/posts')).json.ok);
  await check('角色列表', async () => (await req('GET', '/api/org/roles')).json.ok);
  await check('用户列表', async () => (await req('GET', '/api/org/users')).json.ok);
  await check('当前用户/菜单', async () => { const r = await req('GET', '/api/auth/me'); return r.json.ok && r.json.data.menus.length > 0; });

  console.log('\n[2] 房源管理');
  await check('项目列表（含统计）', async () => { const r = await req('GET', '/api/property/projects'); return r.json.ok && r.json.data.total === 2; });
  await check('楼栋列表', async () => (await req('GET', '/api/property/buildings')).json.ok);
  await check('楼层（跳层 4→3A）', async () => {
    const r = await req('GET', '/api/property/buildings/b_1/floors');
    const f4 = (r.json.data || []).filter(x => x.floor === 4)[0];
    return r.json.ok && f4 && f4.label === '3A';
  });
  await check('房间列表', async () => { const r = await req('GET', '/api/property/rooms?size=5'); return r.json.ok && r.json.data.total > 100; });
  await check('房源统计', async () => (await req('GET', '/api/property/stats')).json.ok);
  await check('房间合并（08-10 场景已存在）', async () => {
    const r = await req('GET', '/api/property/rooms?size=2000');
    return r.json.ok && (r.json.data.list || []).some(x => (x.tags || []).indexOf('合并房源') >= 0);
  });
  await check('房间拆分（合租场景已存在）', async () => {
    const r = await req('GET', '/api/property/rooms?size=2000');
    return (r.json.data.list || []).some(x => (x.tags || []).indexOf('合租') >= 0);
  });

  console.log('\n[3] 客户档案');
  await check('客户列表', async () => { const r = await req('GET', '/api/customer/customers?size=5'); return r.json.ok && r.json.data.total >= 22; });
  await check('客户历史', async () => {
    const r1 = await req('GET', '/api/customer/customers?size=1');
    const id = r1.json.data.list[0].id;
    const r = await req('GET', '/api/customer/customers/' + id + '/history');
    return r.json.ok && Array.isArray(r.json.data.contracts);
  });
  await check('风险标记', async () => {
    const r1 = await req('GET', '/api/customer/customers?size=1');
    const id = r1.json.data.list[0].id;
    const r = await req('POST', '/api/customer/customers/' + id + '/risk', { riskFlag: '重点关注', riskNote: '自检' });
    return r.json.ok;
  });

  console.log('\n[4] 合同管理');
  await check('合同列表', async () => { const r = await req('GET', '/api/contract/contracts?size=5'); return r.json.ok && r.json.data.total >= 58; });
  await check('到期预警', async () => { const r = await req('GET', '/api/contract/expiring?months=6'); return r.json.ok && r.json.data.total > 0; });
  await check('合同复核清单', async () => (await req('GET', '/api/contract/recheck?months=3')).json.ok);
  await check('合同汇总', async () => (await req('GET', '/api/contract/summary')).json.ok);
  await check('新建合同（自动生成审批）', async () => {
    const cu = (await req('GET', '/api/customer/customers?size=1')).json.data.list[0];
    const rm = (await req('GET', '/api/property/rooms?size=2000&status=' + encodeURIComponent('空置') + '')).json.data.list;
    const room = rm[0];
    const r = await req('POST', '/api/contract/contracts', {
      customerId: cu.id, projectId: room.projectId, buildingId: room.buildingId,
      roomIds: [room.id], startDate: '2026-10-01', endDate: '2027-09-30',
      rentUnitPrice: 60, taxIncluded: true, freeMonths: 2, deposit: 20000,
      fees: { propertyUnit: 8, electricPrice: 1, waterPrice: 4, cleaning: 300, repair: 0, billingMode: '分开核算' }
    });
    if (!r.json.ok) { console.log('      → ' + r.json.msg); return false; }
    global.__newContract = r.json.data;
    return true;
  });
  await check('合同变更留痕', async () => {
    if (!global.__newContract) return false;
    const r = await req('POST', '/api/contract/contracts/' + global.__newContract.id + '/change',
      { rentUnitPrice: 66, changeReason: '自检：单价调整', taxIncluded: '是' });
    return r.json.ok && r.json.data.version === 2;
  });
  await check('合同详情', async () => {
    if (!global.__newContract) return false;
    const r = await req('GET', '/api/contract/contracts/' + global.__newContract.id + '/detail');
    return r.json.ok && Array.isArray(r.json.data.bills);
  });

  console.log('\n[5] 收费管理');
  await check('账单列表', async () => { const r = await req('GET', '/api/finance/bills?size=5'); return r.json.ok && r.json.data.total > 200; });
  await check('生成月账单', async () => {
    const r = await req('POST', '/api/finance/bills/generate', { period: '2026-10', vacantElectric: true });
    if (!r.json.ok) { console.log('      → ' + r.json.msg); return false; }
    global.__gen = r.json.data;
    return true;
  });
  await check('空置房基础电费', async () => { const r = await req('POST', '/api/finance/vacant-electric', { period: '2026-10' }); return r.json.ok; });
  await check('收款登记', async () => {
    const b = (await req('GET', '/api/finance/bills?size=20&status=' + encodeURIComponent('未收款') + '')).json.data.list[0];
    const r = await req('POST', '/api/finance/bills/' + b.id + '/pay', { amount: 100, method: '银行转账', date: '2026-10-01' });
    if (!r.json.ok) console.log('      → ' + r.json.msg);
    global.__bill = b;
    return r.json.ok && r.json.data.bill.paidAmount === 100;
  });
  await check('费用调整', async () => {
    if (!global.__bill) return false;
    const r = await req('POST', '/api/finance/bills/' + global.__bill.id + '/adjust', { reason: '自检调整', recalc: true, items: global.__bill.items });
    return r.json.ok;
  });
  await check('抄表录入', async () => {
    const m = (await req('GET', '/api/finance/meters?size=3')).json.data.list[0];
    const r = await req('POST', '/api/finance/readings', { list: [{ meterId: m.id, date: '2026-10-05', value: 99999 }] });
    return r.json.ok && r.json.data.saved === 1;
  });
  await check('抄表修正（电费差额）', async () => {
    const rds = (await req('GET', '/api/finance/readings?size=5')).json.data.list;
    const rd = rds[0];
    const r = await req('POST', '/api/finance/readings/' + rd.id + '/fix', { value: Number(rd.value) + 100, reason: '自检：录入错误修正' });
    return r.json.ok && r.json.data.diffKwh !== undefined;
  });
  await check('公摊电费分摊', async () => {
    const r = await req('POST', '/api/finance/shared-electric', { period: '2026-10', buildingId: 'b_1', floor: 7, totalKwh: 5000, price: 1, mode: 'area' });
    if (!r.json.ok) console.log('      → ' + r.json.msg);
    return r.json.ok && r.json.data.applied > 0;
  });
  await check('用电异常监控', async () => (await req('GET', '/api/finance/electric-anomaly?period=2026-10')).json.ok);
  await check('当日收款汇总', async () => (await req('GET', '/api/finance/daily')).json.ok);
  await check('月度费用汇总', async () => (await req('GET', '/api/finance/monthly?period=2026-10')).json.ok);
  await check('欠费清单', async () => { const r = await req('GET', '/api/report/arrears'); return r.json.ok && r.json.data.total > 0; });
  await check('押金台账', async () => (await req('GET', '/api/finance/deposits')).json.ok);
  await check('租金单价变更', async () => {
    const c = (await req('GET', '/api/contract/contracts?size=1')).json.data.list[0];
    const r = await req('POST', '/api/finance/contracts/' + c.id + '/price', { rentUnitPrice: 55, reason: '自检' });
    return r.json.ok;
  });
  await check('月末记账', async () => (await req('POST', '/api/finance/bills/close', { period: '2026-10' })).json.ok);

  console.log('\n[6] 发票管理');
  await check('发票列表', async () => { const r = await req('GET', '/api/invoice/invoices?size=5'); return r.json.ok && r.json.data.total >= 50; });
  await check('发票模板（4 套）', async () => { const r = await req('GET', '/api/invoice/templates'); return r.json.ok && r.json.data.length === 4; });
  await check('开票校验', async () => {
    const cu = (await req('GET', '/api/customer/customers?size=1')).json.data.list[0];
    const r = await req('POST', '/api/invoice/validate', { customerId: cu.id, type: '增值税专票', amount: 1000, category: '租金' });
    return r.json.ok && r.json.data.issues !== undefined;
  });
  await check('拆分开票', async () => {
    const b = (await req('GET', '/api/finance/bills?size=5&status=' + encodeURIComponent('已收款') + '')).json.data.list[0];
    const r = await req('POST', '/api/invoice/split', { billIds: [b.id], invoiceDate: '2026-10-01' });
    return r.json.ok;
  });
  await check('发票台账统计', async () => (await req('GET', '/api/invoice/summary')).json.ok);

  console.log('\n[7] 审批与钉钉');
  await check('审批列表', async () => { const r = await req('GET', '/api/approval/list?size=20'); return r.json.ok && r.json.data.total >= 8; });
  await check('审批通过（多级流转）', async () => {
    const ap = (await req('GET', '/api/approval/list?size=50')).json.data.list.filter(a => a.status === '审批中')[0];
    if (!ap) return false;
    const r = await req('POST', '/api/approval/' + ap.id + '/approve', { action: '通过', comment: '自检通过' });
    return r.json.ok;
  });
  await check('钉钉配置读取', async () => (await req('GET', '/api/dingtalk/config')).json.ok);
  await check('钉钉消息推送（mock）', async () => {
    const r = await req('POST', '/api/dingtalk/test', {});
    return r.json.ok && r.json.data.msg.status === '模拟发送';
  });
  await check('提醒列表', async () => { const r = await req('GET', '/api/reminders'); return r.json.ok && r.json.data.list.length > 0; });
  await check('提醒处理', async () => {
    const rm = (await req('GET', '/api/reminders')).json.data.list[0];
    return (await req('POST', '/api/reminders/' + rm.id + '/handle', { result: '自检' })).json.ok;
  });

  console.log('\n[8] 工单巡检');
  await check('工单列表', async () => (await req('GET', '/api/ops/workorders?size=5')).json.ok);
  await check('生成日常巡检', async () => {
    const r = await req('POST', '/api/ops/workorders/generate', { kind: 'daily', date: '2026-10-02' });
    return r.json.ok && r.json.data.created > 0;
  });
  await check('生成抄表任务', async () => {
    const r = await req('POST', '/api/ops/workorders/generate', { kind: 'meter', period: '2026-10' });
    if (!r.json.ok || !r.json.data.created) console.log('      → ' + JSON.stringify(r.json).slice(0,200));
    return r.json.ok && r.json.data.created > 0;
  });
  await check('生成合同履约复核', async () => {
    const r = await req('POST', '/api/ops/workorders/generate', { kind: 'contract', months: 6 });
    return r.json.ok;
  });
  await check('工单统计', async () => (await req('GET', '/api/ops/workorder-stats')).json.ok);

  console.log('\n[9] 报表与导出');
  const exports = [
    ['房源统计表', '/api/report/export/rooms?format=csv'], ['客户台账', '/api/report/export/customers?format=csv'],
    ['收费台账', '/api/report/export/bills?format=csv'], ['合同清单', '/api/report/export/contracts?format=csv'],
    ['出租明细', '/api/report/export/rent-detail?format=csv'], ['发票台账', '/api/report/export/invoices?format=csv'],
    ['收款明细', '/api/report/export/payments?format=csv'], ['押金台账', '/api/report/export/deposits?format=csv'],
    ['Excel 导出', '/api/report/export/bills?format=xls']
  ];
  for (const [name, url] of exports) {
    await check('导出 ' + name, async () => {
      const r = await req('GET', url);
      return r.status === 200 && r.raw.length > 100 && (r.headers['content-disposition'] || '').indexOf('attachment') >= 0;
    });
  }
  await check('驾驶舱统计', async () => { const r = await req('GET', '/api/report/dashboard'); return r.json.ok && r.json.data.rooms.total > 0; });
  await check('各项目平均单价', async () => { const r = await req('GET', '/api/report/price'); return r.json.ok && r.json.data.length === 2; });
  await check('空置房间统计', async () => (await req('GET', '/api/report/vacant')).json.ok);

  console.log('\n[10] 系统设置与迁移');
  await check('操作日志', async () => { const r = await req('GET', '/api/system/logs?size=10'); return r.json.ok && r.json.data.total > 0; });
  await check('业务规则读取', async () => (await req('GET', '/api/system/settings?key=biz')).json.ok);
  await check('导入房间', async () => {
    const r = await req('POST', '/api/system/import/rooms', { rows: [{ projectName: '成功新时代', buildingName: '10 栋', floor: '3A', roomNo: '99', area: 120, bizType: '办公', status: '空置' }] });
    return r.json.ok;
  });
  await check('导入抄表并校验差异', async () => {
    const m = (await req('GET', '/api/finance/meters?size=3')).json.data.list[0];
    const r = await req('POST', '/api/system/import/readings', { rows: [{ meterNo: m.meterNo, date: '2026-10-05', value: 88888 }] });
    return r.json.ok;
  });
  await check('数据核对', async () => (await req('GET', '/api/system/verify?period=2026-10')).json.ok);
  await check('重新生成提醒', async () => (await req('POST', '/api/reminders/refresh', {})).json.ok);
  await check('系统概况', async () => (await req('GET', '/api/system/stats')).json.ok);
  await check('数据备份', async () => (await req('POST', '/api/system/backup', {})).json.ok);

  console.log('\n[11] 人事 · 考勤 · 薪酬');
  const E = encodeURIComponent;
  await check('HR 驾驶舱', async () => (await req('GET', '/api/hr/dashboard')).json.ok);
  await check('员工列表', async () => (await req('GET', '/api/hr/employees?page=1&size=5')).json.ok);
  await check('员工按状态筛选', async () => (await req('GET', '/api/hr/employees?status=' + E('在职') + '&size=5')).json.ok);
  await check('班次列表', async () => (await req('GET', '/api/hr/shifts')).json.ok);
  await check('社保规则读取', async () => (await req('GET', '/api/hr/insurance')).json.ok);
  await check('考勤明细', async () => (await req('GET', '/api/hr/attendance?month=2026-09&size=5')).json.ok);
  await check('考勤月度汇总', async () => (await req('GET', '/api/hr/attendance/summary?month=2026-09')).json.ok);
  await check('考勤生成（同月重复=幂等）', async () => {
    const r = await req('POST', '/api/hr/attendance/generate', { month: '2026-09' });
    return r.json.ok;
  });
  await check('请假单列表', async () => (await req('GET', '/api/hr/leaves?size=5')).json.ok);
  await check('加班单列表', async () => (await req('GET', '/api/hr/overtimes?size=5')).json.ok);
  await check('薪资试算（不落库）', async () => (await req('POST', '/api/hr/payroll/calc', { month: '2026-09' })).json.ok);
  await check('工资表列表', async () => (await req('GET', '/api/hr/payrolls?month=2026-09&size=5')).json.ok);
  await check('薪酬月度汇总', async () => (await req('GET', '/api/hr/payroll/summary?month=2026-09')).json.ok);
  await check('人力成本趋势', async () => (await req('GET', '/api/hr/payroll/labor-cost')).json.ok);
  await check('我的工资条', async () => (await req('GET', '/api/hr/my/payrolls')).json.ok);
  await check('我的考勤', async () => (await req('GET', '/api/hr/my/attendance')).json.ok);
  await check('导出考勤月报', async () => {
    const r = await req('GET', '/api/hr/export/attendance?month=2026-09&format=csv');
    return r.status === 200 && r.raw.length > 100;
  });
  await check('导出员工名册', async () => {
    const r = await req('GET', '/api/hr/export/employees?format=csv');
    return r.status === 200 && r.raw.length > 100;
  });
  await check('导出工资表', async () => {
    const r = await req('GET', '/api/hr/export/payroll?month=2026-09&format=csv');
    return r.status === 200 && r.raw.length > 100;
  });
  await check('个税累计预扣法（12月累计=年度汇算）', async () => {
    const H = require('../lib/hr');
    let income = 0, ins = 0, sp = 0, paid = 0, total = 0;
    for (let m = 1; m <= 12; m++) {
      const t = H.calcTax(30000, 2500, 3000, m, { income: income, insurance: ins, special: sp, taxPaid: paid });
      income += 30000; ins += 2500; sp += 3000; paid += t.tax; total += t.tax;
    }
    return Math.abs(total - 29880) < 0.5;
  });
  await check('社保基数封顶保底', async () => {
    const H = require('../lib/hr');
    const pol = H.DEFAULT_INSURANCE;
    // 高于上限 → 封顶；低于下限 → 保底
    const a = H.calcInsurance({ socialBase: 100000, fundBase: 100000 }, pol);
    const b = H.calcInsurance({ socialBase: 1000, fundBase: 1000 }, pol);
    const c = H.calcInsurance({ socialBase: 10000, insureEnabled: false, fundEnabled: false }, pol);
    return a.socialBase === pol.socialMax && b.socialBase === pol.socialMin && c.personal === 0;
  });
  await check('加班费倍率（1.5/2/3 倍）', async () => {
    const H = require('../lib/hr');
    const emp = { baseSalary: 6960, postSalary: 0 }; // 时薪 = 6960/21.75/8 = 40 元
    const r = H.calcOvertimePay(emp, { otHoursWorkday: 2, otHoursWeekend: 2, otHoursHoliday: 2 });
    return Math.abs(r.total - (40 * 2 * 1.5 + 40 * 2 * 2 + 40 * 2 * 3)) < 0.01;
  });
  await check('请假计薪规则（病假 80% / 事假无薪）', async () => {
    const H = require('../lib/hr');
    return H.LEAVE_PAID['病假'] === 0.8 && H.LEAVE_PAID['事假'] === 0 && H.LEAVE_PAID['年假'] === 1;
  });
  await check('员工档案：手机号校验', async () => {
    const r = await req('POST', '/api/hr/employees', { name: '校验测试', phone: '123' });
    return !r.json.ok;
  });
  await check('员工档案：部分更新允许', async () => {
    const e = (await req('GET', '/api/hr/employees?size=1')).json.data.list[0];
    const r = await req('POST', '/api/hr/employees', { id: e.id, perfRate: 1.05 });
    return r.json.ok && r.json.data.perfRate === 1.05;
  });

  console.log('\n[12] 巡更检查（点位 / 记录 / 夜班分析 / 导入 / 导出）');
  // 纯函数层：解析与分析
  const XLS = require('../lib/xls');
  const PAT = require('../lib/patrol');
  const nodeFs = require('fs');
  const SRC = 'J:/梦想之城物业管理系统/局部小工具/巡更检查小工具/新建文件夹/';

  await check('巡更：零依赖 xls 解析（BIFF8 点位表 39 行）', async () => {
    if (!nodeFs.existsSync(SRC + '巡更点位.xls')) return true;      // 源文件缺失则跳过
    const t = XLS.readTable(nodeFs.readFileSync(SRC + '巡更点位.xls'), '巡更点位.xls');
    return t.rows.length === 39 && t.rows[0][1] === '卡号';
  });
  await check('巡更：零依赖 xls 解析（BIFF8 记录表 6765 行）', async () => {
    if (!nodeFs.existsSync(SRC + '维序巡查记录7月.xls')) return true;
    const t = XLS.readTable(nodeFs.readFileSync(SRC + '维序巡查记录7月.xls'), '维序巡查记录7月.xls');
    return t.rows.length === 6765 && String(t.rows[1][2]).indexOf('2026-07-01') === 0;
  });
  await check('巡更：夜班归属 18:30 后记当日、06:30 前记前一日', async () => {
    const a = PAT.assignShiftDate({ timeAt: new Date('2026-07-10T18:30:00').getTime() });
    const b = PAT.assignShiftDate({ timeAt: new Date('2026-07-10T23:10:00').getTime() });
    const c = PAT.assignShiftDate({ timeAt: new Date('2026-07-10T06:29:00').getTime() });
    const d = PAT.assignShiftDate({ timeAt: new Date('2026-07-10T12:00:00').getTime() });
    return a === '2026-07-10' && b === '2026-07-10' && c === '2026-07-09' && d === null;
  });
  // 【口径分歧备忘】原 Python 工具 analysis.py 自相矛盾：
  //   常量 NIGHT_START = time(18, 30)  ← ui.py 默认值也是 18:30
  //   但 assign_shift_date 判据写的是 hour >= 18 or (hour == 17 and minute >= 30)
  //   → 实际从 17:30 起算，比常量早一小时。
  // 我方按「常量 + 界面默认值」= 18:30 实现（与 ui.py:79-95 的输入框默认值一致）。
  // 若物业实际按 17:30 交班，现在可在巡更页时段框直接改成 17:30，无需改代码。
  await check('巡更：默认 18:30 口径下 17:31 判白班（原 Python 判据矛盾点）', async () => {
    return PAT.assignShiftDate({ timeAt: new Date('2026-07-10T17:31:00').getTime() }) === null;
  });
  await check('巡更：显式配 17:30 起始后 17:31 计入当日夜班', async () => {
    return PAT.assignShiftDate({ timeAt: new Date('2026-07-10T17:31:00').getTime() },
      PAT.resolveWindow({ start: '17:30', end: '06:30' })) === '2026-07-10';
  });
  await check('巡更：漏检判定正确', async () => {
    const pts = [{ code: 'A', name: '点位A' }, { code: 'B', name: '点位B' }, { code: 'C', name: '点位C' }];
    const recs = [{ seq: 1, timeAt: new Date('2026-07-10T19:00:00').getTime(), pointCode: 'A', person: '夜班-甲' },
    { seq: 2, timeAt: new Date('2026-07-10T19:10:00').getTime(), pointCode: 'B', person: '夜班-甲' }];
    const r = PAT.analyze({ points: pts, records: recs });
    return r.daily.length === 1 && r.daily[0].totalExpected === 3 && r.daily[0].totalActual === 2 &&
      r.daily[0].totalMissed === 1 && r.daily[0].missed[0] === 'C' && Math.abs(r.daily[0].coverageRate - 66.67) < 0.01;
  });
  await check('巡更：月度汇总与 TOP 漏检点', async () => {
    const pts = [{ code: 'A', name: '点位A' }, { code: 'B', name: '点位B' }];
    const mk = (d, codes) => codes.map((c, i) => ({ seq: i, timeAt: new Date(d + 'T19:0' + i + ':00').getTime(), pointCode: c, person: '夜班-甲' }));
    const recs = mk('2026-07-10', ['A']).concat(mk('2026-07-11', ['A']));
    const r = PAT.analyze({ points: pts, records: recs });
    const m = r.monthly;
    return m.totalNights === 2 && m.totalExpected === 4 && m.totalActual === 2 && m.totalMissed === 2 &&
      m.coverageRate === 50 && m.topMissed[0].name === '点位B' && m.topMissed[0].count === 2;
  });
  await check('巡更：楼层排序（设备房排最后、高层在前）', async () => {
    const k1 = PAT.pointSortKey('18F东面步梯间'), k2 = PAT.pointSortKey('1F东面步梯间'), k3 = PAT.pointSortKey('19设备房'), k4 = PAT.pointSortKey('-1 西面步梯间');
    return k1 < k2 && k2 < k4 && k3 === 999;
  });
  await check('巡更：时间解析支持 6 种格式', async () => {
    const a = PAT.parseTime('2026-07-01 08:25:30'), b = PAT.parseTime('2026/07/01 08:25:30');
    const c = PAT.parseTime('2026-07-01 08:25'), d = PAT.parseTime('2026-07-01'), e = PAT.parseTime('2026/07/01');
    return !!(a && b && c && d && e) && a.getHours() === 8 && PAT.parseTime('乱码') === null;
  });

  // 接口层
  let patrolMonth = '2026-07';
  await check('巡更：概览接口返回统计口径', async () => {
    const r = await req('GET', '/api/patrol/overview');
    if (!r.json.ok) return false;
    patrolMonth = r.json.data.dataMonth || r.json.data.month;
    return r.json.data.pointCount > 0 && r.json.data.recordCount > 0;
  });
  await check('巡更：点位列表非空且已按楼层排序', async () => {
    const r = await req('GET', '/api/patrol/points?size=200&sort=sortKey&order=asc');
    const l = r.json.data.list || [];
    return r.json.ok && l.length > 0 && l[0].sortKey <= l[l.length - 1].sortKey;
  });
  await check('巡更：人员列表含班次标记', async () => {
    const r = await req('GET', '/api/patrol/persons?size=50');
    const l = r.json.data.list || [];
    return r.json.ok && l.length > 0 && l.some(p => p.shift === '夜班');
  });
  await check('巡更：记录列表支持班次筛选', async () => {
    const n = await req('GET', '/api/patrol/records?size=5&shift=' + encodeURIComponent('夜班'));
    const d = await req('GET', '/api/patrol/records?size=5&shift=' + encodeURIComponent('白班'));
    return n.json.ok && d.json.ok && n.json.data.total > 0 && d.json.data.total > 0 &&
      (n.json.data.list[0] || {}).shift === '夜班';
  });
  await check('巡更：分析接口（夜班）', async () => {
    const r = await req('POST', '/api/patrol/analyze', { start: patrolMonth + '-01', end: patrolMonth + '-28', mode: 'night' });
    const d = r.json.data || {};
    return r.json.ok && d.daily.length > 0 && d.monthly.totalExpected > 0 &&
      d.monthly.totalActual <= d.monthly.totalExpected &&
      Math.abs(d.monthly.coverageRate - d.monthly.totalActual / d.monthly.totalExpected * 100) < 0.02;
  });
  await check('巡更：分析接口（白班）', async () => {
    const r = await req('POST', '/api/patrol/analyze', { start: patrolMonth + '-01', end: patrolMonth + '-28', mode: 'day' });
    return r.json.ok && r.json.data.daily.length > 0;
  });
  await check('巡更：日报接口含漏检点清单', async () => {
    // 取月报中第一个有夜班记录的班次日（最后一条记录可能落在白班，其班次日无夜班）
    const mo = await req('GET', '/api/patrol/monthly?month=' + patrolMonth + '&mode=night');
    const d0 = ((mo.json.data || {}).daily || [])[0];
    const date = d0 ? d0.shiftDate : patrolMonth + '-15';
    const r = await req('GET', '/api/patrol/daily?date=' + date + '&mode=night');
    if (!r.json.ok) return false;
    const d = r.json.data;
    return !d.empty && d.report.totalExpected > 0 && Array.isArray(d.report.missedPoints) && (d.records || []).length > 0;
  });
  await check('巡更：月报接口含人员统计', async () => {
    const r = await req('GET', '/api/patrol/monthly?month=' + patrolMonth + '&mode=night');
    const d = r.json.data || {};
    return r.json.ok && d.daily.length > 0 && (d.monthly.personStats || []).length > 0;
  });
  await check('巡更：导出日报 Excel（SpreadsheetML）', async () => {
    const r = await req('GET', '/api/patrol/export?type=daily&format=xls&mode=night&date=' + patrolMonth + '-15');
    return r.status === 200 && r.raw.indexOf('<Workbook') >= 0 && r.raw.indexOf('巡检明细') >= 0;
  });
  await check('巡更：导出月报 Excel 含两张表', async () => {
    const r = await req('GET', '/api/patrol/export?type=monthly&format=xls&mode=night&month=' + patrolMonth);
    return r.status === 200 && (r.raw.match(/<Worksheet/g) || []).length >= 2;
  });
  await check('巡更：导出记录 CSV 带 BOM', async () => {
    const r = await req('GET', '/api/patrol/export?type=records&format=csv&start=' + patrolMonth + '-01&end=' + patrolMonth + '-02');
    return r.status === 200 && r.raw.charCodeAt(0) === 0xFEFF && r.raw.indexOf('班次日') >= 0;
  });
  await check('巡更：点位新增 + 校验重复卡号', async () => {
    const code = 'TEST' + Date.now();
    const add = await req('POST', '/api/patrol/points', { code: code, name: '自检临时点位', status: '启用' });
    const dup = await req('POST', '/api/patrol/points', { code: code, name: '重复卡号' });
    let removed = true;
    if (add.json.ok) { const del = await req('DELETE', '/api/patrol/points/' + add.json.data.id); removed = del.json.ok; }
    return add.json.ok && !dup.json.ok && removed;
  });
  await check('巡更：导入非 Excel 文件被拒绝', async () => {
    const r = await req('POST', '/api/patrol/import/points', { fileName: 'bad.xls', dataBase64: Buffer.from('not an excel').toString('base64') });
    return r.status === 400 && !r.json.ok;
  });
  await check('巡更：导入真实点位表', async () => {
    if (!nodeFs.existsSync(SRC + '巡更点位.xls')) return true;
    const b64 = nodeFs.readFileSync(SRC + '巡更点位.xls').toString('base64');
    const r = await req('POST', '/api/patrol/import/points', { fileName: '巡更点位.xls', dataBase64: b64, mode: 'replace' });
    return r.json.ok && r.json.data.points > 0 && r.json.data.persons > 0;
  });
  await check('巡更：导入真实记录表（覆盖）', async () => {
    if (!nodeFs.existsSync(SRC + '维序巡查记录7月.xls')) return true;
    const b64 = nodeFs.readFileSync(SRC + '维序巡查记录7月.xls').toString('base64');
    const r = await req('POST', '/api/patrol/import/records', { fileName: '维序巡查记录7月.xls', dataBase64: b64, mode: 'replace' });
    return r.json.ok && r.json.data.imported > 0 && r.json.data.total === r.json.data.imported;
  });
  await check('巡更：导入批次留痕', async () => {
    const r = await req('GET', '/api/patrol/batches');
    return r.json.ok && (r.json.data || []).length > 0;
  });

  console.log('\n[13] 权限隔离');
  await check('客服账号不可见组织管理', async () => {
    const lg = await req('POST', '/api/auth/login', { username: 'kefu', password: '123456' });
    const ck = (lg.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    const r = await new Promise(res => {
      const rr = http.request({ hostname: HOST, port: PORT, path: '/api/org/users', method: 'GET', headers: { Cookie: ck } }, res2 => {
        let b = ''; res2.on('data', c => b += c); res2.on('end', () => res({ status: res2.statusCode, body: b }));
      }); rr.end();
    });
    return r.status === 403;
  });
  await check('薪酬保密：普通角色不可看全员薪资', async () => {
    const lg = await req('POST', '/api/auth/login', { username: 'gongcheng', password: '123456' });
    const ck = (lg.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    const r = await new Promise(res => {
      const rr = http.request({ hostname: HOST, port: PORT, path: '/api/hr/payrolls?size=3', method: 'GET', headers: { Cookie: ck } }, res2 => {
        let b = ''; res2.on('data', c => b += c); res2.on('end', () => res({ status: res2.statusCode, body: b }));
      }); rr.end();
    });
    return r.status === 403;
  });
  await check('薪酬保密：普通角色可看本人工资条', async () => {
    const lg = await req('POST', '/api/auth/login', { username: 'kefu', password: '123456' });
    const ck = (lg.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    const r = await new Promise(res => {
      const rr = http.request({ hostname: HOST, port: PORT, path: '/api/hr/my/payrolls', method: 'GET', headers: { Cookie: ck } }, res2 => {
        let b = ''; res2.on('data', c => b += c); res2.on('end', () => res({ status: res2.statusCode, body: b }));
      }); rr.end();
    });
    return r.status === 200;
  });
  await check('人事专员可进行薪资核算', async () => {
    const lg = await req('POST', '/api/auth/login', { username: 'renshi', password: '123456' });
    const ck = (lg.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    const r = await new Promise(res => {
      const rr = http.request({ hostname: HOST, port: PORT, path: '/api/hr/payrolls?size=3', method: 'GET', headers: { Cookie: ck } }, res2 => {
        let b = ''; res2.on('data', c => b += c); res2.on('end', () => res({ status: res2.statusCode, body: b }));
      }); rr.end();
    });
    return r.status === 200;
  });
  await check('巡更隔离：财务账号无巡更权限', async () => {
    const lg = await req('POST', '/api/auth/login', { username: 'caiwu', password: '123456' });
    const ck = (lg.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    const r = await new Promise(res => {
      const rr = http.request({ hostname: HOST, port: PORT, path: '/api/patrol/points?size=1', method: 'GET', headers: { Cookie: ck } }, res2 => {
        let b = ''; res2.on('data', c => b += c); res2.on('end', () => res({ status: res2.statusCode, body: b }));
      }); rr.end();
    });
    return r.status === 403;
  });
  await check('巡更隔离：客服主管可看不可导入', async () => {
    const lg = await req('POST', '/api/auth/login', { username: 'kefu', password: '123456' });
    const ck = (lg.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    const get = p2 => new Promise(res => {
      const rr = http.request({ hostname: HOST, port: PORT, path: p2, method: 'GET', headers: { Cookie: ck } }, res2 => {
        let b = ''; res2.on('data', c => b += c); res2.on('end', () => res({ status: res2.statusCode, body: b }));
      }); rr.end();
    });
    const a = await get('/api/patrol/points?size=1');
    const b = await new Promise(res => {
      const body = JSON.stringify({ fileName: 'x.xls', dataBase64: 'AAA' });
      const rr = http.request({ hostname: HOST, port: PORT, path: '/api/patrol/import/points', method: 'POST', headers: { Cookie: ck, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res2 => {
        let b = ''; res2.on('data', c => b += c); res2.on('end', () => res({ status: res2.statusCode, body: b }));
      }); rr.write(body); rr.end();
    });
    return a.status === 200 && b.status === 403;
  });
  await check('巡更授权：工程主管可导入', async () => {
    const lg = await req('POST', '/api/auth/login', { username: 'gongcheng', password: '123456' });
    const ck = (lg.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    const r = await new Promise(res => {
      const rr = http.request({ hostname: HOST, port: PORT, path: '/api/patrol/analyze', method: 'POST', headers: { Cookie: ck, 'Content-Type': 'application/json', 'Content-Length': 2 } }, res2 => {
        let b = ''; res2.on('data', c => b += c); res2.on('end', () => res({ status: res2.statusCode, body: b }));
      }); rr.write('{}'); rr.end();
    });
    return r.status === 200 || r.status === 400;   // 400 = 已通过权限，仅缺少参数
  });
  await check('工程账号可抄表', async () => {
    const lg = await req('POST', '/api/auth/login', { username: 'gongcheng', password: '123456' });
    const ck = (lg.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    const r = await new Promise(res => {
      const rr = http.request({ hostname: HOST, port: PORT, path: '/api/finance/meters?size=3', method: 'GET', headers: { Cookie: ck } }, res2 => {
        let b = ''; res2.on('data', c => b += c); res2.on('end', () => res({ status: res2.statusCode, body: b }));
      }); rr.end();
    });
    return r.status === 200;
  });

  /* ---------- [14] 多电脑部署加固 ---------- */
  await check('登录 Cookie 为 HttpOnly + SameSite（防 XSS 窃取会话）', async () => {
    const lg = await req('POST', '/api/auth/login', { username: 'admin', password: '123456' });
    const c = (lg.headers['set-cookie'] || []).join(';');
    return /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c);
  });
  await check('附件上传走通存储抽象层并可回读', async () => {
    // 1x1 png（透明）
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const up = await req('POST', '/api/system/upload', {
      fileName: '__selftest__.png',
      dataBase64: 'data:image/png;base64,' + png,
      bizType: 'selftest'
    });
    if (!up.json.ok || !up.json.data || !up.json.data.url) return false;
    const rec = up.json.data;
    // url 应带 storage 标识（local 或 qiniu），证明走的是抽象层而非硬编码写盘
    const hasStorage = !!rec.storage;
    const nameOk = /__selftest__/.test(rec.name || rec.key || '');
    // 清理附件记录与文件
    await req('DELETE', '/api/system/attachments/' + rec.id);
    if (rec.key) {
      const fsx = require('fs');
      const p = require('path');
      const f = p.join(__dirname, '..', 'uploads', String(rec.key).split('/').join(p.sep));
      if (fsx.existsSync(f)) { try { fsx.unlinkSync(f); } catch (e) { } }
    }
    return hasStorage && nameOk;
  });

  await check('会话已落盘（含登录 IP 与 UA，便于多机审计）', async () => {
    const f = path.join(__dirname, '..', 'data', 'sessions.json');
    if (!fs.existsSync(f)) return false;
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(arr) && arr.length > 0 && !!arr[0].expireAt && Object.prototype.hasOwnProperty.call(arr[0], 'ip');
  });
  await check('在线会话列表仅 system:view 可见', async () => {
    const admin = await req('POST', '/api/auth/login', { username: 'admin', password: '123456' });
    const ckA = (admin.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    const okR = await req('GET', '/api/auth/online', null, { Cookie: ckA });
    const gc = await req('POST', '/api/auth/login', { username: 'gongcheng', password: '123456' });
    const ckG = (gc.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    const noR = await req('GET', '/api/auth/online', null, { Cookie: ckG });
    return okR.status === 200 && Array.isArray(okR.body.data) && noR.status === 403;
  });
  await check('强制下线后目标 token 立即失效', async () => {
    const target = await req('POST', '/api/auth/login', { username: 'renshi', password: '123456' });
    const ckT = (target.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    const before = await req('GET', '/api/auth/me', null, { Cookie: ckT });
    const admin = await req('POST', '/api/auth/login', { username: 'admin', password: '123456' });
    const ckA = (admin.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    const uid = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'users.json'), 'utf8'))
      .find(u => u.username === 'renshi').id;
    const k = await req('POST', '/api/auth/online/kick', { userId: uid }, { Cookie: ckA, 'Content-Type': 'application/json' });
    const after = await req('GET', '/api/auth/me', null, { Cookie: ckT });
    return before.status === 200 && before.body.data && k.status === 200 && after.body.data === null;
  });
  await check('数据目录存在单实例锁（防止两台机器互相覆盖数据）', async () => {
    const inst = require('../lib/instance');
    const dataDir = path.join(__dirname, '..', 'data');
    const f = path.join(dataDir, '.instance.lock');
    if (!fs.existsSync(f)) return false;
    const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
    return !!cur.pid && !!cur.host && !!cur.startedAt && inst.pidAlive(cur.pid);
  });
  await check('第二实例被锁拒绝（同一数据目录）', async () => {
    // 注意：不能用 spawnSync —— 在 Y 盘工作区下会触发 EBUSY，必须异步 spawn
    const { spawn } = require('child_process');
    const root = path.join(__dirname, '..');
    return await new Promise(resolve => {
      const p = spawn(process.execPath, [path.join(root, 'server.js'), '8099'], { cwd: root });
      let out = '';
      p.stdout.on('data', d => out += d);
      p.stderr.on('data', d => out += d);
      const timer = setTimeout(() => { try { p.kill(); } catch (e) { } }, 15000);
      p.on('close', () => { clearTimeout(timer); resolve(/数据目录已被占用/.test(out) && /拒绝启动/.test(out)); });
      p.on('error', () => { clearTimeout(timer); resolve(false); });
    });
  });

  /* ---------- [15] 收入台账（对齐公司真实月表格体系） ---------- */
  const I = require('../lib/income');
  await check('收入科目 12 类（与公司收入日报表头一致）', async () => {
    const r = await req('GET', '/api/income/daily?month=2026-08');
    return r.json.ok && r.json.data.cats.length === 12 &&
      ['定金', '新签租金物业', '续费租金物业', '照明电费', '空调电费', '月租停车费',
        '临时停车', '套内保洁', '保洁部卖废品', '会议室', '其他'].every(n =>
          r.json.data.cats.some(c => c.name === n));
  });
  await check('收入日报按天铺满整月且含日汇总列', async () => {
    const r = await req('GET', '/api/income/daily?month=2026-08');
    const d = r.json.data;
    return d.days.length === 31 && d.days[30].date === '2026-08-31' &&
      d.days.every(x => x.total !== undefined);
  });
  await check('租金递增：合同条款「第三年起每年递增6%」解析正确', async () => {
    const rule = I.parseEscalate('计租日起，第三年起每年递增6%');
    return rule.type === 'annual' && rule.fromYear === 3 && rule.rate === 6;
  });
  await check('租金递增：兼容「每2年10%」与「不递增」', async () => {
    const a = I.parseEscalate('每2年10％');
    const b = I.parseEscalate('不递增');
    return a.type === 'everyN' && a.years === 2 && a.rate === 10 && b.type === 'none';
  });
  await check('租金递增：100 元三年复合到 119.1（100→106→112.36→119.1）', async () => {
    const c = { rentUnitPrice: 100, startDate: '2026-01-15', escalateText: '第三年起每年递增6%' };
    const p1 = I.rentPriceOf(c, '2026-01').price;
    const p3 = I.rentPriceOf(c, '2028-01').price;
    const p5 = I.rentPriceOf(c, '2030-01').price;
    return p1 === 100 && Math.abs(p3 - 106) < 0.01 && Math.abs(p5 - 119.1) < 0.01;
  });
  await check('账单生成使用递增后单价（buildBill 返回 escalate 信息）', async () => {
    const B = require('../lib/billing');
    const c = {
      id: 'c_test', rentUnitPrice: 100, area: 100, roomIds: [],
      startDate: '2026-01-15', escalateText: '第三年起每年递增6%',
      fees: { propertyUnit: 75, waterPrice: 4, electricPrice: 1, cleaning: 0, repair: 0 }
    };
    // buildBill 已改 async（内部要读表算水电），必须 await；
    // 传入的假 db 要提供 all/one/where 三个方法的「Promise 版」实现
    const fakeDb = {
      where: async () => [], one: async () => null, all: async () => []
    };
    const b26 = await B.buildBill(fakeDb, c, '2026-01');
    const b28 = await B.buildBill(fakeDb, c, '2028-01');
    return b26.items[0].price === 100 && Math.abs(b28.items[0].price - 106) < 0.01
      && b28.escalate && b28.escalate.times === 1;
  });
  await check('停车费明细接口（含车牌/车量/单价）', async () => {
    const r = await req('GET', '/api/income/parkingItems?size=5');
    return r.json.ok && Array.isArray(r.json.data.list);
  });
  await check('停车费汇总区分月租与临时停车', async () => {
    const r = await req('GET', '/api/income/parkingSummary');
    return r.json.ok && r.json.data.rows.every(x =>
      x.monthly !== undefined && x.temp !== undefined && x.total === Math.round((x.monthly + x.temp) * 100) / 100);
  });
  await check('上期尾款汇总区分未结清与已结清', async () => {
    const r = await req('GET', '/api/income/arrearsSummary');
    return r.json.ok && typeof r.json.data.unsettled === 'number' && typeof r.json.data.settled === 'number';
  });
  await check('支出台账按月汇总且含收款人字段', async () => {
    const r = await req('GET', '/api/income/expenseSummary');
    return r.json.ok && r.json.data.cats.length === 6 && r.json.data.rows.length > 0;
  });
  await check('水电充值台账识别退费（负数金额）', async () => {
    const r = await req('GET', '/api/income/recharges?size=100');
    return r.json.ok && r.json.data.totalCount > 0 && typeof r.json.data.refundTotal === 'number';
  });
  await check('月表格一键生成 7 张表（含表1三sheet与差额表、表9六sheet）', async () => {
    const r = await req('GET', '/api/income/monthlyTables?month=2026-08');
    if (!r.json.ok) return false;
    const t = r.json.data.tables;
    const t1 = t.filter(x => x.key === 't1')[0];
    const t9 = t.filter(x => x.key === 't9')[0];
    const t8 = t.filter(x => x.key === 't8')[0];
    return t.length === 7 && t1 && t1.sheets.length === 3 &&
      t1.sheets[2].name === '差额' &&
      t9 && t9.sheets.length === 6 &&
      t8 && t8.sheets.some(s => s.name === '季度汇总');
  });
  await check('月表格导出为多 sheet Excel（≥9 个工作表）', async () => {
    const r = await new Promise(res => {
      const rr = http.request({
        hostname: HOST, port: PORT, path: '/api/income/export/monthlyTables?month=2026-08',
        method: 'GET', headers: { Cookie: COOKIE }
      }, res2 => {
        let b = ''; res2.on('data', c => b += c);
        res2.on('end', () => res({ status: res2.statusCode, body: b }));
      }); rr.end();
    });
    if (r.status !== 200) return false;
    const n = (r.body.match(/<Worksheet ss:Name="/g) || []).length;
    return n >= 9;
  });
  await check('收入台账导入真实「缴费账单.xlsx」（含退费识别）', async () => {
    const fsx = require('fs');
    const src = 'Y:/物业实际使用的报表及合同/缴费账单.xlsx';
    if (!fsx.existsSync(src)) return false;
    const b64 = fsx.readFileSync(src).toString('base64');
    // 用 append 模式：导入已做幂等（同一笔不会重复入库），
    // 若用 cover 会把演示种子数据清掉，污染演示环境
    const r = await req('POST', '/api/income/import/recharge',
      { fileName: '缴费账单.xlsx', fileBase64: b64, mode: 'append' },
      { 'Content-Type': 'application/json' });
    if (!r.json.ok) return false;
    const q = await req('GET', '/api/income/recharges?size=500');
    if (!q.json.ok) return false;
    // 首次导入会新增约 75 条；重复导入则新增 0 条且 skipped>0（两种都算通过，
    // 因为关键断言是「真实文件能解析 + 退费可识别 + 不产生重复」）
    const real = (r.json.data.count > 0 && r.json.data.count >= 70) ||
      (r.json.data.count === 0 && r.json.data.skipped >= 70);
    return real && q.json.data.totalCount >= 70 && q.json.data.refundTotal < 0;
  });
  await check('收入台账权限隔离：工程主管无收入台账权限', async () => {
    const lg = await req('POST', '/api/auth/login', { username: 'gongcheng', password: '123456' });
    const ck = (lg.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    const r = await req('GET', '/api/income/daily?month=2026-08', null, { Cookie: ck });
    return r.status === 403;
  });
  await check('收入台账权限隔离：出纳可管不可导出', async () => {
    const lg = await req('POST', '/api/auth/login', { username: 'chuna', password: '123456' });
    const ck = (lg.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    const view = await req('GET', '/api/income/daily?month=2026-08', null, { Cookie: ck });
    const exp = await req('GET', '/api/income/export/daily?month=2026-08', null, { Cookie: ck });
    return view.status === 200 && exp.status === 403;
  });
  await check('多 sheet xlsx 解析（表5 真实文件 4 个工作表全读出）', async () => {
    const X = require('../lib/xls');
    const src = 'Y:/物业实际使用的报表及合同/月表格/（表5）开票明细.xlsx';
    if (!fs.existsSync(src)) return false;
    const r = X.readTable(fs.readFileSync(src), '.xlsx');
    return r.sheetNames.length === 4 && r.rows.length >= 100;
  });

  /* ---------- 16. 表9「其他费用」六张台账 ---------- */
  await check('表9 台账元数据为 6 类（与真实其他费用.xlsx 的 6 个 sheet 一致）', async () => {
    const r = await req('GET', '/api/income/otherKinds');
    if (!r.json.ok) return false;
    const names = r.json.data.kinds.map(k => k.name);
    return names.length === 6 &&
      ['其他收入', '其他支出', '中介费', '会议室收入', '垫付收入', '垫付支出']
        .every(n => names.indexOf(n) >= 0);
  });
  await check('表9 六张台账各自可按月分段汇总', async () => {
    const r = await req('GET', '/api/income/otherSummary?start=2026-07-01&end=2026-09-30');
    if (!r.json.ok) return false;
    const ts = r.json.data.tables;
    return ts.length === 6 && ts.every(t => Array.isArray(t.months) && t.months.length === 3);
  });
  await check('表9 中介费取「费用总金额」而非 amount 作口径', async () => {
    const r = await req('GET', '/api/income/otherSummary?start=2026-07-01&end=2026-09-30');
    const ag = (r.json.data.tables || []).filter(t => t.key === 'agency')[0];
    if (!ag) return false;
    // 接口返回的合计必须等于该月 amount 之和（otherAmount 对中介费走 totalAmount）
    const sum = ag.months.reduce((s, m) => s + Number(m.amount || 0), 0);
    return Math.abs(sum - Number(ag.rangeTotal)) < 0.01;
  });
  await check('表9 明细按 kind 过滤只返回本台账数据', async () => {
    const r = await req('GET', '/api/income/otherItems?kind=' + encodeURIComponent('中介费') + '&size=200');
    if (!r.json.ok) return false;
    const list = r.json.data.list || [];
    return list.length > 0 && list.every(x => x.kind === '中介费');
  });
  await check('表9 中介费「未付金额」由服务端算（费用总金额−已付）', async () => {
    const r = await req('POST', '/api/income/otherItems', {
      kind: '中介费', companyName: '__自检中介费__', occurDate: '2026-08-15',
      totalAmount: 10000, paidAmount: 6000, amount: 6000
    });
    if (!r.json.ok) return false;
    const created = r.json.data;
    const okCalc = Number(created.unpaidAmount) === 4000;
    await req('DELETE', '/api/income/otherItems/' + created.id);
    return okCalc;
  });
  await check('表9 导出为 6 个 sheet 的多表 Excel', async () => {
    const r = await req('GET', '/api/income/export/other?start=2026-07-01&end=2026-09-30');
    if (r.status !== 200 || !/<Worksheet/.test(String(r.raw || ''))) return false;
    const n = (String(r.raw).match(/<Worksheet /g) || []).length;
    return n === 6;
  });

  /* ---------- 17. 表8 预提款季度分段 ---------- */
  await check('预提款分段接口把预提款从实际支出中正确拆出', async () => {
    const r = await req('GET', '/api/income/prepaidSegments?start=2026-07-01&end=2026-09-30');
    if (!r.json.ok) return false;
    const d = r.json.data;
    if (!Array.isArray(d.segments) || d.segments.length !== 3) return false;
    // 恒等式：每月 预提 + 实际 = 合计，且总计 = 各月之和
    const idOK = d.segments.every(s => Math.abs((s.prepaid + s.actual) - s.total) < 0.01);
    const sumOK = Math.abs(d.segments.reduce((a, s) => a + s.total, 0) - d.totalAll) < 0.01;
    return idOK && sumOK;
  });
  await check('支出汇总无浮点尾数（曾出现 56087.289999999999）', async () => {
    const r = await req('GET', '/api/income/expenseSummary?start=2026-05-01&end=2026-10-31');
    if (!r.json.ok) return false;
    // 所有金额最多 2 位小数，且不含 9999 尾数
    const vals = [];
    r.json.data.rows.forEach(x => {
      Object.keys(x.byCat).forEach(k => vals.push(x.byCat[k]));
      vals.push(x.total);
    });
    return vals.every(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6);
  });

  /* ---------- 18. register 的 compute 派生字段真正生效 ---------- */
  await check('CRUD compute 生效：停车费金额 = 车量×单价×数量', async () => {
    const r = await req('POST', '/api/income/parkingItems', {
      companyName: '__自检停车费__', carCount: 3, price: 396, qty: 2
    });
    if (!r.json.ok) return false;
    const created = r.json.data;
    const okCalc = Number(created.amount) === 3 * 396 * 2;
    await req('DELETE', '/api/income/parkingItems/' + created.id);
    return okCalc;
  });
  await check('CRUD compute 在更新时同样重算', async () => {
    const r = await req('POST', '/api/income/parkingItems', {
      companyName: '__自检停车费改__', carCount: 1, price: 100, qty: 1
    });
    if (!r.json.ok) return false;
    const created = r.json.data;
    const u = await req('POST', '/api/income/parkingItems', {
      id: created.id, companyName: '__自检停车费改__', carCount: 4, price: 50, qty: 2
    });
    const okCalc = u.json.ok && Number(u.json.data.amount) === 4 * 50 * 2;
    await req('DELETE', '/api/income/parkingItems/' + created.id);
    return okCalc;
  });

  /* ---------- 19. 侧边栏菜单完整性 ---------- */
  await check('登录响应即带 menus（前端不必回退硬编码菜单）', async () => {
    const r = await req('POST', '/api/auth/login', { username: 'admin', password: '123456' });
    if (!r.json.ok) return false;
    const menus = r.json.data.user.menus;
    return Array.isArray(menus) && menus.length >= 14 &&
      menus.some(m => m.key === 'income') && menus.some(m => m.key === 'hr') &&
      menus.some(m => m.key === 'patrol');
  });
  await check('前端兜底菜单与后端 menusOf 保持一致（防新增模块侧边栏缺项）', () => {
    const fsx = require('fs');
    const html = fsx.readFileSync(__dirname + '/../public/index.html', 'utf8');
    const appjs = fsx.readFileSync(__dirname + '/../public/js/app.js', 'utf8');
    const routes = fsx.readFileSync(__dirname + '/../routes/auth.js', 'utf8');
    const backKeys = (routes.match(/key: '([a-z_]+)', name: '[^']+', icon/g) || [])
      .map(s => s.match(/key: '([a-z_]+)'/)[1]);
    const frontKeys = (appjs.match(/key: '([a-z_]+)', name:/g) || [])
      .map(s => s.match(/key: '([a-z_]+)'/)[1]);
    const missing = backKeys.filter(k => frontKeys.indexOf(k) < 0);
    return backKeys.length >= 14 && missing.length === 0 && /views6\.js/.test(html);
  });

  await check('充值台账无重复记录（导入幂等：曾同一笔被重复入库 7 次）', async () => {
    const r = await req('GET', '/api/income/recharges?size=1000');
    if (!r.json.ok) return false;
    const list = r.json.data.list || [];
    const seen = {};
    let dup = 0;
    list.forEach(x => {
      const k = [String(x.time || '').trim(),
        String(x.orderNo || '').trim() || (String(x.meterNo || '') + '@' + String(x.amount || '')),
        Number(x.amount || 0)].join('|');
      if (seen[k]) dup++; else seen[k] = true;
    });
    return dup === 0;
  });

  /* ---------- 20. 残留清理 + 面积自洽（2026-10-04 加） ---------- */
  // 必须在最后跑：前面的写操作测试刚造完数据，此时清最干净
  const cleaned = CLEAN.run();
  console.log('\n[20] 自检残留清理');
  if (cleaned.note === '云端模式跳过') {
    console.log('  – 跳过（' + cleaned.note + '）');
  } else {
    console.log('  ✔ 清理自检产物 ' + cleaned.total + ' 行' + (cleaned.contracts ? '（合同 ' + cleaned.contracts + ' 份）' : ''));
  }

  await check('自检零残留（跑完不再留测试数据）', () => {
    const r = req0('contracts');
    const bad = r ? r.filter(CLEAN.isTest) : [];
    if (bad.length) { console.log('      → 仍残留 ' + bad.length + ' 行：' + bad.slice(0, 3).map(x => x.code || x.id).join(', ')); return false; }
    return true;
  });
  await check('合同面积不超房源面积（出租率不会出现 100%+）', () => {
    const cts = req0('contracts'), rms = req0('rooms');
    if (!cts || !rms) return true;   // 云端模式读不到就跳过
    const areaOf = id => (rms.find(r => r.id === id) || {}).area || 0;
    // 每份合同占用的房源面积：按 roomIds 逐个取房源实际面积，不用合同自报面积
    // （曾因 62 份重复合同自报同一房间 322㎡，累加出 19964㎡ > T3 实际 19365㎡）
    const used = new Map();
    for (const c of cts) {
      if (!Array.isArray(c.roomIds)) continue;
      for (const rid of c.roomIds) used.set(rid, (used.get(rid) || 0) + 1);
    }
    const dup = [...used.entries()].filter(([, n]) => n > 1);
    if (dup.length) {
      console.log('      → ' + dup.length + ' 个房间被多份合同占用：' +
        dup.slice(0, 3).map(([id, n]) => id + '×' + n).join(', '));
      return false;
    }
    return true;
  });

  /* ================= [21] 合同模板比对 · 审批内嵌 + OCR 通道 ================= */
  // 独立于起服务的测试：这里只验证「纯函数级」的判定口径与解析分流，
  // 端到端（含起服务、硬拦截、强制通道）由 scripts/test_approval_compare.js 覆盖。
  console.log('\n[21] 合同模板比对 · 审批内嵌 + OCR 通道');
  const AC = require('../lib/approvalCompare');

  await check('硬拦截口径：无差异/仅提示项 → 放行', () => {
    const a = AC.verdictOf({ ok: true, stat: { high: 0, medium: 0, low: 0, total: 0 } });
    const b = AC.verdictOf({ ok: true, stat: { high: 0, medium: 0, low: 2, total: 2 } });
    return a.block === false && b.block === false;
  });

  await check('硬拦截口径：有建议项/严重项 → 阻断', () => {
    const a = AC.verdictOf({ ok: true, stat: { high: 0, medium: 1, low: 0, total: 1 } });
    const b = AC.verdictOf({ ok: true, stat: { high: 1, medium: 0, low: 0, total: 1 } });
    return a.block === true && b.block === true;
  });

  await check('硬拦截口径：需OCR/解析失败 → 阻断；未比对 → 放行', () => {
    return AC.verdictOf({ ok: false, needOcr: true, error: 'x' }).block === true &&
      AC.verdictOf({ ok: false, error: 'x' }).block === true &&
      AC.verdictOf(null).block === false;
  });

  await check('OCR 凭据缺失时优雅降级（不抛异常）', async () => {
    const ocr = require('../lib/ocr');
    const r = await ocr.recognize(Buffer.from('x'), 'a.jpg');
    return r && r.ok === false && !!r.code;
  });

  await check('OCR 响应映射：DetectedText 拼接 + 低置信度标记', () => {
    const ocr = require('../lib/ocr');
    const m = ocr.mapGeneral({ DetectedText: [
      { Text: '第一条 承租方：甲公司', Confidence: 98 },
      { Text: '手写签名', Confidence: 60 }
    ] });
    return m.text.indexOf('承租方') >= 0 && m.lowConfCount === 1;
  });

  await check('docparse 分流：图片/扫描PDF走OCR，有文本层不浪费额度', async () => {
    const dp = require('../lib/docparse');
    if (dp.needsOcr(dp.extract(Buffer.from('x'), 'a.jpg')) !== true) return false;
    if (dp.needsOcr(dp.extract(Buffer.from('%PDF-1.4 zz'), 'a.pdf')) !== true) return false;
    const d = await dp.extractAsync(Buffer.from('房屋租赁合同\n月租金 1000 元', 'utf8'), 'a.txt');
    return d.ocrTried === false && d.text.indexOf('月租金') >= 0;
  });

  await check('审批比对记录不携带 docText（体积可控）', () => {
    const rec = AC.toCompareRecord({
      ok: true, stat: { high: 1, medium: 0, low: 0, total: 1 }, score: 92,
      diffs: [{ type: 'cn_money_mismatch', severity: 'high', label: '大写金额', msg: '不一致', expected: 'A', actual: 'B' }],
      docText: 'x'.repeat(50000)
    }, { fileName: 'a.docx' });
    return rec.docText === undefined && rec.diffs.length === 1 && rec.diffs[0].typeText === '大写金额不符';
  });

  await check('附件挑选：只认合同正本，不误选营业执照/CAD图纸', () => {
    const hit = AC.pickContractScan([
      { name: '营业执照.jpg', key: 'k0' },
      { name: 'T3-10-04 CAD图纸.png', key: 'k1' },
      { name: '房屋租赁合同.docx', kind: 'contractScan', key: 'k2' }
    ]);
    return hit && hit.key === 'k2' &&
      AC.pickContractScan([{ name: '营业执照.jpg' }]) === null;
  });

  console.log('\n[22] 巡更检查 · 夜班时段可配（原小工具完整移植）');
  await check('时段解析：null/undefined/非法值一律回退 18:30~06:30', () => {
    const a = PAT.resolveWindow(null), b = PAT.resolveWindow(undefined),
      c = PAT.resolveWindow(''), d = PAT.resolveWindow({ start: '99:99', end: '' }),
      e = PAT.resolveWindow({ start: '18:30', end: '18:30' });
    return [a, b, c, d, e].every(w =>
      w.startMin === PAT.NIGHT_START_MIN && w.endMin === PAT.NIGHT_END_MIN) &&
      typeof a.startH === 'number' && typeof a.endM === 'number';
  });
  await check('时段解析：三种传法（字符串/分钟对/时分对）', () => {
    const a = PAT.resolveWindow({ start: '20:00', end: '08:00' });
    const b = PAT.resolveWindow({ startH: 19, startM: 0, endH: 7, endM: 0 });
    return a.startMin === 1200 && a.endMin === 480 &&
      b.startMin === 1140 && b.endMin === 420 &&
      PAT.windowText(a) === '20:00 ~ 次日 08:00';
  });
  await check('时段真实影响漏检判定（06:30 vs 08:00 两种口径结果不同）', () => {
    const pts = [{ code: 'P1', name: '东门' }, { code: 'P2', name: '西门' }];
    const recs = [
      { timeAt: new Date('2026-07-10T19:00:00').getTime(), pointCode: 'P1', person: '夜班-甲' },
      { timeAt: new Date('2026-07-11T05:00:00').getTime(), pointCode: 'P1', person: '夜班-甲' },
      { timeAt: new Date('2026-07-11T07:00:00').getTime(), pointCode: 'P2', person: '夜班-甲' }
    ];
    const a = PAT.analyze({ points: pts, records: recs, start: '2026-07-10', end: '2026-07-11', mode: 'night' });
    const b = PAT.analyze({ points: pts, records: recs, start: '2026-07-10', end: '2026-07-11', mode: 'night',
      window: PAT.resolveWindow({ start: '18:30', end: '08:00' }) });
    return a.daily[0].totalMissed === 1 && b.daily[0].totalMissed === 0 &&
      b.windowText === '18:30 ~ 次日 08:00';
  });
  await check('时段透传：巡更所有接口均带 window（防止新增端点漏传）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    const calls = src.match(/P\.analyze\(\{[\s\S]*?\}\)/g) || [];
    if (calls.length !== 5) return false;                       // analyze/daily/monthly/overview/export
    if (!calls.every(c => /window:\s*(windowOf\(|win\b)/.test(c))) return false;
    const shifts = src.match(/P\.assignShiftDate\([^)]*\)/g) || [];
    return shifts.length > 0 && shifts.every(c => /,\s*win\s*\)/.test(c));
  });
  await check('遗漏明细导出能力齐备（对齐 get_missed_detail）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    return /M_MISS_HEADERS\s*=\s*\[/.test(src) &&
      /function missedDetailRows\s*\(daily\)/.test(src) &&
      /type === 'missed'/.test(src) &&
      /name:\s*'遗漏明细'/.test(src);
  });
  await check('前端时段可配：winQS 首参/后续参前缀自洽（曾拼出 overview&window…）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views5.js'), 'utf8');
    if (!/function winQS\(prefix\)/.test(src)) return false;
    if (!/GET\('\/api\/patrol\/overview' \+ winQS\(true\)/.test(src)) return false;
    const all = src.match(/winQS\((true)?\)/g) || [];
    return all.filter(c => c === 'winQS()').length === 8 &&
      all.filter(c => c === 'winQS(true)').length === 2;
  });
  await check('巡更权限不被 IIFE 顶层固化（曾致导入区整体不渲染）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views5.js'), 'utf8');
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    return /get import\(\)\s*\{\s*return zapPerm\('patrol:import'\)/.test(src) &&
      !/const CAN\s*=\s*\{\s*import:\s*zapPerm/.test(code);
  });

  console.log('\n[23] 路由挂载完整性与 /api 兜底（曾致「比对失败：reading result」）');
  await check('routes/ 下每个路由文件都在 server.js 里 require 了', () => {
    const root = path.join(__dirname, '..');
    const server = nodeFs.readFileSync(path.join(root, 'server.js'), 'utf8');
    const files = nodeFs.readdirSync(path.join(root, 'routes'))
      .filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, ''));
    const missing = files.filter(f => server.indexOf("routes/" + f + "'") < 0);
    if (missing.length) console.log('      未挂载:', missing.join(', '));
    return files.length > 0 && missing.length === 0;
  });
  await check('contractcmp 路由已挂载（比对功能曾整个不可用）', () => {
    const server = nodeFs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    return /require\('\.\/routes\/contractcmp'\)\(db,\s*router,\s*ctx\)/.test(server);
  });
  await check('/api/* 未命中返 404 JSON 而非 SPA 的 index.html', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'lib', 'http.js'), 'utf8');
    // /api/ 守卫必须真实存在，且位于「回 index.html」动作之前
    const guard = src.indexOf("if (pathname.indexOf('/api/') === 0");
    if (guard < 0) return false;
    const serveIdx = src.indexOf('if (fs.existsSync(idx)) return sendFile(res, idx);');
    return serveIdx > guard &&
      /接口不存在（路由未挂载？）：/.test(src) &&
      /'Content-Type':\s*'application\/json/.test(src.slice(guard, serveIdx));
  });
  await check('前端解包 data 前先判 ok（避免 undefined 属性读取异常吞掉真实原因）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views7.js'), 'utf8');
    return !/const res = r\.data\.result;/.test(src) &&
      /r\.ok === false/.test(src) && /r\.data && r\.data\.result/.test(src);
  });

  console.log('\n[24] 表格解析 · 多 Sheet 与双格式兼容（曾致「3月巡更记录导入不能识别」）');
  const XLSX = require('../lib/xls');
  const PAT2 = require('../lib/patrol');

  // 根因 1：RK 浮点写在 double 的错误半区
  await check('RK 浮点写在高 4 字节（曾把 46128.58 读成 5.37e-315 垃圾值）', () => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(46128.5625, 0);
    const rk = ((b.readUInt32LE(4) & 0xFFFFFFFC) | 0);
    const v = XLSX.rkValue(rk);
    return v > 40000 && v < 50000;      // 修复前是 5.37e-315
  });
  await check('RK 整数路径未被浮点修复带坏', () => {
    return XLSX.rkValue((123 << 2) | 0x02) === 123 &&
      Math.round(XLSX.rkValue((1 << 2) | 0x02 | 0x01) * 100) === 1;
  });

  // 根因 2：多 Sheet 只取 out[0]
  await check('parseWorkbook 多 Sheet 取行数最多的表（与 parseXlsx 一致）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'lib', 'xls.js'), 'utf8');
    const pw = src.slice(src.indexOf('function parseWorkbook'), src.indexOf('function unzip'));
    return /s\.rows\.length > main\.rows\.length/.test(pw);
  });
  await check('xls 路径也暴露 sheetNames / sheets（可提示本文件有几个工作表）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'lib', 'xls.js'), 'utf8');
    return /sheetNames:\s*out\.map/.test(src) && /sheets:\s*out/.test(src);
  });

  // 根因 3：表头别名 + 无表头推断 + 防串列
  await check('记录表识别设备原始表头（地点名称/地点编码/巡检员）', () => {
    const r = PAT2.parseRecords([
      ['序号', '地点名称', '地点编码', '巡检时间', '巡检员'],
      ['1', '31楼茶水间', '008D9066', '2026-03-01 05:11:32', '余明辉'],
      ['2', '30楼茶水间', '008C65D6', '2026-03-01 05:11:59', '鲁斌']
    ]);
    return r.mode === 'header' && r.records.length === 2 &&
      r.records[0].pointCode === '008D9066' &&
      r.records[0].pointName === '31楼茶水间' &&
      r.records[1].person === '鲁斌';
  });
  await check('缺列不按位置瞎补（3月表无「巡检器」列曾串成序号）', () => {
    const r = PAT2.parseRecords([
      ['序号', '地点名称', '地点编码', '巡检时间', '巡检员'],
      ['1', '31楼茶水间', '008D9066', '2026-03-01 05:11:32', '余明辉']
    ]);
    return r.records[0].device === '' && r.records[0].seq === 1;
  });
  await check('无表头时按内容推断列位（时间/编码/名称/人员）', () => {
    const r = PAT2.parseRecords([
      ['1', '008D9066', '31楼茶水间', '2026-03-01 05:11:32', '余明辉'],
      ['2', '008C65D6', '30楼茶水间', '2026-03-01 05:11:59', '鲁斌'],
      ['3', '008CACF0', '30楼卫生间', '2026-03-01 05:12:20', '陈玉保']
    ]);
    return r.mode === 'inferred' && r.records.length === 3 &&
      r.records[0].time === '2026-03-01 05:11:32' &&
      r.records[0].pointCode === '008D9066' &&
      r.records[0].pointName === '31楼茶水间' &&
      r.records[0].person === '余明辉';
  });
  await check('一列不兼两职（防串列去重逻辑存在）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'lib', 'patrol.js'), 'utf8');
    const pr = src.slice(src.indexOf('function parseRecords'), src.indexOf('function inferRecordColumns'));
    return /used\[v\] !== undefined/.test(pr);
  });
  await check('点位表兼容设备原始格式（地点名称/地点编码，无「类型」列）', () => {
    const r = PAT2.parsePoints([
      ['序号', '地点名称', '地点编码', '空闲/否', '备注'],
      ['1', '31楼茶水间', '008D9066', '已用', ''],
      ['2', '30楼茶水间', '008C65D6', '已用', '']
    ]);
    return r.mode === 'header' && r.points.length === 2 &&
      r.points[0].code === '008D9066' && r.points[0].name === '31楼茶水间';
  });
  await check('点位表标准格式无回归（地点卡 + 人员卡 + 班次）', () => {
    const r = PAT2.parsePoints([
      ['序号', '卡号', '类型', '名称', '备注', '路线编号', '路线内顺序'],
      ['1', '0006599946', '地点卡', '19设备房', '', '', ''],
      ['2', '0004854438', '地点卡', '18F东面步梯间', '', '', ''],
      ['3', '0008539572', '人员卡', '夜班-何南', '', '', '']
    ]);
    return r.points.length === 2 && r.persons.length === 1 && r.persons[0].shift === '夜班';
  });
  await check('点位表缺「卡号」列时不把序号当卡号（防 100 个假点位）', () => {
    const r = PAT2.parsePoints([
      ['序号', '地点名称'],
      ['1', '31楼茶水间'],
      ['2', '30楼茶水间']
    ]);
    return r.points.every(x => !/^[0-9A-Fa-f]{6,10}$/.test(x.code));
  });
  await check('导入路由按用途在多 sheet 中择优（pickSheet/rowsFor）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    return /function pickSheet/.test(src) && /function rowsFor/.test(src) &&
      /rowsFor\(r\.table, 'records'\)/.test(src) && /rowsFor\(r\.table, 'points'\)/.test(src);
  });
  await check('传错表时给出可操作提示（记录表↔点位表互斥诊断）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    return /这张表是巡查记录表，请改用/.test(src) &&
      /这张表是点位\/人员卡表，请改用/.test(src) && /已自动选用/.test(src);
  });
  await check('导入响应回传 detect 识别模式与 sheets 列表（便于前端提示）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    return /detect:\s*parsed\.mode/.test(src) && /sheets:\s*r\.table\.sheetNames/.test(src);
  });

  // 卡号体系不一致：覆盖率不可解读时必须能说出真实原因
  await check('概览与月报都回传 codeHitRate（卡号命中率，用于覆盖率可解读性判断）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    // 两处都要有：概览诊断当月记录、月报诊断所选月份
    const n = (src.match(/codeHitRate\s*=/g) || []).length;
    return n >= 2;
  });
  await check('卡号命中率保留一位小数（避免 0 与极小值混淆）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    return /Math\.round\(hit \/ [A-Za-z.]+ \* 1000\) \/ 10/.test(src);
  });
  await check('前端有共用的卡号体系警示卡（概览+月报两处调用，文案不会走样）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views5.js'), 'utf8');
    const def = (src.match(/function codeHitWarn/g) || []).length;
    const use = (src.match(/h \+= codeHitWarn/g) || []).length;
    return def === 1 && use === 2;
  });
  await check('警示卡文案给出可执行的下一步（重导记录文件即会带入点位）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views5.js'), 'utf8');
    const body = src.slice(src.indexOf('function codeHitWarn'), src.indexOf('/* ==================== 主视图'));
    return /重新用「导入巡查记录表」导一次/.test(body) && /卡号整套变了/.test(body);
  });

  // 幂等去重：重复导入同一份文件不得让实巡点次翻倍
  await check('记录导入按「时间+卡号+人员」做幂等去重（曾重复导入攒出 13669 条重复）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    return /function dupKey|dupKey\s*=/.test(src) && /existed\[/.test(src);
  });
  await check('去重对无卡号记录退化为「时间+名称+人员」（仍能拦重复导入）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    return /x\.pointCode \|\| x\.pointName/.test(src);
  });
  await check('覆盖模式先清空再去重（不能把 replace 误判成全重复而导不进去）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    const clearAt = src.indexOf("if (mode === 'replace') db.clear('patrolRecords')");
    const existAt = src.indexOf('const existed = {}');
    return clearAt > 0 && existAt > clearAt;   // clear 必须排在 existed 构建之前
  });
  await check('导入响应回传 dup 计数，前端据此提示「跳过重复 N 条」', () => {
    const r = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    const v = nodeFs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'views5.js'), 'utf8');
    return /dup:\s*dupInBatch/.test(r) && /d\.dup/.test(v) && /跳过/.test(v);
  });

  // 一体化导入：点位就在记录文件的另一个 sheet 里，不该让用户导两次
  await check('点位带 month 归属（换过卡的月份用自己那套分母）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    return /month: month \|\| ''/.test(src) && /async function loadPoints\(month\)/.test(src);
  });
  await check('有 guessMonth（从记录时间戳/文件名推断点位归属月份）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    return /function guessMonth\(records, fileName\)/.test(src);
  });
  await check('记录导入顺带吃下同文件里的点位表（一次导入搞定）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    return /r\.table\.sheets\.length > 1/.test(src) && /rowsFor\(r\.table, 'points'\)/.test(src);
  });
  await check('【关键】有该月专属点位时只用专属，不叠加通用（曾致 3 月分母 135、覆盖率 96.5%→71.5%）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    const lp = src.slice(src.indexOf('async function loadPoints(month)'), src.indexOf('async function pointsOf'));
    // 必须先判空回退，再直接返回 scoped —— 不能出现 scoped.concat(common)
    return /if \(!scoped\.length\) return \{ list: common, scoped: false/.test(lp) &&
      /return \{ list: scoped, scoped: true/.test(lp) &&
      !/scoped\.concat\(/.test(lp);
  });
  await check('点位写入逻辑 savePoints 复用（记录导入与点位导入共用，不会日后走样）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    return /function savePoints\(parsed, month\)/.test(src) && /savePoints\(pp, month\)/.test(src) &&
      /savePoints\(parsed, month\)/.test(src);
  });
  await check('分析类端点一律按月取点位（monthly/overview/daily/analyze/export）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    return /loadPoints\(m\)/.test(src) && /loadPoints\(dataMonth\)/.test(src) &&
      (src.match(/await pointsOf\(/g) || []).length >= 3;
  });
  await check('概览区分「点位总数」与「本月分母点数」（两者不能混为一谈）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    return /monthPointCount: points\.length/.test(src) && /pointScope: ptSel\.scoped/.test(src);
  });
  await check('点位覆盖导入只清同月份（否则后月导入会抹掉前月点位体系）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    return /db\.where\('patrolPoints', p => p\.month === month\)/.test(src);
  });
  await check('点位列表支持按归属月份筛选（全部/通用/按月归档）', () => {
    const src = nodeFs.readFileSync(path.join(__dirname, '..', 'routes', 'patrol.js'), 'utf8');
    return /q\.month === 'common'/.test(src) && /q\.month === 'scoped'/.test(src) && /q\.month === 'all'/.test(src);
  });

  console.log('\n== 结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项 ==');
  if (fails.length) { console.log('失败项：'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
})();
