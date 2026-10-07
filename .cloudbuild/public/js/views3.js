/* 视图：审批流程 / 工单巡检 / 报表统计 / 系统设置 */
(function () {

  /* ============ 审批流程 ============ */
  App.view('approval', {
    title: '审批流程（钉钉）',
    async render(el) {
      const tabs = [{ key: 'list', name: '审批单' }, { key: 'mine', name: '待我审批' }, { key: 'dt', name: '钉钉对接' }];
      let cur = 'list';
      el.innerHTML = '<div class="tabs">' + tabs.map(t => '<div class="tab' + (t.key === cur ? ' active' : '') + '" data-tab="' + t.key + '">' + t.name + '</div>').join('') +
        '</div><div id="apBody"></div>';
      el.querySelectorAll('[data-tab]').forEach(t => {
        t.onclick = () => { el.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('active')); t.classList.add('active'); cur = t.getAttribute('data-tab'); renderTab(); };
      });
      async function renderTab() {
        const box = el.querySelector('#apBody');
        box.innerHTML = '';
        if (cur === 'dt') { return renderDingtalk(box); }
        const q = cur === 'mine' ? '&mine=1' : '';
        const r = await GET('/api/approval/list?size=200' + q);
        const list = r.data.list || [];
        box.innerHTML = '<div class="card"><div class="card-head"><h3>' + (cur === 'mine' ? '待我审批' : '审批单列表') + '</h3><span class="spacer"></span>' +
          '<button class="btn btn-sm" id="pushAll">推送钉钉提醒</button> <button class="btn btn-sm" data-reload>刷新</button></div>' +
          '<div class="card-body tight">' +
          Table.render([
            { title: '审批单号', key: 'code', render: r => '<b class="mono">' + U.esc(r.code) + '</b>' },
            { title: '类型', key: 'type', width: 90 },
            { title: '审批事项', key: 'bizTitle', width: 260 },
            { title: '金额', key: 'amount', width: 100, num: true, render: r => '¥' + U.money(r.amount) },
            { title: '当前节点', key: 'currentStep', width: 170 },
            { title: '状态', key: 'status', width: 85, render: r => U.statusTag(r.status) },
            { title: '申请人', key: 'applicant', width: 80 },
            { title: '时间', key: 'createTime', width: 140 },
            { title: '钉钉', key: 'dingtalkSent', width: 70, render: r => r.dingtalkSent ? U.tag('已推', 'green') : '<span class="muted">—</span>' }
          ], list, {
          actions: r => '<button class="btn btn-sm" data-view="' + r.id + '">查看/审批</button> ' +
            (r.status === '审批中' ? '<button class="btn btn-sm" data-push="' + r.id + '">推送钉钉</button>' : '')
        }) + '</div></div>';
        box.querySelector('[data-reload]').onclick = renderTab;
        box.querySelector('#pushAll').onclick = async () => {
          const r2 = await POST('/api/dingtalk/push', { types: ['合同到期', '欠费催收'] });
          UI.toast(r2.ok ? ('已推送 ' + r2.data.count + ' 条提醒') : (r2.msg || '推送失败'), r2.ok ? 'ok' : 'err');
        };
        box.querySelectorAll('[data-view]').forEach(b => b.onclick = () => ApprovalDetail(b.getAttribute('data-view'), renderTab));
        box.querySelectorAll('[data-push]').forEach(b => b.onclick = async () => {
          const r2 = await POST('/api/dingtalk/push', { type: 'approval', id: b.getAttribute('data-push') });
          UI.toast(r2.ok ? '已推送钉钉' : (r2.msg || '推送失败'), r2.ok ? 'ok' : 'err'); renderTab();
        });
      }

      async function renderDingtalk(box) {
        const cfg = await GET('/api/dingtalk/config');
        const msgs = await GET('/api/dingtalk/msgs');
        const c = cfg.data || {};
        box.innerHTML = '<div class="card"><div class="card-head"><h3>钉钉对接配置</h3><span class="spacer"></span>' +
          '<button class="btn btn-sm" id="dtTest">发送测试消息</button></div><div class="card-body">' +
          '<div class="mb12 muted">配置后：单据审批 / 合同审批可在钉钉内完成；到期提醒、欠费提醒、巡检工单提醒自动推送。<br>' +
          '当前模式：<b>' + (c.enabled ? (c.mode === 'live' ? '已启用（正式调用钉钉接口）' : '已启用（模拟模式）') : '未启用') + '</b></div>' +
          Form.html([
            { key: 'enabled', label: '启用钉钉对接', type: 'select', options: ['否', '是'], default: c.enabled ? '是' : '否' },
            { key: 'mode', label: '模式', type: 'select', options: ['mock', 'live'], default: c.mode || 'mock' },
            { key: 'appKey', label: 'AppKey', default: c.appKey || '' },
            { key: 'appSecret', label: 'AppSecret', default: c.appSecret || '', type: 'password' },
            { key: 'agentId', label: 'AgentId（微应用）', default: c.agentId || '' },
            { key: 'corpId', label: 'CorpId', default: c.corpId || '' },
            { key: 'apiBase', label: '接口地址', default: c.apiBase || 'https://api.dingtalk.com', span: 'full' },
            { key: 'pushExpire', label: '推送到期提醒', type: 'select', options: ['是', '否'], default: c.pushExpire === false ? '否' : '是' },
            { key: 'pushArrears', label: '推送欠费提醒', type: 'select', options: ['是', '否'], default: c.pushArrears === false ? '否' : '是' },
            { key: 'pushPatrol', label: '推送巡检工单', type: 'select', options: ['是', '否'], default: c.pushPatrol === false ? '否' : '是' },
            { key: 'expireDays', label: '到期提前天数', type: 'number', default: c.expireDays || 180 },
            { key: 'arrearsDays', label: '欠费提醒天数', type: 'number', default: c.arrearsDays || 10 }
          ], c) +
          '<div class="mt12"><button class="btn btn-primary" id="dtSave">保存配置</button></div>' +
          '<div class="mt12 muted">钉钉审批回调地址：<span class="mono">' + U.esc(c.approveCallback || '/api/dingtalk/callback') + '</span>（由钉钉侧调用回写审批结果）</div>' +
          '</div></div>' +
          '<div class="card mt12"><div class="card-head"><h3>消息推送记录</h3></div><div class="card-body tight">' +
          Table.render([{ title: '时间', key: 'createTime', width: 150 }, { title: '类型', key: 'msgType', width: 110 },
          { title: '标题', key: 'title' }, { title: '模式', key: 'mode', width: 70 },
          { title: '状态', key: 'status', width: 90, render: r => U.statusTag(r.status) },
          { title: '内容', key: 'content', render: r => '<span class="ellipsis">' + U.esc(r.content) + '</span>' }], msgs.data || []) +
          '</div></div>';
        box.querySelector('#dtSave').onclick = () => {
          const v = Form.read(box, [{ key: 'enabled' }, { key: 'mode' }, { key: 'appKey' }, { key: 'appSecret' }, { key: 'agentId' },
          { key: 'corpId' }, { key: 'apiBase' }, { key: 'pushExpire' }, { key: 'pushArrears' }, { key: 'pushPatrol' },
          { key: 'expireDays', type: 'number' }, { key: 'arrearsDays', type: 'number' }]);
          v.enabled = v.enabled === '是';
          v.pushExpire = v.pushExpire === '是'; v.pushArrears = v.pushArrears === '是'; v.pushPatrol = v.pushPatrol === '是';
          POST('/api/dingtalk/config', v).then(r => { UI.toast(r.ok ? '已保存' : r.msg, r.ok ? 'ok' : 'err'); renderDingtalk(box); });
        };
        box.querySelector('#dtTest').onclick = async () => {
          const r = await POST('/api/dingtalk/test', {});
          UI.toast(r.ok ? ('测试消息已处理（' + r.data.msg.status + '）') : r.msg, r.ok ? 'ok' : 'err'); renderDingtalk(box);
        };
      }

      await renderTab();
    }
  });

  /* ---------------- 合同模板比对 · 审批区块渲染 ----------------
   * 独立函数，供 ApprovalDetail 使用。
   * 三种状态都要显示清楚，不能让审批人误判：
   *   ① pending 比对中（可能正在跑 OCR）→ 通过按钮禁用
   *   ② enabled  有结论 → 得分横幅 + 逐条差异表，有差异时通过按钮禁用
   *   ③ none     未做比对（老合同没附件）→ 提示，但不阻断
   */
  function renderCompareBlock(a) {
    const cr = a.compareResult || null;
    const cs = a.compareState || {};

    // ① 比对中
    if (cs.pending === true) {
      return '<h4 class="mt12 mb8">合同模板比对</h4>' +
        '<div class="cmp-banner cmp-run" data-cmp-refresh="' + U.esc(a.id || '') + '">' +
        '<div class="cmp-score"><span class="cmp-num">…</span></div>' +
        '<div class="cmp-txt"><div class="cmp-t">模板比对进行中</div>' +
        '<div class="cmp-s">正在识别合同扫描件（图片/PDF 需 OCR，约需数秒）。比对完成前不可通过审批。</div></div>' +
        '<button class="btn btn-sm" data-cmp-refresh-btn="1">刷新状态</button></div>';
    }

    // ② 未做比对
    if (!cr || cr.enabled === false) {
      return '<h4 class="mt12 mb8">合同模板比对</h4>' +
        '<div class="cmp-banner cmp-none">' +
        '<div class="cmp-score"><span class="cmp-num">—</span></div>' +
        '<div class="cmp-txt"><div class="cmp-t">未做模板比对</div>' +
        '<div class="cmp-s">' + U.esc(cr ? (cr.verdictText || '未附合同扫描件') : '未附合同扫描件，未做模板比对') +
        '。如需核对，请让招商部在合同中上传扫描件。</div></div></div>';
    }

    // ③ 有结论
    const st = cr.stat || { total: 0, high: 0, medium: 0, low: 0 };
    const pass = cr.verdict === 'pass';
    const cls = pass ? 'cmp-pass' : (cr.verdict === 'needOcr' || cr.verdict === 'error' ? 'cmp-err' : 'cmp-reject');
    const ocr = cr.ocr || null;

    // 得分横幅
    let h = '<h4 class="mt12 mb8">合同模板比对</h4>' +
      '<div class="cmp-banner ' + cls + '">' +
      '<div class="cmp-score"><span class="cmp-num">' + (cr.score || 0) + '</span><span class="cmp-unit">/100</span></div>' +
      '<div class="cmp-txt"><div class="cmp-t">' + U.esc(cr.verdictText || '') + '</div>' +
      '<div class="cmp-s">比对文件：<b>' + U.esc(cr.fileName || '—') + '</b>' +
      (cr.engine ? '　识别方式：' + U.esc(ocr && ocr.engine ? 'OCR 识别（' + (ocr.pageCount || 1) + ' 页，平均置信度 ' + (ocr.avgConfidence || 0) + '%）' : cr.engine) : '') +
      (cr.at ? '　比对时间：' + U.esc(cr.at) : '') + '</div>' +
      '<div class="cmp-sev">差异共 <b>' + (st.total || 0) + '</b> 项：' +
      (st.high ? '<span class="s-high">严重 ' + st.high + '</span>' : '') +
      (st.medium ? '<span class="s-med">建议 ' + st.medium + '</span>' : '') +
      (st.low ? '<span class="s-low">提示 ' + st.low + '</span>' : '') +
      (st.total ? '' : '<span class="s-low">无差异</span>') +
      '</div></div></div>';

    // OCR 相关的额外提示（低置信度必须说清楚，否则审批人会去改本来正确的合同）
    const notes = [];
    if (ocr && ocr.lowConfCount) {
      notes.push('<div class="cmp-note warn">⚠ OCR 有 ' + ocr.lowConfCount + ' 行置信度偏低（&lt;80%），' +
        '下列差异若涉及金额/日期，请以纸质原件为准再判断</div>');
    }
    if (ocr && ocr.partial) {
      notes.push('<div class="cmp-note warn">⚠ PDF 部分页面识别失败，识别结果可能不完整</div>');
    }
    (cr.warn || []).slice(0, 3).forEach(w => {
      notes.push('<div class="cmp-note">' + U.esc(w) + '</div>');
    });
    if (cr.verdict === 'needOcr' || cr.verdict === 'error') {
      notes.push('<div class="cmp-note err">无法核对模板一致性，系统已阻止通过。' +
        '请让招商部上传 <b>清晰的 JPG/PNG</b> 或 <b>可复制文字的 PDF</b>，或配置腾讯云 OCR 凭据（TENCENT_SECRET_ID / TENCENT_SECRET_KEY）后重试。</div>');
    }
    if (notes.length) h += '<div class="cmp-notes">' + notes.join('') + '</div>';

    // 逐条差异明细 —— 用户要求「不一致的地方逐一指出」
    const diffs = cr.diffs || [];
    if (diffs.length) {
      // 按严重度分组，审批人先看必须改的
      const groups = [
        { k: 'high', t: '必须修改（严重差异）' },
        { k: 'medium', t: '建议修改' },
        { k: 'low', t: '提示项' }
      ];
      let n = 0;
      h += '<div class="cmp-diffs">';
      groups.forEach(g => {
        const items = diffs.filter(d => d.severity === g.k);
        if (!items.length) return;
        h += '<div class="cmp-grp"><div class="cmp-grp-t ' + g.k + '">' + g.t + '（' + items.length + '）</div>' +
          '<table class="cmp-tbl"><thead><tr>' +
          '<th style="width:34px">#</th><th style="width:82px">类别</th><th style="width:110px">项目</th>' +
          '<th>问题</th><th style="width:22%">模板/系统要求</th><th style="width:22%">上报件实际</th>' +
          '</tr></thead><tbody>';
        items.forEach(d => {
          n++;
          h += '<tr class="sev-' + d.severity + '">' +
            '<td class="idx">' + n + '</td>' +
            '<td><span class="sev-tag ' + d.severity + '">' + U.esc(d.severityText || d.severity) + '</span>' +
            '<div class="muted" style="font-size:11px">' + U.esc(d.typeText || d.type) + '</div></td>' +
            '<td>' + U.esc(d.label || '—') + '</td>' +
            '<td>' + U.esc(d.msg || '') +
            (d.hint ? '<div class="muted" style="font-size:11.5px;margin-top:2px">' + U.esc(d.hint) + '</div>' : '') +
            (d.evidence ? '<div class="muted" style="font-size:11px;margin-top:2px">📍' + U.esc(d.evidence) + '</div>' : '') +
            '</td>' +
            '<td class="expect">' + (d.expected ? U.esc(d.expected) : '<span class="muted">—</span>') + '</td>' +
            '<td class="actual">' + (d.actual ? U.esc(d.actual) : '<span class="muted">（未填写）</span>') + '</td>' +
            '</tr>';
        });
        h += '</tbody></table></div>';
      });
      h += '</div>';
    }

    // 强制通过留痕（已有人绕过过，要让后续审批人看到）
    if (a.compareOverride) {
      h += '<div class="cmp-note warn">已由 <b>' + U.esc(a.compareOverride.byName || '') + '</b>（' +
        U.esc(a.compareOverride.role || '') + '）于 ' + U.esc(a.compareOverride.at || '') +
        ' 强制通过。原判定：' + U.esc(a.compareOverride.origin || '') +
        '。理由：' + U.esc(a.compareOverride.reason || '') + '</div>';
    }
    return h;
  }

  window.ApprovalDetail = async function (id, done) {
    const r = await GET('/api/approval/' + id);
    const a = r.data;
    if (!a) return;
    const cr = a.compareResult || null;
    const cs = a.compareState || {};
    // 硬拦截的判定口径与后端 approvalCompare.verdictOf 保持一致：
    //   pending 比对中 / 有 high / 有 medium / needOcr / error  → 一律不可通过
    const cmpPending = cs.pending === true;
    const cmpBlock = cmpPending || (cr && cr.enabled !== false && !!cr.block);
    const canPass = !cmpBlock;
    const isContract = a.type === '合同审批';

    UI.open({
      title: '审批单：' + a.code, width: 'wide', okText: '关闭',
      body: '<div class="kv">' +
        '<div class="k">审批类型</div><div>' + U.esc(a.type) + '（' + (a.subTypes || []).join(' / ') + '）</div>' +
        '<div class="k">审批事项</div><div>' + U.esc(a.bizTitle) + '</div>' +
        '<div class="k">关联单号</div><div class="mono">' + U.esc(a.bizCode || '—') + '</div>' +
        '<div class="k">金额</div><div>¥' + U.money(a.amount) + '</div>' +
        '<div class="k">申请人</div><div>' + U.esc(a.applicant) + ' · ' + U.esc(a.createTime) + '</div>' +
        '<div class="k">当前状态</div><div>' + U.statusTag(a.status) + '</div>' +
        '</div>' +
        (isContract ? renderCompareBlock(a) : '') +
        '<h4 class="mt12 mb8">审批节点（多级审批）</h4><div class="step-flow">' +
        (a.steps || []).map(s => '<div class="step-node ' + (s.status === '待审批' ? 'active' : (s.status === '已通过' ? 'pass' : (s.status === '已驳回' ? 'reject' : ''))) + '">' +
          '<div class="n">' + U.esc(s.name) + '</div><div class="s">' + U.statusTag(s.status) + ' ' + U.esc(s.time || '') + '</div>' +
          '<div class="s">' + U.esc(s.comment || '') + '</div></div>').join('') + '</div>' +
        (a.status === '审批中' ? '<div class="mt12"><label class="fld">审批意见</label><textarea id="apCmt" placeholder="填写审批意见"></textarea>' +
          (cmpBlock ? '<div class="cmp-block-tip">' +
            (cmpPending
              ? '⏳ 模板比对尚未完成，暂不能通过。'
              : '⛔ 合同与标准模板存在差异，<b>不能通过</b>。请核对上方逐条差异：' +
                '<br>· 属于招商部填错 → 请<b>驳回</b>，让其修改后重新上报；' +
                '<br>· 确认差异无误（如已走线下审批） → 可由总经理填写「强制通过理由」后放行。') +
            '<div class="mt8"><label class="fld">强制通过理由（仅总经理可填，≥5 字，将永久留痕）</label>' +
            '<input id="apForce" placeholder="如：已与法务确认，差异属合同双方另行约定" ' + (cmpPending ? 'disabled' : '') + '></div></div>'
            : '') +
          '<div class="mt8"><button class="btn btn-success" data-ap="通过"' + (canPass ? '' : ' disabled title="存在模板差异，不能通过"') + '>通过</button> ' +
          '<button class="btn btn-danger" data-ap="驳回">驳回</button> ' +
          '<button class="btn" data-ap="push">推送钉钉</button>' +
          (cmpBlock ? '<span class="muted" style="margin-left:10px">「通过」已禁用：' + (cmpPending ? '比对进行中' : '与模板有差异') + '</span>' : '') +
          '</div></div>' : '') +
        '<h4 class="mt12 mb8">审批日志</h4>' +
        '<div class="timeline">' + (a.logs || []).map(x => '<div class="item"><div class="t">' + U.esc(x.time) + ' · ' + U.esc(x.user || '') + '（' + U.esc(x.source || '系统') + '）</div>' +
          '<div><b>' + U.esc(x.action) + '</b> ' + U.esc(x.comment || '') + '</div></div>').join('') + '</div>',
      onMount(mask) {
        // 强制通过开关：填了理由才放开「通过」按钮的禁用态
        const forceInput = mask.querySelector('#apForce');
        const passBtn = mask.querySelector('[data-ap="通过"]');
        if (forceInput && passBtn) {
          forceInput.oninput = () => {
            const s = String(forceInput.value || '').trim();
            passBtn.disabled = !(s.length >= 5);
            passBtn.title = s.length >= 5 ? '将连同理由一起留痕' : '强制通过理由需至少 5 个字';
          };
        }
        // 比对中：轮询刷新（OCR 可能要几秒）
        const refresh = mask.querySelector('[data-cmp-refresh-btn]');
        if (refresh) {
          const reload = async () => {
            const r2 = await GET('/api/approval/' + id);
            if (r2.data && r2.data.compareState && !r2.data.compareState.pending) {
              UI.close(mask); window.ApprovalDetail(id, done);
            }
          };
          refresh.onclick = reload;
          if (cmpPending) {
            let n = 0;
            const t = setInterval(() => { if (++n > 20) return clearInterval(t); reload(); }, 3000);
            mask.addEventListener('DOMNodeRemoved', () => clearInterval(t));
          }
        }
        mask.querySelectorAll('[data-ap]').forEach(b => {
          b.onclick = async () => {
            const act = b.getAttribute('data-ap');
            if (act === 'push') {
              const r2 = await POST('/api/dingtalk/push', { type: 'approval', id: id });
              UI.toast(r2.ok ? '已推送' : r2.msg, r2.ok ? 'ok' : 'err'); return;
            }
            const body = { action: act, comment: mask.querySelector('#apCmt') ? mask.querySelector('#apCmt').value : '' };
            // 前端禁用只是第一道；后端还会再校验一次（防止绕过）
            if (act === '通过' && passBtn && passBtn.disabled) {
              const fr = forceInput ? String(forceInput.value || '').trim() : '';
              if (fr.length >= 5) body.force = true, body.forceReason = fr;
              else return UI.toast('存在模板差异，强制通过需先填写至少 5 个字的理由', 'err');
            }
            const r2 = await POST('/api/approval/' + id + '/approve', body);
            UI.toast(r2.ok ? ('已' + act) : r2.msg, r2.ok ? 'ok' : 'err');
            if (r2.ok) { UI.close(mask); if (done) done(); }
            // 失败时不关弹窗：用户要看到原因并继续操作（填理由 / 驳回）
          };
        });
      },
      onOk() { }
    });
  };

  /* ============ 工单巡检 ============ */
  App.view('workorder', {
    title: '工单巡检',
    async render(el) {
      const projects = await Cache.projects();
      const st = await GET('/api/ops/workorder-stats');
      const v = CrudView({
        title: '工单巡检', name: '工单', api: '/api/ops/workorders', size: 20, formWidth: 'wide', bizType: 'workorder',
        filters: [
          { key: 'projectId', label: '项目', type: 'select', options: projects.map(p => ({ value: p.id, text: p.name })) },
          { key: 'type', label: '类型', type: 'select', options: ['维修工单', '巡检工单', '抄表工单', '消防巡检', '空调巡检'] },
          { key: 'status', label: '状态', type: 'select', options: ['待处理', '处理中', '已完成', '已关闭'] }
        ],
        columns: [
          { title: '工单号', key: 'code', render: r => '<b class="mono">' + U.esc(r.code) + '</b>' },
          { title: '类型', key: 'type', width: 90, render: r => U.tag(r.type, r.category === '消防' ? 'red' : (r.category === '空调' ? 'cyan' : '')) },
          { title: '标题', key: 'title', width: 220 },
          { title: '项目', key: 'projectName', width: 90 },
          { title: '房号', key: 'roomCode', width: 150, render: r => '<span class="muted">' + U.esc(r.roomCode) + '</span>' },
          { title: '优先级', key: 'priority', width: 70, render: r => U.tag(r.priority, r.priority === '紧急' ? 'red' : '') },
          { title: '负责人', key: 'assignee', width: 80 },
          { title: '计划日期', key: 'planDate', width: 100 },
          { title: '状态', key: 'status', width: 80, render: r => U.statusTag(r.status) },
          { title: '重点', key: 'focus', width: 60, render: r => r.focus ? U.tag('重点', 'orange') : '—' },
          { title: '照片', key: 'photoCount', width: 60, render: r => r.photoCount ? '📷 ' + r.photoCount : '—' }
        ],
        actionWidth: 160,
        actions: r => (r.status !== '已完成' && r.status !== '已关闭' ? '<button class="btn btn-sm btn-success" data-act2="finish">完成</button> ' : '') +
          '<button class="btn btn-sm" data-act2="detail">详情</button> <button class="btn btn-sm" data-act2="edit">编辑</button>',
        rowActions: {
          edit(row, done) { v.cfg._openForm(row, done); },
          async detail(row) {
            UI.drawer('工单详情：' + row.code,
              '<div class="kv">' +
              '<div class="k">类型</div><div>' + U.esc(row.type) + '</div>' +
              '<div class="k">标题</div><div>' + U.esc(row.title) + '</div>' +
              '<div class="k">房号</div><div>' + U.esc(row.roomCode) + '</div>' +
              '<div class="k">现场情况</div><div>' + U.esc(row.content || '—') + '</div>' +
              '<div class="k">处理结果</div><div>' + U.esc(row.result || '—') + '</div>' +
              '<div class="k">负责人</div><div>' + U.esc(row.assignee || '—') + '</div>' +
              '<div class="k">计划/完成</div><div>' + U.esc(row.planDate || '—') + ' / ' + U.esc(row.finishDate || '—') + '</div>' +
              '<div class="k">状态</div><div>' + U.statusTag(row.status) + '</div>' +
              '</div>' +
              '<h4 class="mt12 mb8">现场照片</h4>' +
              ((row.photos || []).length ? '<div class="photo-grid">' + row.photos.map(p => '<div class="p"><img src="' + U.esc(p.url) + '" alt=""></div>').join('') + '</div>'
                : '<div class="muted">未上传照片</div>')
            );
          },
          finish(row, done) { FinishWorkorder(row, done); }
        },
        buttons: [
          { key: 'daily', label: '生成日常巡检', cls: 'btn-primary', onClick: () => GenPatrol('daily') },
          { key: 'monthly', label: '生成月度巡检', onClick: () => GenPatrol('monthly') },
          { key: 'meter', label: '生成抄表任务', onClick: () => GenPatrol('meter') },
          { key: 'contract', label: '生成合同履约复核', onClick: () => GenPatrol('contract') }
        ],
        fields: [
          { key: 'type', label: '工单类型', type: 'select', options: ['维修工单', '巡检工单', '抄表工单', '消防巡检', '空调巡检'], default: '维修工单', required: true },
          { key: 'title', label: '工单标题', required: true },
          { key: 'projectId', label: '项目', type: 'select', options: projects.map(p => ({ value: p.id, text: p.name })) },
          { key: 'roomCode', label: '房号' },
          { key: 'priority', label: '优先级', type: 'select', options: ['普通', '紧急'], default: '普通' },
          { key: 'assignee', label: '负责人', default: '陈工程' },
          { key: 'planDate', label: '计划日期', type: 'date', default: U.today() },
          { key: 'content', label: '现场情况', span: 'full', type: 'textarea' },
          { key: 'photos', label: '现场照片', type: 'files', span: 'full' }
        ]
      });
      await v.render(el);
      const s = st.data || {};
      el.insertAdjacentHTML('afterbegin',
        '<div class="stat-grid mb12">' +
        '<div class="stat blue"><span class="bar"></span><div class="k">工单总数</div><div class="v">' + (s.total || 0) + '</div></div>' +
        '<div class="stat red"><span class="bar"></span><div class="k">待处理</div><div class="v">' + ((s.byStatus || {})['待处理'] || 0) + '</div></div>' +
        '<div class="stat orange"><span class="bar"></span><div class="k">处理中</div><div class="v">' + ((s.byStatus || {})['处理中'] || 0) + '</div></div>' +
        '<div class="stat green"><span class="bar"></span><div class="k">已完成</div><div class="v">' + ((s.byStatus || {})['已完成'] || 0) + '</div></div>' +
        '<div class="stat purple"><span class="bar"></span><div class="k">重点标记</div><div class="v">' + (s.focus || 0) + '</div></div>' +
        '<div class="stat cyan"><span class="bar"></span><div class="k">超期未完成</div><div class="v">' + (s.overdue || 0) + '</div></div>' +
        '</div>');
    }
  });

  window.FinishWorkorder = function (row, done) {
    UI.open({
      title: '完成工单：' + row.code, width: 'wide',
      body: '<div class="mb8 muted">记录现场情况与处理结果，可拍照上传。</div>' +
        Form.html([
          { key: 'status', label: '完成状态', type: 'select', options: ['已完成', '已关闭'], default: '已完成' },
          { key: 'finishDate', label: '完成日期', type: 'date', default: U.today() },
          { key: 'result', label: '处理结果', span: 'full', type: 'textarea', required: true },
          { key: 'photos', label: '现场照片', type: 'files', span: 'full', default: row.photos || [] }
        ], row),
      onMount(m) { Form.bind(m, [{ key: 'photos', type: 'files' }], 'workorder'); },
      onOk(m) {
        const v = Form.read(m, [{ key: 'status' }, { key: 'finishDate' }, { key: 'result' }, { key: 'photos', type: 'files' }]);
        if (!v.result) { UI.toast('请填写处理结果', 'err'); return false; }
        return POST('/api/ops/workorders/' + row.id + '/finish', v).then(() => { UI.toast('已完成', 'ok'); Cache.bust(); if (done) done(); });
      }
    });
  };

  window.GenPatrol = async function (kind) {
    const projects = await Cache.projects();
    const nameMap = { daily: '日常巡检（每日）', monthly: '月度巡检', meter: '月度抄表任务', contract: '合同履约复核' };
    UI.open({
      title: '生成' + nameMap[kind],
      body: '<div class="muted mb12">' +
        (kind === 'daily' ? '为中央空调楼层生成每日白班巡检，为消防楼层生成重点巡检（紧急）。' :
          kind === 'monthly' ? '生成月度综合巡检任务（中央空调 + 消防楼层）。' :
            kind === 'meter' ? '按楼栋楼层聚合成抄表工单，覆盖全部已租房间。' :
              '为 3 个月内到期的合同生成履约复核工单。') + '</div>' +
        Form.html([
          { key: 'projectId', label: '项目', type: 'select', options: [{ value: '', text: '全部项目' }].concat(projects.map(p => ({ value: p.id, text: p.name }))) },
          { key: 'date', label: '计划日期', type: 'date', default: U.today() },
          { key: 'assignee', label: '负责人', default: kind === 'contract' ? '王客服' : '陈工程' },
          { key: 'months', label: '复核月数（仅合同复核）', type: 'number', default: 3 }
        ], {}),
      onOk(m) {
        const v = Form.read(m, [{ key: 'projectId' }, { key: 'date' }, { key: 'assignee' }, { key: 'months', type: 'number' }]);
        return POST('/api/ops/workorders/generate', Object.assign({ kind: kind }, v)).then(r => {
          if (!r.ok) { UI.toast(r.msg, 'err'); return false; }
          UI.toast('已生成 ' + r.data.created + ' 条工单', 'ok'); setTimeout(() => App.render(), 400);
        });
      }
    });
  };

  /* ============ 报表统计 ============ */
  App.view('report', {
    title: '报表统计与导出',
    async render(el) {
      const exports = [
        { name: '房源统计表', url: '/api/report/export/rooms', desc: '项目/楼栋/楼层/房号/面积/产权证/配套/客户', icon: '🏢' },
        { name: '客户台账', url: '/api/report/export/customers', desc: '客户资料 + 通讯地址 + 在租房源 + 欠费', icon: '👥' },
        { name: '收费台账', url: '/api/report/export/bills', desc: '账单明细，费用项拆分（数量/单价/金额/税率/税额）', icon: '💰' },
        { name: '合同清单', url: '/api/report/export/contracts', desc: '全部合同要素，含租期/免租期/押金/状态', icon: '📄' },
        { name: '出租明细', url: '/api/report/export/rent-detail', desc: '在租房源出租单报表', icon: '📊' },
        { name: '发票台账', url: '/api/report/export/invoices', desc: '按类型/内容/月份统计开票记录', icon: '🧾' },
        { name: '收款明细', url: '/api/report/export/payments', desc: '每日/每月收款流水', icon: '💵' },
        { name: '押金台账', url: '/api/report/export/deposits', desc: '押金收取、退回、扣款跟踪', icon: '🔐' }
      ];
      let h = '<div class="card"><div class="card-head"><h3>报表导出（支持 CSV / Excel，批量几千条）</h3></div><div class="card-body">' +
        '<div class="grid4">' + exports.map(e =>
          '<div class="card" style="margin:0"><div class="card-body">' +
          '<div style="font-size:22px">' + e.icon + '</div>' +
          '<div class="b mt8">' + U.esc(e.name) + '</div>' +
          '<div class="muted mb8" style="font-size:12px;min-height:34px">' + U.esc(e.desc) + '</div>' +
          '<button class="btn btn-sm" data-exp="' + e.url + '&format=csv">CSV</button> ' +
          '<button class="btn btn-sm btn-primary" data-exp="' + e.url + '&format=xls">Excel</button>' +
          '</div></div>').join('') + '</div></div></div>';

      const price = await GET('/api/report/price');
      h += '<div class="card mt12"><div class="card-head"><h3>各项目平均单价（含税 / 不含税）</h3></div><div class="card-body tight">' +
        Table.render([{ title: '项目', key: 'projectName' }, { title: '在租合同', key: 'count', num: true },
        { title: '平均单价（含税）', key: 'avgTaxIncluded', num: true }, { title: '平均单价（不含税）', key: 'avgTaxExcluded', num: true },
        { title: '综合均价', key: 'avgAll', num: true }, { title: '最低价', key: 'minPrice', num: true }, { title: '最高价', key: 'maxPrice', num: true },
        { title: '在租面积(㎡)', key: 'area', num: true }, { title: '月租金合计', key: 'monthly', num: true }], price.data || []) +
        '</div></div>';

      const vacant = await GET('/api/report/vacant');
      h += '<div class="card mt12"><div class="card-head"><h3>空置房间统计</h3><span class="spacer"></span>' +
        '<span class="muted">共 ' + ((vacant.data || {}).total || 0) + ' 间 / ' + U.money((vacant.data || {}).area) + ' ㎡</span></div>' +
        '<div class="card-body tight">' +
        Table.render([{ title: '房源编码', key: 'code' }, { title: '项目', key: 'projectName' }, { title: '楼栋', key: 'buildingName' },
        { title: '楼层', key: 'floorLabel' }, { title: '面积(㎡)', key: 'area', num: true }, { title: '业态', key: 'bizType' },
        { title: '楼层类型', key: 'level' }, { title: '配套', key: 'facilities' }], ((vacant.data || {}).list || []).slice(0, 100)) +
        '</div></div>';

      el.innerHTML = h;
      el.querySelectorAll('[data-exp]').forEach(b => b.onclick = () => {
        window.open(b.getAttribute('data-exp'), '_blank');
        UI.toast('已开始导出，请查看下载');
      });
    }
  });

  /* ============ 系统设置 ============ */
  App.view('system', {
    title: '系统设置',
    async render(el) {
      const tabs = [{ key: 'log', name: '操作日志' }, { key: 'online', name: '在线会话' }, { key: 'file', name: '附件' }, { key: 'migrate', name: '旧系统迁移' }, { key: 'set', name: '业务规则' }, { key: 'about', name: '系统概况' }];
      let cur = 'log';
      el.innerHTML = '<div class="tabs">' + tabs.map(t => '<div class="tab' + (t.key === cur ? ' active' : '') + '" data-tab="' + t.key + '">' + t.name + '</div>').join('') +
        '</div><div id="stBody"></div>';
      el.querySelectorAll('[data-tab]').forEach(t => {
        t.onclick = () => { el.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('active')); t.classList.add('active'); cur = t.getAttribute('data-tab'); renderTab(); };
      });
      async function renderTab() {
        const box = el.querySelector('#stBody');
        box.innerHTML = '';
        if (cur === 'log') {
          const r = await GET('/api/system/logs?size=100');
          const d = r.data || {};
          box.innerHTML = '<div class="card"><div class="card-head"><h3>操作日志（所有修改留痕）</h3><span class="spacer"></span>' +
            '<input type="text" id="logKw" placeholder="搜索关键字/单号" style="width:180px">' +
            '<select id="logMod" style="width:auto"><option value="">全部模块</option>' +
            ['房源管理', '合同管理', '客户档案', '收费管理', '发票管理', '审批流程', '工单巡检', '系统设置', '认证', '钉钉'].map(m => '<option>' + m + '</option>').join('') +
            '</select></div><div class="card-body tight" id="logBox">' +
            Table.render([{ title: '时间', key: 'time', width: 150 }, { title: '操作人', key: 'userName', width: 90 },
            { title: '模块', key: 'module', width: 90 }, { title: '动作', key: 'action', width: 110 },
            { title: '业务单号', key: 'bizCode', width: 140 }, { title: '详情', key: 'detail' }], d.list || []) +
            '</div></div>';
          const reload = async () => {
            const kw = box.querySelector('#logKw').value, mod = box.querySelector('#logMod').value;
            const r2 = await GET('/api/system/logs?size=100&keyword=' + encodeURIComponent(kw) + '&module=' + encodeURIComponent(mod));
            box.querySelector('#logBox').innerHTML = Table.render([{ title: '时间', key: 'time', width: 150 }, { title: '操作人', key: 'userName', width: 90 },
            { title: '模块', key: 'module', width: 90 }, { title: '动作', key: 'action', width: 110 },
            { title: '业务单号', key: 'bizCode', width: 140 }, { title: '详情', key: 'detail' }], (r2.data || {}).list || []);
          };
          box.querySelector('#logKw').onkeydown = e => { if (e.key === 'Enter') reload(); };
          box.querySelector('#logMod').onchange = reload;
        } else if (cur === 'online') {
          box.innerHTML = '<div class="card"><div class="card-head"><h3>在线会话（多电脑部署）</h3><span class="spacer"></span>' +
            '<button class="btn btn-sm" id="onlReload">刷新</button></div><div class="card-body" id="onlBox">' +
            '<div class="muted">加载中…</div></div></div>';
          const draw = list => {
            const rows = (list || []).map(s => ({
              userName: s.userName,
              username: s.username,
              deviceCount: s.deviceCount || 1,
              devices: (s.devices || []).map(d =>
                '<div>' + U.esc(d.ip || '未知IP') + '　<span class="muted">' + U.esc(String(d.loginTime || '').replace('T', ' ').slice(0, 19)) + '</span></div>'
              ).join(''),
              loginTime: String(s.loginTime || '').replace('T', ' ').slice(0, 19),
              expireAt: String(s.expireAt || '').replace('T', ' ').slice(0, 19),
              _id: s.userId
            }));
            const me = App.user && App.user.id;
            return '<div class="muted mb8">当前在线 <b>' + rows.length + '</b> 人 / 共 ' +
              rows.reduce((n, r) => n + r.deviceCount, 0) + ' 个会话。同一账号可在多台电脑同时登录；' +
              '登录状态保存在服务端数据目录，服务重启后不掉线，24 小时后自动失效。</div>' +
              Table.render([
                { title: '姓名', key: 'userName', width: 90 },
                { title: '账号', key: 'username', width: 100 },
                { title: '设备数', key: 'deviceCount', width: 80, num: true },
                { title: '登录客户端（IP / 登录时间）', key: 'devices' },
                { title: '最近登录', key: 'loginTime', width: 160 },
                { title: '过期时间', key: 'expireAt', width: 160 },
                {
                  title: '操作', key: '_op', width: 110, render: r => r._id === me
                    ? '<span class="muted">当前账号</span>'
                    : '<button class="btn btn-sm" data-kick="' + U.esc(r._id) + '">全部下线</button>'
                }
              ], rows);
          };
          const load = async () => {
            const r = await GET('/api/auth/online');
            if (!r.ok) { box.querySelector('#onlBox').innerHTML = '<div class="muted">无权限查看在线会话</div>'; return; }
            box.querySelector('#onlBox').innerHTML = draw(r.data);
            box.querySelectorAll('[data-kick]').forEach(btn => {
              btn.onclick = () => {
                UI.open({
                  title: '强制下线', width: 'sm',
                  body: '<div class="muted">确定要让该账号在所有电脑上退出登录？其未保存的编辑内容会丢失。</div>',
                  okText: '确定下线', onOk: async () => {
                    const rr = await POST('/api/auth/online/kick', { userId: btn.getAttribute('data-kick') });
                    if (rr.ok) { UI.toast('已强制下线 ' + rr.data + ' 个会话', 'ok'); load(); }
                    else UI.toast(rr.msg || '操作失败', 'err');
                  }
                });
              };
            });
          };
          box.querySelector('#onlReload').onclick = load;
          load();
        } else if (cur === 'file') {
          const r = await GET('/api/system/attachments');
          const rows = r.data || [];
          box.innerHTML = '<div class="card"><div class="card-head"><h3>附件管理</h3><span class="spacer"></span>' +
            '<button class="btn btn-sm" id="upFile">上传附件</button></div><div class="card-body">' +
            '<div class="muted mb8">合同扫描件、身份证、营业执照、现场巡检照片、CAD 图纸统一存储。</div>' +
            Table.render([{ title: '文件名', key: 'name' }, { title: '业务类型', key: 'bizType', width: 100 },
            { title: '大小(KB)', key: 'size', width: 90, num: true }, { title: '上传人', key: 'by', width: 90 },
            { title: '时间', key: 'time', width: 150 },
            {
              title: '操作', key: 'url', width: 130, render: x =>
                '<a class="btn btn-sm" href="' + U.esc(x.url) + '" target="_blank">查看</a> ' +
                '<button class="btn btn-sm btn-danger" data-del="' + U.esc(x.id) + '">删除</button>'
            }], rows) +
            '</div></div>';
          // 删除：云端对象与本地镜像由后端一并清掉，前端只负责确认
          box.querySelectorAll('[data-del]').forEach(b => {
            b.onclick = async () => {
              const id = b.getAttribute('data-del');
              const rec = rows.filter(x => String(x.id) === String(id))[0] || {};
              const yes = await UI.confirm(
                '确定删除附件「' + (rec.name || id) + '」吗？\n\n云端对象与服务器本地镜像会一并删除，不可恢复。', '删除确认');
              if (!yes) return;
              const rr = await DEL('/api/system/attachments/' + encodeURIComponent(id));
              UI.toast(rr.ok ? '已删除' : (rr.msg || '删除失败'), rr.ok ? 'ok' : 'err');
              if (rr.ok) renderTab();
            };
          });
          box.querySelector('#upFile').onclick = () => {
            const inp = document.createElement('input');
            inp.type = 'file'; inp.multiple = true;
            inp.onchange = async () => {
              for (const f of Array.from(inp.files)) {
                const d = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f); });
                await POST('/api/system/upload', { fileName: f.name, dataBase64: d, bizType: '其他' });
              }
              UI.toast('上传完成', 'ok'); renderTab();
            };
            inp.click();
          };
        } else if (cur === 'migrate') {
          box.innerHTML = '<div class="grid2">' +
            '<div class="card"><div class="card-head"><h3>导入房间（旧系统）</h3></div><div class="card-body">' +
            '<div class="muted mb8">列名：projectName,buildingName,floor,roomNo,area,bizType,status,propertyCert,ownerName</div>' +
            '<textarea id="impRooms" style="min-height:180px" placeholder="成功新时代,10栋,3A,01,120,办公,空置,鄂(2020)武汉市不动产权第1号,湖北成功置业"></textarea>' +
            '<div class="mt8"><button class="btn btn-primary" id="doRooms">导入房间</button></div></div></div>' +
            '<div class="card"><div class="card-head"><h3>导入抄表读数（数据校验）</h3></div><div class="card-body">' +
            '<div class="muted mb8">列名：meterNo,date,value；与系统已有读数不一致时会列出差异供人工二次核对。</div>' +
            '<textarea id="impRead" style="min-height:180px" placeholder="DB123456,2026-09-05,12345"></textarea>' +
            '<div class="mt8"><button class="btn btn-primary" id="doRead">导入并校验</button></div></div></div>' +
            '</div>' +
            '<div class="card mt12"><div class="card-head"><h3>数据核对（房间用电 / 电表读数）</h3><span class="spacer"></span>' +
            '<button class="btn btn-sm" id="doVerify">开始核对</button></div><div class="card-body" id="verifyBox"><span class="muted">点击“开始核对”检查本期抄表异常</span></div></div>';
          const parse = t => t.split('\n').map(s => s.trim()).filter(Boolean).map(l => {
            const p = l.split(/[,，\t]/);
            return { projectName: p[0], buildingName: p[1], floor: p[2], roomNo: p[3], area: U.num(p[4]), bizType: p[5], status: p[6], propertyCert: p[7], ownerName: p[8] };
          });
          box.querySelector('#doRooms').onclick = async () => {
            const rows = parse(box.querySelector('#impRooms').value);
            const r = await POST('/api/system/import/rooms', { rows: rows });
            UI.toast('新增 ' + r.data.created + '，更新 ' + r.data.updated + '，失败 ' + r.data.errors.length, r.ok ? 'ok' : 'err');
            if (r.data.errors.length) console.log(r.data.errors);
            Cache.bust();
          };
          box.querySelector('#doRead').onclick = async () => {
            const rows = box.querySelector('#impRead').value.split('\n').map(s => s.trim()).filter(Boolean).map(l => {
              const p = l.split(/[,，\t]/); return { meterNo: p[0], date: p[1], value: U.num(p[2]) };
            });
            const r = await POST('/api/system/import/readings', { rows: rows });
            UI.toast('新增 ' + r.data.created + '，差异 ' + r.data.mismatch.length, 'ok');
            if (r.data.mismatch.length) {
              UI.open({
                title: '读数差异明细（人工二次核对）', width: 'wide', hideCancel: true,
                body: Table.render([{ title: '表号', key: 'meterNo' }, { title: '账期', key: 'period' },
                { title: '系统读数', key: 'system', num: true }, { title: '导入读数', key: 'imported', num: true },
                { title: '差异', key: 'diff', num: true }], r.data.mismatch)
              });
            }
          };
          box.querySelector('#doVerify').onclick = async () => {
            const r = await GET('/api/system/verify?period=' + U.month());
            box.querySelector('#verifyBox').innerHTML = r.data.count
              ? Table.render([{ title: '表号', key: 'meterNo' }, { title: '房号', key: 'roomCode' }, { title: '问题', key: 'issue' }], r.data.issues)
              : '<span style="color:var(--success)">本期抄表数据核对通过，未发现异常</span>';
          };
        } else if (cur === 'set') {
          const r = await GET('/api/system/settings?key=biz');
          const s = r.data || {};
          box.innerHTML = '<div class="card"><div class="card-head"><h3>业务规则</h3></div><div class="card-body">' +
            Form.html([
              { key: 'expireWarnMonths', label: '合同到期预警（月）', type: 'number', default: s.expireWarnMonths || 6 },
              { key: 'expireWarnDays', label: '约定提前提醒（天）', type: 'number', default: s.expireWarnDays || 10 },
              { key: 'recheckMonths', label: '合同复核周期（月）', type: 'number', default: s.recheckMonths || 3 },
              { key: 'vacantElectricMin', label: '空置房基础电费下限（元）', type: 'number', default: s.vacantElectricMin || 5 },
              { key: 'vacantElectricMax', label: '空置房基础电费上限（元）', type: 'number', default: s.vacantElectricMax || 10 },
              { key: 'meterCycle', label: '抄表频次', type: 'select', options: ['每月一次', '每两月一次', '每季度一次'], default: s.meterCycle || '每月一次' },
              { key: 'defaultTemplate', label: '默认发票模板', type: 'select', options: ['模板1', '模板2', '模板3', '模板4'], default: s.defaultTemplate || '模板1' }
            ], s) +
            '<div class="mt12"><button class="btn btn-primary" id="saveBiz">保存</button> ' +
            '<button class="btn" id="refreshRemind">重新生成提醒</button></div>' +
            '<div class="mt12 muted">提醒规则：合同到期前 3~6 个月预警 → 提前一个星期提醒 → 提前一天再次提醒。</div>' +
            '</div></div>';
          box.querySelector('#saveBiz').onclick = () => {
            const v = Form.read(box, [{ key: 'expireWarnMonths', type: 'number' }, { key: 'expireWarnDays', type: 'number' },
            { key: 'recheckMonths', type: 'number' }, { key: 'vacantElectricMin', type: 'number' }, { key: 'vacantElectricMax', type: 'number' },
            { key: 'meterCycle' }, { key: 'defaultTemplate' }]);
            POST('/api/system/settings', Object.assign({ id: s.id, key: 'biz', name: '业务规则' }, v))
              .then(() => UI.toast('已保存', 'ok'));
          };
          box.querySelector('#refreshRemind').onclick = async () => {
            const r2 = await POST('/api/reminders/refresh', {});
            UI.toast('已生成 ' + r2.data.count + ' 条提醒', 'ok');
          };
        } else {
          const r = await GET('/api/system/stats');
          const d = r.data || {};
          // 字节数转人话；附件主存储是七牛还是本机、本地镜像占了多少，运维要一眼看到
          const mb = b => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB');
          const mir = d.mirror;
          const mirTxt = mir
            ? (mir.dir + '（' + mir.files + ' 个文件 / ' + mb(mir.bytes) + (mir.exists ? '' : '，目录尚未创建') + '）')
            : '未启用（设 ATT_MIRROR_DIR 后新上传自动双写）';
          box.innerHTML = '<div class="card"><div class="card-head"><h3>系统概况</h3><span class="spacer"></span>' +
            '<button class="btn btn-sm" id="doBackup">立即备份数据</button></div><div class="card-body">' +
            '<div class="kv"><div class="k">数据目录</div><div class="mono">' + U.esc(d.dbPath || '') + '</div>' +
            '<div class="k">附件目录</div><div class="mono">' + U.esc(d.uploadDir || '') + '</div>' +
            '<div class="k">附件主存储</div><div class="mono">' + U.esc(d.attachmentStorage === 'qiniu' ? '七牛云 Kodo' : '本机 uploads/') + '</div>' +
            '<div class="k">附件本地镜像</div><div class="mono">' + U.esc(mirTxt) + '</div></div>' +
            '<h4 class="mt12 mb8">数据集合统计</h4>' +
            Table.render([{ title: '集合', key: 'k' }, { title: '记录数', key: 'v', num: true }],
              Object.keys(d.collections || {}).map(k => ({ k: k, v: d.collections[k] }))) +
            '</div></div>' +
            '<div class="card mt12"><div class="card-head"><h3>使用说明</h3></div><div class="card-body" style="font-size:13px;line-height:2">' +
            '1. 本系统为 <b>零依赖本地部署</b>，无需安装数据库，数据以 JSON 文件保存在 data 目录，可用“立即备份数据”随时备份。<br>' +
            '2. 移动端访问 <b>/m.html</b>，支持夜班人员手机录入巡检信息与抄表。<br>' +
            '3. 岗位权限隔离：招商（合同/房源）、财务（收费/发票）、客服（催收/工单）、工程（巡检/抄表）各看各的业务数据。<br>' +
            '4. 合同审批 2 级：招商经理（价格）→ 财务经理（租金），免租期 ≥ 2 个月追加总经理（免租期）审批。<br>' +
            '5. 钉钉对接在“审批流程 → 钉钉对接”中配置 AppKey / AppSecret 后即可在钉钉内审批与接收提醒。' +
            '</div></div>';
          box.querySelector('#doBackup').onclick = async () => {
            const r2 = await POST('/api/system/backup', {});
            UI.toast(r2.ok ? ('备份完成：' + r2.data.files + ' 个文件') : r2.msg, r2.ok ? 'ok' : 'err');
          };
        }
      }
      await renderTab();
    }
  });

})();
