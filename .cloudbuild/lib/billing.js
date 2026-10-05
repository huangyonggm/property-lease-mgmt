'use strict';
// 收费核心逻辑：月账单生成、水电抄表计费、楼层公摊分摊、收款、押金
const { uid, money, monthOf, addMonths, addDays, today, now, num } = require('./util');
const INC = require('./income');

const CATEGORY = ['租金', '物业费', '电费', '水费', '保洁费', '维修费'];

// 取上一期读数
async function prevReading (db, meterId, period) {
  const list = (await db.where('readings', r => r.meterId === meterId && r.period < period))
    .sort((a, b) => a.period < b.period ? 1 : -1);
  return list[0] || null;
}

async function usageOf (db, meterId, period) {
  const cur = (await db.one('readings', r => r.meterId === meterId && r.period === period));
  if (!cur) return { usage: 0, cur: null, prev: null };
  const prev = await prevReading(db, meterId, period);
  let usage = prev ? (num(cur.value) - num(prev.value)) : 0;
  if (usage < 0) usage = 0; // 换表/录入错误保护
  return { usage: usage, cur: cur, prev: prev };
}

// 生成单条费用行
function mkItem(name, category, qty, unit, price, taxRate, remark) {
  const amount = money(num(qty) * num(price));
  return {
    name: name, category: category, qty: num(qty), unit: unit, price: num(price),
    amount: amount, taxRate: num(taxRate), taxAmount: money(amount - amount / (1 + num(taxRate) / 100)),
    remark: remark || ''
  };
}

// 判断某月是否落在免租期
function isFreeMonth(c, period) {
  if (!c.freeStart || !c.freeEnd) return false;
  return period >= monthOf(c.freeStart) && period <= monthOf(c.freeEnd);
}

// 按合同生成某月账单（不落库，返回对象）
async function buildBill (db, c, period, opt) {
  opt = opt || {};
  const items = [];
  const free = isFreeMonth(c, period);

  // 租金单价按合同递增规则计算（合同模板：计租日起第三年起每年递增 6%）
  const esc = INC.rentPriceOf(c, period);
  const rent = free ? 0 : money(esc.price * c.area);
  const rentRemark = free ? '免租期减免'
    : (esc.times > 0 ? '递增后单价（' + esc.note + '）' : '');
  items.push(mkItem('租金', '租金', c.area, '㎡', esc.price, 9, rentRemark));

  items.push(mkItem('物业费', '物业费', c.area, '㎡', money(c.fees.propertyUnit / 10), 6, ''));

  // 电费：按合同拆分「照明电费 / 空调电费」（真实收入日报分列）
  // 注意：这里内外两层循环都用 for...of —— 内层要 await db.where + await usageOf，
  // forEach/map 的回调是同步函数，await 拿不到结果（云端是 Promise），
  // 会导致 usageE/usageAir 恒为 0，电费整项丢失。
  let usageE = 0, usageAir = 0;
  if (opt.meter !== false) {
    for (const rid of c.roomIds) {
      const ems = await db.where('meters', m => m.roomId === rid);
      for (const em of ems) {
        if (em.type !== '电表') continue;
        const u = (await usageOf(db, em.id, period)).usage;
        if (/空调/.test(em.name || em.meterType || '')) usageAir += u;
        else usageE += u;
      }
    }
  }
  if (usageE > 0) items.push(mkItem('照明电费', '电费', usageE, '度', c.fees.electricPrice, 13, ''));
  if (usageAir > 0) items.push(mkItem('空调电费', '电费', usageAir, '度', c.fees.electricPrice, 13, '空调专用回路'));

  let usageW = 0;
  if (opt.meter !== false) {
    for (const rid of c.roomIds) {
      const wm = await db.one('meters', m => m.roomId === rid && m.type === '水表');
      if (wm) usageW += (await usageOf(db, wm.id, period)).usage;
    }
  }
  if (usageW > 0) items.push(mkItem('水费', '水费', usageW, '吨', c.fees.waterPrice, 3, ''));

  if (opt.cleaning !== false && num(c.fees.cleaning) > 0) items.push(mkItem('套内保洁', '保洁费', 1, '次', c.fees.cleaning, 6, ''));
  if (opt.repair !== false && num(c.fees.repair) > 0) items.push(mkItem('维修费', '维修费', 1, '次', c.fees.repair, 13, '含维修及专项维保'));

  const total = money(items.reduce((s, it) => s + it.amount, 0));
  const tax = money(items.reduce((s, it) => s + it.taxAmount, 0));
  return {
    items: items, totalAmount: total, taxAmount: tax,
    usageE: usageE, usageW: usageW, usageAir: usageAir, free: free,
    escalate: {
      price: esc.price, base: esc.base, yearNo: esc.yearNo,
      times: esc.times || 0, note: esc.note
    }
  };
}

// 批量生成某月账单（跳过已生成的合同）
async function generateBills (db, period, opt) {
  opt = opt || {};
  const contracts = (await db.where('contracts', c => {
    if (opt.projectId && c.projectId !== opt.projectId) return false;
    if (c.status === '退租' || c.status === '终止') return false;
    if (period < monthOf(c.startDate)) return false;
    if (period > monthOf(c.endDate)) return false;
    return true;
  }));
  const created = [], skipped = [], errors = [];
  // for...of：循环体要 await db.one / buildBill / db.insert，forEach 回调是同步函数，
  // await 拿不到结果，云端会导致「账单批量生成全部失败、errors 里全是 undefined」
  for (const c of contracts) {
    const exist = await db.one('bills', b => b.contractId === c.id && b.period === period);
    if (exist) { skipped.push(c.code); continue; }
    try {
      const built = await buildBill(db, c, period, opt);
      const bill = {
        id: uid('bl'), code: db.nextNo('bills', 'ZD', period + '-01'),
        contractId: c.id, contractCode: c.code,
        customerId: c.customerId, customerName: c.customerName,
        projectId: c.projectId, buildingId: c.buildingId,
        roomIds: c.roomIds.slice(), roomCodes: c.roomCodes.slice(),
        period: period, billDate: period + '-01', dueDate: period + '-10',
        crossMonth: !!opt.crossMonth,
        items: built.items, totalAmount: built.totalAmount, taxAmount: built.taxAmount,
        paidAmount: 0, status: '未收款', invoiceStatus: '未开票', invoiceIds: [],
        remark: opt.crossMonth ? '账单跨月（含上月末费用）' : '',
        ownerId: opt.userId || '', deptId: 'd_cw', createdBy: opt.userId || ''
      };
      await db.insert('bills', bill);
      created.push(bill);
    } catch (e) { errors.push(c.code + '：' + e.message); }
  }
  return { period: period, created: created.length, skipped: skipped.length, errors: errors, bills: created };
}

// 空置房间基础电费（5~10 元/月）
async function generateVacantElectric (db, period, opt) {
  opt = opt || {};
  const setting = (await db.one('settings', s => s.key === 'biz')) || {};
  const min = num(setting.vacantElectricMin, 5), max = num(setting.vacantElectricMax, 10);
  const rooms = (await db.where('rooms', r => r.status === '空置' && (!opt.projectId || r.projectId === opt.projectId)));
  const created = [];
  // for...of：循环体里要 await db.one / db.insert（云端是 Promise），forEach 回调是同步函数
  for (const r of rooms) {
    const exist = await db.one('bills', b => b.period === period && b.vacantRoomId === r.id);
    if (exist) continue;
    const fee = money((min + max) / 2);
    const bill = {
      id: uid('bl'), code: db.nextNo('bills', 'KZ', period + '-01'),
      contractId: '', contractCode: '',
      customerId: '', customerName: '空置房基础电费',
      projectId: r.projectId, buildingId: r.buildingId,
      roomIds: [r.id], roomCodes: [r.code], vacantRoomId: r.id,
      period: period, billDate: period + '-01', dueDate: period + '-10',
      crossMonth: false,
      items: [mkItem('空置房基础电费', '电费', 1, '间', fee, 13, '空置房间基础电费')],
      totalAmount: fee, taxAmount: money(fee - fee / 1.13),
      paidAmount: 0, status: '未收款', invoiceStatus: '未开票', invoiceIds: [],
      internal: true,   // 空置房基础电费为内部成本，不计入欠费催收
      remark: '空置房间基础电费（内部成本，不进入欠费催收）', ownerId: opt.userId || '', deptId: 'd_cw', createdBy: opt.userId || ''
    };
    await db.insert('bills', bill);
    created.push(bill);
  }
  return { created: created.length, amount: money(created.reduce((s, b) => s + b.totalAmount, 0)) };
}

// 整层公摊电费分摊：按房间面积比例分摊
async function allocateSharedElectric (db, opt) {
  opt = opt || {};
  const period = opt.period;
  const buildingId = opt.buildingId;
  const floor = opt.floor;
  const totalKwh = num(opt.totalKwh);      // 整层总表用电量
  const totalFee = num(opt.totalFee);      // 整层总电费（可选，优先使用）
  const price = num(opt.price, 1);
  const mode = opt.mode || 'area';         // area 按面积 / equal 平均 / usage 按用量
  if (!period || !buildingId || floor === undefined) return { ok: false, msg: '缺少参数' };
  if (!totalKwh && !totalFee) return { ok: false, msg: '请输入整层总表用电量或总电费' };

  const rooms = (await db.where('rooms', r => r.buildingId === buildingId && String(r.floor) === String(floor) && r.status !== '停用'));
  if (!rooms.length) return { ok: false, msg: '该楼层没有可分摊房间' };
  const fee = totalFee > 0 ? totalFee : money(totalKwh * price);
  const totalArea = rooms.reduce((s, r) => s + num(r.area), 0);
  const rows = [];
  let allocated = 0;
  // for...of + entries()：需要「下标 i」（分摊最后一份补差）且循环体要 await
  for (const [i, r] of rooms.entries()) {
    let share = 0;
    if (mode === 'equal') {
      share = i === rooms.length - 1 ? money(fee - allocated) : money(fee / rooms.length);
    } else if (mode === 'usage') {
      const em = await db.one('meters', m => m.roomId === r.id && m.type === '电表');
      const u = em ? (await usageOf(db, em.id, period)).usage : 0;
      share = u; // 先记录用量
      rows.push({ roomId: r.id, roomCode: r.code, area: r.area, usage: u, shareFee: 0 });
      continue;
    } else {
      share = i === rooms.length - 1 ? money(fee - allocated) : money(fee * num(r.area) / totalArea);
    }
    allocated = money(allocated + share);
    rows.push({ roomId: r.id, roomCode: r.code, area: r.area, usage: 0, shareFee: share });
  }
  if (mode === 'usage') {
    const totalUsage = rows.reduce((s, r) => s + r.usage, 0);
    let acc = 0;
    rows.forEach((r, i) => {
      r.shareFee = i === rows.length - 1 ? money(fee - acc) : (totalUsage > 0 ? money(fee * r.usage / totalUsage) : 0);
      acc = money(acc + r.shareFee);
    });
  }
  const rec = {
    id: uid('se'), period: period, buildingId: buildingId, floor: floor,
    totalKwh: totalKwh, totalFee: fee, price: price, mode: mode,
    rows: rows, by: opt.userName || '', byId: opt.userId || '', createTime: now()
  };
  await db.insert('shared_electric', rec);
  // 把分摊电费写入当期账单（若无账单则创建一条公摊账单）
  let applied = 0;
  // for...of：循环体要 await db.one / db.update / db.insert
  for (const r of rows) {
    const bill = await db.one('bills', b => b.period === period && b.roomIds && b.roomIds.indexOf(r.roomId) >= 0 && b.contractId);
    const item = mkItem('公摊电费', '电费', 1, '项', r.shareFee, 13, '整层公摊分摊（' + floorNameOf(floor) + '层）');
    if (bill) {
      bill.items = bill.items.filter(it => it.name !== '公摊电费');
      bill.items.push(item);
      bill.totalAmount = money(bill.items.reduce((s, it) => s + it.amount, 0));
      bill.taxAmount = money(bill.items.reduce((s, it) => s + it.taxAmount, 0));
      bill.paidAmount = Math.min(bill.paidAmount, bill.totalAmount);
      if (bill.totalAmount - bill.paidAmount <= 0.01) bill.status = '已收款';
      else if (bill.paidAmount > 0) bill.status = '部分收款';
      await db.update('bills', bill.id, { items: bill.items, totalAmount: bill.totalAmount, taxAmount: bill.taxAmount, status: bill.status });
      applied++;
    } else {
      const room = await db.find('rooms', r.roomId);
      await db.insert('bills', {
        id: uid('bl'), code: db.nextNo('bills', 'GT', period + '-01'),
        contractId: '', contractCode: '', customerId: '', customerName: '公摊电费',
        projectId: room ? room.projectId : '', buildingId: buildingId,
        roomIds: [r.roomId], roomCodes: [r.roomCode], sharedId: rec.id,
        period: period, billDate: period + '-01', dueDate: period + '-10',
        crossMonth: false, items: [item], totalAmount: item.amount, taxAmount: item.taxAmount,
        paidAmount: 0, status: '未收款', invoiceStatus: '未开票', invoiceIds: [],
        remark: '整层公摊电费分摊', ownerId: opt.userId || '', deptId: 'd_cw', createdBy: opt.userId || ''
      });
      applied++;
    }
  }
  return { ok: true, record: rec, applied: applied };
}

const FLOOR_ALIAS = { 4: '3A', 13: '12A', 14: '13A', 24: '23A' };
function floorNameOf(f) { return FLOOR_ALIAS[f] || String(f); }

// 收款
async function pay (db, opt) {
  const bill = (await db.find('bills', opt.billId));
  if (!bill) return { ok: false, msg: '账单不存在' };
  const amount = money(opt.amount);
  if (amount <= 0) return { ok: false, msg: '收款金额必须大于 0' };
  const remain = money(bill.totalAmount - bill.paidAmount);
  if (amount > remain + 0.01) return { ok: false, msg: '收款金额超过欠费金额（剩余 ' + remain.toFixed(2) + ' 元）' };
  bill.paidAmount = money(bill.paidAmount + amount);
  bill.status = (bill.totalAmount - bill.paidAmount <= 0.01) ? '已收款' : '部分收款';
  (await db.update('bills', bill.id, { paidAmount: bill.paidAmount, status: bill.status }));
  const p = (await db.insert('payments', {
    id: uid('pm'), code: db.nextNo('payments', 'SK', opt.date || today()),
    billId: bill.id, billCode: bill.code, contractId: bill.contractId,
    customerId: bill.customerId, customerName: bill.customerName,
    roomCodes: bill.roomCodes, amount: amount, date: opt.date || today(),
    method: opt.method || '银行转账', remark: opt.remark || '',
    by: opt.userName || '', byId: opt.userId || '', projectId: bill.projectId, status: '已确认'
  }));
  return { ok: true, payment: p, bill: bill };
}

// 当日收款汇总
async function dailyCollection (db, date) {
  const d = date || today();
  // ⚠ 性能改造（2026-10-04）：原来这里有 **N+1**：
  //     const list = await db.where('payments', p => p.date === d && p.status === '已确认');
  //       ↑ 函数条件无法下推 SQL → 把 830 行 payments 全表拉回内存
  //     for (const p of list) { … await db.find('projects', p.projectId); }  ← 每笔一次往返
  //   实测当日 10 笔收款 = 1 次全表载入 + 10 次串行 find ≈ 880ms，
  //   是整个驾驶舱的最大瓶颈（其余 16 条聚合并发后总共只要 ~200ms）。
  //
  // 改法两步：
  //   ① 函数条件 → 对象条件，WHERE 直接下推 SQL，只回当日那几行；
  //   ② 循环里逐条 db.find → 先一次性把涉及的 projectId 收集起来，
  //      用一次 IN 查询建映射表。项目数是个位数，这一层几乎免费。
  const list = await db.where('payments', { date: d, status: '已确认' });
  const byMethod = {}, byProject = {};
  let total = 0;
  // 收集需要查名的 projectId（去重，避免同一项目重复查）
  const pjIds = [];
  list.forEach(p => {
    total = money(total + p.amount);
    byMethod[p.method] = money((byMethod[p.method] || 0) + p.amount);
    if (p.projectId && pjIds.indexOf(p.projectId) < 0) pjIds.push(p.projectId);
  });
  // 一次 IN 查询拿全部项目名（原来是每笔一次 find）
  const pjName = {};
  if (pjIds.length) {
    const pjs = await db.where('projects', { id: pjIds });
    pjs.forEach(p => { pjName[String(p.id)] = p.name; });
  }
  list.forEach(p => {
    const key = pjName[String(p.projectId)] || '未分配';
    byProject[key] = money((byProject[key] || 0) + p.amount);
  });
  return { date: d, count: list.length, total: total, byMethod: byMethod, byProject: byProject, list: list };
}

// 月度费用汇总
async function monthlySummary (db, period) {
  const bills = (await db.where('bills', b => b.period === period));
  const cat = {};
  let total = 0, paid = 0, unpaid = 0;
  bills.forEach(b => {
    total = money(total + b.totalAmount);
    paid = money(paid + b.paidAmount);
    unpaid = money(unpaid + (b.totalAmount - b.paidAmount));
    (b.items || []).forEach(it => { cat[it.category] = money((cat[it.category] || 0) + it.amount); });
  });
  return { period: period, count: bills.length, total: total, paid: paid, unpaid: unpaid, byCategory: cat };
}

// 欠费清单
async function arrearsList (db, opt) {
  opt = opt || {};
  const src = await db.where('bills', b => {
    if (b.totalAmount - b.paidAmount <= 0.01) return false;
    if (b.internal && !opt.includeInternal) return false;   // 内部成本（空置房基础电费）不进入催收
    if (opt.projectId && b.projectId !== opt.projectId) return false;
    if (opt.customerId && b.customerId !== opt.customerId) return false;
    if (opt.onlyOverdue && b.status !== '逾期') return false;
    return true;
  });
  // 逐条查客户与项目（云端 db 是 async，map 回调里 await 必须靠 Promise.all 聚合）
  const list = await Promise.all(src.map(async b => {
    const cu = await db.find('customers', b.customerId);
    const pj = await db.find('projects', b.projectId);
    return {
      billId: b.id, billCode: b.code, period: b.period, contractCode: b.contractCode,
      customerId: b.customerId, customerName: b.customerName,
      phone: cu ? cu.phone : '', contact: cu ? cu.contact : '', address: cu ? cu.address : '',
      roomCodes: b.roomCodes, projectId: b.projectId,
      projectName: (pj || {}).name || '',
      totalAmount: b.totalAmount, paidAmount: b.paidAmount,
      arrears: money(b.totalAmount - b.paidAmount), status: b.status, dueDate: b.dueDate,
      overdueDays: b.dueDate ? Math.max(0, Math.round((new Date(today()) - new Date(b.dueDate)) / 86400000)) : 0
    };
  }));
  return list.sort((a, b) => b.arrears - a.arrears);
}

// 电费异常检测（偷电监控）：房间用电量异常偏低/偏高
async function electricAnomaly (db, period) {
  const contracts = (await db.where('contracts', c => c.status === '正常履约' || c.status === '逾期'));
  // 【性能修复：用电异常监控线上要 27 秒】
  // 原实现对「每个合同 × 每个房间」都 await db.one('meters', m=>m.roomId===rid && m.type==='电表')
  // 和 usageOf（内部再查 readings）。meters 的条件里 type==='电表' 是字面量、可下推，
  // 于是每个房间都发一条 SELECT * FROM meters WHERE type='电表'（回约 200 行且不入缓存），
  // 266 个房间 = 266 次「串行」SQL 往返 ≈ 27 秒。
  // 改为：一次性载入 meters/rooms/readings 并建索引，整个循环 0 次额外 SQL、0 次逐行深拷贝。
  const meters = await db.all('meters');
  const rooms = await db.all('rooms');
  const readings = await db.all('readings');
  const emByRoom = {};                       // roomId -> 该房间的电表（取第一只，与原 db.one 一致）
  meters.forEach(m => { if (m.type === '电表' && !emByRoom[m.roomId]) emByRoom[m.roomId] = m; });
  const roomMap = {}; rooms.forEach(r => { roomMap[r.id] = r; });
  const byMeter = {};                        // meterId -> 按 period 升序的读数
  readings.forEach(r => { (byMeter[r.meterId] = byMeter[r.meterId] || []).push(r); });
  Object.keys(byMeter).forEach(k => byMeter[k].sort((a, b) => a.period < b.period ? -1 : (a.period > b.period ? 1 : 0)));
  // 等价于 usageOf(...).usage：当期读数 − 上一期读数，负数归零（换表/录入错误保护）
  function usageAtIndex(meterId, per) {
    const arr = byMeter[meterId];
    if (!arr) return 0;
    let cur = null, prev = null;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].period === per) cur = arr[i];
      else if (arr[i].period < per) prev = arr[i];   // 升序，最后一个 < per 的即上一期
    }
    if (!cur) return 0;
    const u = prev ? (num(cur.value) - num(prev.value)) : 0;
    return u < 0 ? 0 : u;
  }

  const rows = [];
  for (const c of contracts) {
    for (const rid of (c.roomIds || [])) {
      const em = emByRoom[rid];
      if (!em) continue;
      const room = roomMap[rid];
      if (!room) continue;
      const usage = usageAtIndex(em.id, period);
      const perSqm = num(room.area) > 0 ? money(usage / room.area) : 0;
      let flag = '';
      if (usage === 0 && room.status === '已租') flag = '零用电（疑似未接表/偷电）';
      else if (perSqm > 0 && perSqm < 0.3 && room.status === '已租') flag = '单位面积用电异常偏低';
      else if (perSqm > 8) flag = '单位面积用电异常偏高';
      if (flag) rows.push({
        roomId: rid, roomCode: room.code, area: room.area, meterNo: em.meterNo,
        usage: usage, perSqm: perSqm, flag: flag,
        contractCode: c.code, customerName: c.customerName, projectId: c.projectId
      });
    }
  }
  return rows;
}

module.exports = {
  CATEGORY, mkItem, usageOf, buildBill, generateBills, generateVacantElectric,
  allocateSharedElectric, pay, dailyCollection, monthlySummary, arrearsList,
  electricAnomaly, isFreeMonth, floorNameOf, FLOOR_ALIAS
};
