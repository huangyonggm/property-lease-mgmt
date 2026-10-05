'use strict';
/* 合同模板比对 —— 把招商部上报的合同与标准模板 / 系统数据逐项核对并标红
 *
 * 三个界面：
 *   ContractCompareUpload   上传比对（选合同 + 传文件 → 出差异清单）
 *   ContractCompareLedger   全部比对记录台账
 *   ContractCompareTemplate 标准模板清单（给业务方对照"该长什么样"）
 *
 * 后端：routes/contractcmp.js；引擎：lib/contractCompare.js
 */
(function () {
  const { UI, Table, App, U, GET, POST } = window;

  function canManage() {
    try {
      const u = App.user || {};
      if (u.isAdmin) return true;
      return (u.perms || []).indexOf('contract:manage') >= 0;
    } catch (e) { return false; }
  }

  const SEV = {
    high: { label: '严重', color: 'red', icon: '✕' },
    medium: { label: '中等', color: 'orange', icon: '!' },
    low: { label: '提示', color: 'gray', icon: 'i' }
  };
  const VERDICT = {
    pass: { label: '通过', tag: 'green', text: '与标准模板一致' },
    review: { label: '需复核', tag: 'orange', text: '有中等差异，建议人工确认' },
    reject: { label: '不通过', tag: 'red', text: '存在严重差异，必须整改' },
    needOcr: { label: '需OCR', tag: 'cyan', text: '图片/扫描件无文本层，需先做文字识别' }
  };

  /* ---------------- 差异详情弹窗 ---------------- */
  function diffDetail(r) {
    const rows = (r.diffs || []).map(d => {
      const s = SEV[d.severity] || SEV.low;
      return {
        sev: '<span class="tag ' + s.color + '">' + s.icon + ' ' + s.label + '</span>',
        type: d.type,
        label: U.esc(d.label || ''),
        msg: U.esc(d.msg || ''),
        exp: U.esc(d.expected === undefined ? '-' : String(d.expected)),
        act: U.esc(d.actual === undefined ? '-' : String(d.actual)),
        ev: d.evidence ? '<span class="muted" style="font-size:11px">' + U.esc(String(d.evidence).slice(0, 100)) + '</span>' : ''
      };
    });
    const v = VERDICT[r.verdict] || VERDICT.review;
    const body =
      '<div style="padding:4px 2px 12px">' +
      '<div style="display:flex;gap:14px;align-items:center;margin-bottom:10px;flex-wrap:wrap">' +
      '<span class="tag ' + v.tag + '" style="font-size:13px;padding:4px 10px">' + v.label + '</span>' +
      '<span style="font-size:20px;font-weight:700;color:' +
      (r.score >= 90 ? 'var(--success)' : r.score >= 60 ? 'var(--warning)' : 'var(--danger)') + '">' +
      r.score + '</span><span class="muted">/ 100 分</span>' +
      '<span class="muted">' + v.text + '</span>' +
      '</div>' +
      '<div style="display:flex;gap:14px;font-size:12px;margin-bottom:10px" class="muted">' +
      '<span>严重 <b style="color:var(--danger)">' + (r.stat ? r.stat.high : 0) + '</b></span>' +
      '<span>中等 <b style="color:var(--warning)">' + (r.stat ? r.stat.medium : 0) + '</b></span>' +
      '<span>提示 <b>' + (r.stat ? r.stat.low : 0) + '</b></span>' +
      '<span>共 ' + (r.stat ? r.stat.total : 0) + ' 项</span>' +
      '<span>识别 ' + (r.kind || '') + ' / ' + (r.paraCount || 0) + ' 段 / ' + (r.docChars || 0) + ' 字</span>' +
      '</div>' +
      (r.warn && r.warn.length ? '<div class="muted" style="font-size:12px;margin-bottom:8px">⚠ ' + U.esc(r.warn.join('；')) + '</div>' : '') +
      (rows.length
        ? Table.render([
            { title: '', key: 'sev', width: 62 },
            { title: '项目', key: 'label', width: 150 },
            { title: '问题', key: 'msg' },
            { title: '模板要求', key: 'exp', width: 180 },
            { title: '上报内容', key: 'act', width: 180 },
            { title: '原文证据', key: 'ev', width: 150 }
          ], rows)
        : '<div style="padding:24px;text-align:center;color:var(--success)">✔ 未发现与标准模板的差异</div>') +
      '</div>';

    UI.open({
      title: '合同模板比对结果', width: 'wide', hideCancel: true,
      body: body
    });
  }

  /* ---------------- 上传比对 ---------------- */
  window.ContractCompareUpload = async function (presetContractId) {
    let contracts = [];
    try {
      const r = await GET('/api/contract/contracts?pageSize=500');
      contracts = (r.data && r.data.list) || [];
    } catch (e) { UI.toast('读取合同列表失败：' + e.message, 'err'); return; }
    if (!contracts.length) { UI.toast('系统里还没有合同', 'err'); return; }

    const opts = contracts.map(c => ({
      v: c.id,
      t: c.code + '　' + c.customerName + '　' + (c.roomCodes || []).join('/')
    }));
    let cid = presetContractId || (contracts[0] && contracts[0].id);
    let file = null;
    let skipNo = true;

    const body =
      '<div class="form-grid" style="gap:14px">' +
      '<div class="form-item" style="grid-column:1/-1">' +
      '<label>比对哪份合同</label>' +
      '<select id="ccCid">' + opts.map(o =>
        '<option value="' + U.esc(o.v) + '"' + (o.v === cid ? ' selected' : '') + '>' + U.esc(o.t) + '</option>'
      ).join('') + '</select>' +
      '<div class="muted" style="font-size:11px;margin-top:3px">系统里没有的合同（招商部新签的）需先在合同管理中录入</div>' +
      '</div>' +
      '<div class="form-item" style="grid-column:1/-1">' +
      '<label>上传上报的合同文件</label>' +
      '<input type="file" id="ccFile" accept=".docx,.pdf,.jpg,.jpeg,.png,.webp,.bmp,.gif,.txt,.md" />' +
      '<div class="muted" style="font-size:11px;margin-top:3px">' +
      '支持 Word（.docx）、PDF、图片（.jpg/.png 扫描件）、纯文本。上限 30MB。' +
      '<b>图片与扫描版 PDF 无文本层，需要先做 OCR</b>，当前会标记为「需OCR」。' +
      '</div>' +
      '</div>' +
      '<div class="form-item" style="grid-column:1/-1">' +
      '<label style="display:flex;align-items:center;gap:6px;font-weight:400">' +
      '<input type="checkbox" id="ccSkip"' + (skipNo ? ' checked' : '') + ' style="width:auto" /> ' +
      '<span>只检查合同编号是否填写（系统编号规则与模板前缀可能不同，不做格式强校验）</span></label>' +
      '</div>' +
      '<div class="form-item" style="grid-column:1/-1">' +
      '<div id="ccPick" class="muted" style="font-size:12px">未选择文件</div>' +
      '</div>' +
      '</div>';

    UI.open({
      title: '合同模板比对', width: 'wide',
      okText: '开始比对', cancelText: '关闭',
      body: body,
      onMount(mask) {
        window.__ccMask = mask;
        const sel = mask.querySelector('#ccCid');
        if (sel) sel.onchange = () => { cid = sel.value; };
        const f = mask.querySelector('#ccFile');
        if (f) f.onchange = () => {
          file = f.files && f.files[0];
          const box = mask.querySelector('#ccPick');
          if (box) {
            box.innerHTML = file
              ? '已选：<b>' + U.esc(file.name) + '</b>　' + (file.size / 1024 / 1024).toFixed(2) + ' MB'
              : '未选择文件';
          }
        };
        const sk = mask.querySelector('#ccSkip');
        if (sk) sk.onchange = () => { skipNo = sk.checked; };
      },
      onOk() {
        if (!file) { UI.toast('请先选择要比对的合同文件', 'err'); return false; }
        if (file.size > 30 * 1024 * 1024) { UI.toast('文件超过 30MB', 'err'); return false; }
        const rd = new FileReader();
        rd.onload = () => {
          POST('/api/contract-compare/check', {
            contractId: cid,
            fileName: file.name,
            skipNumberCompare: skipNo,
            dataBase64: String(rd.result).split(',')[1] || ''
          }).then(r => {
            // 【防御】POST 不会因业务失败而 throw（只有 401 / 网络异常才 throw），
            // 失败时返回 { ok:false, msg }，此时 r.data 是 undefined。
            // 之前直接 r.data.result 会抛「Cannot read properties of undefined」，
            // 把真实原因（后端 msg，比如路由未挂载返回 HTML）整个吞掉。
            if (!r || r.ok === false) {
              UI.toast('比对失败：' + ((r && r.msg) || '接口无返回（可能未登录或路由不存在）'), 'err');
              return;
            }
            const res = r.data && r.data.result;
            if (!res) {
              UI.toast('比对失败：接口未返回比对结果', 'err');
              return;
            }
            // 关掉上传弹窗，再开结果弹窗
            if (window.__ccMask) { window.__ccMask.remove(); window.__ccMask = null; }
            setTimeout(() => diffDetail(res), 150);
            UI.toast('比对完成：' + (VERDICT[res.verdict] || {}).label + '，得分 ' + res.score, res.verdict === 'pass' ? 'ok' : 'warn');
          }).catch(e => UI.toast('比对失败：' + (e.message || e), 'err'));
        };
        rd.onerror = () => UI.toast('读取文件失败', 'err');
        rd.readAsDataURL(file);
        return false;   // 不自动关闭，等异步结果
      }
    });
  };

  /* ---------------- 台账 ---------------- */
  window.ContractCompareLedger = async function () {
    const r = await GET('/api/contract-compare/records?pageSize=500');
    const list = (r.data && r.data.list) || [];
    const st = (r.data && r.data.stat) || {};
    const rows = list.map(x => {
      const v = VERDICT[x.verdict] || VERDICT.review;
      return {
        code: x.contractCode,
        file: U.esc(x.fileName || ''),
        type: U.tag((x.fileType || '').toUpperCase(), 'cyan'),
        score: '<b style="color:' + (x.score >= 90 ? 'var(--success)' : x.score >= 60 ? 'var(--warning)' : 'var(--danger)') + '">' + x.score + '</b>',
        verdict: U.tag(v.label, v.tag),
        total: (x.total || 0) + ' 项',
        sev: (x.high ? '<span style="color:var(--danger)">严重 ' + x.high + '</span>' : '') +
          (x.medium ? ' <span style="color:var(--warning)">中 ' + x.medium + '</span>' : '') +
          (x.low ? ' <span class="muted">提示 ' + x.low + '</span>' : ''),
        at: U.esc(x.comparedAt || ''),
        op: '<button class="btn btn-sm" data-cc-report="' + x.id + '">报告</button>'
      };
    });
    UI.open({
      title: '合同模板比对台账', width: 'wide', hideCancel: true,
      body:
        '<div style="display:flex;gap:16px;padding:6px 2px 12px;font-size:13px" class="muted">' +
        '<span>共 <b>' + (st.total || 0) + '</b> 次比对</span>' +
        '<span style="color:var(--success)">通过 ' + (st.pass || 0) + '</span>' +
        '<span style="color:var(--warning)">需复核 ' + (st.review || 0) + '</span>' +
        '<span style="color:var(--danger)">不通过 ' + (st.reject || 0) + '</span>' +
        '<span style="color:var(--cyan)">需OCR ' + (st.needOcr || 0) + '</span>' +
        '</div>' +
        (rows.length
          ? Table.render([
              { title: '合同号', key: 'code', width: 150 },
              { title: '上报文件', key: 'file' },
              { title: '格式', key: 'type', width: 60 },
              { title: '得分', key: 'score', width: 60, num: true },
              { title: '结论', key: 'verdict', width: 80 },
              { title: '差异', key: 'total', width: 70 },
              { title: '严重分布', key: 'sev', width: 160 },
              { title: '比对时间', key: 'at', width: 140 },
              { title: '操作', key: 'op', width: 70 }
            ], rows)
          : '<div style="padding:30px;text-align:center" class="muted">还没有比对记录<br><br>' +
            '<button class="btn btn-primary" onclick="ContractCompareUpload()">上传第一份合同开始比对</button></div>'),
      onMount(mask) {
        mask.querySelectorAll('[data-cc-report]').forEach(b => {
          b.onclick = () => window.open('/api/contract-compare/report/' + b.getAttribute('data-cc-report'), '_blank');
        });
      }
    });
  };

  /* ---------------- 标准模板清单 ---------------- */
  window.ContractCompareTemplate = async function () {
    const r = await GET('/api/contract-compare/template');
    const d = r.data || {};
    const meta = d.meta || {};
    const body =
      '<div style="padding:4px 2px 12px">' +
      '<div class="muted" style="margin-bottom:12px;line-height:1.8">' +
      '模板文件：<b>' + U.esc(meta.fileName || '') + '</b>　' +
      '（' + (meta.paragraphs || 0) + ' 段 / ' + (meta.sectionCount || 0) + ' 章 / ' +
      (meta.placeholderCount || 0) + ' 处待填槽位 / ' + (meta.tableCount || 0) + ' 表格）<br>' +
      '比对会同时核对三件事：<b>①</b> 合同文本 vs 本模板（条款有没有被删改）　' +
      '<b>②</b> 合同文本 vs 系统数据（金额/面积/日期对不对得上）　' +
      '<b>③</b> 模板占位符有没有全部替换成实际内容' +
      '</div>' +
      '<h4 style="margin:10px 0 6px">一、需填槽位（' + (d.slots || []).length + ' 项）</h4>' +
      Table.render([
        { title: '槽位', key: 'label', width: 170 },
        { title: '对应系统字段', key: 'dbField', width: 140, render: s => s.dbField ? '<code class="mono">' + s.dbField + '</code>' : '<span class="muted">推导</span>' },
        { title: '类型', key: 'type', width: 80 },
        { title: '必填', key: 'required', width: 50, render: s => s.required ? '是' : '否' },
        { title: '格式约定', key: 'patternHint', render: s => U.esc(s.patternHint || '—') }
      ], d.slots || []) +
      '<h4 style="margin:16px 0 6px">二、章节（' + (d.sections || []).length + ' 章，缺章即报）</h4>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
      (d.sections || []).map(s =>
        '<span class="tag ' + (s.severity === 'high' ? 'red' : s.severity === 'medium' ? 'orange' : 'gray') + '">' +
        U.esc(s.label) + '</span>').join('') +
      '</div>' +
      '<h4 style="margin:16px 0 6px">三、关键条款（' + (d.keyClauses || []).length + ' 条，改写即报）</h4>' +
      Table.render([
        { title: '条款', key: 'label', width: 220 },
        { title: '分组', key: 'group', width: 100, render: s => U.tag(s.group || '', 'cyan') },
        { title: '模板原文', key: 'expect' }
      ], d.keyClauses || []) +
      '<h4 style="margin:16px 0 6px">四、必须一致的固定内容（' + (d.fixedItems || []).length + ' 项）</h4>' +
      Table.render([
        { title: '项目', key: 'label' },
        { title: '级别', key: 'severity', width: 70, render: s => U.tag((SEV[s.severity] || SEV.low).label, (SEV[s.severity] || SEV.low).color) }
      ], d.fixedItems || []) +
      '</div>';
    UI.open({ title: '标准合同模板基线', width: 'wide', hideCancel: true, body: body });
  };

  /* ---------------- 说明 ----------------
   * 工具栏入口直接加在 views2.js 的 contract 视图 buttons 数组里
   * （CrudView 把 buttons 收进内部闭包，外部拿不到引用，挂钩方式不可靠）。
   * 本文件只提供三个函数：ContractCompareUpload / Ledger / Template。
   */
})();
