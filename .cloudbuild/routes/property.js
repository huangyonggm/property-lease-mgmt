'use strict';
// 房源（不动产）管理：项目 / 楼栋 / 房间 / 跳层 / 合并拆分 / 跨楼栋迁移 / CAD 图纸
const { ok, fail } = require('../lib/http');
const { register, can } = require('../lib/crud');
const audit = require('../lib/audit');
const { uid, num, money, now, today, pad } = require('../lib/util');
const { FLOOR_ALIAS, floorNameOf } = require('../lib/billing');

module.exports = function (db, router) {
  /* ---------- 项目 ---------- */
  register(router, '/api/property/projects', 'projects', {
    db, view: 'property:view', manage: 'property:manage', sort: 'code',
    async decorate(row) {
      const o = Object.assign({}, row);
      o.roomCount = (await db.where('rooms', r => r.projectId === row.id)).length;
      o.rentedCount = (await db.where('rooms', r => r.projectId === row.id && r.status === '已租')).length;
      o.vacantCount = (await db.where('rooms', r => r.projectId === row.id && r.status === '空置')).length;
      o.buildingCount = (await db.where('buildings', b => b.projectId === row.id)).length;
      const m = (await db.find('users', row.managerId));
      o.managerName = m ? m.name : '';
      const cs = (await db.where('contracts', c => c.projectId === row.id && c.status === '正常履约'));
      o.contractCount = cs.length;
      const areas = (await db.where('rooms', r => r.projectId === row.id));
      o.totalArea = money(areas.reduce((s, r) => s + num(r.area), 0));
      o.rentArea = money(areas.filter(r => r.status === '已租').reduce((s, r) => s + num(r.area), 0));
      o.occupancy = o.totalArea > 0 ? Math.round(o.rentArea / o.totalArea * 1000) / 10 : 0;
      return o;
    },
    after(row, action, req) {
      audit.routeLog(db, req, '房源管理', action === 'insert' ? '新增项目' : '修改项目', { bizId: row.id, bizCode: row.code, detail: row.name });
    }
  });

  /* ---------- 楼栋 ---------- */
  register(router, '/api/property/buildings', 'buildings', {
    db, view: 'property:view', manage: 'property:manage', sort: 'code',
    where(q) { return q.projectId ? { projectId: q.projectId } : null; },
    async decorate(row) {
      const o = Object.assign({}, row);
      const pj = (await db.find('projects', row.projectId));
      o.projectName = pj ? pj.name : '';
      o.roomCount = (await db.where('rooms', r => r.buildingId === row.id)).length;
      o.vacantCount = (await db.where('rooms', r => r.buildingId === row.id && r.status === '空置')).length;
      o.floorAlias = row.floorAlias || FLOOR_ALIAS;
      return o;
    }
  });

  // 楼层列表（含跳层命名）
  router.get('/api/property/buildings/:id/floors', async (req, res) => {
    if (!can(req, res, 'property:view')) return;
    const b = (await db.find('buildings', req.params.id));
    if (!b) return fail(res, '楼栋不存在', 404);
    const alias = b.floorAlias || FLOOR_ALIAS;
    const floors = [];
    for (let f = 1; f <= num(b.floors, 1); f++) {
      const label = alias[f] || String(f);
      const rooms = (await db.where('rooms', r => r.buildingId === b.id && String(r.floor) === String(f)));
      floors.push({
        floor: f, label: label, isSkip: !!alias[f],
        roomCount: rooms.length,
        vacantCount: rooms.filter(r => r.status === '空置').length,
        isAc: (b.acFloors || []).indexOf(f) >= 0,
        isFire: (b.fireFloors || []).indexOf(f) >= 0,
        area: money(rooms.reduce((s, r) => s + num(r.area), 0))
      });
    }
    ok(res, floors);
  });

  /* ---------- 房间 ---------- */
  register(router, '/api/property/rooms', 'rooms', {
    db, view: 'property:view', manage: 'property:manage', sort: 'code',
    // decorate 每行都要找“含该房间的有效合同”，该条件不可选择性下推，逐行查会退化成
    // N 次近全表拉取（实测 20 行 → contracts×20、回传 5MB）。先整表预载一次，之后走内存匹配。
    preload: ['contracts'],
    where(q, req) {
      const w = {};
      if (q.projectId) w.projectId = q.projectId;
      if (q.buildingId) w.buildingId = q.buildingId;
      if (q.floor) w.floor = q.floor;
      if (q.status) w.status = q.status;
      if (q.level) w.level = q.level;
      return Object.keys(w).length ? w : null;
    },
    async search(kw, where) {
      return (await db.where('rooms', where)).filter(r =>
        (r.code || '').indexOf(kw) >= 0 || (r.roomNo || '').indexOf(kw) >= 0 ||
        (r.propertyCert || '').indexOf(kw) >= 0 || (r.ownerName || '').indexOf(kw) >= 0 ||
        (r.remark || '').indexOf(kw) >= 0);
    },
    async decorate(row) {
      const o = Object.assign({}, row);
      const b = (await db.find('buildings', row.buildingId));
      const pj = (await db.find('projects', row.projectId));
      o.buildingName = b ? b.name : '';
      o.projectName = pj ? pj.name : '';
      o.floorLabel = row.floorLabel || floorNameOf(row.floor);
      const ct = (await db.one('contracts', c => c.status !== '退租' && c.status !== '终止' && c.roomIds && c.roomIds.indexOf(row.id) >= 0));
      o.contractCode = ct ? ct.code : '';
      o.customerName = ct ? ct.customerName : '';
      o.customerId = ct ? ct.customerId : '';
      o.endDate = ct ? ct.endDate : '';
      o.rentUnitPrice = ct ? ct.rentUnitPrice : 0;
      if (o.mergedFrom && o.mergedFrom.length) {
        // map 回调要 await db.find → Promise.all 聚合
        o.mergedNames = (await Promise.all(o.mergedFrom.map(id => db.find('rooms', id))))
          .map(r => (r ? r.code : '')).filter(Boolean);
      }
      return o;
    },
    async beforeRemove(row) {
      const ct = (await db.one('contracts', c => c.roomIds && c.roomIds.indexOf(row.id) >= 0 && c.status !== '退租'));
      if (ct) return '该房间存在有效合同 ' + ct.code + '，不能删除';
      return null;
    },
    after(row, action, req) {
      audit.routeLog(db, req, '房源管理', action === 'insert' ? '新增房间' : '修改房间',
        { bizId: row.id, bizCode: row.code, detail: '面积 ' + row.area + '㎡ / ' + row.status });
    }
  });

  // 批量生成房间
  router.post('/api/property/rooms/batch', async (req, res) => {
    if (!can(req, res, 'property:manage')) return;
    const b = req.body || {};
    if (!b.buildingId || !b.from || !b.to) return fail(res, '缺少楼栋或房号范围');
    const bd = (await db.find('buildings', b.buildingId));
    if (!bd) return fail(res, '楼栋不存在');
    const from = num(b.from), to = num(b.to);
    const created = [], skipped = [];
    for (let i = from; i <= to; i++) {
      const no = pad(i, num(b.width, 2));
      const exist = (await db.one('rooms', r => r.buildingId === b.buildingId && String(r.floor) === String(b.floor) && r.roomNo === no));
      if (exist) { skipped.push(no); continue; }
      created.push((await db.insert('rooms', {
        id: uid('rm'), projectId: bd.projectId, buildingId: b.buildingId,
        floor: num(b.floor), floorLabel: floorNameOf(num(b.floor)),
        roomNo: no, code: bd.name + '-' + floorNameOf(num(b.floor)) + '-' + no,
        area: num(b.area, 100), useArea: money(num(b.area, 100) * 0.75),
        bizType: b.bizType || '办公', status: '空置',
        level: num(b.floor) <= 3 ? '低层' : (num(b.floor) >= 12 ? '高层' : '中间楼层'),
        propertyCert: b.propertyCert || '', certNo: '', certArea: num(b.area, 100), ownerName: b.ownerName || '',
        cadFile: '', facilities: [], mergedFrom: [], splitFrom: '', parentRoomId: '',
        sharedElectric: true, priceStandard: num(b.priceStandard), remark: '', tags: []
      })));
    }
    audit.routeLog(db, req, '房源管理', '批量生成房间', { detail: bd.name + ' ' + floorNameOf(num(b.floor)) + ' 层，新增 ' + created.length + ' 间' });
    ok(res, { created: created.length, skipped: skipped.length });
  });

  // 房间合并：把多个房间合并到主房间
  router.post('/api/property/rooms/merge', async (req, res) => {
    if (!can(req, res, 'property:manage')) return;
    const b = req.body || {};
    const ids = (b.roomIds || []).filter(Boolean);
    if (ids.length < 2) return fail(res, '请至少选择 2 间房间');
    const main = (await db.find('rooms', ids[0]));
    if (!main) return fail(res, '主房间不存在');
    // 一次把待合并的房间全查出来复用：原来同一个房间查了 4 次
    // （filter 一次、reduce 一次、remark 里一次、update 一次）
    const others = (await Promise.all(ids.slice(1).map(id => db.find('rooms', id)))).filter(Boolean);
    // 同步回调里不能 await，先串行查出「有有效合同」的房间
    const withContract = [];
    for (let i = 0; i < ids.length; i++) {
      if (i === 0) continue;
      const ct = await db.one('contracts', c => c.roomIds && c.roomIds.indexOf(ids[i]) >= 0 && c.status !== '退租');
      if (ct) withContract.push(ids[i]);
    }
    if (withContract.length && !b.force) return fail(res, '所选房间中存在有效合同，合并后需同步变更合同，请勾选“强制合并”');
    // 主房间也并入查询结果，算总面积时不用再查一次
    const allRooms = [main].concat(others);
    const areaAll = money(allRooms.reduce((s, r) => s + num(r && r.area), 0));
    await db.update('rooms', main.id, {
      mergedFrom: (main.mergedFrom || []).concat(ids.slice(1)),
      area: areaAll, useArea: money(areaAll * 0.75),
      tags: (main.tags || []).concat(['合并房源']),
      remark: (main.remark ? main.remark + '；' : '') + '已合并 ' + others.map(r => r.roomNo).join('、') + ' 号'
    });
    // for...of：循环体要 await db.update
    for (const id of ids.slice(1)) await db.update('rooms', id, { parentRoomId: main.id, status: '停用' });
    audit.routeLog(db, req, '房源管理', '房间合并', { bizId: main.id, bizCode: main.code, detail: '合并 ' + ids.length + ' 间，合并后面积 ' + areaAll + '㎡' });
    ok(res, (await db.find('rooms', main.id)));
  });

  // 房间拆分：把一间拆成 N 间
  router.post('/api/property/rooms/split', async (req, res) => {
    if (!can(req, res, 'property:manage')) return;
    const b = req.body || {};
    const room = (await db.find('rooms', b.roomId));
    if (!room) return fail(res, '房间不存在');
    const parts = b.parts || [];
    if (!parts.length) return fail(res, '请填写拆分后的房间');
    const bd = (await db.find('buildings', room.buildingId));
    const created = [];
    // for...of：循环体要 await db.insert
    for (const p of parts) {
      created.push(await db.insert('rooms', {
        id: uid('rm'), projectId: room.projectId, buildingId: room.buildingId,
        floor: room.floor, floorLabel: room.floorLabel || floorNameOf(room.floor),
        roomNo: p.roomNo, code: (bd ? bd.name : '') + '-' + (room.floorLabel || floorNameOf(room.floor)) + '-' + p.roomNo,
        area: num(p.area), useArea: money(num(p.area) * 0.75),
        bizType: room.bizType, status: '空置', level: room.level,
        propertyCert: room.propertyCert, certNo: '', certArea: num(p.area), ownerName: room.ownerName,
        cadFile: room.cadFile, facilities: room.facilities, mergedFrom: [], splitFrom: room.id, parentRoomId: '',
        sharedElectric: true, priceStandard: room.priceStandard, remark: '由 ' + room.code + ' 拆分', tags: ['合租']
      }));
    }
    (await db.update('rooms', room.id, { status: '停用', tags: ['已拆分'], remark: '已拆分为 ' + parts.map(p => p.roomNo).join('、') }));
    audit.routeLog(db, req, '房源管理', '房间拆分', { bizId: room.id, bizCode: room.code, detail: '拆分为 ' + parts.map(p => p.roomNo).join('、') });
    ok(res, { created: created.length, rooms: created });
  });

  // 房源跨楼栋迁移：房间 + 历史账单 + 费用 + 合同一并迁移
  router.post('/api/property/rooms/transfer', async (req, res) => {
    if (!can(req, res, 'property:manage')) return;
    const b = req.body || {};
    const room = (await db.find('rooms', b.roomId));
    if (!room) return fail(res, '房间不存在');
    const target = (await db.find('buildings', b.toBuildingId));
    if (!target) return fail(res, '目标楼栋不存在');
    const toFloor = num(b.toFloor, room.floor);
    const bd = (await db.find('buildings', room.buildingId));
    const before = JSON.parse(JSON.stringify(room));
    const newCode = target.name + '-' + floorNameOf(toFloor) + '-' + (b.toRoomNo || room.roomNo);
    (await db.update('rooms', room.id, {
      buildingId: target.id, projectId: target.projectId,
      floor: toFloor, floorLabel: floorNameOf(toFloor),
      roomNo: b.toRoomNo || room.roomNo, code: newCode,
      remark: (room.remark ? room.remark + '；' : '') + '于 ' + today() + ' 由 ' + (bd ? bd.name : '') + ' 迁移至 ' + target.name
    }));
    // 历史账单：跟随迁移（保留原房号痕迹）
    const bills = (await db.where('bills', bl => bl.roomIds && bl.roomIds.indexOf(room.id) >= 0));
    // for...of：循环体要 await db.update
    for (const bl of bills) {
      bl.roomCodes = (bl.roomCodes || []).map(c => c === before.code ? newCode : c);
      bl.projectId = target.projectId; bl.buildingId = target.id;
      await db.update('bills', bl.id, { roomCodes: bl.roomCodes, projectId: bl.projectId, buildingId: bl.buildingId });
    }
    // 合同：更新房号显示与归属
    const contracts = (await db.where('contracts', c => c.roomIds && c.roomIds.indexOf(room.id) >= 0));
    for (const c of contracts) {
      c.roomCodes = (c.roomCodes || []).map(x => x === before.code ? newCode : x);
      c.projectId = target.projectId; c.buildingId = target.id;
      c.changeLog = (c.changeLog || []).concat([{ time: now(), user: (req.u || {}).name || '', action: '房源迁移', detail: before.code + ' → ' + newCode + '（账单与费用同步迁移）' }]);
      await db.update('contracts', c.id, { roomCodes: c.roomCodes, projectId: c.projectId, buildingId: c.buildingId, changeLog: c.changeLog });
    }
    // 表具与抄表
    for (const m of await db.where('meters', x => x.roomId === room.id)) {
      await db.update('meters', m.id, { buildingId: target.id, projectId: target.projectId });
    }
    // 读数随表具 roomId 关联，无需改（保持原样，仅确认已查询）
    await db.where('readings', r => r.roomId === room.id);
    audit.routeLog(db, req, '房源管理', '房源跨楼栋迁移', {
      bizId: room.id, bizCode: before.code,
      detail: before.code + ' → ' + newCode + '；同步迁移账单 ' + bills.length + ' 条、合同 ' + contracts.length + ' 份',
      before: before, after: (await db.find('rooms', room.id))
    });
    ok(res, { room: (await db.find('rooms', room.id)), bills: bills.length, contracts: contracts.length });
  });

  // 房间配套 / 产权证 / CAD 图纸更新
  router.post('/api/property/rooms/:id/attrs', async (req, res) => {
    if (!can(req, res, 'property:manage')) return;
    const b = req.body || {};
    const row = (await db.find('rooms', req.params.id));
    if (!row) return fail(res, '房间不存在', 404);
    const before = JSON.parse(JSON.stringify(row));
    const patch = {};
    ['area', 'useArea', 'level', 'bizType', 'status', 'propertyCert', 'certNo', 'certArea', 'ownerName', 'cadFile', 'facilities', 'sharedElectric', 'priceStandard', 'remark'].forEach(k => {
      if (b[k] !== undefined) patch[k] = b[k];
    });
    (await db.update('rooms', req.params.id, patch));
    audit.routeLog(db, req, '房源管理', '修改房源属性', { bizId: row.id, bizCode: row.code, before: before, after: (await db.find('rooms', row.id)) });
    ok(res, (await db.find('rooms', row.id)));
  });

  // 房源统计（按项目 / 楼栋 / 楼层）
  router.get('/api/property/stats', async (req, res) => {
    if (!can(req, res, 'property:view')) return;
    const projects = (await db.where('projects'));
    // map 回调要 await 查房间 → Promise.all 聚合
    const rows = await Promise.all(projects.map(async pj => {
      const rooms = await db.where('rooms', r => r.projectId === pj.id);
      const vacant = rooms.filter(r => r.status === '空置');
      return {
        projectId: pj.id, projectName: pj.name, portName: pj.portName,
        total: rooms.length, vacant: vacant.length,
        rented: rooms.filter(r => r.status === '已租').length,
        repair: rooms.filter(r => r.status === '维修').length,
        disabled: rooms.filter(r => r.status === '停用').length,
        area: money(rooms.reduce((s, r) => s + num(r.area), 0)),
        vacantArea: money(vacant.reduce((s, r) => s + num(r.area), 0)),
        occupancy: rooms.length ? Math.round((rooms.length - vacant.length) / rooms.length * 1000) / 10 : 0
      };
    }));
    ok(res, rows);
  });

  // 跳层规则
  router.get('/api/property/floor-alias', async (req, res) => {
    if (!can(req, res, 'property:view')) return;
    ok(res, FLOOR_ALIAS);
  });

  return router;
};
