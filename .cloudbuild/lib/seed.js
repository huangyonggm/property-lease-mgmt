'use strict';
// 初始化演示数据：组织架构 / 房源 / 客户 / 合同 / 账单 / 抄表 / 发票 / 工单 / 审批
const { uid, md5, addMonths, addDays, monthOf, money, pad, today, now, num, daysInMonth } = require('./util');
const { allPermCodes } = require('./auth');

const PWD = md5('123456');

function rnd(min, max) { return Math.round(min + Math.random() * (max - min)); }
function pickOne(arr) { return arr[rnd(0, arr.length - 1)]; }

const floorAlias = { 4: '3A', 13: '12A', 14: '13A', 24: '23A' };
function floorName(f) { return floorAlias[f] || String(f); }

function seed(db) {
  if (db.count('users') > 0) return false;
  const ALL = allPermCodes();

  /* ===================== 1. 组织架构 ===================== */
  const depts = [
    { id: 'd_zs', name: '招商部', code: 'ZS' },
    { id: 'd_kf', name: '客服部', code: 'KF' },
    { id: 'd_cw', name: '财务部', code: 'CW' },
    { id: 'd_rs', name: '人事部', code: 'RS' },
    { id: 'd_gc', name: '工程运维部', code: 'GC' },
    { id: 'd_zjb', name: '总经办', code: 'ZJB' }
  ].map(d => Object.assign(d, { parentId: '', sort: 0, manager: '', remark: '', status: '启用' }));
  db.insertMany('depts', depts);

  const posts = [
    { id: 'p_zszy', name: '招商专员', deptId: 'd_zs', desc: '房源招租、合同录入' },
    { id: 'p_zsjl', name: '招商经理', deptId: 'd_zs', desc: '价格审核、合同初审' },
    { id: 'p_kfzy', name: '客服专员', deptId: 'd_kf', desc: '欠费催收、工单受理' },
    { id: 'p_kfjl', name: '客服主管', deptId: 'd_kf', desc: '客服统筹、退租核验' },
    { id: 'p_kj', name: '会计', deptId: 'd_cw', desc: '记账、报表' },
    { id: 'p_jxfp', name: '进线发票', deptId: 'd_cw', desc: '进项发票管理' },
    { id: 'p_cnfp', name: '出纳发票', deptId: 'd_cw', desc: '销项发票开具' },
    { id: 'p_cn', name: '出纳', deptId: 'd_cw', desc: '收款、付款、押金' },
    { id: 'p_cwjl', name: '财务经理', deptId: 'd_cw', desc: '租金审核、合同复审' },
    { id: 'p_rszy', name: '人事专员', deptId: 'd_rs', desc: '人员与权限' },
    { id: 'p_gczg', name: '工程主管', deptId: 'd_gc', desc: '巡检、维修、抄表' },
    { id: 'p_sdwx', name: '水电维修工', deptId: 'd_gc', desc: '设备维修、水电抄表' },
    { id: 'p_bay', name: '保安员', deptId: 'd_gc', desc: '门岗、巡逻、夜班值班' },
    { id: 'p_bjy', name: '保洁员', deptId: 'd_gc', desc: '公共区域保洁' },
    { id: 'p_ybzby', name: '夜班值班员', deptId: 'd_gc', desc: '夜间值守、空调每日白班巡检衔接' },
    { id: 'p_zjl', name: '总经理', deptId: 'd_zjb', desc: '免租期与终审' }
  ].map(p => Object.assign(p, { status: '启用' }));
  db.insertMany('posts', posts);

  const roles = [
    { id: 'r_admin', name: '超级管理员', code: 'ADMIN', perms: ALL.concat(['*']), dataScope: 'all', remark: '系统全部权限' },
    { id: 'r_zsjl', name: '招商经理', code: 'ZSJL', perms: ['dashboard:view', 'property:view', 'property:manage', 'customer:view', 'customer:manage', 'contract:view', 'contract:manage', 'contract:approve', 'approval:view', 'approval:approve', 'approval:price', 'report:view', 'report:export', 'workorder:view', 'income:view'], dataScope: 'all' },
    { id: 'r_zszy', name: '招商专员', code: 'ZSZY', perms: ['dashboard:view', 'property:view', 'customer:view', 'customer:manage', 'contract:view', 'contract:manage', 'approval:view', 'workorder:view', 'patrol:view', 'hr:view'], dataScope: 'project' },
    { id: 'r_kfzy', name: '客服专员', code: 'KFZY', perms: ['dashboard:view', 'property:view', 'customer:view', 'contract:view', 'billing:view', 'billing:collect', 'workorder:view', 'workorder:manage', 'patrol:view', 'report:view', 'hr:view'], dataScope: 'project' },
    { id: 'r_kfjl', name: '客服主管', code: 'KFJL', perms: ['dashboard:view', 'property:view', 'customer:view', 'customer:manage', 'customer:risk', 'contract:view', 'contract:terminate', 'billing:view', 'billing:manage', 'billing:collect', 'workorder:view', 'workorder:manage', 'report:view', 'report:export', 'income:view'], dataScope: 'all' },
    { id: 'r_cwjl', name: '财务经理', code: 'CWJL', perms: ['dashboard:view', 'property:view', 'customer:view', 'contract:view', 'contract:approve', 'billing:view', 'billing:manage', 'billing:collect', 'billing:deposit', 'invoice:view', 'invoice:manage', 'invoice:split', 'approval:view', 'approval:approve', 'approval:rent', 'hr:view', 'hr:payroll', 'report:view', 'report:export', 'income:view', 'income:manage', 'income:export', 'income:import'], dataScope: 'all' },
    { id: 'r_kj', name: '会计', code: 'KJ', perms: ['dashboard:view', 'property:view', 'customer:view', 'contract:view', 'billing:view', 'billing:manage', 'invoice:view', 'invoice:manage', 'hr:view', 'hr:payroll', 'report:view', 'report:export', 'income:view', 'income:export'], dataScope: 'all' },
    { id: 'r_cn', name: '出纳', code: 'CN', perms: ['dashboard:view', 'property:view', 'customer:view', 'contract:view', 'billing:view', 'billing:collect', 'billing:deposit', 'invoice:view', 'report:view', 'income:view', 'income:manage'], dataScope: 'all' },
    { id: 'r_jxfp', name: '进线发票', code: 'JXFP', perms: ['dashboard:view', 'invoice:view', 'invoice:manage', 'billing:view', 'report:view', 'income:view'], dataScope: 'all' },
    { id: 'r_cnfp', name: '出纳发票', code: 'CNFP', perms: ['dashboard:view', 'invoice:view', 'invoice:manage', 'invoice:split', 'billing:view', 'report:view', 'report:export', 'income:view', 'income:export'], dataScope: 'all' },
    { id: 'r_rszy', name: '人事专员', code: 'RSZY', perms: ['dashboard:view', 'org:view', 'org:manage', 'system:view', 'hr:view', 'hr:manage', 'hr:attend', 'hr:payroll', 'report:view', 'report:export'], dataScope: 'dept' },
    { id: 'r_gczg', name: '工程主管', code: 'GCZG', perms: ['dashboard:view', 'property:view', 'billing:view', 'billing:meter', 'workorder:view', 'workorder:manage', 'workorder:patrol', 'patrol:view', 'patrol:manage', 'patrol:import', 'patrol:analyze', 'patrol:export', 'hr:view', 'hr:attend', 'report:view'], dataScope: 'all' },
    // 总经理：默认拿「除 manage 外」的全部权限，再显式补回几个
    //「不算管理主数据、但必须能操作」的权限，否则前端会直接隐藏入口：
    //   patrol:import       导入巡更点位表/巡查记录（导入数据 ≠ 管主数据）
    //   patrol:analyze      跑巡更漏检分析
    //   patrol:export       导出巡更报表
    // 这三项若漏掉，总经理打开巡更页会「看不到导入区」，与原独立小工具
    // 「谁打开都能导入」的体验不一致（2026-10-04 用户反馈）。
    { id: 'r_zjl', name: '总经理', code: 'ZJL', perms: ALL.filter(p => p.indexOf(':manage') < 0).concat(['patrol:import', 'patrol:analyze', 'patrol:export']), dataScope: 'all' }
  ].map(r => Object.assign(r, { status: '启用' }));
  db.insertMany('roles', roles);

  const users = [
    { username: 'admin', name: '系统管理员', roleId: 'r_admin', deptId: 'd_zjb', postId: 'p_zjl', isAdmin: true, phone: '13800000000', dataScope: 'all' },
    { username: 'zhaoshang', name: '张招商', roleId: 'r_zsjl', deptId: 'd_zs', postId: 'p_zsjl', phone: '13800000001', dataScope: 'all' },
    { username: 'zhaoshang2', name: '李招租', roleId: 'r_zszy', deptId: 'd_zs', postId: 'p_zszy', phone: '13800000002', dataScope: 'project' },
    { username: 'kefu', name: '王客服', roleId: 'r_kfjl', deptId: 'd_kf', postId: 'p_kfjl', phone: '13800000003', dataScope: 'all' },
    { username: 'kefu2', name: '赵客服', roleId: 'r_kfzy', deptId: 'd_kf', postId: 'p_kfzy', phone: '13800000004', dataScope: 'project' },
    { username: 'caiwu', name: '孙财务', roleId: 'r_cwjl', deptId: 'd_cw', postId: 'p_cwjl', phone: '13800000005', dataScope: 'all' },
    { username: 'kuaiji', name: '周会计', roleId: 'r_kj', deptId: 'd_cw', postId: 'p_kj', phone: '13800000006', dataScope: 'all' },
    { username: 'chuna', name: '钱出纳', roleId: 'r_cn', deptId: 'd_cw', postId: 'p_cn', phone: '13800000007', dataScope: 'all' },
    { username: 'jinxianfp', name: '吴进票', roleId: 'r_jxfp', deptId: 'd_cw', postId: 'p_jxfp', phone: '13800000008', dataScope: 'all' },
    { username: 'chunafp', name: '郑出票', roleId: 'r_cnfp', deptId: 'd_cw', postId: 'p_cnfp', phone: '13800000009', dataScope: 'all' },
    { username: 'renshi', name: '冯人事', roleId: 'r_rszy', deptId: 'd_rs', postId: 'p_rszy', phone: '13800000010', dataScope: 'dept' },
    { username: 'gongcheng', name: '陈工程', roleId: 'r_gczg', deptId: 'd_gc', postId: 'p_gczg', phone: '13800000011', dataScope: 'all' },
    { username: 'zongjingli', name: '黄总经理', roleId: 'r_zjl', deptId: 'd_zjb', postId: 'p_zjl', phone: '13800000012', dataScope: 'all' }
  ].map((u, i) => Object.assign(u, {
    id: 'u_' + (i + 1), password: PWD, status: '启用',
    perms: null, projectIds: [], dingtalkUserId: 'dt' + (i + 1)
  }));
  db.insertMany('users', users);

  /* ===================== 2. 项目 / 楼栋 / 房间 ===================== */
  const projects = [
    { id: 'pj_1', name: '成功新时代', code: 'CGXSD', address: '武汉市洪山区光谷大道 100 号', managerId: 'u_2', portName: '成功新时代招商端口', area: 32000, lessorName: '湖北成功置业投资有限公司', lessorCreditCode: '91420100MA4K7X8L2P', remark: '主力在营项目' },
    { id: 'pj_2', name: 'T3', code: 'T3', address: '武汉市江汉区建设大道 88 号', managerId: 'u_2', portName: 'T3 招商端口', area: 18000, lessorName: '武汉 T3 置业管理有限公司', lessorCreditCode: '91420103MA4K9Y6M3Q', remark: '新交付项目' }
  ].map(p => Object.assign(p, { status: '启用' }));
  db.insertMany('projects', projects);

  const buildings = [
    { id: 'b_1', projectId: 'pj_1', name: '10 栋', code: 'B10', floors: 18, floorAlias: floorAlias, buildArea: 12000, acFloors: [7], fireFloors: [7, 8], remark: '中央空调 7 楼' },
    { id: 'b_2', projectId: 'pj_1', name: '20 栋', code: 'B20', floors: 12, floorAlias: floorAlias, buildArea: 9000, acFloors: [], fireFloors: [3, 4], remark: '' },
    { id: 'b_3', projectId: 'pj_2', name: 'T3 主楼', code: 'T3M', floors: 10, floorAlias: floorAlias, buildArea: 18000, acFloors: [7], fireFloors: [1, 7], remark: '7 楼中央空调' }
  ].map(b => Object.assign(b, { status: '启用' }));
  db.insertMany('buildings', buildings);

  const rooms = [];
  const bizTypes = ['办公', '商铺', '仓储', '餐饮'];
  function mkRoom(projectId, buildingId, floor, no, area, opts) {
    opts = opts || {};
    const bname = buildingId === 'b_1' ? '10栋' : (buildingId === 'b_2' ? '20栋' : 'T3');
    return Object.assign({
      id: uid('rm'), projectId, buildingId,
      floor: floor, floorLabel: floorName(floor),
      roomNo: no, code: bname + '-' + floorName(floor) + '-' + no,
      area: area, useArea: Math.round(area * 0.75 * 100) / 100,
      bizType: opts.bizType || pickOne(bizTypes),
      status: '空置',
      level: floor <= 3 ? '低层' : (floor >= 12 ? '高层' : '中间楼层'),
      propertyCert: '', certNo: '', certArea: area, ownerName: '',
      cadFile: '', facilities: [], mergedFrom: [], splitFrom: '', parentRoomId: '',
      sharedElectric: true, priceStandard: 0, remark: '', tags: []
    }, opts);
  }

  for (let f = 1; f <= 18; f++) {
    for (let i = 1; i <= 6; i++) {
      rooms.push(mkRoom('pj_1', 'b_1', f, pad(i), rnd(60, 320), {
        facilities: (f === 7 ? ['中央空调', '消防楼层'] : (f % 3 === 0 ? ['独立空调'] : ['分体空调'])),
        propertyCert: '鄂(2020)武汉市不动产权第 ' + rnd(100000, 999999) + ' 号',
        certArea: rnd(60, 320), ownerName: '湖北成功置业投资有限公司'
      }));
    }
  }
  for (let f = 1; f <= 12; f++) {
    for (let i = 1; i <= 6; i++) {
      rooms.push(mkRoom('pj_1', 'b_2', f, pad(i), rnd(50, 260), {
        facilities: f % 4 === 0 ? ['消防楼层'] : ['分体空调'],
        propertyCert: '鄂(2021)武汉市不动产权第 ' + rnd(100000, 999999) + ' 号',
        ownerName: '湖北成功置业投资有限公司'
      }));
    }
  }
  for (let f = 1; f <= 10; f++) {
    for (let i = 1; i <= 8; i++) {
      rooms.push(mkRoom('pj_2', 'b_3', f, pad(i), rnd(80, 400), {
        facilities: f === 7 ? ['中央空调', '消防楼层'] : ['中央空调'],
        propertyCert: '鄂(2023)武汉市不动产权第 ' + rnd(100000, 999999) + ' 号',
        ownerName: '武汉 T3 置业管理有限公司'
      }));
    }
  }
  // 场景1：08-10 号合并为一套房源
  const addRooms = [8, 9, 10].map(n => mkRoom('pj_1', 'b_1', 5, pad(n), rnd(90, 150), {
    propertyCert: '鄂(2020)武汉市不动产权第 555001 号', ownerName: '湖北成功置业投资有限公司'
  }));
  rooms.push.apply(rooms, addRooms);
  const mainRoom = addRooms[0];
  mainRoom.mergedFrom = [addRooms[1].id, addRooms[2].id];
  mainRoom.area = money(addRooms.reduce((s, r) => s + r.area, 0));
  mainRoom.useArea = money(mainRoom.area * 0.75);
  mainRoom.remark = '08-10 号合并为一套房源出租';
  mainRoom.tags = ['合并房源'];
  addRooms[1].parentRoomId = mainRoom.id; addRooms[1].status = '停用';
  addRooms[2].parentRoomId = mainRoom.id; addRooms[2].status = '停用';

  // 场景2：一套房源拆分给多个客户（合租）
  const bigRoom = rooms.filter(r => r.buildingId === 'b_3' && r.floor === 6 && r.roomNo === '01')[0];
  if (bigRoom) {
    const s1 = mkRoom('pj_2', 'b_3', 6, '01-A', Math.round(bigRoom.area * 0.5), { splitFrom: bigRoom.id, tags: ['合租'], remark: '由 01 拆分，独立核算' });
    const s2 = mkRoom('pj_2', 'b_3', 6, '01-B', Math.round(bigRoom.area * 0.5), { splitFrom: bigRoom.id, tags: ['合租'], remark: '由 01 拆分，独立核算' });
    rooms.push(s1, s2);
    bigRoom.status = '停用'; bigRoom.remark = '已拆分为 01-A / 01-B'; bigRoom.tags = ['已拆分'];
  }
  db.insertMany('rooms', rooms);

  /* ===================== 3. 客户档案 ===================== */
  const companyNames = ['武汉晨曦科技有限公司', '湖北云之博建筑工程有限公司', '武汉星海贸易有限公司', '武汉三和教育咨询有限公司', '湖北中楚物流有限公司', '武汉光谷软件开发有限公司', '武汉佳合餐饮管理有限公司', '湖北启明医疗器械有限公司', '武汉新创网络科技有限公司', '湖北盛世广告传媒有限公司', '武汉博远财税咨询有限公司', '湖北恒安保安服务有限公司'];
  const personNames = ['刘建国', '周敏', '陈立', '杨秀兰', '吴国庆', '郑晓东', '孙丽', '马涛', '胡军', '林芳'];
  const customers = [];
  companyNames.forEach((n, i) => {
    customers.push({
      id: uid('cu'), name: n, type: '企业客户',
      creditCode: '9142010' + String(rnd(10000000, 99999999)) + 'X' + rnd(0, 9),
      legalPerson: personNames[i % personNames.length],
      idCard: '420' + rnd(100, 999) + '19' + rnd(70, 95) + pad(rnd(1, 12)) + pad(rnd(1, 28)) + String(rnd(1000, 9999)),
      bankName: '中国银行武汉光谷支行', bankAccount: '6217 ' + rnd(1000, 9999) + ' ' + rnd(1000, 9999) + ' ' + rnd(1000, 9999),
      contact: personNames[(i + 3) % personNames.length], phone: '139' + rnd(10000000, 99999999),
      address: '武汉市洪山区光谷大道 ' + rnd(1, 999) + ' 号 ' + floorName(rnd(1, 18)) + ' 层',
      invoiceTitle: n, invoiceTaxNo: '', invoiceBank: '', invoiceAccount: '', invoiceAddress: '',
      riskFlag: i === 4 ? '逾期风险' : '正常', riskNote: i === 4 ? '历史存在 2 次延迟付款，需重点跟进' : '',
      status: '正常', attachments: [], ownerId: 'u_3', deptId: 'd_zs', createDate: addDays(today(), -rnd(30, 900))
    });
  });
  personNames.forEach((n, i) => {
    const risk = i === 2 || i === 6;
    customers.push({
      id: uid('cu'), name: n, type: '个人客户',
      creditCode: '', legalPerson: '',
      idCard: '420' + rnd(100, 999) + '19' + rnd(70, 98) + pad(rnd(1, 12)) + pad(rnd(1, 28)) + String(rnd(1000, 9999)),
      bankName: '招商银行武汉分行', bankAccount: '6214 ' + rnd(1000, 9999) + ' ' + rnd(1000, 9999),
      contact: n, phone: '137' + rnd(10000000, 99999999),
      address: '武汉市江汉区建设大道 ' + rnd(1, 200) + ' 号 ' + rnd(1, 30) + ' 栋 ' + rnd(101, 2508) + ' 室',
      invoiceTitle: n, invoiceTaxNo: '', invoiceBank: '', invoiceAccount: '', invoiceAddress: '',
      riskFlag: risk ? '违约风险' : '正常',
      riskNote: risk ? '个人客户，曾出现合同无法履约情况，需提高押金比例' : '',
      status: '正常', attachments: [], ownerId: 'u_3', deptId: 'd_zs', createDate: addDays(today(), -rnd(30, 700))
    });
  });
  db.insertMany('customers', customers);

  /* ===================== 4. 合同 ===================== */
  const availRooms = rooms.filter(r => r.status === '空置');
  const contracts = [];
  const usedRooms = new Set();
  const todayStr = today();
  const curMonth = monthOf(todayStr);

  function mkContract(i) {
    const cu = customers[i % customers.length];
    let roomList = [];
    let tries = 0;
    while (roomList.length === 0 && tries < 60) {
      tries++;
      const r = availRooms[rnd(0, availRooms.length - 1)];
      if (!r || usedRooms.has(r.id)) continue;
      if (r.area > 300 && Math.random() > 0.4) continue;
      roomList = [r];
      usedRooms.add(r.id);
      if (r.tags && r.tags.indexOf('合租') >= 0 && Math.random() > 0.5) {
        const sibling = rooms.filter(x => x.splitFrom === r.splitFrom && x.id !== r.id && !usedRooms.has(x.id))[0];
        if (sibling) { roomList.push(sibling); usedRooms.add(sibling.id); }
      }
    }
    if (!roomList.length) return null;
    const area = money(roomList.reduce((s, r) => s + r.area, 0));
    const start = addDays(todayStr, -rnd(30, 700));
    const months = pickOne([12, 24, 36, 12, 24]);
    const end = addMonths(start, months);
    const unitPrice = Math.round((rnd(35, 95) + Math.random()) * 100) / 100;
    const taxIncluded = Math.random() > 0.5;
    const freeMonths = pickOne([0, 0, 1, 2, 3]);
    const deposit = money(unitPrice * area * (freeMonths > 1 ? 3 : 2));
    const statusRoll = Math.random();
    let status = '正常履约';
    if (end < todayStr) status = '逾期';
    else if (statusRoll > 0.93) status = '退租';
    else if (statusRoll > 0.88) status = '变更';
    const room = roomList[0];
    roomList.forEach(r => { r.status = status === '退租' ? '空置' : '已租'; });
    return {
      id: uid('ct'),
      code: 'HT' + start.replace(/-/g, '') + String(i + 1).padStart(3, '0'),
      customerId: cu.id, customerName: cu.name, customerType: cu.type,
      projectId: room.projectId, buildingId: room.buildingId,
      roomIds: roomList.map(r => r.id),
      roomCodes: roomList.map(r => r.code),
      area: area,
      lessorName: room.projectId === 'pj_1' ? '湖北成功置业投资有限公司' : '武汉 T3 置业管理有限公司',
      lessorCreditCode: '91420100MA4' + rnd(100000, 999999),
      lessorContact: '张招商', lessorPhone: '13800000001',
      lesseeContact: cu.contact, lesseePhone: cu.phone,
      startDate: start, endDate: end,
      rentUnitPrice: unitPrice, taxIncluded: taxIncluded,
      rentMonthly: money(unitPrice * area),
      freeStart: freeMonths ? start : '', freeEnd: freeMonths ? addMonths(start, freeMonths) : '', freeMonths: freeMonths,
      deposit: deposit, depositPaid: statusRoll > 0.1 ? deposit : 0,
      depositStatus: statusRoll > 0.1 ? '已收' : '未收',
      depositRefundStatus: status === '退租' ? (Math.random() > 0.5 ? '已退' : '待退') : '未退',
      fees: {
        propertyUnit: pickOne([5, 6, 8, 10, 12]),
        waterPrice: pickOne([3.5, 4.0, 4.5]), electricPrice: pickOne([0.85, 0.95, 1.05, 1.15]),
        cleaning: money(rnd(200, 800)), repair: money(rnd(0, 500)),
        billingMode: roomList.length > 1 ? '合并核算' : '分开核算'
      },
      payCycle: pickOne(['月付', '季付', '半年付']),
      status: status,
      version: 1, changeLog: [], attachments: [],
      signDate: start, remark: '',
      ownerId: 'u_3', deptId: 'd_zs', createdBy: 'u_3'
    };
  }
  for (let i = 0; i < 190; i++) {
    const c = mkContract(i);
    if (c) contracts.push(c);
  }
  db.insertMany('contracts', contracts);
  // 同步房间租赁状态并落库（在租=已租，退租/终止=空置）
  contracts.forEach(c => {
    const st = (c.status === '退租' || c.status === '终止') ? '空置' : '已租';
    c.roomIds.forEach(rid => {
      const r = db.find('rooms', rid);
      if (r && r.parentRoomId === '' && (r.tags || []).indexOf('已拆分') < 0) r.status = st;
    });
  });
  db.persist('rooms');

  /* ===================== 5. 电表 / 水表 + 抄表 ===================== */
  const meters = [];
  const readings = [];
  const meterByRoom = {};      // roomId -> { '电表': meter, '水表': meter }
  const usageMap = {};         // meterId -> { period: 用量 }
  const periods = [];
  for (let m = 5; m >= 0; m--) periods.push(monthOf(addMonths(todayStr, -m)));

  contracts.forEach(c => {
    c.roomIds.forEach(rid => {
      const room = db.find('rooms', rid);
      if (!room) return;
      const em = { id: uid('mt'), type: '电表', roomId: rid, buildingId: room.buildingId, projectId: c.projectId, meterNo: 'DB' + String(rnd(100000, 999999)), initValue: rnd(1000, 8000), rate: 1, status: '启用', remark: '' };
      const wm = { id: uid('mt'), type: '水表', roomId: rid, buildingId: room.buildingId, projectId: c.projectId, meterNo: 'SB' + String(rnd(100000, 999999)), initValue: rnd(100, 900), rate: 1, status: '启用', remark: '' };
      meters.push(em, wm);
      meterByRoom[rid] = { '电表': em, '水表': wm };
      usageMap[em.id] = {}; usageMap[wm.id] = {};
      let ev = em.initValue, wv = wm.initValue;
      for (let m = 5; m >= 0; m--) {
        const period = periods[5 - m];
        const date = period + '-0' + rnd(1, 5);
        const dE = rnd(80, Math.max(120, Math.round(room.area * 3)));   // 面积越大用电越多
        const dW = rnd(2, 40);
        ev += dE; wv += dW;
        usageMap[em.id][period] = dE;
        usageMap[wm.id][period] = dW;
        readings.push({ id: uid('rd'), meterId: em.id, roomId: rid, period: period, date: date, value: ev, by: '陈工程', source: '人工抄表' });
        readings.push({ id: uid('rd'), meterId: wm.id, roomId: rid, period: period, date: date, value: wv, by: '陈工程', source: '人工抄表' });
      }
    });
  });
  db.insertMany('meters', meters);
  db.insertMany('readings', readings);

  /* ===================== 6. 账单 / 收款 / 押金 ===================== */
  const bills = [], payments = [], deposits = [];

  contracts.forEach(c => {
    if (!db.find('rooms', c.roomIds[0])) return;
    periods.forEach((period, pi) => {
      if (period < monthOf(c.startDate)) return;
      if (c.status === '退租' && pi < 3) return;
      const isFree = c.freeStart && c.freeEnd && period >= monthOf(c.freeStart) && period <= monthOf(c.freeEnd);
      const items = [];
      const rent = isFree ? 0 : money(c.rentUnitPrice * c.area);
      items.push({ name: '租金', category: '租金', qty: c.area, unit: '㎡', price: c.rentUnitPrice, amount: rent, taxRate: 9, taxAmount: money(rent - rent / 1.09), remark: isFree ? '免租期减免' : '' });
      const propFee = money(c.fees.propertyUnit * c.area / 10);
      items.push({ name: '物业费', category: '物业费', qty: c.area, unit: '㎡', price: money(c.fees.propertyUnit / 10), amount: propFee, taxRate: 6, taxAmount: money(propFee - propFee / 1.06) });
      const mmap = meterByRoom[c.roomIds[0]] || {};
      const em = mmap['电表'], wm = mmap['水表'];
      const usageE = (em && usageMap[em.id] && usageMap[em.id][period]) || 0;
      const eFee = money(usageE * c.fees.electricPrice);
      items.push({ name: '电费', category: '电费', qty: usageE, unit: '度', price: c.fees.electricPrice, amount: eFee, taxRate: 13, taxAmount: money(eFee - eFee / 1.13) });
      const usageW = (wm && usageMap[wm.id] && usageMap[wm.id][period]) || 0;
      const wFee = money(usageW * c.fees.waterPrice);
      items.push({ name: '水费', category: '水费', qty: usageW, unit: '吨', price: c.fees.waterPrice, amount: wFee, taxRate: 3, taxAmount: money(wFee - wFee / 1.03) });
      if (Math.random() > 0.4) items.push({ name: '室内保洁费', category: '保洁费', qty: 1, unit: '次', price: c.fees.cleaning, amount: c.fees.cleaning, taxRate: 6, taxAmount: money(c.fees.cleaning - c.fees.cleaning / 1.06) });
      if (Math.random() > 0.7) items.push({ name: '维修费', category: '维修费', qty: 1, unit: '次', price: c.fees.repair, amount: c.fees.repair, taxRate: 13, taxAmount: money(c.fees.repair - c.fees.repair / 1.13) });
      const total = money(items.reduce((s, it) => s + it.amount, 0));
      const dueDate = period + '-10';
      let paid = 0, status = '未收款';
      const r2 = Math.random();
      if (period < curMonth) {
        if (r2 > 0.82) { paid = 0; status = '逾期'; }
        else if (r2 > 0.15) { paid = total; status = '已收款'; }
        else { paid = money(total * 0.5); status = '部分收款'; }
      } else {
        if (r2 > 0.7) { paid = total; status = '已收款'; }
        else if (r2 > 0.6) { paid = money(total * 0.4); status = '部分收款'; }
      }
      const bill = {
        id: uid('bl'), code: 'ZD' + period.replace('-', '') + String(bills.length + 1).padStart(4, '0'),
        contractId: c.id, contractCode: c.code,
        customerId: c.customerId, customerName: c.customerName,
        projectId: c.projectId, buildingId: c.buildingId, roomIds: c.roomIds.slice(), roomCodes: c.roomCodes.slice(),
        period: period, billDate: period + '-01', dueDate: dueDate,
        crossMonth: Math.random() > 0.85,
        items: items, totalAmount: total, taxAmount: money(items.reduce((s, it) => s + it.taxAmount, 0)),
        paidAmount: paid, status: status,
        invoiceStatus: '未开票', invoiceIds: [],
        remark: '', ownerId: 'u_7', deptId: 'd_cw', createdBy: 'u_7'
      };
      if (bill.crossMonth) bill.remark = '账单跨月（含上月末费用）';
      bills.push(bill);
      if (paid > 0) {
        payments.push({
          id: uid('pm'), code: 'SK' + period.replace('-', '') + String(payments.length + 1).padStart(4, '0'),
          billId: bill.id, billCode: bill.code, contractId: c.id, customerId: c.customerId, customerName: c.customerName,
          roomCodes: bill.roomCodes, amount: paid, date: addDays(dueDate, rnd(-3, 12)),
          method: pickOne(['银行转账', '支付宝', '微信', '现金', '电汇']),
          remark: '', by: '钱出纳', byId: 'u_8', projectId: c.projectId, status: '已确认'
        });
      }
    });
    if (c.depositPaid > 0) {
      deposits.push({
        id: uid('dp'), contractId: c.id, contractCode: c.code, customerId: c.customerId, customerName: c.customerName,
        type: '收取', amount: c.depositPaid, date: c.startDate, method: '银行转账', by: '钱出纳', byId: 'u_8',
        status: c.depositRefundStatus === '已退' ? '已退回' : (c.depositRefundStatus === '待退' ? '待退回' : '在管'),
        refundAmount: c.depositRefundStatus === '已退' ? money(c.depositPaid * 0.8) : 0,
        refundDate: c.depositRefundStatus === '已退' ? addDays(c.endDate, 5) : '',
        deductAmount: c.depositRefundStatus === '已退' ? money(c.depositPaid * 0.2) : 0,
        deductReason: c.depositRefundStatus === '已退' ? '水电欠费及房屋损耗扣款' : '',
        projectId: c.projectId, remark: ''
      });
    }
  });
  db.insertMany('bills', bills);
  db.insertMany('payments', payments);
  db.insertMany('deposits', deposits);

  /* ===================== 7. 发票 ===================== */
  const invoices = [];
  const cats = [['租金', 9], ['物业费', 6], ['电费', 13], ['杂费', 13], ['保洁费', 6]];
  bills.filter(b => b.status === '已收款').slice(0, 90).forEach((b, i) => {
    const cat = cats[i % cats.length];
    const item = b.items.filter(it => it.category === cat[0])[0] || b.items[0];
    const amount = money(item.amount);
    if (amount <= 0) return;
    const type = b.customerName.indexOf('公司') > 0 ? '增值税专票' : '增值税普票';
    invoices.push({
      id: uid('iv'), code: 'FP' + b.period.replace('-', '') + String(invoices.length + 1).padStart(4, '0'),
      invoiceNo: String(rnd(10000000, 99999999)), invoiceDate: addDays(b.period + '-15', rnd(0, 10)),
      type: type, category: cat[0],
      customerId: b.customerId, customerName: b.customerName,
      contractId: b.contractId, contractCode: b.contractCode,
      billIds: [b.id], billCodes: [b.code],
      roomCodes: b.roomCodes, projectId: b.projectId,
      amount: amount, taxRate: cat[1], taxAmount: money(amount - amount / (1 + cat[1] / 100)),
      status: '已开具', remark: '', by: '郑出票', byId: 'u_10',
      title: b.customerName, taxNo: b.customerName.indexOf('公司') > 0 ? '9142010' + rnd(10000000, 99999999) : '',
      bankInfo: '', address: '', template: '模板' + (1 + (i % 4))
    });
    b.invoiceStatus = '已开票';
    b.invoiceIds = [invoices[invoices.length - 1].id];
  });
  db.insertMany('invoices', invoices);

  /* ===================== 8. 审批 ===================== */
  const approvals = [];
  contracts.slice(0, 8).forEach((c, i) => {
    const m = i % 4;
    const steps = [
      { level: 1, name: '招商经理审核（价格）', roleCode: 'ZSJL', userId: 'u_2', status: m === 0 ? '待审批' : '已通过', time: now(), comment: m === 0 ? '' : '价格符合市场指导价' },
      { level: 2, name: '财务经理审核（租金）', roleCode: 'CWJL', userId: 'u_6', status: m === 0 ? '待审批' : (m === 1 ? '待审批' : '已通过'), time: now(), comment: '' },
      { level: 3, name: '总经理审核（免租期）', roleCode: 'ZJL', userId: 'u_13', status: '免审批', time: '', comment: c.freeMonths >= 2 ? '免租期超 1 个月需总经理审批' : '免租期未超阈值，免审批' }
    ];
    if (c.freeMonths >= 2) steps[2].status = (m === 2) ? '待审批' : '已通过';
    const pending = steps.filter(s => s.status === '待审批')[0];
    approvals.push({
      id: uid('ap'), code: 'SP' + todayStr.replace(/-/g, '') + String(i + 1).padStart(3, '0'),
      type: '合同审批', subTypes: ['价格审核', '租金审核', '免租期审核'],
      bizId: c.id, bizCode: c.code, bizTitle: c.customerName + ' / ' + c.roomCodes.join('、'),
      projectId: c.projectId, amount: c.rentMonthly,
      currentLevel: pending ? pending.level : 99, totalLevel: 2,
      status: pending ? '审批中' : '已通过',
      steps: steps, logs: [{ time: now(), user: '李招租', action: '提交', comment: '新签合同，请审批' }],
      applicant: '李招租', applicantId: 'u_3', createTime: now(),
      dingtalkSent: false
    });
  });
  db.insertMany('approvals', approvals);

  /* ===================== 9. 工单 / 巡检 ===================== */
  const workorders = [];
  const woTypes = [['维修工单', '维修'], ['巡检工单', '巡检'], ['抄表工单', '抄表'], ['消防巡检', '消防'], ['空调巡检', '空调']];
  for (let i = 0; i < 40; i++) {
    const t = woTypes[i % woTypes.length];
    const room = rooms[rnd(0, rooms.length - 1)];
    const st = pickOne(['待处理', '处理中', '已完成', '已完成', '已关闭']);
    workorders.push({
      id: uid('wo'), code: 'GD' + todayStr.replace(/-/g, '') + String(i + 1).padStart(3, '0'),
      type: t[0], category: t[1],
      projectId: room.projectId, buildingId: room.buildingId, roomId: room.id, roomCode: room.code,
      title: t[1] === '维修' ? pickOne(['空调不制冷', '洗手间漏水', '照明灯损坏', '门锁故障', '墙面渗水']) :
        t[1] === '抄表' ? '月度电表抄表' :
          t[1] === '消防' ? '消防楼层设施巡检' : t[1] === '空调' ? '7 楼中央空调白班巡检' : '月度综合巡检',
      content: '现场情况记录：' + pickOne(['设备运行正常', '发现异常已处理', '需更换配件', '需持续观察']),
      status: st, priority: pickOne(['普通', '普通', '紧急']),
      assignee: '陈工程', assigneeId: 'u_12',
      planDate: addDays(todayStr, rnd(-20, 10)), finishDate: st === '已完成' ? addDays(todayStr, -rnd(0, 15)) : '',
      result: st === '已完成' ? pickOne(['已修复', '已处理完毕', '正常']) : '',
      photos: [], focus: (room.facilities || []).indexOf('消防楼层') >= 0 || (room.facilities || []).indexOf('中央空调') >= 0,
      createdBy: '陈工程', createdById: 'u_12', createTime: now()
    });
  }
  db.insertMany('workorders', workorders);

  /* ===================== 10. 设置 / 提醒 ===================== */
  db.insert('settings', {
    id: 'st_dingtalk', key: 'dingtalk', name: '钉钉对接', enabled: false, mode: 'mock',
    appKey: '', appSecret: '', agentId: '', corpId: '',
    apiBase: 'https://api.dingtalk.com',
    approveCallback: '/api/dingtalk/callback',
    pushExpire: true, pushArrears: true, pushPatrol: true,
    expireDays: 180, arrearsDays: 10,
    remark: 'mode=mock 时推送写入本地消息队列，不实际调用钉钉接口'
  });
  db.insert('settings', {
    id: 'st_biz', key: 'biz', name: '业务规则',
    expireWarnMonths: 6, expireWarnDays: 10, recheckMonths: 3,
    vacantElectricMin: 5, vacantElectricMax: 10,
    meterCycle: '每月一次', defaultTemplate: '模板1'
  });

  const reminders = [];
  contracts.forEach(c => {
    const d = Math.round((new Date(c.endDate) - new Date(todayStr)) / 86400000);
    if (c.status === '正常履约' && d > 0 && d <= 180) {
      reminders.push({
        id: uid('rm2'), type: '合同到期', level: d <= 30 ? '紧急' : (d <= 90 ? '重要' : '提示'),
        contractId: c.id, contractCode: c.code, customerId: c.customerId, customerName: c.customerName,
        roomCodes: c.roomCodes, projectId: c.projectId,
        dueDate: c.endDate, daysLeft: d,
        content: '合同 ' + c.code + ' 将于 ' + c.endDate + ' 到期，剩余 ' + d + ' 天',
        status: '未处理', ownerId: 'u_2', createdAt: now()
      });
    }
  });
  bills.filter(b => b.status !== '已收款' && b.totalAmount - b.paidAmount > 0).forEach(b => {
    reminders.push({
      id: uid('rm2'), type: '欠费催收', level: b.status === '逾期' ? '紧急' : '重要',
      contractId: b.contractId, contractCode: b.contractCode, customerId: b.customerId, customerName: b.customerName,
      roomCodes: b.roomCodes, projectId: b.projectId,
      amount: money(b.totalAmount - b.paidAmount), period: b.period,
      content: '账单 ' + b.code + '（' + b.period + '）欠费 ' + money(b.totalAmount - b.paidAmount).toFixed(2) + ' 元',
      status: '未处理', ownerId: 'u_4', createdAt: now(), billId: b.id
    });
  });
  db.insertMany('reminders', reminders);

  /* ===================== 11. 人事 / 考勤 / 薪酬 ===================== */
  const HR = require('./hr');

  /* --- 11.1 班制班次 --- */
  const shifts = [
    { id: 'sf_1', name: '行政班', code: 'XZ', workStart: '09:00', workEnd: '18:00', restStart: '12:00', restEnd: '13:30', hours: 8, restDays: [0, 6], crossDay: false, nightDuty: false, remark: '周一至周五 09:00-18:00' },
    { id: 'sf_2', name: '早班', code: 'ZC', workStart: '07:00', workEnd: '15:00', restStart: '11:30', restEnd: '12:00', hours: 8, restDays: [6], crossDay: false, nightDuty: false, remark: '月休 4 天' },
    { id: 'sf_3', name: '晚班', code: 'WC', workStart: '15:00', workEnd: '23:00', restStart: '18:00', restEnd: '18:30', hours: 8, restDays: [6], crossDay: false, nightDuty: false, remark: '覆盖闭店高峰' },
    { id: 'sf_4', name: '夜班', code: 'YB', workStart: '23:00', workEnd: '07:00', restStart: '03:00', restEnd: '03:30', hours: 8, restDays: [], crossDay: true, nightDuty: true, remark: '夜班 1 人值班（含中央空调夜间巡检），做二休一' }
  ].map(s => Object.assign(s, { status: '启用' }));
  db.insertMany('shifts', shifts);

  /* --- 11.2 岗位薪资档（武汉市物业服务行业参考） --- */
  const SALARY = {
    '总经理': { base: 15000, post: 8000, perf: 5000, lv: 'A1' },
    '财务经理': { base: 9500, post: 4500, perf: 3000, lv: 'B1' },
    '招商经理': { base: 9500, post: 4500, perf: 3000, lv: 'B1' },
    '客服主管': { base: 7500, post: 3000, perf: 2500, lv: 'B2' },
    '工程主管': { base: 7500, post: 3000, perf: 2500, lv: 'B2' },
    '会计': { base: 6000, post: 2000, perf: 1500, lv: 'C1' },
    '人事专员': { base: 5000, post: 1800, perf: 1200, lv: 'C2' },
    '出纳': { base: 4800, post: 1500, perf: 1200, lv: 'C2' },
    '进线发票': { base: 4500, post: 1200, perf: 1000, lv: 'C3' },
    '出纳发票': { base: 4500, post: 1200, perf: 1000, lv: 'C3' },
    '招商专员': { base: 4200, post: 1500, perf: 1500, lv: 'C3' },
    '客服专员': { base: 4000, post: 1200, perf: 1200, lv: 'C3' },
    '水电维修工': { base: 4600, post: 1400, perf: 900, lv: 'D1' },
    '夜班值班员': { base: 3600, post: 900, perf: 600, lv: 'D2' },
    '保安员': { base: 3400, post: 800, perf: 600, lv: 'D2' },
    '保洁员': { base: 3000, post: 600, perf: 400, lv: 'D3' }
  };
  function salaryOf(postName) {
    const s = SALARY[postName] || { base: 4000, post: 1200, perf: 1000, lv: 'C3' };
    return { baseSalary: s.base, postSalary: s.post, perfSalary: s.perf, level: s.lv };
  }
  function shiftFor(postName) {
    if (postName === '夜班值班员') return 'sf_4';
    if (postName === '保安员') return rnd(0, 1) ? 'sf_2' : 'sf_3';
    if (postName === '保洁员') return 'sf_2';
    if (postName === '水电维修工') return 'sf_1';
    return 'sf_1';
  }
  function projectFor(deptId) {
    // 招商/客服/工程按项目分布，职能岗归属集团
    if (deptId === 'd_zs' || deptId === 'd_kf' || deptId === 'd_gc') return rnd(0, 2) ? projects[0].id : projects[1].id;
    return '';
  }

  const SURNAME = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章';
  const GIVEN = ['伟','芳','娜','敏','静','丽','强','磊','洋','勇','艳','杰','娟','涛','明','超','秀英','霞','平','刚','桂英','建国','志强','文博','思远','雨欣','浩然','嘉怡','子轩','梦琪','天佑','雅静'];
  const EDU = ['高中', '大专', '本科', '本科', '本科', '硕士'];
  const MOBILE_PRE = ['3', '5', '7', '8', '9'];
  const BANKS = ['中国工商银行', '中国建设银行', '招商银行', '中国银行', '交通银行'];
  const DISTRICT = ['洪山区', '江汉区', '武昌区', '江岸区', '硚口区', '汉阳区', '青山区'];
  const STREET = ['光谷大道', '珞喻路', '建设大道', '解放大道', '雄楚大街', '中南路', '和平大道', '发展大道'];

  function genName(used) {
    for (let i = 0; i < 200; i++) {
      const n = SURNAME[Math.floor(Math.random() * SURNAME.length)] + pickOne(GIVEN);
      if (used.indexOf(n) < 0) { used.push(n); return n; }
    }
    return SURNAME[0] + '员工';
  }
  function genMobile(used) {
    for (let i = 0; i < 200; i++) {
      const m = '1' + pickOne(MOBILE_PRE) + Math.floor(100000000 + Math.random() * 899999999);
      if (used.indexOf(m) < 0) { used.push(m); return m; }
    }
    return '13800000000';
  }
  function genIdCard(birth, seq) {
    const b = String(birth).replace(/-/g, '');
    return '420100' + b + String(seq % 1000).padStart(3, '0') + String((seq % 9) + 1);
  }

  const usedName = [], usedMobile = [];
  const employees = [];
  let empSeq = 0;

  function makeEmployee(o) {
    empSeq++;
    const post = posts.find(p => p.id === o.postId) || {};
    const deptId = post.deptId || o.deptId;
    const sow = salaryOf(post.name || '');
    const sal = num(o.baseSalary) || sow.baseSalary;
    const isFrontline = ['保安员', '保洁员', '夜班值班员', '水电维修工'].indexOf(post.name) >= 0;
    const gender = o.gender || (Math.random() < 0.45 ? '女' : '男');
    const birth = o.birthday || (1970 + rnd(0, 32)) + '-' + pad(rnd(1, 12)) + '-' + pad(rnd(1, 28));
    if (gender === '男') o.gender = '男';
    return Object.assign({
      id: 'em_' + empSeq, no: 'EMP' + String(empSeq).padStart(4, '0'),
      userId: o.userId || '', name: o.name, gender: gender, birthday: birth,
      idCard: genIdCard(birth, empSeq),
      phone: o.phone, deptId: deptId, postId: o.postId, projectId: o.projectId === undefined ? projectFor(deptId) : o.projectId,
      level: sow.level, shiftId: o.shiftId || shiftFor(post.name || ''),
      hireDate: o.hireDate, regularDate: o.regularDate || addMonths(o.hireDate, 3),
      contractStart: o.hireDate,
      // 劳动合同到期日：多数分散在未来 1~3 年，约 12% 临近到期（用于演示到期预警）
      contractEnd: o.contractEnd || addMonths(todayStr, Math.random() < 0.12 ? 1 : rnd(6, 36)),
      marital: o.marital || (Math.random() < 0.6 ? '已婚' : '未婚'),
      education: o.education || pickOne(EDU), school: '', major: '',
      nativePlace: pickOne(['湖北省武汉市', '湖北省黄冈市', '湖北省荆州市', '河南省信阳市', '湖南省岳阳市', '安徽省安庆市']),
      address: '湖北省武汉市' + pickOne(DISTRICT) + pickOne(STREET) + rnd(1, 999) + '号' + rnd(1, 30) + '栋' + rnd(101, 2508) + '室',
      emergencyContact: '', emergencyPhone: '',
      bankName: pickOne(BANKS),
      bankCard: '6222' + Math.floor(100000000000 + Math.random() * 899999999999) + '',
      status: o.status, leaveDate: o.leaveDate || '', leaveReason: o.leaveReason || '',
      /* --- 薪资 --- */
      baseSalary: sal, postSalary: num(o.postSalary) || sow.postSalary,
      perfSalary: num(o.perfSalary) || sow.perfSalary, perfRate: o.perfRate === undefined ? (0.9 + Math.random() * 0.25) : o.perfRate,
      allowanceTraffic: isFrontline ? 150 : 300, allowanceMeal: 400,
      allowancePhone: post.name && post.name.indexOf('经理') >= 0 ? 200 : 100,
      allowanceNight: isFrontline ? 30 : 0, allowanceOther: 0,
      attendanceBonus: 200, lateFine: 20,
      /* --- 社保公积金 --- */
      socialBase: sal + sow.postSalary, fundBase: sal + sow.postSalary,
      fundRate: 0.08, insureEnabled: true, fundEnabled: true,
      specialDeduction: o.specialDeduction === undefined ? pickOne([1000, 1500, 2000, 2000, 3000, 4000, 0, 0]) : o.specialDeduction,
      openingIncome: 0, openingInsurance: 0, openingSpecial: 0, openingTax: 0,
      files: [], remark: o.remark || '', createTime: now(), createdBy: '系统初始化'
    }, o.files ? { files: o.files } : {});
  }

  // 11.2.1 有系统账号的 13 位员工
  users.forEach((u, i) => {
    usedName.push(u.name); usedMobile.push(u.phone);
    employees.push(makeEmployee({
      userId: u.id, name: u.name, gender: '男', postId: u.postId, projectId: '',
      phone: u.phone, hireDate: '2021-03-01', status: '在职',
      specialDeduction: i < 3 ? 4000 : 2000, remark: '已开通系统账号 ' + u.username
    }));
  });

  // 11.2.2 其余员工（一线为主）
  const headCount = {
    'p_zszy': 4, 'p_kfzy': 5, 'p_kj': 1, 'p_cn': 1, 'p_jxfp': 1, 'p_cnfp': 1,
    'p_rszy': 1, 'p_sdwx': 4, 'p_bay': 8, 'p_bjy': 8, 'p_ybzby': 3
  };
  Object.keys(headCount).forEach(pid => {
    for (let i = 0; i < headCount[pid]; i++) {
      const hire = addDays(todayStr, -rnd(120, 2600));
      const st = Math.random() < 0.04 ? '离职' : (Math.random() < 0.08 ? '试用' : '在职');
      let leaveDate = '', leaveReason = '';
      if (st === '离职') { leaveDate = addDays(todayStr, -rnd(5, 90)); leaveReason = pickOne(['个人原因辞职', '合同到期不续签', '岗位调整']); }
      employees.push(makeEmployee({
        name: genName(usedName), postId: pid, phone: genMobile(usedMobile),
        hireDate: hire, status: st, leaveDate: leaveDate, leaveReason: leaveReason
      }));
    }
  });
  // 保证演示数据中一定有离职样本（否则「离职」状态与离职档案无从演示）
  if (employees.filter(e => e.status === '离职').length < 2) {
    const pool = employees.filter(e => !e.userId && e.status === '在职').slice(-3);
    pool.forEach((e, i) => {
      if (i >= 2) return;
      e.status = '离职';
      e.leaveDate = addDays(todayStr, -rnd(8, 45));
      e.leaveReason = pickOne(['个人原因辞职', '合同到期不续签', '岗位调整']);
    });
  }
  db.insertMany('employees', employees);
  // 年初至演示起始月（1-4 月）的累计：让个税累计预扣结果符合全年预期
  const firstPayMonth = '2026-05';
  const openingMonths = Number(firstPayMonth.split('-')[1]) - 1; // 4
  const policy = HR.insurancePolicy(db);
  employees.forEach(e => {
    if (e.status === '离职') return;
    const ins = HR.calcInsurance(e, policy);
    const monthlyGross = num(e.baseSalary) + num(e.postSalary) + num(e.perfSalary) * num(e.perfRate, 1) +
      num(e.allowanceTraffic) + num(e.allowanceMeal) + num(e.allowancePhone);
    let accIncome = 0, accIns = 0, accSpecial = 0, accTax = 0;
    for (let k = 1; k <= openingMonths; k++) {
      accIncome += monthlyGross;
      accIns += ins.personal;
      accSpecial += num(e.specialDeduction);
      const t = HR.calcTax(accIncome, accIns, accSpecial, k, { income: 0, insurance: 0, special: 0, taxPaid: accTax });
      accTax += t.tax;
    }
    e.openingIncome = money(accIncome);
    e.openingInsurance = money(accIns);
    e.openingSpecial = money(accSpecial);
    e.openingTax = money(accTax);
  });
  // 注意：insertMany 写入的是对象副本，这里必须整体回写，否则上面赋值的期初累计不会落盘
  db.replace('employees', employees);

  /* --- 11.3 请假 / 出差 / 加班单据 --- */
  const LEAVE_TYPES = ['事假', '病假', '年假', '调休', '婚假', '出差', '外勤'];
  const LEAVE_REASON = {
    '事假': '家中有事需处理', '病假': '感冒发烧，医院就诊', '年假': '年休假出游计划',
    '调休': '前期加班调休', '婚假': '本人结婚休假', '出差': '赴外地考察同业态项目', '外勤': '客户现场踏勘'
  };
  const leaves = [];
  let lvSeq = 0;
  const activeEmps = employees.filter(e => e.status === '在职' || e.status === '试用');
  activeEmps.forEach(e => {
    const n = rnd(0, 3);
    for (let i = 0; i < n; i++) {
      lvSeq++;
      const type = pickOne(LEAVE_TYPES);
      const start = addDays(todayStr, -rnd(1, 150));
      const days = type === '婚假' ? rnd(3, 10) : rnd(1, 3);
      const end = addDays(start, days - 1);
      leaves.push({
        id: 'lv_' + lvSeq, code: 'LV' + String(start).replace(/-/g, '') + String(lvSeq).padStart(4, '0'),
        employeeId: e.id, employeeName: e.name, deptId: e.deptId, type: type,
        startDate: start, endDate: end, days: days, hours: days * 8,
        reason: LEAVE_REASON[type] || '', status: '已通过',
        applicant: e.name, approver: employees[10].name, approveTime: now(), approveRemark: '',
        files: [], createTime: now()
      });
    }
  });
  // 少量待审批（演示审批待办，走 /approve 后可自动同步考勤）
  [3, 4, 5].forEach(i => {
    const e = activeEmps[i];
    if (!e) return;
    lvSeq++;
    const type = pickOne(['事假', '病假', '年假', '出差']);
    // 日期落在近几天（已生成考勤），审批通过后能立即回写考勤 —— 对应「事后补假」场景
    const start = addDays(todayStr, -rnd(1, 3));
    const days = type === '出差' ? 2 : rnd(1, 2);
    leaves.push({
      id: 'lv_' + lvSeq, code: 'LV' + String(start).replace(/-/g, '') + String(lvSeq).padStart(4, '0'),
      employeeId: e.id, employeeName: e.name, deptId: e.deptId, type: type,
      startDate: start, endDate: addDays(start, days - 1), days: days, hours: days * 8,
      reason: LEAVE_REASON[type] || '', status: '待审批',
      applicant: e.name, approver: '', approveTime: '', approveRemark: '', files: [], createTime: now()
    });
  });
  db.insertMany('leaves', leaves);

  const overtimes = [];
  let otSeq = 0;
  activeEmps.forEach(e => {
    const n = rnd(0, 4);
    for (let i = 0; i < n; i++) {
      otSeq++;
      const date = addDays(todayStr, -rnd(1, 150));
      const wd = new Date(date).getDay();
      const type = (wd === 0 || wd === 6) ? '休息日' : '工作日';
      overtimes.push({
        id: 'ot_' + otSeq, code: 'OT' + String(date).replace(/-/g, '') + String(otSeq).padStart(4, '0'),
        employeeId: e.id, employeeName: e.name, date: date, type: type,
        hours: pickOne([1, 2, 2, 3, 4]), compensate: Math.random() < 0.6 ? '加班费' : '调休',
        reason: pickOne(['月结集中加班', '突发设备故障抢修', '配合客户夜间收货', '季度盘点', '系统上线切换']),
        status: '已通过', applicant: e.name, approver: employees[11].name, approveTime: now(),
        createTime: now()
      });
    }
  });
  // 少量待审批，用于演示待办（加班）
  [0, 1, 2].forEach(i => {
    const e = activeEmps[i];
    otSeq++;
    overtimes.push({
      id: 'ot_' + otSeq, code: 'OT' + String(todayStr).replace(/-/g, '') + String(otSeq).padStart(4, '0'),
      employeeId: e.id, employeeName: e.name, date: todayStr, type: '工作日', hours: 3,
      compensate: '加班费', reason: '系统切换夜间值守', status: '待审批', applicant: e.name, approver: '', approveTime: '', createTime: now()
    });
  });
  db.insertMany('overtimes', overtimes);

  /* --- 11.4 考勤明细（近 6 个自然月：前 5 个完整月 + 当月至今） --- */
  const attendMonths = [];
  for (let i = 5; i >= 1; i--) attendMonths.push(monthOf(addMonths(todayStr, -i)));
  attendMonths.push(monthOf(todayStr)); // 当月（只到当天）

  const empList = employees.filter(e => e.status !== '离职' || String(e.leaveDate) >= attendMonths[0] + '-01');
  const attendance = [];
  const holidaysGPS = { '01-01': true, '05-01': true, '05-02': true, '05-03': true, '10-01': true, '10-02': true, '10-03': true };

  empList.forEach(e => {
    const shift = shifts.find(s => s.id === e.shiftId) || shifts[0];
    const myLeaves = leaves.filter(l => l.employeeId === e.id && l.status === '已通过');
    const myOts = overtimes.filter(o => o.employeeId === e.id && o.status === '已通过');
    const restSet = shift.restDays || [];
    let shiftIndex = 0;
    attendMonths.forEach((month, mi) => {
      const dim = daysInMonth(month);
      const isCurrentMonth = (month === monthOf(todayStr));
      const maxDay = isCurrentMonth ? Number(todayStr.split('-')[2]) : dim;
      const [yy, mm] = String(month).split('-').map(Number);
      for (let d = 1; d <= maxDay; d++) {
        const date = month + '-' + pad(d);
        if (String(e.hireDate) > date) continue;
        if (e.leaveDate && String(e.leaveDate) < date) continue;
        const md = String(month).slice(5) + '-' + pad(d);
        const wd = new Date(yy, mm - 1, d).getDay();
        let isRest = restSet.indexOf(wd) >= 0 || !!holidaysGPS[md];
        // 夜班做二休一
        if (shift.id === 'sf_4' && !isRest) { shiftIndex++; if (shiftIndex % 3 === 0) isRest = true; }

        const row = {
          id: uid('at'), employeeId: e.id, employeeNo: e.no, employeeName: e.name,
          deptId: e.deptId, deptName: (depts.find(x => x.id === e.deptId) || {}).name || '',
          postName: (posts.find(x => x.id === e.postId) || {}).name || '',
          date: date, month: month, shiftId: shift.id, shiftName: shift.name,
          workStart: '', workEnd: '', checkIn: '', checkOut: '',
          status: '', lateMin: 0, earlyMin: 0, workHours: 0, otHours: 0, otType: '', leaveType: '',
          nightDuty: !!shift.nightDuty, remark: '', createTime: now()
        };
        const lv = myLeaves.find(l => l.startDate <= date && date <= l.endDate);
        if (isRest) {
          row.status = '休息';
        } else if (lv) {
          row.status = '请假'; row.leaveType = lv.type; row.workHours = num(lv.days, 1);
          row.remark = lv.type + '：' + (lv.reason || '');
        } else {
          row.workStart = shift.workStart; row.workEnd = shift.workEnd; row.workHours = num(shift.hours, 8);
          const r = Math.random();
          if (r < 0.006) {
            row.status = '旷工'; row.remark = '未请假缺勤';
          } else if (r < 0.022) {
            row.status = '出差'; row.remark = '外派出差';
          } else if (r < 0.04) {
            row.status = '缺卡'; row.remark = '忘打卡，待补卡';
          } else {
            const lateM = Math.random() < 0.07 ? rnd(2, 45) : 0;
            const earlyM = Math.random() < 0.04 ? rnd(2, 35) : 0;
            const [sh, sm] = String(shift.workStart).split(':').map(Number);
            const [eh, em] = String(shift.workEnd).split(':').map(Number);
            const inDt = new Date(yy, mm - 1, d, sh, sm);
            inDt.setMinutes(inDt.getMinutes() + (lateM > 0 ? lateM : -rnd(1, 18)));
            const outDt = new Date(yy, mm - 1, d, eh, em);
            outDt.setMinutes(outDt.getMinutes() - (earlyM > 0 ? earlyM : -rnd(0, 12)));
            if (shift.crossDay) outDt.setDate(outDt.getDate() + 1);
            row.checkIn = pad(inDt.getHours()) + ':' + pad(inDt.getMinutes());
            row.checkOut = pad(outDt.getHours()) + ':' + pad(outDt.getMinutes());
            row.lateMin = lateM; row.earlyMin = earlyM;
            row.status = (lateM > 0 && earlyM > 0) ? '迟到且早退' : (lateM > 0 ? '迟到' : (earlyM > 0 ? '早退' : '正常'));
          }
        }
        // 加班单写入
        const ot = myOts.find(o => o.date === date);
        if (ot && row.status !== '休息') { row.otHours = num(ot.hours); row.otType = ot.type; }
        attendance.push(row);
      }
    });
  });
  db.insertMany('attendance', attendance);
  db.persist('attendance');

  /* --- 11.5 工资表（近 5 个已结算月份） --- */
  const payMonths = [];
  for (let i = 5; i >= 1; i--) payMonths.push(monthOf(addMonths(todayStr, -i)));
  payMonths.forEach((month, mi) => {
    let seq = 0;
    empList.forEach(e => {
      if (String(e.hireDate) > (month + '-' + pad(daysInMonth(month)))) return;
      if (e.leaveDate && String(e.leaveDate) < (month + '-01')) return;
      if (e.status === '离职' && String(e.leaveDate).indexOf(month) !== 0) return;
      seq++;
      const calc = HR.buildPayroll(db, Object.assign({}, e, {
        deptName: (depts.find(x => x.id === e.deptId) || {}).name || '',
        postName: (posts.find(x => x.id === e.postId) || {}).name || ''
      }), month);
      const ym = String(month).replace('-', '');
      db.insert('payrolls', Object.assign({}, calc, {
        id: 'pr_' + ym + '_' + seq,
        code: 'GZ' + ym + String(seq).padStart(4, '0'),
        status: mi < payMonths.length - 2 ? '已发放' : (mi === payMonths.length - 2 ? '已核算' : '草稿'),
        payDate: mi < payMonths.length - 2 ? addDays(month + '-15', 0) : '',
        payee: mi < payMonths.length - 2 ? '钱出纳' : '',
        payChannel: mi < payMonths.length - 2 ? '银行代发' : '',
        createTime: now(), createdBy: '系统初始化'
      }));
    });
  });
  db.persist('payrolls');

  // 11.6 人事类提醒：劳动合同到期 / 当月考勤异常
  const hrReminders = [];
  const hrMonth = monthOf(todayStr);
  activeEmps.forEach(e => {
    if (e.contractEnd) {
      const d = Math.round((new Date(e.contractEnd) - new Date(todayStr)) / 86400000);
      if (d > 0 && d <= 60) {
        hrReminders.push({
          id: uid('rm3'), type: '合同到期', level: d <= 15 ? '紧急' : '重要',
          dueDate: e.contractEnd, daysLeft: d, status: '未处理', ownerId: 'u_11',
          content: '员工劳动合同到期：' + e.name + '（' + e.no + '）将于 ' + e.contractEnd + ' 到期，剩余 ' + d + ' 天',
          employeeId: e.id, employeeName: e.name, createdAt: now()
        });
      }
    }
    const s = HR.summarizeAttendance(db, e.id, hrMonth);
    if (s.lateCount >= 3) {
      hrReminders.push({
        id: uid('rm3'), type: '考勤异常', level: '提示', dueDate: '', daysLeft: 0,
        status: '未处理', ownerId: 'u_11',
        content: '员工 ' + e.name + '（' + e.no + '）本月迟到 ' + s.lateCount + ' 次，建议谈话并计入绩效考核',
        employeeId: e.id, employeeName: e.name, createdAt: now()
      });
    }
  });
  if (hrReminders.length) db.insertMany('reminders', hrReminders);

  /* ===================== 12. 巡更检查（点位 / 人员 / 巡查记录） ===================== */
  const patrol = seedPatrol(db, true);
  const patrolPoints = patrol.points, patrolPersons = patrol.persons, patrolRecords = patrol.records;

  db.insert('logs', {
    id: uid('log'), time: now(), userId: 'u_1', userName: '系统管理员',
    module: '系统', action: '初始化', bizType: '系统', bizId: '', bizCode: '',
    detail: '系统初始化完成：项目 ' + projects.length + ' 个 / 房间 ' + rooms.length + ' 间 / 客户 ' + customers.length + ' 家 / 合同 ' + contracts.length + ' 份 / 账单 ' + bills.length + ' 条 / 员工 ' + employees.length + ' 人 / 巡更点位 ' + patrolPoints.length + ' 个 / 巡查记录 ' + patrolRecords.length + ' 条',
    ip: ''
  });
  return true;
}

/* ---------- 巡更检查演示数据（独立函数：首次初始化与「已有库补种」共用） ---------- */
function seedPatrol(db, force) {
  if (!force && db.count('patrolPoints') > 0) return { points: 0, persons: 0, records: 0 };
  const XLS = require('./xls');
  const PAT = require('./patrol');
  const nodeFs = require('fs');
  // 巡更演示数据的来源目录。
  // 【为什么必须用环境变量而不是硬编码字面量】
  // 原来这里写死 'J:/梦想之城物业管理系统/局部小工具/巡更检查小工具/新建文件夹/'，
  // Netlify 的 nft 打包器会**静态扫描源码里的路径字面量**并把那个目录整个打进函数包。
  // 实测后果：api.zip 里混进了「梦想之城物业管理系统/局部小工具/.../维序巡查记录7月.xls」
  // （972KB）—— 一个跟本项目无关的外部项目的原始巡更文件，跟着部署到了公网。
  // 改成环境变量后 nft 追踪不到任何字面量路径，外部目录自然不会进包。
  // 本地需要读真实文件时：PATROL_SRC='J:/梦想之城物业管理系统/局部小工具/巡更检查小工具/新建文件夹/' npm start
  const SRC_DIR = String(process.env.PATROL_SRC || '').replace(/[\\/]+$/, '');
  let patrolPoints = [], patrolPersons = [], patrolRecords = [];
  let patrolSrc = '';

  // 优先使用真实巡更导出文件（仅当显式配置了来源目录时才尝试）
  if (SRC_DIR) {
    try {
      const pf = SRC_DIR + '/巡更点位.xls';
      const rf = SRC_DIR + '/维序巡查记录7月.xls';
      if (nodeFs.existsSync(pf) && nodeFs.existsSync(rf)) {
        const pp = PAT.parsePoints(XLS.readTable(nodeFs.readFileSync(pf), '巡更点位.xls').rows);
        const rr = PAT.parseRecords(XLS.readTable(nodeFs.readFileSync(rf), '维序巡查记录7月.xls').rows);
        if (pp.points.length && rr.records.length) {
          patrolPoints = pp.points;
          patrolPersons = pp.persons;
          patrolRecords = rr.records;
          patrolSrc = '巡更点位.xls + 维序巡查记录7月.xls';
        }
      }
    } catch (e) {
      console.error('[INIT] 巡更真实数据读取失败，改用内置演示数据：', e.message);
    }
  }

  // 兜底：内置演示数据（真实文件不可用时）
  if (!patrolPoints.length) {
    const floors = [18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, -1, -2];
    floors.forEach((f, i) => {
      ['东面步梯间', '西面楼梯间'].forEach((suffix, j) => {
        patrolPoints.push({
          code: String(100000 + i * 10 + j),
          name: (f < 0 ? '-' + Math.abs(f) + ' ' : f + 'F') + suffix,
          remark: f < 0 ? 'B' + Math.abs(f) : f + 'F', route: '路线A', routeOrder: i * 2 + j + 1, sortKey: 0
        });
      });
    });
    patrolPoints.push({ code: '0000000019', name: '19设备房', remark: '设备房', route: '路线A', routeOrder: 99, sortKey: 999 });
    patrolPersons = [
      { code: '9000000001', name: '夜班-朱春平', shift: '夜班' },
      { code: '9000000002', name: '夜班-何南', shift: '夜班' },
      { code: '9000000003', name: '白班-廖正凯', shift: '白班' }
    ];
    let seq = 1;
    for (let d = 45; d >= 0; d--) {
      const base = addDays(today(), -d);
      const person = patrolPersons[d % 2].name;
      let t = new Date(base + 'T18:30:00');
      patrolPoints.forEach(p => {
        t = new Date(t.getTime() + (60 + rnd(0, 120)) * 1000);
        patrolRecords.push({
          seq: seq++, time: PAT.fmtDateTime(t), timeAt: t.getTime(),
          device: '巡检器01', pointCode: p.code, person: person, pointName: p.name
        });
      });
    }
    patrolSrc = '内置演示数据';
  }

  patrolPoints.forEach(p => { p.sortKey = PAT.pointSortKey(p.name); });
  patrolPoints.sort((a, b) => (a.sortKey - b.sortKey) || (a.name < b.name ? -1 : 1));
  db.insertMany('patrolPoints', patrolPoints.map(p => Object.assign({ status: '启用' }, p)));
  db.insertMany('patrolPersons', patrolPersons.map(p => Object.assign({ status: '在职' }, p)));
  db.insertMany('patrolRecords', patrolRecords.map(r => Object.assign({ id: uid('pr') }, r)));
  db.insert('patrolBatches', {
    id: uid('pbt'), type: '初始化', fileName: patrolSrc, fileUrl: '',
    time: now(), points: patrolPoints.length, persons: patrolPersons.length,
    records: patrolRecords.length, mode: 'replace', operator: '系统',
    range: patrolRecords.length ? (patrolRecords[0].time.slice(0, 10) + ' ~ ' + patrolRecords[patrolRecords.length - 1].time.slice(0, 10)) : ''
  });
  console.log('[INIT] 巡更演示数据：点位 ' + patrolPoints.length + ' 个 / 人员 ' + patrolPersons.length + ' 人 / 记录 ' + patrolRecords.length + ' 条（' + patrolSrc + '）');
  return { points: patrolPoints.length, persons: patrolPersons.length, records: patrolRecords.length };
}

module.exports = { seed, seedPatrol, floorAlias, floorName };
