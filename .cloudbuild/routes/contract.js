'use strict';
// 合同管理：录入、状态、变更留痕、退租、到期预警、导出
const { ok, fail } = require('../lib/http');
const { register, can } = require('../lib/crud');
const audit = require('../lib/audit');
const dingtalk = require('../lib/dingtalk');
const { uid, money, num, now, today, addDays, addMonths, monthOf, diffDays } = require('../lib/util');
const INC = require('../lib/income');

const STATUS = ['正常履约', '退租', '变更', '逾期', '终止', '审批中', '审批驳回'];

// 合同字段规范化（后端权威计算，避免前端/接口不传导致数据缺失）
async function normalizeContract(src, target, db) {
  // 房源汇总：房号 / 面积 / 项目 / 楼栋
  if (src.roomIds && src.roomIds.length) {
    // map 回调要 await db.find，用 Promise.all 聚合（回调是同步函数，直接 await 拿不到值）
    const rooms = (await Promise.all(src.roomIds.map(id => db.find('rooms', id)))).filter(Boolean);
    target.roomCodes = rooms.map(r => r.code);
    target.area = money(rooms.reduce((s, r) => s + num(r.area), 0));
    if (rooms[0]) { target.projectId = rooms[0].projectId; target.buildingId = rooms[0].buildingId; }
  }
  if (target.rentUnitPrice !== undefined && target.area !== undefined) {
    target.rentMonthly = money(num(target.rentUnitPrice) * num(target.area));
  }
  // 免租期起止自动推导
  if (target.freeMonths !== undefined) {
    target.freeMonths = num(target.freeMonths);
    if (target.freeMonths > 0 && target.startDate) {
      target.freeStart = target.startDate;
      target.freeEnd = addMonths(target.startDate, target.freeMonths);
    } else { target.freeStart = ''; target.freeEnd = ''; }
  }
  // 承租方信息
  if (target.customerId) {
    const cu = (await db.find('customers', target.customerId));
    if (cu) { target.customerName = cu.name; target.customerType = cu.type; target.lesseeContact = target.lesseeContact || cu.contact; target.lesseePhone = target.lesseePhone || cu.phone; }
  }
  // 出租方默认取项目主体
  if (target.projectId) {
    const pj = (await db.find('projects', target.projectId));
    if (pj) {
      target.lessorName = target.lessorName || pj.lessorName || '';
      target.lessorCreditCode = target.lessorCreditCode || pj.lessorCreditCode || '';
      target.lessorContact = target.lessorContact || '张招商';
      target.lessorPhone = target.lessorPhone || '13800000001';
    }
  }
  if (target.deposit !== undefined && target.depositPaid === undefined) {
    target.depositStatus = target.depositStatus || '未收';
    target.depositRefundStatus = target.depositRefundStatus || '未退';
  }
  target.payCycle = target.payCycle || '月付';
  return target;
}

module.exports = function (db, router) {
  register(router, '/api/contract/contracts', 'contracts', {
    db, view: 'contract:view', manage: 'contract:manage', sort: 'startDate',
    where(q, req) {
      const w = {};
      if (q.projectId) w.projectId = q.projectId;
      if (q.buildingId) w.buildingId = q.buildingId;
      if (q.status) w.status = q.status;
      if (q.customerId) w.customerId = q.customerId;
      if (q.expireSoon) {
        const days = num(q.expireSoon, 180);
        return c => {
          if (c.status !== '正常履约') return false;
          const d = diffDays(today(), c.endDate);
          return d >= 0 && d <= days;
        };
      }
      return Object.keys(w).length ? w : null;
    },
    async search(kw, where) {
      return (await db.where('contracts', where)).filter(c =>
        (c.code || '').indexOf(kw) >= 0 || (c.customerName || '').indexOf(kw) >= 0 ||
        (c.roomCodes || []).join(',').indexOf(kw) >= 0 || (c.lessorName || '').indexOf(kw) >= 0);
    },
    async decorate(row) {
      const o = Object.assign({}, row);
      const pj = (await db.find('projects', row.projectId));
      const bd = (await db.find('buildings', row.buildingId));
      const cu = (await db.find('customers', row.customerId));
      o.projectName = pj ? pj.name : '';
      o.buildingName = bd ? bd.name : '';
      o.customerType = cu ? cu.type : (row.customerType || '');
      o.riskFlag = cu ? cu.riskFlag : '';
      o.daysLeft = diffDays(today(), row.endDate);
      o.statusText = row.status;
      const bills = (await db.where('bills', b => b.contractId === row.id));
      o.billCount = bills.length;
      o.arrears = money(bills.reduce((s, b) => s + (b.totalAmount - b.paidAmount), 0));
      o.freeText = row.freeMonths
        ? (row.freeMonths + ' 个月' + (row.freeStart && row.freeEnd ? '（' + row.freeStart + ' ~ ' + row.freeEnd + '）' : ''))
        : '无';
      return o;
    },
    validate(b) {
      if (!b.customerId) return '请选择承租方客户';
      if (!(b.roomIds || []).length) return '请选择房源';
      if (!b.startDate || !b.endDate) return '请填写租期';
      if (b.startDate && b.endDate && b.endDate <= b.startDate) return '合同结束日期必须晚于开始日期';
      return null;
    },
    async beforeInsert(b, req) {
      b.code = b.code || db.nextNo('contracts', 'HT', b.startDate || today());
      b.status = b.status || '审批中';
      b.version = 1;
      b.changeLog = [{ time: now(), user: (req.u || {}).name || '', action: '创建合同', detail: '' }];
      b.createdBy = req.user.id;
      b.ownerId = req.user.id;
      b.deptId = req.user.deptId;
      // 租金递增：按合同条款文字解析成规则对象，供账单引擎使用
      // 合同模板实测条款：「计租日起，第三年起每年递增6%」「每2年10％」「不递增」
      if (!b.escalateRule) b.escalateRule = INC.parseEscalate(b.escalateText || '');
      b.escalateRule = INC.parseEscalate(b.escalateText || b.escalateRule.raw || '');
      // 违约金规则（合同模板：日千分之五 + 当期三个月租金）
      b.penalty = Object.assign({
        lateDailyRate: 0.005,      // 日千分之五
        breachMonths: 3,           // 违约赔偿 = 当期三个月租金
        payAheadDays: 10,          // 每季度期满前 10 日支付下一季度
        handoverDays: 5,           // 通知后 5 日未办交接视为违约
        noticeMonths: 2,           // 提前解除需提前 2 个月书面通知
        repairNoticeDays: 3,       // 维修提前 3 日通知
        depositRefundWorkdays: 30  // 保证金退还 30 个工作日
      }, b.penalty || {});
      b.fees = Object.assign({ propertyUnit: 8, waterPrice: 4, electricPrice: 1, cleaning: 0, repair: 0, billingMode: '分开核算' }, b.fees || {});
      await normalizeContract(b, b, db);
    },
    async beforeUpdate(patch, before, req) {
      if (patch.fees) patch.fees = Object.assign({}, before.fees || {}, patch.fees);
      if (patch.penalty) patch.penalty = Object.assign({}, before.penalty || {}, patch.penalty);
      if (patch.escalateText !== undefined) patch.escalateRule = INC.parseEscalate(patch.escalateText || '');
      const merged = Object.assign({}, before, patch);
      await normalizeContract(merged, patch, db);
    },
    async after(row, action, req) {
      // 房间状态同步
    if (row.roomIds) {
      // for...of：循环体要 await 查表与更新
      for (const rid of row.roomIds) {
        const r = await db.find('rooms', rid);
        if (!r) continue;
        let st = r.status;
        if (row.status === '正常履约' || row.status === '逾期' || row.status === '变更') st = '已租';
        else if (row.status === '退租' || row.status === '终止') st = '空置';
        if (st !== r.status) await db.update('rooms', rid, { status: st });
      }
    }
      audit.routeLog(db, req, '合同管理', action === 'insert' ? '新增合同' : '修改合同', {
        bizId: row.id, bizCode: row.code, detail: row.customerName + ' / ' + (row.roomCodes || []).join('、')
      });
      // 自动发起审批
      if (action === 'insert' && (req.body || {}).submitApprove !== false) {
        createApproval(db, row, req);
      }
    }
  });

async   function createApproval(db, c, req) {
    if (!c.customerName && c.customerId) {
      const cu = (await db.find('customers', c.customerId));
      if (cu) { c.customerName = cu.name; (await db.update('contracts', c.id, { customerName: cu.name })); }
    }
    // ---- 模板比对：招商部上报合同时，审批人先看到与标准模板的差异 ----
    // 设计取舍：比对放在审批单创建之后「异步补写」，而不是 await 在前面。
    //   原因：比对里可能触发腾讯云 OCR（网络往返 + 图片上传，单页约 1~3 秒，
    //   多页 PDF 更久）。await 在前面会让「保存合同」按钮卡住好几秒，
    //   招商部会以为系统崩了。而审批单本身必须立刻建好（业务主流程）。
    //   差异会在几秒内补写进审批单；审批人点开详情时如果还没跑完，
    //   界面显示「模板比对中」，通过按钮保持禁用直到有结论。
    const compareState = { pending: false, done: false, error: '' };

    const steps = [
      { level: 1, name: '招商经理审核（价格）', roleCode: 'ZSJL', userId: 'u_2', status: '待审批', time: '', comment: '' },
      { level: 2, name: '财务经理审核（租金）', roleCode: 'CWJL', userId: 'u_6', status: '待审批', time: '', comment: '' },
      { level: 3, name: '总经理审核（免租期）', roleCode: 'ZJL', userId: 'u_13', status: num(c.freeMonths) >= 2 ? '待审批' : '免审批', time: '', comment: num(c.freeMonths) >= 2 ? '免租期超 1 个月需总经理审批' : '免租期未超阈值，免审批' }
    ];
    const ap = (await db.insert('approvals', {
      id: uid('ap'), code: db.nextNo('approvals', 'SP', today()),
      type: '合同审批', subTypes: ['价格审核', '租金审核', '免租期审核'],
      bizId: c.id, bizCode: c.code, bizTitle: c.customerName + ' / ' + (c.roomCodes || []).join('、'),
      projectId: c.projectId, amount: c.rentMonthly,
      currentLevel: 1, totalLevel: 2, status: '审批中', steps: steps,
      // 模板比对结论（异步补写；pending 表示还在跑，界面禁用「通过」）
      compareState: compareState,
      logs: [{ time: now(), user: (req.u || {}).name || '', action: '提交', comment: '新签合同，请审批' }],
      applicant: (req.u || {}).name || '', applicantId: req.user.id, createTime: now(), dingtalkSent: false
    }));
    (await db.update('contracts', c.id, { status: '审批中' }));

    // 异步跑比对：完成后回写审批单。整段吞异常，保证永不影响合同创建。
    runApprovalCompare(db, ap, c, req).catch(() => { });

    // 钉钉推送（如已启用）。config 要读库 → 必须 await，否则拿到 Promise、cfg.enabled 恒为 undefined（推送静默失效）
    const cfg = await dingtalk.config(db);
    if (cfg.enabled && cfg.pushApprove !== false) {
      dingtalk.pushApproval(db, ap).catch(() => { });
    }
    return ap;
  }

  /**
   * 合同审批 · 自动模板比对（后台异步执行）
   *
   * 流程：从合同附件里挑出合同正本 → 读回内容 → 解析（图片/扫描件自动 OCR）
   *       → 三方比对（上报件 vs 标准模板 vs 系统数据）→ 结果写回审批单 + 归档存档表
   *
   * 失败策略：任何一步出错都只记录状态，不抛异常。
   *   比对失败 ≠ 合同有问题，但「无法证明合规」也不能放行，
   *   所以出错时按「阻断」处理（见 approvalCompare.verdictOf 的 error 分支）。
   */
  async function runApprovalCompare(db, ap, contract, req) {
    const AC = require('../lib/approvalCompare');
    let record, verdict, result, att = null;

    try {
      // 附件存储层（本地磁盘 / 七牛云）
      let attStore = null;
      try {
        const path = require('path');
        const { AttStore } = require('../lib/attstore');
        const uploadDir = (opt && opt.uploadDir) || path.join(__dirname, '..', 'uploads');
        attStore = new AttStore(uploadDir);
      } catch (e) { /* 存储层不可用则无法读回内容，走未比对分支 */ }

      const fresh = (await db.find('contracts', contract.id)) || contract;
      att = AC.pickContractScan(fresh.attachments);
      const rooms = Array.isArray(fresh.roomIds) && fresh.roomIds.length
        ? (await db.where('rooms', { id: fresh.roomIds })) || []
        : [];

      const r = await AC.runCompare({
        db: db, attStore: attStore, contract: fresh, rooms: rooms, att: att,
        opt: { by: (req && req.user && req.user.id) || '' }
      });
      record = r.record; result = r.result; verdict = r.verdict;

      if (att) {
        await AC.archive(db, fresh, att, result, record, (req && req.user && req.user.id) || '');
      }
    } catch (e) {
      record = AC.noneRecord('模板比对执行异常：' + e.message);
      verdict = { verdict: 'error', block: true, level: 'high', reason: record.verdictText };
    }

    const cur = (await db.find('approvals', ap.id)) || ap;
    const logs = Array.isArray(cur.logs) ? cur.logs.slice() : [];
    logs.push({
      time: now(), user: '系统', action: '模板比对',
      comment: record.verdictText +
        (record.stat && record.stat.total ? '（差异 ' + record.stat.total + ' 项：严重 ' + record.stat.high + ' / 建议 ' + record.stat.medium + ' / 提示 ' + record.stat.low + '）' : '') +
        (record.fileName ? '　文件：' + record.fileName : '')
    });
    await db.update('approvals', ap.id, {
      compareResult: record,
      compareState: { pending: false, done: true, error: verdict.block ? record.verdictText : '' }
    });
    // 日志单独追加（db.update 会整字段覆盖，logs 要先读出来再回写）
    await db.update('approvals', ap.id, { logs: logs });
  }

  router.get('/api/contract/status', async (req, res) => {
    if (!can(req, res, 'contract:view')) return;
    ok(res, STATUS);
  });

  // 合同详情（含账单、收款、发票、附件、变更记录）
  router.get('/api/contract/contracts/:id/detail', async (req, res) => {
    if (!can(req, res, 'contract:view')) return;
    const c = (await db.find('contracts', req.params.id));
    if (!c) return fail(res, '合同不存在', 404);
    ok(res, {
      contract: c,
      bills: (await db.where('bills', b => b.contractId === c.id)).sort((a, b) => a.period < b.period ? 1 : -1),
      payments: (await db.where('payments', p => p.contractId === c.id)),
      invoices: (await db.where('invoices', i => i.contractId === c.id)),
      deposits: (await db.where('deposits', d => d.contractId === c.id)),
      approvals: (await db.where('approvals', a => a.bizId === c.id)),
      rooms: (await Promise.all((c.roomIds || []).map(id => db.find('rooms', id)))).filter(Boolean),
      customer: (await db.find('customers', c.customerId))
    });
  });

  // 合同变更（留痕，版本号 +1）
  router.post('/api/contract/contracts/:id/change', async (req, res) => {
    if (!can(req, res, 'contract:manage')) return;
    const b = req.body || {};
    const c = (await db.find('contracts', req.params.id));
    if (!c) return fail(res, '合同不存在', 404);
    const before = JSON.parse(JSON.stringify(c));
    const patch = {};
    ['rentUnitPrice', 'taxIncluded', 'area', 'endDate', 'startDate', 'freeStart', 'freeEnd', 'freeMonths',
      'deposit', 'payCycle', 'remark', 'lesseeContact', 'lesseePhone', 'fees'].forEach(k => {
        if (b[k] !== undefined) patch[k] = b[k];
      });
    if (b.roomIds) {
      patch.roomIds = b.roomIds;
      // 一次查全量房间，避免在 map/reduce 回调里反复 await（回调是同步函数，云端拿不到值）
      const rs = (await Promise.all(b.roomIds.map(id => db.find('rooms', id)))).filter(Boolean);
      patch.roomCodes = rs.map(r => r.code);
      patch.area = money(rs.reduce((s, r) => s + num(r.area), 0));
    }
    patch.version = num(c.version, 1) + 1;
    patch.status = b.status || '变更';
    patch.changeLog = (c.changeLog || []).concat([{
      time: now(), user: (req.u || {}).name || '', action: '合同变更', detail: b.changeReason || '',
      before: JSON.stringify(before).slice(0, 3000), after: JSON.stringify(patch).slice(0, 3000)
    }]);
    (await db.update('contracts', c.id, patch));
    audit.routeLog(db, req, '合同管理', '合同变更', {
      bizId: c.id, bizCode: c.code, detail: b.changeReason || '', before: before, after: (await db.find('contracts', c.id))
    });
    ok(res, (await db.find('contracts', c.id)));
  });

  // 退租：生成退房单据 + 水电核验 + 押金退回流程
  router.post('/api/contract/contracts/:id/terminate', async (req, res) => {
    if (!can(req, res, 'contract:terminate')) return;
    const b = req.body || {};
    const c = (await db.find('contracts', req.params.id));
    if (!c) return fail(res, '合同不存在', 404);
    const bills = (await db.where('bills', bl => bl.contractId === c.id));
    const arrears = money(bills.reduce((s, x) => s + (x.totalAmount - x.paidAmount), 0));
    // 水电读数核验（双层循环要 await 查表，用 for...of）
    const meters = [];
    for (const rid of (c.roomIds || [])) {
      for (const m of await db.where('meters', x => x.roomId === rid)) {
        const rs = (await db.where('readings', r => r.meterId === m.id)).sort((a, b) => a.period < b.period ? 1 : -1);
        meters.push({ meterId: m.id, meterNo: m.meterNo, type: m.type, last: rs[0] ? rs[0].value : m.initValue, period: rs[0] ? rs[0].period : '' });
      }
    }
    const checkout = (await db.insert('checkouts', {
      id: uid('co'), code: db.nextNo('checkouts', 'TF', today()),
      contractId: c.id, contractCode: c.code, customerId: c.customerId, customerName: c.customerName,
      roomIds: c.roomIds, roomCodes: c.roomCodes, projectId: c.projectId,
      outDate: b.outDate || today(), reason: b.reason || '',
      meterCheck: meters, meterConfirmed: !!b.meterConfirmed,
      arrears: arrears, arrearsCleared: arrears <= 0.01,
      deposit: num(c.deposit), depositPaid: num(c.depositPaid),
      refundAmount: money(num(b.refundAmount, Math.max(0, num(c.depositPaid) - arrears))),
      deductAmount: num(b.deductAmount, 0), deductReason: b.deductReason || '',
      status: '待核验', by: (req.u || {}).name || '', byId: req.user.id, createTime: now(),
      remark: b.remark || ''
    }));
    const patch = {
      status: b.mode === '终止' ? '终止' : '退租',
      depositRefundStatus: '待退',
      changeLog: (c.changeLog || []).concat([{ time: now(), user: (req.u || {}).name || '', action: b.mode === '终止' ? '合同终止' : '退租', detail: '退房单 ' + checkout.code + '；欠费 ' + arrears + ' 元' }])
    };
    (await db.update('contracts', c.id, patch));
    // for...of：循环体要 await db.update，否则云端下房间状态不会变（仍是「已租」）
    for (const rid of (c.roomIds || [])) await db.update('rooms', rid, { status: '空置' });
    audit.routeLog(db, req, '合同管理', b.mode === '终止' ? '合同终止' : '退租办理', {
      bizId: c.id, bizCode: c.code, detail: '生成退房单 ' + checkout.code + '，欠费 ' + arrears + ' 元，应退押金 ' + checkout.refundAmount + ' 元'
    });
    ok(res, { checkout: checkout, contract: (await db.find('contracts', c.id)), arrears: arrears });
  });

  // 退房单列表 / 押金退回
  router.get('/api/contract/checkouts', async (req, res) => {
    if (!can(req, res, 'contract:view')) return;
    const list = (await db.where('checkouts', q => true)).sort((a, b) => a.createTime < b.createTime ? 1 : -1);
    ok(res, { list: list, total: list.length });
  });

  router.post('/api/contract/checkouts/:id/refund', async (req, res) => {
    if (!can(req, res, 'billing:deposit')) return;
    const b = req.body || {};
    const co = (await db.find('checkouts', req.params.id));
    if (!co) return fail(res, '退房单不存在', 404);
    (await db.update('checkouts', co.id, {
      status: '已退款', refundAmount: money(b.refundAmount !== undefined ? b.refundAmount : co.refundAmount),
      refundDate: b.refundDate || today(), refundBy: (req.u || {}).name || '', remark: b.remark || co.remark
    }));
    const d = (await db.one('deposits', x => x.contractId === co.contractId));
    if (d) (await db.update('deposits', d.id, {
      status: '已退回', refundAmount: money(b.refundAmount !== undefined ? b.refundAmount : co.refundAmount),
      refundDate: b.refundDate || today(), deductAmount: num(co.deductAmount), deductReason: co.deductReason
    }));
    (await db.update('contracts', co.contractId, { depositRefundStatus: '已退', status: '退租' }));
    audit.routeLog(db, req, '合同管理', '押金退回', { bizId: co.id, bizCode: co.code, detail: '退回 ' + (b.refundAmount !== undefined ? b.refundAmount : co.refundAmount) + ' 元' });
    ok(res, (await db.find('checkouts', co.id)));
  });

  // 到期预警列表
  router.get('/api/contract/expiring', async (req, res) => {
    if (!can(req, res, 'contract:view')) return;
    const months = num(req.query.months, 6);
    const days = months * 30;
    const src1 = await db.where('contracts', c => {
      if (c.status !== '正常履约' && c.status !== '变更') return false;
      const d = diffDays(today(), c.endDate);
      return d >= 0 && d <= days;
    });
    // map 回调要 await 查库 → Promise.all 聚合
    const list = (await Promise.all(src1.map(async c => {
      const o = Object.assign({}, c);
      o.daysLeft = diffDays(today(), c.endDate);
      o.level = o.daysLeft <= 30 ? '紧急' : (o.daysLeft <= 90 ? '重要' : '提示');
      o.projectName = ((await db.find('projects', c.projectId)) || {}).name || '';
      const cu = await db.find('customers', c.customerId);
      o.phone = cu ? cu.phone : ''; o.contact = cu ? cu.contact : '';
      return o;
    }))).sort((a, b) => a.daysLeft - b.daysLeft);
    ok(res, { list: list, total: list.length });
  });

  // 年度巡检复核：每 3-6 个月复核一次
  router.get('/api/contract/recheck', async (req, res) => {
    if (!can(req, res, 'contract:view')) return;
    const months = num(req.query.months, 3);
    const src2 = await db.where('contracts', c => c.status === '正常履约' || c.status === '变更');
    const list = (await Promise.all(src2.map(async c => {
      const last = c.lastRecheck || c.startDate;
      const elapsed = Math.round((new Date(today()) - new Date(last)) / 86400000);
      return Object.assign({}, c, {
        lastRecheck: last, elapsedDays: elapsed,
        needRecheck: elapsed >= months * 30,
        projectName: ((await db.find('projects', c.projectId)) || {}).name || ''
      });
    }))).filter(c => c.needRecheck);
    ok(res, { list: list, total: list.length });
  });

  router.post('/api/contract/contracts/:id/recheck', async (req, res) => {
    if (!can(req, res, 'contract:manage')) return;
    const c = (await db.find('contracts', req.params.id));
    if (!c) return fail(res, '合同不存在', 404);
    (await db.update('contracts', c.id, {
      lastRecheck: today(),
      changeLog: (c.changeLog || []).concat([{ time: now(), user: (req.u || {}).name || '', action: '合同复核', detail: (req.body || {}).result || '' }])
    }));
    audit.routeLog(db, req, '合同管理', '合同复核', { bizId: c.id, bizCode: c.code, detail: (req.body || {}).result || '' });
    ok(res, true);
  });

  // 合同汇总统计
  router.get('/api/contract/summary', async (req, res) => {
    if (!can(req, res, 'contract:view')) return;
    const all = (await db.where('contracts'));
    const byStatus = {}, byProject = {};
    let area = 0, monthly = 0;
    // for...of：循环体要 await db.find 补项目名
    for (const c of all) {
      byStatus[c.status] = (byStatus[c.status] || 0) + 1;
      const pj = await db.find('projects', c.projectId);
      const key = pj ? pj.name : '未分配';
      byProject[key] = (byProject[key] || 0) + 1;
      if (c.status === '正常履约' || c.status === '变更') {
        area = money(area + num(c.area));
        monthly = money(monthly + num(c.rentMonthly));
      }
    }
    ok(res, { total: all.length, byStatus: byStatus, byProject: byProject, area: area, monthly: monthly });
  });

  return router;
};
