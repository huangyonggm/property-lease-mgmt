'use strict';
// 钉钉对接：配置管理、AccessToken、消息推送（mock/live）、审批回调
const https = require('https');
const { uid, now } = require('./util');

async function config(db) {
  return (await db.one('settings', s => s.key === 'dingtalk')) || {};
}

async function saveConfig(db, patch) {
  const c = config(db);
  if (!c.id) {
    return (await db.insert('settings', Object.assign({ id: 'st_dingtalk', key: 'dingtalk', name: '钉钉对接' }, patch)));
  }
  return (await db.update('settings', c.id, patch));
}

function httpJson(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + (u.search || ''),
      method: method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf || '{}')); } catch (e) { resolve({ _raw: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getAccessToken(db) {
  const c = config(db);
  if (!c.appKey || !c.appSecret) throw new Error('未配置钉钉 AppKey / AppSecret');
  const r = await httpJson('POST', (c.apiBase || 'https://api.dingtalk.com') + '/v1.0/oauth2/accessToken', {
    appKey: c.appKey, appSecret: c.appSecret
  });
  if (!r.accessToken) throw new Error('获取 access_token 失败：' + JSON.stringify(r));
  return r.accessToken;
}

// 发送工作通知
async function sendNotice(db, opt) {
  const c = config(db);
  const msg = {
    id: uid('dt'), type: opt.msgType || '工作通知',
    title: opt.title || '物业租赁系统通知',
    content: opt.content || '',
    userIds: opt.userIds || [],
    bizType: opt.bizType || '', bizId: opt.bizId || '',
    status: '待发送', mode: c.mode || 'mock', createTime: now(), result: ''
  };
  if (!c.enabled || (c.mode || 'mock') === 'mock') {
    msg.status = '模拟发送';
    msg.result = 'mock 模式：未实际调用钉钉接口';
    (await db.insert('dingtalk_msgs', msg));
    return { ok: true, mock: true, msg: msg };
  }
  try {
    const token = await getAccessToken(db);
    const r = await httpJson('POST', (c.apiBase || 'https://api.dingtalk.com') + '/v1.0/im/v1messages', {
      robotCode: c.appKey,
      msgKey: 'sampleMarkdown',
      msgParam: JSON.stringify({ title: msg.title, text: msg.content }),
      userIds: msg.userIds
    }, { 'x-acs-dingtalk-access-token': token });
    msg.status = '已发送';
    msg.result = JSON.stringify(r).slice(0, 500);
  } catch (e) {
    msg.status = '发送失败';
    msg.result = e.message;
  }
  (await db.insert('dingtalk_msgs', msg));
  return { ok: msg.status === '已发送', msg: msg };
}

// 审批推送：把待办推给钉钉
async function pushApproval(db, approval) {
  const c = config(db);
  const step = (approval.steps || []).filter(s => s.status === '待审批')[0];
  if (!step) return { ok: false, msg: '无待审批节点' };
  const user = (await db.find('users', step.userId));
  const content = '【' + approval.type + '】' + approval.bizTitle + '\n单号：' + approval.code +
    '\n当前节点：' + step.name + '\n金额：' + (approval.amount || 0).toLocaleString('zh-CN') + ' 元\n请在钉钉内完成审批。';
  const r = await sendNotice(db, {
    msgType: '审批通知', title: approval.type + '待审批：' + approval.code,
    content: content, userIds: [user ? user.dingtalkUserId : ''].filter(Boolean),
    bizType: 'approval', bizId: approval.id
  });
  (await db.update('approvals', approval.id, { dingtalkSent: true }));
  return r;
}

// 批量推送提醒（到期 / 欠费 / 巡检）
async function pushReminders(db, types) {
  const c = config(db);
  const t = types || ['合同到期', '欠费催收'];
  const list = (await db.where('reminders', r => t.indexOf(r.type) >= 0 && r.status === '未处理'));
  const sent = [];
  for (const r of list.slice(0, 200)) {
    const owner = (await db.find('users', r.ownerId));
    const res = await sendNotice(db, {
      msgType: r.type + '提醒', title: '【' + r.type + '】' + r.customerName,
      content: r.content, userIds: [owner && owner.dingtalkUserId].filter(Boolean),
      bizType: 'reminder', bizId: r.id
    });
    (await db.update('reminders', r.id, { pushed: true, pushTime: now() }));
    sent.push(res);
  }
  return { count: sent.length };
}

// 钉钉审批回调（由钉钉侧调用本接口回写审批结果）
async function handleCallback(db, payload) {
  const bizId = payload.bizId || payload.businessId || '';
  const result = payload.result || payload.type || '';   // agree / refuse
  const ap = (await db.find('approvals', bizId)) || (await db.one('approvals', a => a.code === bizId));
  if (!ap) return { ok: false, msg: '未找到审批单：' + bizId };
  return approve(db, ap.id, {
    userId: payload.userId || '',
    userName: payload.userName || '钉钉审批',
    action: (result === 'refuse' || result === 'reject') ? '驳回' : '通过',
    comment: payload.comment || '钉钉审批回写',
    source: '钉钉'
  });
}

// 本地审批流转
async function approve(db, id, opt) {
  const ap = (await db.find('approvals', id));
  if (!ap) return { ok: false, msg: '审批单不存在' };
  if (ap.status !== '审批中') return { ok: false, msg: '审批单不在审批中状态' };
  const step = (ap.steps || []).filter(s => s.status === '待审批').sort((a, b) => a.level - b.level)[0];
  if (!step) return { ok: false, msg: '无待审批节点' };
  step.status = opt.action === '驳回' ? '已驳回' : '已通过';
  step.time = now();
  step.comment = opt.comment || '';
  step.operator = opt.userName || '';
  ap.logs = ap.logs || [];
  ap.logs.push({ time: now(), user: opt.userName || '', action: opt.action, comment: opt.comment || '', source: opt.source || '系统' });
  if (opt.action === '驳回') {
    ap.status = '已驳回';
    if (ap.bizId && (await db.find('contracts', ap.bizId))) (await db.update('contracts', ap.bizId, { status: '审批驳回' }));
  } else {
    const next = (ap.steps || []).filter(s => s.status === '待审批').sort((a, b) => a.level - b.level)[0];
    if (next) {
      ap.currentLevel = next.level;
      ap.status = '审批中';
    } else {
      ap.status = '已通过';
      ap.currentLevel = 99;
      if (ap.bizId && (await db.find('contracts', ap.bizId))) {
        (await db.update('contracts', ap.bizId, { approveStatus: '已通过', status: '正常履约' }));
      }
    }
  }
  (await db.update('approvals', id, { steps: ap.steps, logs: ap.logs, status: ap.status, currentLevel: ap.currentLevel }));
  return { ok: true, approval: ap };
}

module.exports = {
  config, saveConfig, sendNotice, pushApproval, pushReminders, handleCallback, approve, getAccessToken
};
