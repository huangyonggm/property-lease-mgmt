'use strict';
// 工单巡检、系统设置、附件上传、操作日志、旧系统数据迁移
const { ok, fail } = require('../lib/http');
const { register, can, needLogin } = require('../lib/crud');
const audit = require('../lib/audit');
const fs = require('fs');
const path = require('path');
const { uid, num, now, today, addDays, monthOf, money } = require('../lib/util');
const { floorNameOf } = require('../lib/billing');
const { AttStore, MIME_BY_EXT } = require('../lib/attstore');
const OCR = require('../lib/ocr');

module.exports = function (db, router, opt) {
  opt = opt || {};
  const uploadDir = opt.uploadDir;
  // 附件存储实例（本地磁盘或七牛云，全进程共用一个）
  let _att = null;
  function attStore() {
    if (!_att) _att = new AttStore(opt.uploadDir);
    return _att;
  }

  /* ================= 工单 / 巡检 ================= */
  register(router, '/api/ops/workorders', 'workorders', {
    db, view: 'workorder:view', manage: 'workorder:manage', sort: 'planDate',
    where(q, req) {
      const w = {};
      if (q.projectId) w.projectId = q.projectId;
      if (q.buildingId) w.buildingId = q.buildingId;
      if (q.status) w.status = q.status;
      if (q.type) w.type = q.type;
      if (q.category) w.category = q.category;
      if (q.mine === '1' && req.user) return x => x.assigneeId === req.user.id && (!q.status || x.status === q.status);
      return Object.keys(w).length ? w : null;
    },
    async search(kw, where) {
      return (await db.where('workorders', where)).filter(w =>
        (w.code || '').indexOf(kw) >= 0 || (w.title || '').indexOf(kw) >= 0 ||
        (w.roomCode || '').indexOf(kw) >= 0 || (w.content || '').indexOf(kw) >= 0);
    },
    async decorate(row) {
      const o = Object.assign({}, row);
      const pj = (await db.find('projects', row.projectId));
      const b = (await db.find('buildings', row.buildingId));
      o.projectName = pj ? pj.name : '';
      o.buildingName = b ? b.name : '';
      o.photoCount = (row.photos || []).length;
      return o;
    },
    beforeInsert(b, req) {
      b.code = b.code || db.nextNo('workorders', 'GD', today());
      b.createdBy = (req.u || {}).name || ''; b.createdById = req.user.id; b.createTime = now();
      b.photos = b.photos || [];
    },
    after(row, action, req) {
      audit.routeLog(db, req, '工单巡检', action === 'insert' ? '创建工单' : '更新工单', { bizId: row.id, bizCode: row.code, detail: row.title });
    }
  });

  // 工单处理 / 完成（含现场照片、处理结果）
  router.post('/api/ops/workorders/:id/finish', async (req, res) => {
    if (!can(req, res, 'workorder:manage')) return;
    const b = req.body || {};
    const w = (await db.find('workorders', req.params.id));
    if (!w) return fail(res, '工单不存在', 404);
    (await db.update('workorders', w.id, {
      status: b.status || '已完成',
      result: b.result || '', photos: b.photos || w.photos || [],
      finishDate: b.finishDate || today(), finishBy: (req.u || {}).name || '', finishTime: now()
    }));
    audit.routeLog(db, req, '工单巡检', '工单完成', { bizId: w.id, bizCode: w.code, detail: b.result || '' });
    ok(res, (await db.find('workorders', w.id)));
  });

  // 自动生成巡检任务：日常（每日）/ 月度 / 合同履约复核 / 月度抄表
  router.post('/api/ops/workorders/generate', async (req, res) => {
    if (!can(req, res, 'workorder:manage')) return;
    const b = req.body || {};
    const kind = b.kind || 'daily';
    const date = b.date || today();
    const projectId = b.projectId;
    const created = [];
    const buildings = (await db.where('buildings', x => !projectId || x.projectId === projectId));

    if (kind === 'daily' || kind === 'monthly') {
      // 三层循环都要查库 → 全部用 for...of 串行。
      // 用 forEach 的话回调是同步函数，云端下 await 拿不到结果，工单会一条都建不出来。
      for (const bd of buildings) {
        // 中央空调楼层：每日白班巡检
        for (const f of (bd.acFloors || [])) {
          const rooms = await db.where('rooms', r => r.buildingId === bd.id && String(r.floor) === String(f));
          if (!rooms.length) continue;
          created.push(await db.insert('workorders', {
            id: uid('wo'), code: db.nextNo('workorders', 'GD', date),
            type: kind === 'daily' ? '空调巡检' : '巡检工单', category: '空调',
            projectId: bd.projectId, buildingId: bd.id, roomId: rooms[0].id, roomCode: rooms[0].code,
            title: (kind === 'daily' ? '每日白班' : '月度') + '中央空调巡检（' + floorNameOf(f) + '层）',
            content: '巡检要点：主机运行状态、风口温度、冷凝水排放、噪音与振动',
            status: '待处理', priority: '普通', assignee: b.assignee || '陈工程', assigneeId: b.assigneeId || 'u_12',
            planDate: date, finishDate: '', result: '', photos: [], focus: true,
            createdBy: (req.u || {}).name || '', createdById: req.user.id, createTime: now()
          }));
        }
        // 消防楼层：重点标记
        for (const f of (bd.fireFloors || [])) {
          const rooms = await db.where('rooms', r => r.buildingId === bd.id && String(r.floor) === String(f));
          if (!rooms.length) continue;
          created.push(await db.insert('workorders', {
            id: uid('wo'), code: db.nextNo('workorders', 'GD', date),
            type: '消防巡检', category: '消防',
            projectId: bd.projectId, buildingId: bd.id, roomId: rooms[0].id, roomCode: rooms[0].code,
            title: (kind === 'daily' ? '每日' : '月度') + '消防楼层巡检（' + floorNameOf(f) + '层）',
            content: '巡检要点：灭火器有效期、消防栓水压、疏散通道、报警联动',
            status: '待处理', priority: '紧急', assignee: b.assignee || '陈工程', assigneeId: b.assigneeId || 'u_12',
            planDate: date, finishDate: '', result: '', photos: [], focus: true,
            createdBy: (req.u || {}).name || '', createdById: req.user.id, createTime: now()
          }));
        }
      }
    }

    if (kind === 'meter') {
      const period = b.period || monthOf(date);
      const rooms = (await db.where('rooms', r => r.status === '已租' && (!projectId || r.projectId === projectId)));
      // 按楼栋+楼层聚合生成一张抄表工单
      const groups = {};
      rooms.forEach(r => {
        const k = r.buildingId + '_' + r.floor;
        groups[k] = groups[k] || { buildingId: r.buildingId, floor: r.floor, rooms: [] };
        groups[k].rooms.push(r);
      });
      for (const k of Object.keys(groups)) {
        const g = groups[k];
        const bd = await db.find('buildings', g.buildingId);
        created.push(await db.insert('workorders', {
          id: uid('wo'), code: db.nextNo('workorders', 'GD', date),
          type: '抄表工单', category: '抄表',
          projectId: bd ? bd.projectId : '', buildingId: g.buildingId,
          roomId: g.rooms[0].id, roomCode: g.rooms.map(r => r.code).join('、'),
          title: period + ' 月度电表抄表（' + (bd ? bd.name : '') + ' ' + floorNameOf(g.floor) + '层，' + g.rooms.length + ' 间）',
          content: '抄表范围：' + g.rooms.map(r => r.code).join('、'),
          status: '待处理', priority: '普通', assignee: b.assignee || '陈工程', assigneeId: b.assigneeId || 'u_12',
          planDate: date, finishDate: '', result: '', photos: [], focus: false,
          period: period, createdBy: (req.u || {}).name || '', createdById: req.user.id, createTime: now()
        }));
      }
    }

    if (kind === 'contract') {
      const months = num(b.months, 3);
      const cs = (await db.where('contracts', c => (c.status === '正常履约' || c.status === '变更') && (!projectId || c.projectId === projectId)));
      for (const c of cs) {
        const days = Math.round((new Date(c.endDate) - new Date(today())) / 86400000);
        if (days > months * 30 || days < 0) continue;
        created.push(await db.insert('workorders', {
          id: uid('wo'), code: db.nextNo('workorders', 'GD', date),
          type: '巡检工单', category: '履约',
          projectId: c.projectId, buildingId: c.buildingId, roomId: (c.roomIds || [])[0] || '', roomCode: (c.roomCodes || []).join('、'),
          title: '合同履约复核：' + c.customerName + '（' + c.code + '）',
          content: '合同到期日 ' + c.endDate + '，剩余 ' + days + ' 天；复核租金缴纳、房屋状况、续租意向',
          status: '待处理', priority: days <= 30 ? '紧急' : '普通',
          assignee: b.assignee || '王客服', assigneeId: b.assigneeId || 'u_4',
          planDate: date, finishDate: '', result: '', photos: [], focus: days <= 30,
          createdBy: (req.u || {}).name || '', createdById: req.user.id, createTime: now()
        }));
      }
    }

    audit.routeLog(db, req, '工单巡检', '生成巡检任务', { detail: kind + '，生成 ' + created.length + ' 条' });
    ok(res, { created: created.length, list: created });
  });

  router.get('/api/ops/workorder-stats', async (req, res) => {
    if (!can(req, res, 'workorder:view')) return;
    const all = (await db.where('workorders'));
    const byStatus = {}, byType = {};
    all.forEach(w => { byStatus[w.status] = (byStatus[w.status] || 0) + 1; byType[w.type] = (byType[w.type] || 0) + 1; });
    return ok(res, {
      total: all.length, byStatus: byStatus, byType: byType,
      focus: all.filter(w => w.focus).length,
      overdue: all.filter(w => w.status !== '已完成' && w.status !== '已关闭' && w.planDate && w.planDate < today()).length
    });
  });

  /* ================= 附件在线预览（本机代理） =================
   * 【为什么必须有这个接口】
   * 七牛「私有空间」的下载链接**一律返回 `Content-Disposition: attachment`**
   * （实测：即使在 URL 上附加 response-content-disposition=inline 并让它参与签名，
   *   七牛仍然返回 attachment，只认自己的默认行为）——浏览器只会下载文件、
   * 不会内联显示，发票 PDF 的 iframe 在线预览因此失效。
   * 这里把内容取回来，自己以 `inline` 输出：
   *   · 浏览器可直接显示 PDF / 图片（用户点「查看」就是打开而非下载）
   *   · 天然获得鉴权：必须登录才能看，健康证/身份证等敏感件不会裸奔
   *   · 地址恒定，不像七牛签名链接那样 1 小时过期
   *
   * 前端拿到的附件 url 已由 lib/http.js 的 ok() 统一重写指向本接口（见 resignAttUrls）。
   * 附件实体本身仍在七牛，这里只是取回中转。
   */
  router.get('/api/attachment/file', async (req, res) => {
    if (!needLogin(req, res)) return;
    const key = String((req.query && req.query.key) || '').trim();
    if (!key) return fail(res, '缺少附件标识 key');
    // 防目录穿越：本地模式下 key 会参与拼路径
    if (key.indexOf('..') >= 0 || key.indexOf('\\') >= 0 || key.charAt(0) === '/' || key.indexOf('\0') >= 0) {
      return fail(res, '非法的附件标识');
    }
    let buf = null;
    try {
      buf = await attStore().read(key);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      // 对象不存在时七牛返回 404，翻译成 HTTP 404 更准确
      if (/404|not found/i.test(msg)) return fail(res, '附件不存在：' + key, 404);
      return fail(res, '读取附件失败：' + msg, 500);
    }
    if (!buf) return fail(res, '附件不存在：' + key, 404);

    const ext = path.extname(key).toLowerCase();
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
    const dlName = path.basename(key);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': buf.length,
      // inline = 内联显示；同时给出文件名，用户「另存为」时名字是对的
      // （不能带 attachment，否则浏览器又变成下载）
      'Content-Disposition': 'inline; filename="' + encodeURIComponent(dlName) + '"',
      // 私有内容不进共享缓存；给浏览器 5 分钟本地缓存，避免翻页时反复回源
      'Cache-Control': 'private, max-age=300'
    });
    res.end(buf);
  });

  /* ================= 附件上传 ================= */
  router.post('/api/system/upload', async (req, res) => {
    if (!needLogin(req, res)) return;
    const b = req.body || {};
    if (!b.dataBase64) return fail(res, '缺少文件内容');
    const m = String(b.dataBase64).match(/^data:([^;]+);base64,(.*)$/);
    const mime = m ? m[1] : 'application/octet-stream';
    const data = m ? m[2] : b.dataBase64;
    const ext = (b.fileName && path.extname(b.fileName)) || (mime.indexOf('png') >= 0 ? '.png' : mime.indexOf('jpeg') >= 0 || mime.indexOf('jpg') >= 0 ? '.jpg' : mime.indexOf('pdf') >= 0 ? '.pdf' : '.bin');
    const name = (b.bizType || 'file') + '_' + uid('') + ext;
    // 存储层抽象：本地磁盘 / 七牛云，由 ATT_STORAGE 切换，业务代码无须区分
    const att = attStore();
    const buf = Buffer.from(data, 'base64');
    let stored;
    try {
      stored = await att.put(name, buf, { mime: mime });
    } catch (e) {
      return fail(res, '附件上传失败：' + e.message);
    }
    const rec = {
      name: b.fileName || name, key: stored.key, url: stored.url,
      storage: stored.storage, size: buf.length,
      bizType: b.bizType || '', bizId: b.bizId || '', by: (req.u || {}).name || '', time: now()
    };
    // 用 insert 的返回值（含生成的 id / createTime）作为响应体。
    // 原来直接返回上面的 rec —— rec 里没有 id（id 是 db.insert 内部生成的），
    // 前端只能拿到 url/name，后续想按 id 删除/引用这条附件记录就无从下手。
    const saved = await db.insert('attachments', rec);

    // ---- 发票附件：上传即自动识别 ----
    // bizType='invoice' 时调腾讯云增值税发票专用 OCR，识别结果原样放在响应的
    // 顶层 `ocr` 字段（**不塞进 rec**：rec 会被前端存进发票的 attachments 数组，
    // 把识别中间结果一起持久化进去是脏数据）。前端拿到后用 fillInvoiceFromOcr 回填表单。
    //
    // 失败处理：`ocr_error` 只作提示，**附件本身照常上传成功** ——
    // OCR 是增强能力，不是前置依赖；税率识别不准、图片不是发票版式、
    // 甚至根本没配凭据，都不该让「把发票传上来存档」这件基本的事做不成。
    let extra = null;
    if (String(b.bizType || '') === 'invoice') {
      try {
        const r = await OCR.recognizeVatInvoice(buf, mime, b.fileName);
        extra = r && r.ok ? { ocr: r } : { ocr_error: (r && (r.msg || r.code)) || '发票识别失败' };
      } catch (e) {
        extra = { ocr_error: e.message || String(e) };
      }
    }
    ok(res, saved, extra);
  });

  router.get('/api/system/attachments', async (req, res) => {
    if (!needLogin(req, res)) return;
    const q = req.query;
    ok(res, (await db.where('attachments', a => (!q.bizType || a.bizType === q.bizType) && (!q.bizId || a.bizId === q.bizId))));
  });

  /* ================= 操作日志 ================= */
  router.get('/api/system/logs', async (req, res) => {
    if (!can(req, res, 'system:log')) return;
    const q = req.query;
    let list = (await db.where('logs', l => (!q.module || l.module === q.module) && (!q.userId || l.userId === q.userId) && (!q.bizId || l.bizId === q.bizId) && (!q.keyword || (l.detail || '').indexOf(q.keyword) >= 0 || (l.bizCode || '').indexOf(q.keyword) >= 0)));
    list = list.sort((a, b) => a.time < b.time ? 1 : -1);
    const total = list.length;
    const p = Math.max(1, num(q.page, 1)), sz = Math.max(1, num(q.size, 20));
    ok(res, { list: list.slice((p - 1) * sz, p * sz), total: total });
  });

  /* ================= 系统设置 ================= */
  router.get('/api/system/settings', async (req, res) => {
    if (!needLogin(req, res)) return;
    const key = req.query.key;
    ok(res, key ? (await db.one('settings', s => s.key === key)) : (await db.where('settings')));
  });

  router.post('/api/system/settings', async (req, res) => {
    if (!can(req, res, 'system:manage')) return;
    const b = req.body || {};
    if (b.id && (await db.find('settings', b.id))) { (await db.update('settings', b.id, b)); return ok(res, (await db.find('settings', b.id))); }
    ok(res, (await db.insert('settings', b)));
  });

  /* ================= 旧系统数据迁移 ================= */
  // 导入房间
  router.post('/api/system/import/rooms', async (req, res) => {
    if (!can(req, res, 'property:import')) return;
    const b = req.body || {};
    const rows = b.rows || [];
    if (!rows.length) return fail(res, '没有可导入的数据');
    const created = [], updated = [], errors = [];
    // for...of + entries()：要拿到行号 i（报错提示用「第 N 行」）且循环体要 await
    for (const [i, r] of rows.entries()) {
      try {
        const pj = (await db.one('projects', p => p.name === r.projectName || p.code === r.projectName)) || (await db.one('projects'));
        const bd = await db.one('buildings', x => x.projectId === pj.id && (x.name === r.buildingName || x.code === r.buildingName));
        if (!bd) { errors.push('第 ' + (i + 2) + ' 行：楼栋不存在（' + r.buildingName + '）'); continue; }
        const floorNum = parseInt(String(r.floor).replace(/[^\d]/g, ''), 10) || 1;
        const exist = await db.one('rooms', x => x.buildingId === bd.id && x.roomNo === r.roomNo && String(x.floor) === String(floorNum));
        const payload = {
          projectId: pj.id, buildingId: bd.id, floor: floorNum, floorLabel: r.floor || floorNameOf(floorNum),
          roomNo: r.roomNo, code: bd.name + '-' + (r.floor || floorNameOf(floorNum)) + '-' + r.roomNo,
          area: num(r.area), useArea: num(r.useArea, num(r.area) * 0.75),
          bizType: r.bizType || '办公', status: r.status || '空置',
          level: floorNum <= 3 ? '低层' : (floorNum >= 12 ? '高层' : '中间楼层'),
          propertyCert: r.propertyCert || '', certArea: num(r.certArea, num(r.area)), ownerName: r.ownerName || '',
          remark: r.remark || '旧系统导入'
        };
        if (exist) { await db.update('rooms', exist.id, payload); updated.push(exist.id); }
        else created.push((await db.insert('rooms', payload)).id);
      } catch (e) { errors.push('第 ' + (i + 2) + ' 行：' + e.message); }
    }
    audit.routeLog(db, req, '系统设置', '导入房间', { detail: '新增 ' + created.length + '，更新 ' + updated.length + '，失败 ' + errors.length });
    ok(res, { created: created.length, updated: updated.length, errors: errors });
  });

  // 导入电表读数（旧系统核对用）
  router.post('/api/system/import/readings', async (req, res) => {
    if (!can(req, res, 'billing:meter')) return;
    const b = req.body || {};
    const rows = b.rows || [];
    const created = [], errors = [], mismatch = [];
    // for...of + entries()：循环体要 await，且报错提示需要行号
    for (const [i, r] of rows.entries()) {
      const m = await db.one('meters', x => x.meterNo === r.meterNo);
      if (!m) { errors.push('第 ' + (i + 2) + ' 行：电表号不存在 ' + r.meterNo); continue; }
      const period = r.period || monthOf(r.date || today());
      const exist = await db.one('readings', x => x.meterId === m.id && x.period === period);
      if (exist) {
        if (num(exist.value) !== num(r.value)) {
          mismatch.push({ meterNo: r.meterNo, period: period, system: exist.value, imported: num(r.value), diff: money(num(r.value) - num(exist.value)) });
        }
        continue;
      }
      created.push((await db.insert('readings', {
        id: uid('rd'), meterId: m.id, roomId: m.roomId, period: period,
        date: r.date || today(), value: num(r.value), by: (req.u || {}).name || '', source: '旧系统导入'
      })).id);
    }
    audit.routeLog(db, req, '系统设置', '导入抄表读数', { detail: '新增 ' + created.length + '，差异 ' + mismatch.length + '，失败 ' + errors.length });
    ok(res, { created: created.length, mismatch: mismatch, errors: errors });
  });

  // 数据核对：房间用电 / 电表读数
  router.get('/api/system/verify', async (req, res) => {
    if (!can(req, res, 'system:view')) return;
    const period = req.query.period || monthOf(today());
    const rows = [];
    // for...of：循环体要 await 查房间与读数
    for (const m of await db.where('meters', x => x.type === '电表')) {
      const rm = await db.find('rooms', m.roomId);
      const rs = (await db.where('readings', r => r.meterId === m.id)).sort((a, b) => a.period < b.period ? 1 : -1);
      const cur = rs.filter(r => r.period === period)[0];
      if (!cur) { rows.push({ meterNo: m.meterNo, roomCode: rm ? rm.code : '', issue: '本期未抄表' }); continue; }
      const prev = rs.filter(r => r.period < period)[0];
      if (!prev) continue;
      const usage = num(cur.value) - num(prev.value);
      if (usage < 0) rows.push({ meterNo: m.meterNo, roomCode: rm ? rm.code : '', issue: '读数倒挂（本期 ' + cur.value + ' < 上期 ' + prev.value + '）' });
      else if (usage === 0 && rm && rm.status === '已租') rows.push({ meterNo: m.meterNo, roomCode: rm.code, issue: '已租房间本期零用电，疑似偷电或未抄表' });
    }
    ok(res, { period: period, issues: rows, count: rows.length });
  });

  /* ================= 系统概况 / 备份 ================= */
  router.get('/api/system/stats', async (req, res) => {
    if (!can(req, res, 'system:view')) return;
    const stats = db.stats();
    // 附件存储概况：主存储（七牛/本地）+ 本地镜像占用。
    // 镜像的意义是「七牛挂了手里还有一份」，运维需要能看到它到底存了多少、有没有生效。
    const att = attStore();
    ok(res, {
      collections: stats, dbPath: opt.dataDir, uploadDir: uploadDir,
      attachmentStorage: att.mode,
      mirror: att.mirrorStats()
    });
  });

  router.post('/api/system/backup', async (req, res) => {
    if (!can(req, res, 'system:manage')) return;
    const backupDir = path.join(opt.rootDir, 'backups', today().replace(/-/g, ''));
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const files = fs.readdirSync(opt.dataDir).filter(f => f.indexOf('.json') > 0 && f.indexOf('.tmp') < 0);
    files.forEach(f => fs.copyFileSync(path.join(opt.dataDir, f), path.join(backupDir, f)));
    audit.routeLog(db, req, '系统设置', '数据备份', { detail: backupDir + '，共 ' + files.length + ' 个文件' });
    ok(res, { dir: backupDir, files: files.length });
  });

  router.post('/api/system/reseed', async (req, res) => {
    if (!can(req, res, 'system:manage')) return;
    const { seed } = require('../lib/seed');
    const r = seed(db);
    ok(res, { seeded: r });
  });

  return router;
};
