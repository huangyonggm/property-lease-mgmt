'use strict';
// 审批流程（多级审批）+ 钉钉对接 + 提醒中心
const { ok, fail } = require('../lib/http');
const { can, needLogin } = require('../lib/crud');
const audit = require('../lib/audit');
const dt = require('../lib/dingtalk');
const { uid, num, now, today, money } = require('../lib/util');

module.exports = function (db, router) {
  /* ---------- 审批 ---------- */
  router.get('/api/approval/list', async (req, res) => {
    if (!can(req, res, 'approval:view')) return;
    const q = req.query;
    let list = (await db.where('approvals', a => (!q.status || a.status === q.status) && (!q.type || a.type === q.type) && (!q.projectId || a.projectId === q.projectId)));
    // 待我审批。roleCode 要查库，先把当前用户的角色码取出来再过滤，
    // 不能写在 some() 回调里 await —— 回调是同步函数，云端下会拿到 Promise
    if (q.mine === '1' && req.user) {
      const myRole = await db.find('roles', req.user.roleId);
      const myCode = (myRole || {}).code || '';
      list = list.filter(a => (a.steps || []).some(s =>
        s.status === '待审批' && (String(s.userId) === String(req.user.id) || s.roleCode === myCode)));
    }
    list = list.sort((a, b) => a.createTime < b.createTime ? 1 : -1);
    // 补项目名：map 回调要 await db.find，用 Promise.all 聚合
    list = await Promise.all(list.map(async a => {
      const o = Object.assign({}, a);
      o.projectName = ((await db.find('projects', a.projectId)) || {}).name || '';
      const step = (a.steps || []).filter(s => s.status === '待审批').sort((x, y) => x.level - y.level)[0];
      o.currentStep = step ? step.name : '';
      o.currentUserId = step ? step.userId : '';
      return o;
    }));
    ok(res, { list: list, total: list.length });
  });

  router.get('/api/approval/:id', async (req, res) => {
    if (!can(req, res, 'approval:view')) return;
    const a = (await db.find('approvals', req.params.id));
    if (!a) return fail(res, '审批单不存在', 404);
    const biz = (await db.find('contracts', a.bizId));
    ok(res, Object.assign({}, a, { biz: biz }));
  });

  // 发起审批
  router.post('/api/approval', async (req, res) => {
    if (!can(req, res, 'approval:approve')) return;
    const b = req.body || {};
    const steps = b.steps || [
      { level: 1, name: '招商经理审核（价格）', roleCode: 'ZSJL', userId: b.firstUserId || 'u_2', status: '待审批', time: '', comment: '' },
      { level: 2, name: '财务经理审核（租金）', roleCode: 'CWJL', userId: b.secondUserId || 'u_6', status: '待审批', time: '', comment: '' }
    ];
    const ap = (await db.insert('approvals', {
      id: uid('ap'), code: db.nextNo('approvals', 'SP', today()),
      type: b.type || '合同审批', subTypes: b.subTypes || ['价格审核', '租金审核', '免租期审核'],
      bizId: b.bizId || '', bizCode: b.bizCode || '', bizTitle: b.bizTitle || '',
      projectId: b.projectId || '', amount: num(b.amount),
      currentLevel: 1, totalLevel: steps.filter(s => s.status === '待审批').length,
      status: '审批中', steps: steps,
      logs: [{ time: now(), user: (req.u || {}).name || '', action: '提交', comment: b.comment || '' }],
      applicant: (req.u || {}).name || '', applicantId: req.user.id, createTime: now(), dingtalkSent: false
    }));
    audit.routeLog(db, req, '审批流程', '发起审批', { bizId: ap.id, bizCode: ap.code, detail: ap.bizTitle });
    ok(res, ap);
  });

  // 审批操作（通过 / 驳回）
  router.post('/api/approval/:id/approve', async (req, res) => {
    if (!can(req, res, 'approval:approve')) return;
    const b = req.body || {};
    const apId = req.params.id;

    // ---- 合同模板比对：硬拦截（必须无差异才能通过）----
    // 为什么后端也要拦，不能只在前端禁用按钮：
    //   前端禁用只挡「页面上的通过按钮」，直接调接口 / 旧版页面 / 数据订正脚本
    //   都能绕过。审批是写库操作，规则必须在服务端兜住，否则拦截形同虚设。
    if (b.action !== '驳回') {
      const ap0 = await db.find('approvals', apId);
      if (!ap0) return fail(res, '审批单不存在');
      const AC = require('../lib/approvalCompare');
      const cr = ap0.compareResult || null;
      const cs = ap0.compareState || {};

      // 比对还在跑（可能触发了 OCR）→ 不能通过，得等结论
      if (cs.pending === true) {
        return fail(res, '合同模板比对尚未完成（正在识别扫描件），请稍后刷新再审批', 409);
      }

      const v = cr && cr.enabled !== false
        ? { block: !!cr.block, reason: cr.verdictText || '', stat: cr.stat || {} }
        : AC.verdictOf(null);

      if (v.block) {
        // 强制通过：仅限总经理 / 系统管理员，且必须书面说明理由，全程留痕。
        // 没有这个口子，一旦 OCR 误判或模板本身有争议，审批就彻底卡死无法推进。
        const role = await db.find('roles', req.user.roleId);
        // 角色 code 是大写（见 data/roles.json）：ZJL 总经理 / ADMIN 超级管理员
        const roleCode = String((role || {}).code || '').toUpperCase();
        const isGM = roleCode === 'ZJL' || roleCode === 'ADMIN' || req.user.isAdmin === true;
        const forceReason = String(b.forceReason || '').trim();
        if (!(b.force === true && isGM && forceReason.length >= 5)) {
          const st = v.stat || {};
          const extra = st.total ? '（严重 ' + (st.high || 0) + ' / 建议 ' + (st.medium || 0) + ' / 提示 ' + (st.low || 0) + '）' : '';
          return fail(res,
            '合同与标准模板存在差异，' + v.reason + extra + '。请退回招商部修改后重新上报；' +
            '如确认差异无误需强制通过，请总经理在「强制通过理由」中填写至少 5 个字。', 409);
        }
        // 留痕：谁在什么情况下绕过了硬拦截
        await db.update('approvals', apId, {
          compareOverride: {
            at: now(), by: req.user.id, byName: (req.u || {}).name || '',
            role: roleCode, reason: forceReason,
            stat: v.stat || {}, origin: v.reason
          }
        });
        audit.routeLog(db, req, '审批流程', '强制通过（模板有差异）', {
          bizId: apId, bizCode: ap0.code,
          detail: '原判定：' + v.reason + '；强制通过理由：' + forceReason
        });
      }
    }

    // dt.approve 内部要查库（云端 async），必须 await
    const r = await dt.approve(db, apId, {
      userId: req.user.id, userName: (req.u || {}).name || '',
      action: b.action === '驳回' ? '驳回' : '通过', comment: b.comment || '', source: '系统'
    });
    if (!r.ok) return fail(res, r.msg);
    audit.routeLog(db, req, '审批流程', b.action === '驳回' ? '审批驳回' : '审批通过', {
      bizId: apId, bizCode: r.approval.code, detail: (b.comment || '')
    });
    // 通过后推送钉钉下一节点（推送失败不影响审批结果）
    const cfg = await dt.config(db);
    if (cfg.enabled && r.approval.status === '审批中') dt.pushApproval(db, r.approval).catch(() => { });
    ok(res, r.approval);
  });

  /* ---------- 钉钉 ---------- */
  router.get('/api/dingtalk/config', async (req, res) => {
    if (!needLogin(req, res)) return;
    const c = await dt.config(db);
    ok(res, Object.assign({}, c, { appSecret: c.appSecret ? '******' : '' }));
  });

  router.post('/api/dingtalk/config', async (req, res) => {
    if (!can(req, res, 'system:manage')) return;
    const b = req.body || {};
    if (b.appSecret === '******') delete b.appSecret;
    await dt.saveConfig(db, b);
    audit.routeLog(db, req, '系统设置', '修改钉钉配置', { detail: 'enabled=' + b.enabled + ' mode=' + b.mode });
    ok(res, await dt.config(db));
  });

  router.post('/api/dingtalk/test', async (req, res) => {
    if (!can(req, res, 'system:manage')) return;
    const b = req.body || {};
    const r = await dt.sendNotice(db, {
      msgType: '测试消息', title: '物业租赁系统 - 钉钉联通测试',
      content: '这是一条来自物业不动产租赁管理系统的测试消息。\n时间：' + now(),
      userIds: b.userIds || [], bizType: 'test'
    });
    ok(res, r);
  });

  router.post('/api/dingtalk/push', async (req, res) => {
    if (!can(req, res, 'approval:view')) return;
    const b = req.body || {};
    if (b.type === 'approval') {
      const ap = (await db.find('approvals', b.id));
      if (!ap) return fail(res, '审批单不存在');
      const r = await dt.pushApproval(db, ap);
      audit.routeLog(db, req, '钉钉', '推送审批', { bizId: ap.id, bizCode: ap.code });
      return ok(res, r);
    }
    const r = await dt.pushReminders(db, b.types || ['合同到期', '欠费催收']);
    audit.routeLog(db, req, '钉钉', '推送提醒', { detail: '推送 ' + r.count + ' 条' });
    ok(res, r);
  });

  // 钉钉审批回调（钉钉侧调用）
  router.post('/api/dingtalk/callback', async (req, res) => {
    const b = req.body || {};
    const r = await dt.handleCallback(db, b);
    if (r.ok) audit.write(db, { module: '钉钉', action: '审批回调', bizId: b.bizId || '', detail: JSON.stringify(b).slice(0, 500) });
    ok(res, r);
  });

  router.get('/api/dingtalk/msgs', async (req, res) => {
    if (!can(req, res, 'system:view')) return;
    const list = (await db.where('dingtalk_msgs')).sort((a, b) => a.createTime < b.createTime ? 1 : -1).slice(0, 200);
    ok(res, list);
  });

  /* ---------- 提醒中心 ---------- */
  router.get('/api/reminders', async (req, res) => {
    if (!needLogin(req, res)) return;
    const q = req.query;
    let list = (await db.where('reminders', r => (!q.type || r.type === q.type) && (!q.status || r.status === q.status) && (!q.projectId || r.projectId === q.projectId) && (!q.level || r.level === q.level)));
    list = list.sort((a, b) => (b.level === '紧急' ? 1 : 0) - (a.level === '紧急' ? 1 : 0) || ((a.daysLeft || 999) - (b.daysLeft || 999)));
    const summary = {
      total: list.length,
      expire: list.filter(r => r.type === '合同到期').length,
      arrears: list.filter(r => r.type === '欠费催收').length,
      urgent: list.filter(r => r.level === '紧急').length,
      arrearsAmount: money(list.filter(r => r.type === '欠费催收').reduce((s, r) => s + num(r.amount), 0))
    };
    ok(res, { list: list, summary: summary });
  });

  router.post('/api/reminders/:id/handle', async (req, res) => {
    if (!needLogin(req, res)) return;
    const b = req.body || {};
    const r = (await db.find('reminders', req.params.id));
    if (!r) return fail(res, '提醒不存在', 404);
    (await db.update('reminders', r.id, { status: '已处理', handleResult: b.result || '', handleBy: (req.u || {}).name || '', handleTime: now() }));
    audit.routeLog(db, req, '提醒中心', '处理提醒', { bizId: r.id, detail: r.type + '：' + (b.result || '') });
    ok(res, true);
  });

  // 重新生成提醒（按当前合同与账单）
  router.post('/api/reminders/refresh', async (req, res) => {
    if (!needLogin(req, res)) return;
    const biz = (await db.one('settings', s => s.key === 'biz')) || {};
    const months = num(biz.expireWarnMonths, 6);
    db.clear('reminders');
    let n = 0;
    // for...of：循环体要 await db.insert（云端是 Promise），forEach 回调是同步函数会漏写
    for (const c of await db.where('contracts', c2 => c2.status === '正常履约' || c2.status === '变更')) {
      const d = Math.round((new Date(c.endDate) - new Date(today())) / 86400000);
      if (d > 0 && d <= months * 30) {
        await db.insert('reminders', {
          id: uid('rm2'), type: '合同到期', level: d <= 30 ? '紧急' : (d <= 90 ? '重要' : '提示'),
          contractId: c.id, contractCode: c.code, customerId: c.customerId, customerName: c.customerName,
          roomCodes: c.roomCodes, projectId: c.projectId, dueDate: c.endDate, daysLeft: d,
          content: '合同 ' + c.code + '（' + c.customerName + ' / ' + (c.roomCodes || []).join('、') + '）将于 ' + c.endDate + ' 到期，剩余 ' + d + ' 天',
          status: '未处理', ownerId: 'u_2', createdAt: now()
        });
        n++;
      }
    }
    for (const b2 of await db.where('bills', x => x.totalAmount - x.paidAmount > 0.01 && !x.internal)) {
      await db.insert('reminders', {
        id: uid('rm2'), type: '欠费催收', level: b2.status === '逾期' ? '紧急' : '重要',
        contractId: b2.contractId, contractCode: b2.contractCode, customerId: b2.customerId, customerName: b2.customerName,
        roomCodes: b2.roomCodes, projectId: b2.projectId, amount: money(b2.totalAmount - b2.paidAmount), period: b2.period,
        content: '账单 ' + b2.code + '（' + b2.period + '）欠费 ' + money(b2.totalAmount - b2.paidAmount).toFixed(2) + ' 元',
        status: '未处理', ownerId: 'u_4', createdAt: now(), billId: b2.id
      });
      n++;
    }
    ok(res, { count: n });
  });

  return router;
};
