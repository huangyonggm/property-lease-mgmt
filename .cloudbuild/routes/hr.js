'use strict';
// 人事管理：员工档案 / 班次排班 / 考勤打卡 / 请假加班 / 社保规则 / 薪资核算与发放
const { ok, fail } = require('../lib/http');
const { register, can, needLogin } = require('../lib/crud');
const A = require('../lib/auth');
const H = require('../lib/hr');
const X = require('../lib/exportx');
const audit = require('../lib/audit');
const path = require('path');
const { uid, num, money, today, now, monthOf, addDays, addMonths, diffDays, daysInMonth, pad, pick } = require('../lib/util');

function sendDownload(res, filename, content, mime) {
  const buf = Buffer.from(content, 'utf8');
  res.writeHead(200, {
    'Content-Type': (mime || 'text/csv') + '; charset=utf-8',
    'Content-Length': buf.length,
    'Content-Disposition': 'attachment; filename="' + encodeURIComponent(filename) + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename)
  });
  res.end(buf);
}

/**
 * 部门 / 岗位名称查表助手。
 *
 * 原来每行都 db.find 查一次，50 个员工就是 100 次查库；云端下每次都是一次网络往返，
 * 页面会明显变慢。改成「一次 db.all 拉全量 → 建 id→名称 映射 → 内存查」。
 * 映射按 db 实例缓存（部门/岗位是低频变更数据），改完这两张表后调 resetNameMaps 清缓存。
 */
async function nameMaps(db) {
  if (!db.__hrNameMaps) {
    db.__hrNameMaps = Promise.all([db.all('depts'), db.all('posts')]).then((rs) => {
      const dept = {}, post = {};
      (rs[0] || []).forEach(r => { dept[r.id] = r.name || ''; });
      (rs[1] || []).forEach(r => { post[r.id] = r.name || ''; });
      return { dept: dept, post: post };
    });
  }
  return db.__hrNameMaps;
}

function resetNameMaps(db) { db.__hrNameMaps = null; }

async function dt(db, id) { return (await nameMaps(db)).dept[id] || ''; }
async function pt(db, id) { return (await nameMaps(db)).post[id] || ''; }

module.exports = function (db, router, opt) {
  const ctx = opt || {};
  const exportDir = ctx.exportDir || path.join(ctx.rootDir || __dirname + '/..', 'exports');

  /* ===================== 1. 员工档案 ===================== */
  register(router, '/api/hr/employees', 'employees', {
    db, view: 'hr:view', manage: 'hr:manage', sort: 'no',
    async search(kw, where) {
      kw = String(kw).toLowerCase();
      return (await db.where('employees', where)).filter(e =>
        (e.name || '').toLowerCase().indexOf(kw) >= 0 ||
        (e.no || '').toLowerCase().indexOf(kw) >= 0 ||
        (e.phone || '').indexOf(kw) >= 0 ||
        (e.idCard || '').indexOf(kw) >= 0
      );
    },
    where(q, req) {
      const f = r => {
        if (q.status && r.status !== q.status) return false;
        if (q.deptId && r.deptId !== q.deptId) return false;
        if (q.projectId && r.projectId !== q.projectId) return false;
        return true;
      };
      return f;
    },
    async decorate(row) {
      return Object.assign({}, row, {
        deptName: await dt(db, row.deptId),
        postName: await pt(db, row.postId),
        projectName: ((await db.find('projects', row.projectId)) || {}).name || '',
        age: row.birthday ? diffDays(row.birthday, today()) > 0 ? Math.floor(diffDays(row.birthday, today()) / 365) : 0 : '',
        seniority: row.hireDate ? (Math.max(0, Math.floor(diffDays(row.hireDate, today()) / 365)) + ' 年') : ''
      });
    },
    async validate(b) {
      // 更新允许只提交变更字段（带 id 时不强制姓名）
      // 姓名仅在新增时必填；工号无论新增/更新，只要提交了就校验唯一性
      if (!b.name && !b.id) return '请填写员工姓名';
      if (b.no) {
        const exist = (await db.one('employees', e => e.no === b.no && String(e.id) !== String(b.id || '')));
        if (exist) return '工号已存在：' + b.no;
      }
      if (b.phone && !/^1\d{10}$/.test(b.phone)) return '手机号格式不正确';
      if (b.idCard && !/^\d{17}[\dXx]$/.test(b.idCard)) return '身份证号格式不正确（18 位）';
      return null;
    },
    async beforeInsert(b, req) {
      if (!b.no) b.no = 'EMP' + String((await db.count('employees')) + 1).padStart(4, '0');
      const exist = (await db.one('employees', e => e.no === b.no));
      if (exist) b.no = b.no + '-' + uid('').slice(0, 3);
      if (!b.status) b.status = '试用';
      if (!b.hireDate) b.hireDate = today();
      b.createTime = now();
      b.createdBy = req.u ? req.u.name : '';
    },
    after(row, action, req) {
      const map = { insert: '新增员工', update: '修改员工档案', remove: '删除员工' };
      audit.routeLog(db, req, '人事管理', map[action] || '变更员工', { bizId: row.id, bizCode: row.no, detail: row.name });
    }
  });

  // 员工档案附件 / 合同到期提醒由前端统一走 /api/system/upload

  /* ===================== 2. 班次班制 ===================== */
  router.get('/api/hr/shifts', async (req, res) => {
    if (!can(req, res, 'hr:view')) return;
    ok(res, (await db.where('shifts')));
  });
  router.post('/api/hr/shifts', async (req, res) => {
    if (!can(req, res, 'hr:manage')) return;
    const b = req.body || {};
    const list = Array.isArray(b) ? b : [b];
    // for...of：循环体要 await 查/写
    for (const s of list) {
      if (s.id && (await db.find('shifts', s.id))) await db.update('shifts', s.id, s);
      else {
        const p = Object.assign({}, s); delete p.id;
        await db.insert('shifts', p);
      }
    }
    audit.routeLog(db, req, '人事管理', '维护班次', { detail: list.length + ' 条' });
    ok(res, (await db.where('shifts')));
  });
  router.del('/api/hr/shifts/:id', async (req, res) => {
    if (!can(req, res, 'hr:manage')) return;
    const used = (await db.where('employees', e => e.shiftId === req.params.id)).length;
    if (used) return fail(res, '该班次下还有 ' + used + ' 名员工，不能删除');
    (await db.remove('shifts', req.params.id));
    ok(res, true);
  });

  /* ===================== 3. 社保公积金规则 ===================== */
  router.get('/api/hr/insurance', async (req, res) => {
    if (!can(req, res, 'hr:view')) return;
    ok(res, await H.insurancePolicy(db));
  });
  router.post('/api/hr/insurance', async (req, res) => {
    if (!can(req, res, 'hr:manage')) return;
    const b = req.body || {};
    const st = (await db.one('settings', s => s.key === 'insurance'));
    const payload = {
      city: b.city, socialMin: num(b.socialMin), socialMax: num(b.socialMax),
      fundMin: num(b.fundMin), fundMax: num(b.fundMax), fundRate: num(b.fundRate),
      items: Array.isArray(b.items) ? b.items : []
    };
    if (st) (await db.update('settings', st.id, { value: payload }));
    else (await db.insert('settings', { id: 'st_ins', key: 'insurance', name: '社保公积金规则', value: payload }));
    audit.routeLog(db, req, '人事管理', '修改社保规则', { detail: (payload.city || '') + ' 缴费基数与比例' });
    ok(res, await H.insurancePolicy(db));
  });

  /* ===================== 4. 考勤 ===================== */
  // 注意：具体子路径必须注册在 /api/hr/attendance/:id 之前

  // 4.1 明细列表（支持 月 / 员工 / 部门 / 状态 过滤）
  router.get('/api/hr/attendance', async (req, res) => {
    if (!can(req, res, 'hr:view')) return;
    const q = req.query;
    let list = (await db.where('attendance', a => {
      if (q.month && a.month !== q.month) return false;
      if (q.employeeId && a.employeeId !== q.employeeId) return false;
      if (q.deptId && a.deptId !== q.deptId) return false;
      if (q.status && a.status !== q.status) return false;
      if (q.startDate && String(a.date) < q.startDate) return false;
      if (q.endDate && String(a.date) > q.endDate) return false;
      return true;
    }));
    if (!q.size) list = list.slice(0, 500);
    list = list.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.employeeNo).localeCompare(String(b.employeeNo)));
    ok(res, { list: list, total: list.length });
  });

  // 4.2 月度考勤汇总
  router.get('/api/hr/attendance/summary', async (req, res) => {
    if (!can(req, res, 'hr:view')) return;
    const month = req.query.month || monthOf(today());
    ok(res, await H.attendanceOverview(db, month, { deptId: req.query.deptId }));
  });

  // 4.3 生成月度排班考勤
  router.post('/api/hr/attendance/generate', async (req, res) => {
    if (!can(req, res, 'hr:attend')) return;
    const b = req.body || {};
    const month = b.month || monthOf(today());
    const [yy, mm] = String(month).split('-').map(Number);
    if (!yy || !mm) return fail(res, '月份格式应为 YYYY-MM');
    const dim = daysInMonth(month);

    let emps = (await db.where('employees', e => e.status === '在职' || e.status === '试用'));
    if (b.employeeId) emps = emps.filter(e => e.id === b.employeeId);
    if (b.deptId) emps = emps.filter(e => e.deptId === b.deptId);
    if (!emps.length) return fail(res, '没有符合条件的在职员工');

    // 已通过的请假/出差（用于标记）
    const leaves = (await db.where('leaves', l => l.status === '已通过'));

    let created = 0, skipped = 0;
    const rows = [];
    // for...of：循环体要 await 查班次、查考勤、await dt/pt。
    // forEach/map 回调是同步函数，云端下会把整月考勤写不进去。
    for (const e of emps) {
      const shift = (await db.find('shifts', e.shiftId)) || (await db.one('shifts')) ||
        { name: '行政班', workStart: '09:00', workEnd: '18:00', hours: 8, restDays: [0, 6] };
      const restDays = Array.isArray(shift.restDays) ? shift.restDays : [0, 6];
      const myLeaves = leaves.filter(l => l.employeeId === e.id);
      const eDeptName = await dt(db, e.deptId);
      const ePostName = await pt(db, e.postId);
      for (let d = 1; d <= dim; d++) {
        const date = month + '-' + pad(d);
        const exist = await db.one('attendance', a => a.employeeId === e.id && a.date === date);
        if (exist && !b.overwrite) { skipped++; continue; }
        const wd = new Date(date).getDay();
        const isRest = restDays.indexOf(wd) >= 0;
        const lv = myLeaves.find(l => l.startDate <= date && date <= l.endDate);

        const row = {
          employeeId: e.id, employeeNo: e.no, employeeName: e.name,
          deptId: e.deptId, deptName: eDeptName, postName: ePostName,
          date: date, month: month, shiftId: shift.id || '', shiftName: shift.name,
          workStart: '', workEnd: '', checkIn: '', checkOut: '',
          status: '', lateMin: 0, earlyMin: 0, workHours: 0, otHours: 0, otType: '',
          leaveType: '', nightDuty: false, remark: ''
        };

        if (isRest) {
          row.status = '休息';
        } else if (lv) {
          row.status = '请假';
          row.leaveType = lv.type;
          row.workHours = num(lv.days, 1);
          row.remark = (lv.type || '请假') + '：' + (lv.reason || '');
        } else {
          row.workStart = shift.workStart || '09:00';
          row.workEnd = shift.workEnd || '18:00';
          row.workHours = num(shift.hours, 8);
          const r = Math.random();
          if (r < 0.005) {
            row.status = '旷工'; // 约 0.5%
          } else if (r < 0.02) {
            row.status = '出差';
          } else if (r < 0.035) {
            row.status = '缺卡';
          } else {
            // 正常出勤 + 少量迟到/早退
            const lateM = Math.random() < 0.08 ? Math.round(3 + Math.random() * 42) : 0;
            const earlyM = Math.random() < 0.05 ? Math.round(3 + Math.random() * 40) : 0;
            const [sh, sm] = String(row.workStart).split(':').map(Number);
            const [eh, em] = String(row.workEnd).split(':').map(Number);
            const inDate = new Date(yy, mm - 1, d, sh || 9, sm || 0);
            inDate.setMinutes(inDate.getMinutes() + lateM + Math.round(Math.random() * 10) - 5);
            const outDate = new Date(yy, mm - 1, d, eh || 18, em || 0);
            outDate.setMinutes(outDate.getMinutes() - earlyM + Math.round(Math.random() * 10) - 3);
            if (String(shift.crossDay) === 'true' || shift.crossDay === true) outDate.setDate(outDate.getDate() + 1);
            row.checkIn = pad(inDate.getHours()) + ':' + pad(inDate.getMinutes());
            row.checkOut = pad(outDate.getHours()) + ':' + pad(outDate.getMinutes());
            row.lateMin = lateM; row.earlyMin = earlyM;
            row.status = (lateM > 0 && earlyM > 0) ? '迟到且早退' : (lateM > 0 ? '迟到' : (earlyM > 0 ? '早退' : '正常'));
            // 加班（约 12%）
            if (Math.random() < 0.12) {
              row.otHours = [1, 2, 2, 3, 4][Math.floor(Math.random() * 5)];
              row.otType = Math.random() < 0.75 ? '工作日' : '休息日';
            }
            if (shift.nightDuty) row.nightDuty = true;
          }
        }
        rows.push(row);
      }
    }

    // 落库：for...of，逐条 insert（await 在循环体内）
    for (const r of rows) {
      await db.insert('attendance', Object.assign(r, { id: uid('at'), createTime: now() }));
      created++;
    }
    db.persist('attendance');
    audit.routeLog(db, req, '人事管理', '生成考勤', { detail: month + ' 生成 ' + created + ' 条' + (skipped ? '，跳过已存在 ' + skipped + ' 条' : '') });
    ok(res, { created: created, skipped: skipped, month: month });
  });

  // 4.4 打卡（员工自助 / 代打卡）
  router.post('/api/hr/attendance/check', async (req, res) => {
    if (!needLogin(req, res)) return;
    const b = req.body || {};
    const empId = b.employeeId || ((await db.one('employees', e => e.userId === req.user.id)) || {}).id;
    if (!empId) return fail(res, '未关联员工档案，请联系人事');
    const emp = (await db.find('employees', empId));
    if (!emp) return fail(res, '员工不存在');
    const date = b.date || today();
    let rec = (await db.one('attendance', a => a.employeeId === empId && a.date === date));
    if (!rec) {
      const shift = (await db.find('shifts', emp.shiftId)) || (await db.one('shifts')) || { name: '行政班', workStart: '09:00', workEnd: '18:00', hours: 8 };
      rec = (await db.insert('attendance', {
        id: uid('at'), employeeId: empId, employeeNo: emp.no, employeeName: emp.name,
        deptId: emp.deptId, deptName: await dt(db, emp.deptId), postName: await pt(db, emp.postId),
        date: date, month: monthOf(date), shiftId: shift.id || '', shiftName: shift.name,
        workStart: shift.workStart, workEnd: shift.workEnd, checkIn: '', checkOut: '',
        status: '缺卡', lateMin: 0, earlyMin: 0, workHours: num(shift.hours, 8),
        otHours: 0, otType: '', leaveType: '', nightDuty: !!shift.nightDuty, remark: '', createTime: now()
      }));
    }
    const t = b.time || new Date().toTimeString().slice(0, 5);
    if (b.type === 'out') rec.checkOut = t; else rec.checkIn = t;

    // 迟到 / 早退判定
    const toMin = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
    if (rec.workStart && rec.checkIn) rec.lateMin = Math.max(0, toMin(rec.checkIn) - toMin(rec.workStart));
    else rec.lateMin = 0;
    if (rec.workEnd && rec.checkOut) rec.earlyMin = Math.max(0, toMin(rec.workEnd) - toMin(rec.checkOut));
    else rec.earlyMin = 0;

    const hasIn = !!rec.checkIn, hasOut = !!rec.checkOut;
    if (rec.status !== '请假' && rec.status !== '出差' && rec.status !== '休息' && rec.status !== '旷工') {
      if (hasIn && hasOut) {
        rec.status = (rec.lateMin > 0 && rec.earlyMin > 0) ? '迟到且早退' : (rec.lateMin > 0 ? '迟到' : (rec.earlyMin > 0 ? '早退' : '正常'));
      } else rec.status = '缺卡';
    }
    (await db.update('attendance', rec.id, rec));
    db.persist('attendance');
    audit.routeLog(db, req, '人事管理', '打卡', { bizId: rec.id, detail: emp.name + ' ' + date + ' ' + (b.type === 'out' ? '下班' : '上班') + ' ' + t });
    ok(res, rec);
  });

  // 4.5 考勤修正 / 补卡
  router.post('/api/hr/attendance/:id/fix', async (req, res) => {
    if (!can(req, res, 'hr:attend')) return;
    const rec = (await db.find('attendance', req.params.id));
    if (!rec) return fail(res, '考勤记录不存在');
    const b = req.body || {};
    const patch = {};
    ['status', 'checkIn', 'checkOut', 'otHours', 'otType', 'leaveType', 'nightDuty', 'remark', 'lateMin', 'earlyMin'].forEach(k => {
      if (b[k] !== undefined) patch[k] = b[k];
    });
    const before = JSON.parse(JSON.stringify(rec));
    const row = (await db.update('attendance', rec.id, patch));
    db.persist('attendance');
    audit.routeLog(db, req, '人事管理', '考勤修正', { bizId: rec.id, detail: rec.employeeName + ' ' + rec.date, before: before, after: row });
    ok(res, row);
  });

  // 4.6 单条明细/删除（register 放在最后，避免抢占具体子路径）
  register(router, '/api/hr/attendance', 'attendance', {
    db, view: 'hr:view', manage: 'hr:attend', sort: 'date'
  });

  /* ===================== 5. 请假 / 出差 ===================== */
  register(router, '/api/hr/leaves', 'leaves', {
    db, view: 'hr:view', manage: 'hr:attend', sort: 'createTime',
    where(q) {
      return r => {
        if (q.employeeId && r.employeeId !== q.employeeId) return false;
        if (q.type && r.type !== q.type) return false;
        if (q.status && r.status !== q.status) return false;
        if (q.month && String(r.startDate).indexOf(q.month) !== 0 && String(r.endDate).indexOf(q.month) !== 0) return false;
        return true;
      };
    },
    async decorate(row) {
      return Object.assign({}, row, { deptName: await dt(db, row.deptId) });
    },
    validate(b) {
      if (!b.employeeId) return '请选择员工';
      if (!b.type) return '请选择请假类型';
      if (!b.startDate || !b.endDate) return '请填写起止日期';
      if (String(b.endDate) < String(b.startDate)) return '结束日期不能早于开始日期';
      return null;
    },
    async beforeInsert(b, req) {
      b.code = db.nextNo('leaves', 'LV');
      if (!b.status) b.status = '待审批';
      if (!b.days) b.days = diffDays(b.startDate, b.endDate) + 1;
      const e = (await db.find('employees', b.employeeId));
      b.employeeName = e ? e.name : '';
      b.deptId = e ? e.deptId : '';
      b.createTime = now();
      b.applicant = req.u ? req.u.name : '';
    },
    after(row, action, req) {
      const map = { insert: '提交请假单', update: '修改请假单', remove: '删除请假单' };
      audit.routeLog(db, req, '人事管理', map[action] || '请假单变更', { bizId: row.id, bizCode: row.code, detail: row.employeeName + ' ' + row.type });
    }
  });

  router.post('/api/hr/leaves/:id/approve', async (req, res) => {
    if (!can(req, res, 'hr:manage')) return;
    const row = (await db.find('leaves', req.params.id));
    if (!row) return fail(res, '请假单不存在');
    const b = req.body || {};
    const result = b.result || '已通过';
    const before = JSON.parse(JSON.stringify(row));
    (await db.update('leaves', row.id, {
      status: result, approveTime: now(),
      approver: req.u ? req.u.name : '', approveRemark: b.remark || ''
    }));
    // 通过后把请假同步写入考勤
    let synced = 0;
    if (result === '已通过') {
      const dim = daysInMonth(monthOf(row.startDate));
      let d = row.startDate;
      let guard = 0;
      while (d <= row.endDate && guard < 400) {
        guard++;
        const rec = (await db.one('attendance', a => a.employeeId === row.employeeId && a.date === d));
        if (rec) {
          (await db.update('attendance', rec.id, { status: '请假', leaveType: row.type, remark: (row.type || '') + '：' + (row.reason || '') }));
          synced++;
        }
        d = addDays(d, 1);
      }
      db.persist('attendance');
    }
    audit.routeLog(db, req, '人事管理', '审批请假单', { bizId: row.id, bizCode: row.code, detail: row.employeeName + ' ' + row.type + ' → ' + result, before: before, after: (await db.find('leaves', row.id)) });
    ok(res, { row: (await db.find('leaves', row.id)), synced: synced });
  });

  /* ===================== 6. 加班登记 ===================== */
  register(router, '/api/hr/overtimes', 'overtimes', {
    db, view: 'hr:view', manage: 'hr:attend', sort: 'date',
    where(q) {
      return r => {
        if (q.employeeId && r.employeeId !== q.employeeId) return false;
        if (q.status && r.status !== q.status) return false;
        if (q.month && String(r.date).indexOf(q.month) !== 0) return false;
        return true;
      };
    },
    async decorate(row) {
      const e = (await db.find('employees', row.employeeId));
      return Object.assign({}, row, {
        deptName: e ? await dt(db, e.deptId) : '',
        rate: H.OT_RATE[row.type] || 1.5,
        amount: function () { return 0; }
      });
    },
    validate(b) {
      if (!b.employeeId) return '请选择员工';
      if (!num(b.hours)) return '加班时长必须大于 0';
      return null;
    },
    async beforeInsert(b, req) {
      b.code = db.nextNo('overtimes', 'OT');
      if (!b.status) b.status = '待审批';
      const e = (await db.find('employees', b.employeeId));
      b.employeeName = e ? e.name : '';
      b.createTime = now();
    },
    after(row, action, req) {
      audit.routeLog(db, req, '人事管理', '登记加班', { bizId: row.id, bizCode: row.code, detail: row.employeeName + ' ' + row.hours + ' 小时' });
    }
  });

  router.post('/api/hr/overtimes/:id/approve', async (req, res) => {
    if (!can(req, res, 'hr:manage')) return;
    const row = (await db.find('overtimes', req.params.id));
    if (!row) return fail(res, '加班单不存在');
    const b = req.body || {};
    const result = b.result || '已通过';
    (await db.update('overtimes', row.id, { status: result, approveTime: now(), approver: req.u ? req.u.name : '' }));
    // 通过后写入当日考勤的加班时长
    if (result === '已通过') {
      const rec = (await db.one('attendance', a => a.employeeId === row.employeeId && a.date === row.date));
      if (rec) {
        (await db.update('attendance', rec.id, { otHours: num(row.hours), otType: row.type || '工作日' }));
        db.persist('attendance');
      }
    }
    audit.routeLog(db, req, '人事管理', '审批加班单', { bizId: row.id, bizCode: row.code, detail: row.employeeName + ' → ' + result });
    ok(res, (await db.find('overtimes', row.id)));
  });

  /* ===================== 7. 薪资核算 ===================== */
  // 注意：具体子路径必须在 register('/api/hr/payrolls') 之前注册

  // 7.1 试算（不落库）
  router.post('/api/hr/payroll/calc', async (req, res) => {
    if (!can(req, res, 'hr:payroll')) return;
    const b = req.body || {};
    const month = b.month || monthOf(addMonths(today() + '-01', -1));
    let emps = (await db.where('employees', e => e.status === '在职' || e.status === '试用'));
    if (b.employeeId) emps = emps.filter(e => e.id === b.employeeId);
    if (b.deptId) emps = emps.filter(e => e.deptId === b.deptId);
    // map 回调要 await 核算工资 → Promise.all 聚合（回调是同步函数）
    const list = await Promise.all(emps.map(async e => {
      const p = await H.buildPayroll(db, Object.assign({}, e, { deptName: await dt(db, e.deptId), postName: await pt(db, e.postId) }), month, { bonus: b.bonus });
      p.id = '';
      p.code = '';
      return p;
    }));
    ok(res, { month: month, list: list, summary: H.payrollSummaryOfList(list) });
  });

  // 7.2 生成工资表
  router.post('/api/hr/payroll/generate', async (req, res) => {
    if (!can(req, res, 'hr:payroll')) return;
    const b = req.body || {};
    const month = b.month || monthOf(addMonths(today() + '-01', -1));
    let emps = (await db.where('employees', e => e.status === '在职' || e.status === '试用'));
    if (b.employeeId) emps = emps.filter(e => e.id === b.employeeId);
    if (b.deptId) emps = emps.filter(e => e.deptId === b.deptId);
    if (!emps.length) return fail(res, '没有符合条件的在职员工');

    let created = 0, updated = 0;
    // for...of：循环体要 await 查重、核算、写入
    for (const e of emps) {
      const exist = await db.one('payrolls', p => p.employeeId === e.id && p.month === month);
      if (exist && exist.status === '已发放' && !b.force) continue;
      const calc = await H.buildPayroll(db, Object.assign({}, e, { deptName: await dt(db, e.deptId), postName: await pt(db, e.postId) }), month, { bonus: b.bonus });
      if (exist) {
        Object.keys(calc).forEach(k => { if (k !== 'id') exist[k] = calc[k]; });
        exist.code = exist.code || db.nextNo('payrolls', 'GZ');
        exist.updateTime = now();
        await db.update('payrolls', exist.id, exist);
        updated++;
      } else {
        const row = Object.assign({}, calc, {
          id: uid('pr'), code: db.nextNo('payrolls', 'GZ'),
          status: '草稿', createTime: now(), createdBy: req.u ? req.u.name : ''
        });
        await db.insert('payrolls', row);
        created++;
      }
    }
    db.persist('payrolls');
    audit.routeLog(db, req, '人事管理', '生成工资表', { detail: month + ' 新增 ' + created + ' 条，更新 ' + updated + ' 条' });
    ok(res, { created: created, updated: updated, month: month });
  });

  // 7.3 月度薪酬汇总（全员汇总同样受薪酬保密约束）
  router.get('/api/hr/payroll/summary', async (req, res) => {
    if (!can(req, res, 'hr:payroll')) return;
    const month = req.query.month || monthOf(addMonths(today() + '-01', -1));
    ok(res, await H.payrollSummary(db, month));
  });

  // 7.4 人力成本（含单位社保）
  router.get('/api/hr/payroll/labor-cost', async (req, res) => {
    if (!can(req, res, 'hr:payroll')) return;
    const months = [];
    for (let i = 5; i >= 0; i--) months.push(monthOf(addMonths(today(), -i)));
    // map 回调要 await laborCost → Promise.all 聚合
    const costs = await Promise.all(months.map(async m => Object.assign({ month: m }, await H.laborCost(db, m))));
    // 未核算的月份不进入趋势图（避免出现全 0 柱子）
    ok(res, costs.filter(x => x.gross > 0));
  });

  // 7.5 批量发放
  router.post('/api/hr/payroll/pay-all', async (req, res) => {
    if (!can(req, res, 'hr:payroll')) return;
    const b = req.body || {};
    const month = b.month;
    if (!month) return fail(res, '请选择月份');
    const payDate = b.payDate || today();
    const list = (await db.where('payrolls', p => p.month === month && p.status !== '已发放'));
    if (!list.length) return fail(res, '该月没有待发放的工资记录');
    let amount = 0;
    // for...of：循环体要 await db.update
    for (const p of list) {
      await db.update('payrolls', p.id, { status: '已发放', payDate: payDate, payee: req.u ? req.u.name : '' });
      amount += num(p.netPay);
    }
    db.persist('payrolls');
    audit.routeLog(db, req, '人事管理', '批量发放工资', { detail: month + ' 共 ' + list.length + ' 人，合计 ¥' + money(amount) });
    ok(res, { count: list.length, amount: money(amount) });
  });

  // 7.6 员工自助：我的工资条
  router.get('/api/hr/my/payrolls', async (req, res) => {
    if (!needLogin(req, res)) return;
    const emp = (await db.one('employees', e => e.userId === req.user.id));
    if (!emp) return ok(res, { list: [], emp: null });
    const list = await H.yearPayrolls(db, emp.id, String(req.query.year || today().slice(0, 4)));
    ok(res, { emp: { id: emp.id, name: emp.name, no: emp.no, deptName: await dt(db, emp.deptId), postName: await pt(db, emp.postId) }, list: list });
  });

  // 7.7 员工自助：我的考勤
  router.get('/api/hr/my/attendance', async (req, res) => {
    if (!needLogin(req, res)) return;
    const emp = (await db.one('employees', e => e.userId === req.user.id));
    if (!emp) return ok(res, { list: [], summary: null });
    const month = req.query.month || monthOf(today());
    const list = (await db.where('attendance', a => a.employeeId === emp.id && a.month === month))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    ok(res, { list: list, summary: await H.summarizeAttendance(db, emp.id, month) });
  });

  /* ===================== 8. 工资表 CRUD（放最后，避免抢占具体子路径） ===================== */
  // 薪资明细涉及薪酬保密，单独要求 hr:payroll；仅有 hr:view 的人员走 /api/hr/my/payrolls 查看本人工资条
  register(router, '/api/hr/payrolls', 'payrolls', {
    db, view: 'hr:payroll', manage: 'hr:payroll', sort: 'month',
    where(q) {
      return r => {
        if (q.month && r.month !== q.month) return false;
        if (q.employeeId && r.employeeId !== q.employeeId) return false;
        if (q.deptId && r.deptId !== q.deptId) return false;
        if (q.status && r.status !== q.status) return false;
        return true;
      };
    },
    async search(kw, where) {
      kw = String(kw).toLowerCase();
      return (await db.where('payrolls', where)).filter(p =>
        (p.employeeName || '').toLowerCase().indexOf(kw) >= 0 ||
        (p.employeeNo || '').toLowerCase().indexOf(kw) >= 0 ||
        (p.code || '').toLowerCase().indexOf(kw) >= 0);
    },
    async decorate(row) {
      return Object.assign({}, row, { deptName: await dt(db, row.deptId) });
    },
    beforeRemove(row) {
      if (row.status === '已发放') return '该工资已发放，不能删除';
      return null;
    },
    after(row, action, req) {
      audit.routeLog(db, req, '人事管理', '调整工资表', { bizId: row.id, bizCode: row.code, detail: row.employeeName + ' ' + row.month });
    }
  });

  // 单条状态流转：审核 / 发放 / 反审核
  router.post('/api/hr/payrolls/:id/approve', async (req, res) => {
    if (!can(req, res, 'hr:payroll')) return;
    const row = (await db.find('payrolls', req.params.id));
    if (!row) return fail(res, '工资记录不存在');
    (await db.update('payrolls', row.id, { status: '已核算', approveTime: now(), approver: req.u ? req.u.name : '' }));
    db.persist('payrolls');
    audit.routeLog(db, req, '人事管理', '工资核算确认', { bizId: row.id, bizCode: row.code, detail: row.employeeName + ' ' + row.month });
    ok(res, (await db.find('payrolls', row.id)));
  });

  router.post('/api/hr/payrolls/:id/pay', async (req, res) => {
    if (!can(req, res, 'hr:payroll')) return;
    const row = (await db.find('payrolls', req.params.id));
    if (!row) return fail(res, '工资记录不存在');
    if (row.status === '已发放') return fail(res, '该工资已发放');
    const b = req.body || {};
    (await db.update('payrolls', row.id, {
      status: '已发放', payDate: b.payDate || today(),
      payee: req.u ? req.u.name : '', payChannel: b.payChannel || '银行代发', remark: b.remark || row.remark
    }));
    db.persist('payrolls');
    audit.routeLog(db, req, '人事管理', '发放工资', { bizId: row.id, bizCode: row.code, detail: row.employeeName + ' ' + row.month + ' 实发 ¥' + money(row.netPay) });
    ok(res, (await db.find('payrolls', row.id)));
  });

  /* ===================== 9. HR 驾驶舱 ===================== */
  router.get('/api/hr/dashboard', async (req, res) => {
    if (!can(req, res, 'hr:view')) return;
    const emps = (await db.where('employees'));
    const active = emps.filter(e => e.status === '在职' || e.status === '试用');
    const lastMonth = monthOf(addMonths(today(), -1));
    // 全员薪酬汇总受薪酬保密约束：无 hr:payroll 的角色不返回（普通员工通过「我的工资条」查看本人）
    const canPay = A.hasPerm(req.u, 'hr:payroll');
    const paySum = canPay ? await H.payrollSummary(db, lastMonth) : null;
    // 考勤看上月完整数据（本月尚未走完，月初时统计意义不大）
    const attSum = await H.attendanceOverview(db, lastMonth);
    const byDept = {};
    // for...of：循环体要 await dt（走部门映射表）
    for (const e of active) {
      const k = (await dt(db, e.deptId)) || '未分配';
      byDept[k] = (byDept[k] || 0) + 1;
    }
    const pendingLeaves = (await db.where('leaves', l => l.status === '待审批')).length;
    const pendingOt = (await db.where('overtimes', o => o.status === '待审批')).length;

    // 本月入职 / 离职
    const cm = monthOf(today());
    ok(res, {
      employees: {
        total: emps.length, active: active.length,
        probation: emps.filter(e => e.status === '试用').length,
        left: emps.filter(e => e.status === '离职').length,
        newJoin: emps.filter(e => String(e.hireDate).indexOf(cm) === 0).length
      },
      byDept: Object.keys(byDept).map(k => ({ deptName: k, count: byDept[k] })),
      attendance: {
        month: attSum.month, employees: attSum.employees, records: attSum.records,
        lateCount: attSum.lateCount, absentDays: attSum.absentDays,
        leaveDays: attSum.leaveDays, otHours: attSum.otHours
      },
      payroll: paySum,
      pending: { leaves: pendingLeaves, overtimes: pendingOt },
      upcomingContract: (await db.where('employees', e => {
        if (!e.contractEnd || e.status === '离职') return false;
        return diffDays(today(), e.contractEnd) <= 30;
      })).length
    });
  });

  /* ===================== 10. 导出 ===================== */
  router.get('/api/hr/export/payroll', async (req, res) => {
    if (!can(req, res, 'hr:payroll')) return;
    const month = req.query.month || monthOf(addMonths(today() + '-01', -1));
    const fmt = req.query.format || 'csv';
    const list = (await db.where('payrolls', p => p.month === month))
      .sort((a, b) => String(a.employeeNo).localeCompare(String(b.employeeNo)));
    if (!list.length) return fail(res, '该月没有工资数据');
    const headers = [
      { title: '月份', key: 'month' }, { title: '工号', key: 'employeeNo' }, { title: '姓名', key: 'employeeName' },
      { title: '部门', key: 'deptName' }, { title: '岗位', key: 'postName' },
      { title: '应发合计', key: 'grossPay', type: 'number' }, { title: '加班费', key: 'ot', type: 'number', value: r => (r.overtime || {}).total || 0 },
      { title: '社保个人', key: 'socialPersonal', type: 'number' }, { title: '公积金个人', key: 'fundPersonal', type: 'number' },
      { title: '专项附加扣除', key: 'specialDeduction', type: 'number' },
      { title: '个人所得税', key: 'tax', type: 'number' }, { title: '实发工资', key: 'netPay', type: 'number' },
      { title: '单位社保', key: 'insuranceUnit', type: 'number' },
      { title: '出勤天数', key: 'realDays', type: 'number', value: r => (r.attendance || {}).realDays || 0 },
      { title: '加班小时', key: 'otHours', type: 'number', value: r => (r.attendance || {}).otHours || 0 },
      { title: '状态', key: 'status' }
    ];
    const name = '工资表_' + month;
    const content = fmt === 'xls' ? X.toXls([{ name: '工资表', headers: headers, rows: list }]) : X.toCSV(headers, list);
    X.writeExport(exportDir, name + (fmt === 'xls' ? '.xls' : '.csv'), content);
    sendDownload(res, name + (fmt === 'xls' ? '.xls' : '.csv'), content, fmt === 'xls' ? 'application/vnd.ms-excel' : 'text/csv');
  });

  router.get('/api/hr/export/attendance', async (req, res) => {
    if (!can(req, res, 'hr:view')) return;
    const month = req.query.month || monthOf(today());
    const fmt = req.query.format || 'csv';
    // 注意括号：成员访问 .list 的优先级高于 await，
    // 写成 `await f(x).list` 实际是 `await (promise.list)` → 恒为 undefined。
    // 必须写成 `(await f(x)).list`。
    const list = (await H.attendanceOverview(db, month)).list;
    if (!list.length) return fail(res, '该月没有考勤数据');
    const headers = [
      { title: '工号', key: 'employeeNo' }, { title: '姓名', key: 'employeeName' }, { title: '部门', key: 'deptName' },
      { title: '应出勤', key: 'shouldDays', type: 'number' }, { title: '实出勤', key: 'realDays', type: 'number' },
      { title: '迟到次数', key: 'lateCount', type: 'number' }, { title: '迟到分钟', key: 'lateMin', type: 'number' },
      { title: '早退次数', key: 'earlyCount', type: 'number' }, { title: '旷工天数', key: 'absentDays', type: 'number' },
      { title: '请假天数', key: 'leaveDays', type: 'number' }, { title: '无薪假', key: 'unpaidLeaveDays', type: 'number' },
      { title: '出差天数', key: 'businessTripDays', type: 'number' },
      { title: '加班小时', key: 'otHours', type: 'number' },
      { title: '工作日加班', key: 'otHoursWorkday', type: 'number' }, { title: '休息日加班', key: 'otHoursWeekend', type: 'number' },
      { title: '夜班次数', key: 'nightCount', type: 'number' }
    ];
    // for...of：循环体要 await 查员工编号
    for (const l of list) {
      const e = await db.find('employees', l.employeeId);
      l.employeeNo = e ? e.no : '';
    }
    const name = '考勤月报_' + month;
    const content = fmt === 'xls' ? X.toXls([{ name: '考勤月报', headers: headers, rows: list }]) : X.toCSV(headers, list);
    X.writeExport(exportDir, name + (fmt === 'xls' ? '.xls' : '.csv'), content);
    sendDownload(res, name + (fmt === 'xls' ? '.xls' : '.csv'), content, fmt === 'xls' ? 'application/vnd.ms-excel' : 'text/csv');
  });

  router.get('/api/hr/export/employees', async (req, res) => {
    if (!can(req, res, 'hr:view')) return;
    const fmt = req.query.format || 'csv';
    // map 回调要 await dt/pt → Promise.all 聚合
    const list = await Promise.all((await db.where('employees')).map(async e => Object.assign({}, e, {
      deptName: await dt(db, e.deptId), postName: await pt(db, e.postId)
    })));
    const headers = [
      { title: '工号', key: 'no' }, { title: '姓名', key: 'name' }, { title: '性别', key: 'gender' },
      { title: '部门', key: 'deptName' }, { title: '岗位', key: 'postName' }, { title: '职级', key: 'level' },
      { title: '手机', key: 'phone' }, { title: '身份证号', key: 'idCard' },
      { title: '学历', key: 'education' }, { title: '入职日期', key: 'hireDate' }, { title: '转正日期', key: 'regularDate' },
      { title: '合同到期', key: 'contractEnd' }, { title: '状态', key: 'status' },
      { title: '通讯地址', key: 'address' }, { title: '紧急联系人', key: 'emergencyContact' }, { title: '紧急联系电话', key: 'emergencyPhone' },
      { title: '基本工资', key: 'baseSalary', type: 'number' }, { title: '岗位工资', key: 'postSalary', type: 'number' },
      { title: '开户行', key: 'bankName' }, { title: '银行卡号', key: 'bankCard' }
    ];
    const name = '员工名册_' + today();
    const content = fmt === 'xls' ? X.toXls([{ name: '员工名册', headers: headers, rows: list }]) : X.toCSV(headers, list);
    X.writeExport(exportDir, name + (fmt === 'xls' ? '.xls' : '.csv'), content);
    sendDownload(res, name + (fmt === 'xls' ? '.xls' : '.csv'), content, fmt === 'xls' ? 'application/vnd.ms-excel' : 'text/csv');
  });

  // ─── 员工档案导入 ───────────────────────────────────────────────────────────

  /** 下载导入模板（含一行示例数据） */
  router.get('/api/hr/import/employee-template', async (req, res) => {
    if (!can(req, res, 'hr:manage')) return fail(res, '无权限');
    const XLSX = require('../node_modules/xlsx');
    const fields = [
      { title: '工号', key: 'no' }, { title: '姓名', key: 'name' }, { title: '性别', key: 'gender' },
      { title: '部门ID', key: 'deptId' }, { title: '岗位ID', key: 'postId' }, { title: '职级', key: 'level' },
      { title: '手机', key: 'phone' }, { title: '身份证号', key: 'idCard' },
      { title: '学历', key: 'education' }, { title: '入职日期', key: 'hireDate' }, { title: '转正日期', key: 'regularDate' },
      { title: '合同到期', key: 'contractEnd' }, { title: '状态', key: 'status' },
      { title: '通讯地址', key: 'address' }, { title: '紧急联系人', key: 'emergencyContact' },
      { title: '紧急联系电话', key: 'emergencyPhone' },
      { title: '基本工资', key: 'baseSalary' }, { title: '岗位工资', key: 'postSalary' },
      { title: '开户行', key: 'bankName' }, { title: '银行卡号', key: 'bankCard' }
    ];
    // 用 aoa_to_sheet 确保第一行是中文表头，第二行是示例数据
    const ws = XLSX.utils.aoa_to_sheet([
      fields.map(f => f.title),
      fields.map(f => f.title === '工号' ? 'EMP0001' : f.title === '姓名' ? '张三' : '')
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '员工档案');
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const tplName = '员工档案导入模板.xlsx';
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(tplName) + '"; filename*=UTF-8\'\'' + encodeURIComponent(tplName));
    res.end(buf);
  });

  /** 批量导入员工档案 */
  router.post('/api/hr/import/employees', async (req, res) => {
    if (!can(req, res, 'hr:manage')) return fail(res, '无权限');
    const body = req.body;
    if (!Array.isArray(body) || body.length === 0) return fail(res, '文件为空');

    const XLSX = require('../node_modules/xlsx');
    const { Buffer } = require('buffer');

    // 读取 buffer → xlsx sheet → rows
    let rows;
    try {
      const ab = Buffer.from(body);
      const wb = XLSX.read(ab, { type: 'array' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    } catch (e) {
      return fail(res, 'Excel 解析失败：' + e.message);
    }

    if (rows.length === 0) return fail(res, '没有数据行');

    const deptMap = await (await db.where('departments')).reduce((m, d) => { m[String(d.id)] = d; return m; }, {});
    const postMap = await (await db.where('posts')).reduce((m, p) => { m[String(p.id)] = p; return m; }, {});

    let ok = 0, dup = 0, failList = [];
    // 中文表头 → 英文 key 映射（兼容两种表头格式）
    const CN2EN = {
      '工号': 'no', '姓名': 'name', '性别': 'gender',
      '部门ID': 'deptId', '岗位ID': 'postId', '职级': 'level',
      '手机': 'phone', '身份证号': 'idCard', '学历': 'education',
      '入职日期': 'hireDate', '转正日期': 'regularDate', '合同到期': 'contractEnd',
      '状态': 'status', '通讯地址': 'address',
      '紧急联系人': 'emergencyContact', '紧急联系电话': 'emergencyPhone',
      '基本工资': 'baseSalary', '岗位工资': 'postSalary',
      '开户行': 'bankName', '银行卡号': 'bankCard'
    };
    function normRow(raw) {
      // 直接取英文 key；若无，则用中文 key 映射
      const out = {};
      for (const [cn, en] of Object.entries(CN2EN)) {
        if (raw[en] !== undefined && raw[en] !== '') out[en] = raw[en];
        else if (raw[cn] !== undefined && raw[cn] !== '') out[en] = raw[cn];
      }
      return out;
    }
    for (const raw of rows) {
      const r = normRow(raw);
      const no = String(r.no || '').trim();
      const name = String(r.name || '').trim();
      if (!no || !name) { failList.push({ row: failList.length + 2, err: '工号或姓名为空' }); continue; }

      const emp = await db.one('employees', e => e.no === no);
      if (emp) {
        // 更新已有记录
        await db.update('employees', emp.id, {
          ...pick(r, ['no','name','gender','deptId','postId','level','phone','idCard','education',
                        'hireDate','regularDate','contractEnd','status','address',
                        'emergencyContact','emergencyPhone','baseSalary','postSalary','bankName','bankCard']),
          updatedAt: new Date()
        });
        ok++;
      } else {
        // 新建
        const id = await db.insert('employees', {
          ...pick(r, ['no','name','gender','deptId','postId','level','phone','idCard','education',
                        'hireDate','regularDate','contractEnd','status','address',
                        'emergencyContact','emergencyPhone','baseSalary','postSalary','bankName','bankCard']),
          status: r.status || '试用',
          createdAt: new Date(), updatedAt: new Date()
        });
        if (!id) { failList.push({ row: failList.length + 2, err: '插入失败' }); }
        else ok++;
      }
    }

    res.json({ ok: true, total: rows.length, imported: ok, updated: ok - failList.length, skipped: dup, errors: failList });
  });

  return router;
};
