/* 视图：巡更检查（数据概览 / 巡更点位 / 巡更人员 / 巡查记录 / 班次日报 / 月度汇总）
   由「巡更检查小工具」整合而来：夜班时段 18:30 ~ 次日 06:30 */
(function () {

  function zapPerm(code) {
    const u = App.user || {};
    if (u.isAdmin) return true;
    const p = u.perms || [];
    return p.indexOf('*') >= 0 || p.indexOf(code) >= 0;
  }
  // 【必须惰性求值】本文件是 IIFE，模块加载就执行。若在顶层写成
  //   const CAN = { import: zapPerm('patrol:import') }
  // 则取值发生在「页面刚加载、App.user 还是 undefined」的时刻，
  // 权限被永久固化为 false —— 表现为登录后打开巡更页看不到导入区、
  // 导出按钮、编辑按钮全都消失（2026-10-04 用户报「小工具没复制全」）。
  // 改成 getter：每次读取时才去查当前登录用户的权限。
  const CAN = {
    get manage() { return zapPerm('patrol:manage'); },
    get import() { return zapPerm('patrol:import'); },
    get analyze() { return zapPerm('patrol:analyze'); },
    get exp() { return zapPerm('patrol:export'); },
    get view() { return zapPerm('patrol:view'); }
  };

  // 默认统计口径：跟随「有数据的月份 / 最后一次打卡日」，避免演示数据停留在历史月份时页面空白
  let _def = null;
  async function patrolDefaults() {
    if (_def) return _def;
    const r = await GET('/api/patrol/overview' + winQS(true));
    _def = r.ok ? r.data : { dataMonth: U.month(), lastRecord: '' };
    return _def;
  }
  function bustDefaults() { _def = null; }

  /* ==================== 夜班时段（可配，对齐原独立小工具 ui.py:79-95） ====================
   * 原小工具工具栏上有「夜班时段 起始 ~ 次日」两个输入框，我方初版把 18:30/06:30 写死在
   * lib/patrol.js 里，导致物业改班次后统计口径对不上。这里做成前端可改 + localStorage 记住，
   * 所有涉及班次归属的请求（overview / daily / monthly / export / records）统一带上。 */
  const WIN_KEY = 'patrol.window.v1';
  let _win = null;
  function win() {
    if (_win) return _win;
    let v = { start: '18:30', end: '06:30' };
    try {
      const s = JSON.parse(localStorage.getItem(WIN_KEY) || 'null');
      if (s && s.start && s.end) v = s;
    } catch (e) { }
    _win = v;
    return v;
  }
  function setWin(start, end) {
    _win = { start: String(start || '18:30'), end: String(end || '06:30') };
    try { localStorage.setItem(WIN_KEY, JSON.stringify(_win)); } catch (e) { }
    bustDefaults();          // 口径变了，概览里的默认日期要重取
    return _win;
  }
  /** 生成 query 片段。prefix=true 时前面补 '?'（用于「首个参数」场景，如 overview） */
  function winQS(prefix) {
    const w = win();
    const s = 'windowStart=' + encodeURIComponent(w.start) + '&windowEnd=' + encodeURIComponent(w.end);
    return prefix ? '?' + s : '&' + s;
  }
  /** 工具栏里的时段输入控件（返回 HTML；配合 bindWin 绑定） */
  function winHTML() {
    const w = win();
    return '<span class="muted" style="font-size:12.5px;align-self:center">夜班时段</span>' +
      '<input type="time" data-win="start" value="' + U.esc(w.start) + '" style="width:auto">' +
      '<span class="muted" style="align-self:center">~ 次日</span>' +
      '<input type="time" data-win="end" value="' + U.esc(w.end) + '" style="width:auto">' +
      '<button class="btn" data-winsave>应用</button>';
  }
  /** 绑定时段控件：change 时先落盘，再回调刷新当前页签 */
  function bindWin(scope, after) {
    const btn = scope.querySelector('[data-winsave]');
    if (!btn) return;
    const s = scope.querySelector('[data-win="start"]');
    const e = scope.querySelector('[data-win="end"]');
    btn.onclick = () => {
      let sv = s.value, ev = e.value;
      if (!sv || !ev) { UI.toast('请填写完整的起止时间', 'err'); return; }
      if (sv === ev) { UI.toast('起始与结束时间不能相同', 'err'); return; }
      setWin(sv, ev);
      UI.toast('夜班时段已设为 ' + sv + ' ~ 次日 ' + ev);
      if (after) after();
    };
  }

  function rateTag(r) {
    const c = r >= 100 ? 'green' : (r >= 90 ? '' : (r >= 60 ? 'orange' : 'red'));
    return U.tag(r.toFixed(0) + '%', c);
  }
  function missedTag(n) { return n > 0 ? U.tag('漏 ' + n, 'red') : U.tag('全巡', 'green'); }

  /**
   * 「点位表与本月打卡记录卡号对不上」警示卡。
   *
   * 覆盖率的分母是点位表，分子是「打卡记录里卡号能命中点位表」的记录数。
   * 设备换过 / 重新发卡后，点位表与旧月份记录是两套卡号（实测 3 月 100 个塔号体系卡
   * 与 7 月 35 个楼层体系卡交集为 0），命中率会掉到 0%，于是覆盖率恒 0%、
   * 漏检数 = 全部点数 —— 数字本身没错，但完全没法解读。
   *
   * 这里把真实原因直接说出来并给出下一步动作，而不是让人对着 0% 猜。
   * 概览页与月报页共用，避免两处文案日后走样。
   *
   * @param {number} rate        卡号命中率 %（null/undefined = 无记录，无法判断）
   * @param {number} recCount    本月打卡记录条数
   * @param {string} month       YYYY-MM
   * @param {number} coverage    当前算出的覆盖率 %，用于说明「所以显示为 x%」
   * @param {string} [scope]     'overview' | 'monthly'，决定措辞里的页面语境
   * @returns {string} HTML 片段，条件不满足时返回空串
   */
  function codeHitWarn(rate, recCount, month, coverage, scope) {
    if (rate === null || rate === undefined) return '';
    if (!(recCount > 0)) return '';
    if (!(rate < 50)) return '';
    return '<div class="card mb12" style="border-left:3px solid var(--warn)">' +
      '<div class="card-head" style="color:var(--warn)">⚠ 点位表与 ' + U.esc(month) + ' 打卡记录对不上（卡号命中率 ' + rate + '%）</div>' +
      '<div class="card-body"><div style="font-size:13.5px;line-height:1.9">' +
      U.esc(month) + ' 的 ' + U.money(recCount, 0) + ' 条打卡记录里，只有 ' + rate +
      '% 的点位卡号能在当前用于计算的点位表里找到，所以本月覆盖率显示为 ' +
      (Number(coverage) || 0).toFixed(1) + '%。<br>' +
      '原因：<b>设备更换或重新发卡后，点位卡号整套变了</b>（例如 3 月是 <code>T1 负一</code> 这类塔号体系，' +
      '后来改成 <code>18F东面步梯间</code> 的楼层体系，两套卡号交集为 0）。<br>' +
      '处理办法：把 <b>' + U.esc(month) + ' 那份记录文件重新用「导入巡查记录表」导一次</b> —— ' +
      '设备导出的 xls 里点位表和记录表在同一个文件的不同工作表中，一次导入就会连点位一起进来，' +
      '并自动归档到 ' + U.esc(month) + '（不会影响其他月份）。<br>' +
      '若这个文件里确实没有点位表，可改用「📍 导入点位表」单独导入，并在表单里把「归属月份」填成 ' +
      U.esc(month) + '。</div></div></div>';
  }

  /* ==================== 主视图 ==================== */
  App.view('patrol', {
    title: '巡更检查管理',
    async render(el) {
      const tabs = [
        { key: 'ov', name: '数据概览' },
        { key: 'pt', name: '巡更点位' },
        { key: 'ps', name: '巡更人员' },
        { key: 'rc', name: '巡查记录' },
        { key: 'dy', name: '班次日报' },
        { key: 'mo', name: '月度汇总' }
      ];
      let cur = 'ov';
      el.innerHTML = '<div class="sub-tabs">' + tabs.map(t => '<div class="chip' + (t.key === cur ? ' active' : '') + '" data-tab="' + t.key + '">' + t.name + '</div>').join('') + '</div>' +
        '<div id="patrolBody"></div>';
      el.querySelectorAll('[data-tab]').forEach(t => {
        t.onclick = () => {
          el.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('active'));
          t.classList.add('active'); cur = t.getAttribute('data-tab'); renderTab();
        };
      });
      async function renderTab() {
        const box = el.querySelector('#patrolBody');
        box.innerHTML = '';
        if (cur === 'ov') return renderOverview(box);
        if (cur === 'pt') return renderPoints(box);
        if (cur === 'ps') return renderPersons(box);
        if (cur === 'rc') return renderRecords(box);
        if (cur === 'dy') return renderDaily(box);
        if (cur === 'mo') return renderMonthly(box);
      }
      renderTab();
    }
  });

  /* ==================== 1. 数据概览 ==================== */
  async function renderOverview(box) {
    box.innerHTML = '<div class="empty">加载中…</div>';
    const r = await GET('/api/patrol/overview' + winQS(true));
    if (!r.ok) { box.innerHTML = '<div class="empty">' + U.esc(r.msg || '加载失败') + '</div>'; return; }
    const d = r.data;

    let h = '';

    // 【导入区置顶】用户 2026-10-04 要求：导入入口放界面顶端，不要压在概览指标下面。
    // 巡更数据全靠手工导入，入口埋在页面底部要滚动到底才看得到，等于没有。
    if (CAN.import) {
h += '<div class="card mb12"><div class="card-head">数据导入（支持 .xls / .xlsx / .csv，无需安装任何插件）</div><div class="card-body">' +
      '<div class="flex" style="flex-wrap:wrap">' +
      '<button class="btn btn-primary" data-imp="records">📋 导入巡查记录表</button>' +
      '<button class="btn" data-imp="points">📍 导入巡更点位表</button>' +
      '<span class="muted" style="font-size:12.5px">当前夜班口径：' + U.esc(win().start) + ' 至次日 ' + U.esc(win().end) + '，以夜班起始日为班次日</span>' +
      '</div>' +
      '<div class="muted mt8" style="font-size:12.5px;line-height:1.8">' +
      '<b>设备导出的 xls 把点位表和记录表放在同一个文件的不同工作表里</b>（例如维序的 ' +
      '<code>Rpt_cardinfo</code> 点位清单 + <code>Rpt_downdata</code> 巡更流水）。' +
      '这种情况<b>只用「导入巡查记录表」一次</b>即可，点位会被一并读入并自动归档到该记录所属月份，' +
      '不用再单独导一次。只有手上是独立点位表文件时才点第二个按钮。</div></div></div>';
    }

    h += '<div class="card mb12"><div class="card-body"><div class="flex" style="flex-wrap:wrap">' +
      winHTML() +
      '<span class="muted" style="font-size:12.5px;align-self:center">　改动时段后，班次归属、覆盖率、漏检判定都会按新口径重算</span>' +
      '</div></div></div>';

    // 【分母点数】覆盖率的分母是「本月参与计算的点位数」，不等于点位表存量。
      // 设备换过卡后点位按月归档，两套卡号同时留在表里，若直接拿存量当分母，
      // 3 月和 7 月的应巡都会被算成两套卡号之和。所以必须分别显示。
      h += '<div class="card mb12"><div class="card-head">巡更概况</div><div class="card-body">' +
      '<div class="pay-sum">' +
      '<div><span class="muted">点位总数</span><b>' + d.pointCount + '</b></div>' +
      (d.pointScope === 'month'
        ? '<div><span class="muted">' + U.esc(d.month) + ' 分母点数</span><b>' + (d.monthPointCount || 0) + '</b></div>'
        : '<div><span class="muted">本月分母点数</span><b>' + (d.monthPointCount || d.pointCount) + '</b></div>') +
      '<div><span class="muted">巡更人员</span><b>' + d.personCount + '</b></div>' +
      '<div><span class="muted">巡查记录</span><b>' + U.money(d.recordCount, 0) + '</b></div>' +
      '<div><span class="muted">最近打卡</span><b style="font-size:14px">' + U.esc(d.lastRecord || '—') + '</b></div>' +
      '<div class="net"><span class="muted">' + U.esc(d.month) + ' 夜班覆盖率</span><b>' + (d.monthCoverage || 0).toFixed(1) + '%</b></div>' +
      '<div><span class="muted">夜班次数</span><b>' + d.monthNights + '</b></div>' +
      '<div><span class="muted">全巡夜数</span><b>' + d.monthPerfect + '</b></div>' +
      '<div><span class="muted">漏检点次</span><b style="color:' + (d.monthMissed > 0 ? 'var(--danger)' : 'var(--success)') + '">' + d.monthMissed + '</b></div>' +
      '</div>' +
      (d.pointScope === 'month'
        ? '<div class="muted mt8" style="font-size:12.5px">覆盖率分母采用 <b>' + U.esc(d.month) +
          ' 专属点位</b>（该月设备换过卡号，点位已按月归档；' +
          '另有 ' + Math.max(0, (d.pointCount || 0) - (d.monthPointCount || 0)) +
          ' 个通用点位<b>不计入</b>本月分母 —— 它们属于另一套卡号体系）</div>'
        : '') +
      '</div></div>';

    // 【卡号体系不一致提示】文案与月报页共用 codeHitWarn，避免两处说法不一致
    h += codeHitWarn(d.codeHitRate, d.monthRecordCount, d.month, d.monthCoverage, 'overview');

    // 最近 7 个夜班柱状图
    if (d.recent && d.recent.length) {
      const max = Math.max.apply(null, d.recent.map(x => x.expected || 1));
      h += '<div class="card mb12"><div class="card-head">最近 ' + d.recent.length + ' 个夜班（实巡 / 应巡）</div><div class="card-body">' +
        '<div class="chart-bars">' + d.recent.map(x => {
        const pct = Math.round(x.actual / Math.max(1, x.expected) * 100);
        const hh = Math.max(6, Math.round(x.actual / max * 130));
        const color = pct >= 100 ? 'var(--success)' : (pct >= 60 ? 'var(--warn)' : 'var(--danger)');
        return '<div class="bar-col"><div class="bar-vl">' + x.actual + '/' + x.expected + '</div>' +
          '<div class="bar-wrap"><div class="bar" style="height:' + hh + 'px;background:' + color + '" title="' + U.esc(x.persons || '') + '"></div></div>' +
          '<div class="bar-lb">' + U.esc(String(x.date).slice(5)) + '</div></div>';
      }).join('') + '</div></div></div>';
    }

    // TOP 漏检点
    h += '<div class="grid2">';
    h += '<div class="card"><div class="card-head">漏检最多的点位（本月 TOP5）</div><div class="card-body tight">' +
      (d.topMissed && d.topMissed.length
        ? Table.render([
          { title: '巡更点', key: 'name' },
          { title: '漏检次数', key: 'count', width: 90, num: true, render: r => U.tag(r.count + ' 次', r.count > 5 ? 'red' : 'orange') }
        ], d.topMissed)
        : '<div class="empty">本月无漏检，巡检覆盖良好 👍</div>') +
      '</div></div>';

    // 导入批次
    h += '<div class="card"><div class="card-head">数据来源</div><div class="card-body tight">' +
      (d.batches && d.batches.length
        ? Table.render([
          { title: '类型', key: 'type', width: 80, render: r => U.tag(r.type, r.type === '记录表' ? 'blue' : 'cyan') },
          { title: '文件', key: 'fileName', render: r => '<span class="ellipsis">' + U.esc(r.fileName) + '</span>' },
          { title: '条数', key: 'records', width: 90, num: true, render: r => (r.records || ((r.points || 0) + (r.persons || 0))) },
          { title: '时间', key: 'time', width: 140 }
        ], d.batches)
        : '<div class="empty">暂无导入记录</div>') +
      '</div></div>';
    h += '</div>';

    box.innerHTML = h;
    bindWin(box, () => renderOverview(box));
    bindImport(box, () => renderOverview(box));
  }

  /* ==================== 2. 巡更点位 ==================== */
  function renderPoints(box) {
    // 【归属月份 month】设备中途换过 / 重新发卡后，同一物业不同月份是两套卡号体系
    //（3 月 100 个塔号体系卡 vs 7 月 35 个楼层体系卡，卡号交集为 0）。
    // 全并进一张表会让两个月的应巡分母都变成 135，覆盖率双双算错。
    // 所以点位带 month 归属：留空 = 通用点位（任何月份都参与分母）。
    const view = CrudView({
      key: 'patrolPoint', name: '巡更点位', api: '/api/patrol/points', size: 50, sort: 'sortKey',
      extraQuery: { sort: 'sortKey', order: 'asc' },
      searchPlaceholder: '点位名称 / 卡号',
      hideAdd: !CAN.manage,
      filters: [
        { key: 'status', label: '状态', type: 'select', options: ['启用', '停用'] },
        {
          key: 'month', label: '归属月份', type: 'select',
          options: [
            { value: '', text: '全部' },
            { value: 'common', text: '通用点位（无月份）' },
            { value: 'scoped', text: '按月归档点位' }
          ]
        }
      ],
      fields: [
        { key: 'code', label: '卡号', required: true, placeholder: '巡更点卡号' },
        { key: 'name', label: '点位名称', required: true, placeholder: '如 18F东面步梯间' },
        {
          key: 'month', label: '归属月份', span: 'half',
          placeholder: '如 2026-03；留空=通用点位',
          hint: '设备换过 / 重新发卡后卡号会整套换掉。填了月份（如 2026-03）的点位只在该月参与覆盖率分母；留空表示通用点位 —— 仅当该月没有专属点位时才计入。'
        },
        { key: 'route', label: '路线编号', placeholder: '如 路线A' },
        { key: 'routeOrder', label: '路线内顺序', type: 'number', default: 0 },
        { key: 'remark', label: '备注', span: 'full' },
        { key: 'status', label: '状态', type: 'select', options: ['启用', '停用'], default: '启用' }
      ],
      columns: [
        { title: '排序', key: 'sortKey', width: 60, num: true },
        { title: '卡号', key: 'code', width: 120, render: r => '<b class="mono">' + U.esc(r.code) + '</b>' },
        { title: '点位名称', key: 'name' },
        {
          title: '归属月份', key: 'month', width: 100,
          render: r => r.month ? U.tag(r.month, 'blue') : '<span class="muted">通用</span>'
        },
        { title: '路线', key: 'route', width: 100 },
        { title: '顺序', key: 'routeOrder', width: 70, num: true },
        { title: '备注', key: 'remark' },
        { title: '状态', key: 'status', width: 80, render: r => U.statusTag(r.status) }
      ]
    });
    box.innerHTML = '';
    view.render(box);
    if (CAN.import) {
      const bar = document.createElement('div');
      bar.className = 'card mb12';
      bar.innerHTML = '<div class="card-body"><div class="flex"><button class="btn btn-primary" data-imp="points">📍 导入点位表（含人员卡）</button>' +
        '<span class="muted" style="font-size:12.5px">表格需含「卡号 / 类型 / 名称」列，类型=地点卡 记为点位，人员卡 记为人员</span></div>' +
        '<div class="muted mt8" style="font-size:12.5px">' +
        '导「维序设备原始导出」时不用单独导点位 —— 点位就在记录那个 xls 的另一个工作表里，' +
        '用「导入巡查记录表」一次就会连点位一起进来，并自动归档到那个月。' +
        '只有手上是独立的点位表文件时才用这个按钮。</div></div>';
      box.insertBefore(bar, box.firstChild);
      bindImport(bar, () => { Cache.bust(); view.render(box); });
    }
  }

  /* ==================== 3. 巡更人员 ==================== */
  function renderPersons(box) {
    const view = CrudView({
      key: 'patrolPerson', name: '巡更人员', api: '/api/patrol/persons', size: 50, sort: 'name',
      searchPlaceholder: '姓名 / 卡号',
      hideAdd: !CAN.manage,
      filters: [
        { key: 'shift', label: '班次', type: 'select', options: ['夜班', '白班'] }
      ],
      fields: [
        { key: 'code', label: '卡号', required: true },
        { key: 'name', label: '人员', required: true, placeholder: '如 夜班-朱春平' },
        { key: 'shift', label: '班次', type: 'select', options: ['夜班', '白班'], default: '夜班' },
        { key: 'phone', label: '联系电话' },
        { key: 'status', label: '状态', type: 'select', options: ['在职', '离职'], default: '在职' }
      ],
      columns: [
        { title: '卡号', key: 'code', width: 130, render: r => '<b class="mono">' + U.esc(r.code) + '</b>' },
        { title: '人员', key: 'name', width: 160 },
        { title: '班次', key: 'shift', width: 80, render: r => U.tag(r.shift || '未指定', r.shift === '夜班' ? 'blue' : 'cyan') },
        { title: '联系电话', key: 'phone', width: 130 },
        { title: '状态', key: 'status', width: 80, render: r => U.statusTag(r.status) }
      ]
    });
    view.render(box);
  }

  /* ==================== 4. 巡查记录 ==================== */
  function renderRecords(box) {
    const st = { page: 1, size: 20, start: '', end: '', person: '', shift: '', keyword: '' };
    box.innerHTML = '<div class="card mb12"><div class="card-body">' +
      '<div class="flex" style="flex-wrap:wrap">' +
      winHTML() +
      '<input type="date" data-f="start" placeholder="开始日期" style="width:auto">' +
      '<input type="date" data-f="end" placeholder="结束日期" style="width:auto">' +
      '<select data-f="shift" style="width:auto"><option value="">全部班次</option><option value="夜班">夜班</option><option value="白班">白班</option></select>' +
      '<input type="text" data-f="person" placeholder="人员" style="width:130px">' +
      '<input type="text" data-f="keyword" placeholder="巡更点 / 编码 / 人员" style="width:200px">' +
      '<button class="btn btn-primary" data-q>查询</button>' +
      (CAN.import ? '<button class="btn" data-imp="records">📋 导入记录表</button>' : '') +
      (CAN.exp ? '<button class="btn" data-exp>导出 Excel</button>' : '') +
      (CAN.manage ? '<button class="btn btn-danger" data-clear>清空记录</button>' : '') +
      '</div></div></div><div id="rcList" class="card"><div class="card-body tight"></div></div>';

    box.querySelectorAll('[data-f]').forEach(x => {
      x.onchange = () => { st[x.getAttribute('data-f')] = x.value; };
      x.onkeydown = e => { if (e.key === 'Enter') load(); };
    });
    box.querySelector('[data-q]').onclick = () => { st.page = 1; load(); };
    bindWin(box, () => renderRecords(box));

    if (CAN.exp) {
      box.querySelector('[data-exp]').onclick = () => {
        location.href = '/api/patrol/export?type=records&format=xls&start=' + encodeURIComponent(st.start) + '&end=' + encodeURIComponent(st.end) + winQS();
      };
    }
    if (CAN.manage) {
      box.querySelector('[data-clear]').onclick = async () => {
        const yes = await UI.confirm('确定清空全部巡查记录吗？该操作不可恢复。', '危险操作');
        if (!yes) return;
        const r = await POST('/api/patrol/records/clear', {});
        if (r.ok) { UI.toast('已清空 ' + r.data.cleared + ' 条记录'); load(); }
        else UI.toast(r.msg || '清空失败', 'err');
      };
    }
    bindImport(box, () => load());

    async function load() {
      const lb = box.querySelector('#rcList .card-body');
      lb.innerHTML = '<div class="empty">加载中…</div>';
      const q = ['page=' + st.page, 'size=' + st.size, 'start=' + encodeURIComponent(st.start), 'end=' + encodeURIComponent(st.end),
        'shift=' + encodeURIComponent(st.shift), 'person=' + encodeURIComponent(st.person), 'keyword=' + encodeURIComponent(st.keyword),
        'windowStart=' + encodeURIComponent(win().start), 'windowEnd=' + encodeURIComponent(win().end)].join('&');
      const r = await GET('/api/patrol/records?' + q);
      if (!r.ok) { lb.innerHTML = '<div class="empty">' + U.esc(r.msg) + '</div>'; return; }
      lb.innerHTML = Table.render([
        { title: '序号', key: 'seq', width: 70, num: true },
        { title: '巡检时间', key: 'time', width: 160 },
        { title: '班次', key: 'shift', width: 70, render: r2 => U.tag(r2.shift, r2.shift === '夜班' ? 'blue' : 'cyan') },
        { title: '班次日', key: 'shiftDate', width: 100 },
        { title: '巡点编码', key: 'pointCode', width: 120, render: r2 => '<span class="mono">' + U.esc(r2.pointCode) + '</span>' },
        { title: '巡更点', key: 'pointName' },
        { title: '人员', key: 'person', width: 130 },
        { title: '巡检器', key: 'device', width: 100 }
      ], r.data.list || []) + Table.pager(r.data.total || 0, st.page, st.size);
      lb.querySelectorAll('[data-page]').forEach(b => {
        b.onclick = () => { const p = Number(b.getAttribute('data-page')); if (p >= 1) { st.page = p; load(); } };
      });
    }
    load();
  }

  /* ==================== 5. 班次日报 ==================== */
  async function renderDaily(box) {
    const def = await patrolDefaults();
    const st = { date: def.lastShiftDate || (def.lastRecord || '').slice(0, 10) || U.today(), mode: 'night' };
    box.innerHTML = '<div class="card mb12"><div class="card-body"><div class="flex" style="flex-wrap:wrap">' +
      winHTML() +
      '<select data-f="mode" style="width:auto"><option value="night" selected>夜班</option><option value="day">白班</option></select>' +
      '<input type="date" data-f="date" value="' + st.date + '" style="width:auto">' +
      '<button class="btn btn-primary" data-q>查看</button>' +
      (CAN.exp ? '<button class="btn" data-exp>导出日报 Excel</button><button class="btn" data-expc>导出日报 CSV</button>' : '') +
      '<span class="muted" style="font-size:12.5px">与原巡更小工具口径一致：巡检明细 + 遗漏汇总两张表</span>' +
      '</div></div></div><div id="dyBody"></div>';

    box.querySelectorAll('[data-f]').forEach(x => {
      x.onchange = () => { st[x.getAttribute('data-f')] = x.value; load(); };
    });
    box.querySelector('[data-q]').onclick = () => load();
    bindWin(box, () => renderDaily(box));
    if (CAN.exp) {
      box.querySelector('[data-exp]').onclick = () => {
        location.href = '/api/patrol/export?type=daily&format=xls&mode=' + st.mode + '&date=' + st.date + winQS();
      };
      box.querySelector('[data-expc]').onclick = () => {
        location.href = '/api/patrol/export?type=daily&format=csv&mode=' + st.mode + '&date=' + st.date + winQS();
      };
    }

    async function load() {
      const b = box.querySelector('#dyBody');
      b.innerHTML = '<div class="empty">加载中…</div>';
      const r = await GET('/api/patrol/daily?date=' + st.date + '&mode=' + st.mode + winQS());
      if (!r.ok) { b.innerHTML = '<div class="empty">' + U.esc(r.msg) + '</div>'; return; }
      const d = r.data;
      if (d.empty) {
        const hint = (st.mode === 'night' && def.lastShiftDate && def.lastShiftDate !== st.date)
          ? '<div class="mt8"><button class="btn btn-sm" data-jump="' + def.lastShiftDate + '">跳到最后一个夜班（' + def.lastShiftDate + '）</button></div>' : '';
        b.innerHTML = '<div class="card"><div class="empty">该日期没有' + (st.mode === 'day' ? '白班' : '夜班') + '巡查记录' + hint + '</div></div>';
        const jb = b.querySelector('[data-jump]');
        if (jb) jb.onclick = () => {
          st.date = jb.getAttribute('data-jump');
          box.querySelector('[data-f="date"]').value = st.date;
          load();
        };
        return;
      }
      const rep = d.report;
      let h = '<div class="card mb12"><div class="card-head">' + U.esc(st.date) + ' ' + (st.mode === 'day' ? '白班' : '夜班') + '巡检报告</div><div class="card-body">' +
        '<div class="pay-sum">' +
        '<div><span class="muted">应巡点位</span><b>' + rep.totalExpected + '</b></div>' +
        '<div><span class="muted">实巡点位</span><b>' + rep.totalActual + '</b></div>' +
        '<div><span class="muted">漏检点位</span><b style="color:' + (rep.totalMissed > 0 ? 'var(--danger)' : 'var(--success)') + '">' + rep.totalMissed + '</b></div>' +
        '<div class="net"><span class="muted">覆盖率</span><b>' + rep.coverageRate.toFixed(1) + '%</b></div>' +
        '<div><span class="muted">打卡条数</span><b>' + rep.recordCount + '</b></div>' +
        '<div><span class="muted">当班人员</span><b style="font-size:14px">' + U.esc(rep.allPersonText || '—') + '</b></div>' +
        '<div><span class="muted">首次打卡</span><b style="font-size:14px">' + U.esc(rep.firstTime) + '</b></div>' +
        '<div><span class="muted">末次打卡</span><b style="font-size:14px">' + U.esc(rep.lastTime) + '</b></div>' +
        '</div></div></div>';

      // 漏检点位
      h += '<div class="card mb12"><div class="card-head">漏检点位（' + rep.missed.length + '）</div><div class="card-body">' +
        (rep.missed.length
          ? '<div class="flex" style="flex-wrap:wrap">' + rep.missedPoints.map(n => '<span class="chip" style="border-color:var(--danger);color:var(--danger)">' + U.esc(n) + '</span>').join('') + '</div>'
          : '<div class="empty">全部点位均已巡检 ✔</div>') +
        '</div></div>';

      // 打卡明细
      h += '<div class="card"><div class="card-head">打卡明细（' + (d.records || []).length + ' 条）</div><div class="card-body tight">' +
        Table.render([
          { title: '#', key: 'seq', width: 60, num: true },
          { title: '巡检时间', key: 'time', width: 155 },
          { title: '巡点编码', key: 'pointCode', width: 120, render: r2 => '<span class="mono">' + U.esc(r2.pointCode) + '</span>' },
          { title: '巡更点', key: 'pointName' },
          { title: '人员', key: 'person', width: 130 },
          { title: '巡检器', key: 'device', width: 100 }
        ], d.records || []) + '</div></div>';
      b.innerHTML = h;
    }
    load();
  }

  /* ==================== 6. 月度汇总 ==================== */
  async function renderMonthly(box) {
    const def = await patrolDefaults();
    const st = { month: def.dataMonth || U.month(), mode: 'night' };
    box.innerHTML = '<div class="card mb12"><div class="card-body"><div class="flex" style="flex-wrap:wrap">' +
      winHTML() +
      '<input type="month" data-f="month" value="' + st.month + '" style="width:auto">' +
      '<select data-f="mode" style="width:auto"><option value="night" selected>夜班</option><option value="day">白班</option></select>' +
      '<button class="btn btn-primary" data-q>统计</button>' +
      (CAN.exp ? '<button class="btn" data-exp>导出月报 Excel</button><button class="btn" data-expc>导出月报 CSV</button>' : '') +
      (CAN.exp ? '<button class="btn btn-danger" data-expm>导出遗漏明细 Excel</button>' : '') +
      '</div></div></div><div id="moBody"></div>';
    box.querySelectorAll('[data-f]').forEach(x => { x.onchange = () => { st[x.getAttribute('data-f')] = x.value; load(); }; });
    box.querySelector('[data-q]').onclick = () => load();
    bindWin(box, () => renderMonthly(box));
    if (CAN.exp) {
      box.querySelector('[data-exp]').onclick = () => {
        location.href = '/api/patrol/export?type=monthly&format=xls&mode=' + st.mode + '&month=' + st.month + winQS();
      };
      box.querySelector('[data-expc]').onclick = () => {
        location.href = '/api/patrol/export?type=monthly&format=csv&mode=' + st.mode + '&month=' + st.month + winQS();
      };
      const bm = box.querySelector('[data-expm]');
      if (bm) bm.onclick = () => {
        location.href = '/api/patrol/export?type=missed&format=xls&mode=' + st.mode + '&month=' + st.month + winQS();
      };
    }

    async function load() {
      const b = box.querySelector('#moBody');
      b.innerHTML = '<div class="empty">统计中…</div>';
      const r = await GET('/api/patrol/monthly?month=' + st.month + '&mode=' + st.mode + winQS());
      if (!r.ok) { b.innerHTML = '<div class="empty">' + U.esc(r.msg) + '</div>'; return; }
      const d = r.data, m = d.monthly;
      let h = '<div class="card mb12"><div class="card-head">' + U.esc(st.month) + ' ' + (st.mode === 'day' ? '白班' : '夜班') + '汇总</div><div class="card-body">' +
        '<div class="pay-sum">' +
        '<div><span class="muted">班次天数</span><b>' + m.totalNights + '</b></div>' +
        '<div><span class="muted">应巡点次</span><b>' + m.totalExpected + '</b></div>' +
        '<div><span class="muted">实巡点次</span><b>' + m.totalActual + '</b></div>' +
        '<div><span class="muted">漏检点次</span><b style="color:' + (m.totalMissed > 0 ? 'var(--danger)' : 'var(--success)') + '">' + m.totalMissed + '</b></div>' +
        '<div class="net"><span class="muted">覆盖率</span><b>' + m.coverageRate.toFixed(1) + '%</b></div>' +
        '<div><span class="muted">全巡天数</span><b>' + m.perfectNights + '</b></div>' +
        '<div><span class="muted">全巡率</span><b>' + m.perfectRate.toFixed(1) + '%</b></div>' +
        '</div></div></div>';

      // 【卡号体系不一致提示】月报页与概览页共用同一套文案。
      // 月报更容易让人误解：这里列出了「漏检最多的点位 TOP10」和 1085 条遗漏明细，
      // 数字看着非常具体，但根因只是点位表跟这批记录不是同一套卡号。
      // 不提示的话，用户会去逐个核查点位是否真的漏巡 —— 方向完全错了。
      h += codeHitWarn(d.codeHitRate, d.recordCount, st.month, m.coverageRate, 'monthly');

      h += '<div class="grid2 mb12">';
      h += '<div class="card"><div class="card-head">漏检最多的点位（TOP10）</div><div class="card-body tight">' +
        (m.topMissed.length
          ? Table.render([{ title: '巡更点', key: 'name' }, { title: '漏检次数', key: 'count', width: 100, num: true, render: r2 => U.tag(r2.count + ' 次', r2.count > 5 ? 'red' : 'orange') }], m.topMissed.slice(0, 10))
          : '<div class="empty">本月无漏检 ✔</div>') + '</div></div>';
      h += '<div class="card"><div class="card-head">人员统计</div><div class="card-body tight">' +
        Table.render([
          { title: '人员', key: 'person', width: 130 },
          { title: '班次', key: 'shift', width: 70, render: r2 => U.tag(r2.shift, r2.shift === '夜班' ? 'blue' : (r2.shift === '白班' ? 'cyan' : '')) },
          { title: '当班次数', key: 'nights', width: 80, num: true },
          { title: '打卡条数', key: 'records', width: 80, num: true },
          { title: '覆盖率', key: 'rate', width: 80, num: true, render: r2 => rateTag(r2.rate) }
        ], m.personStats || []) + '</div></div>';
      h += '</div>';

      // 遗漏明细（对齐原小工具「导出遗漏明细」：日期 + 漏检点 + 卡号 + 当班人员）
      const missRows = [];
      (d.daily || []).forEach(x => (x.missed || []).forEach((c, i) => {
        missRows.push({ date: x.shiftDate, name: (x.missedPoints || [])[i] || c, code: c, person: x.allPersonText || '未知' });
      }));
      h += '<div class="card mb12"><div class="card-head">遗漏明细（' + missRows.length + ' 条）</div><div class="card-body tight">' +
        (missRows.length
          ? Table.render([
            { title: '班次日', key: 'date', width: 110 },
            { title: '漏检点位', key: 'name' },
            { title: '卡号', key: 'code', width: 130, render: r3 => '<span class="mono">' + U.esc(r3.code) + '</span>' },
            { title: '当班人员', key: 'person', width: 150 }
          ], missRows)
          : '<div class="empty">本月无漏检 ✔</div>') +
        '</div></div>';

      h += '<div class="card"><div class="card-head">每日明细</div><div class="card-body tight">' +
        Table.render([
          { title: '班次日', key: 'shiftDate', width: 110 },
          { title: '当班人员', key: 'allPersonText' },
          { title: '应巡', key: 'totalExpected', width: 70, num: true },
          { title: '实巡', key: 'totalActual', width: 70, num: true },
          { title: '漏检', key: 'totalMissed', width: 70, num: true, render: r2 => missedTag(r2.totalMissed) },
          { title: '覆盖率', key: 'coverageRate', width: 80, num: true, render: r2 => rateTag(r2.coverageRate) },
          { title: '打卡条数', key: 'recordCount', width: 80, num: true },
          { title: '时段', width: 210, render: r2 => '<span class="muted">' + U.esc(r2.firstTime.slice(11) + ' ~ ' + r2.lastTime.slice(11)) + '</span>' },
          { title: '漏检点位', render: r2 => r2.missedPoints.length ? '<span class="ellipsis" style="color:var(--danger)">' + U.esc(r2.missedPoints.join('、')) + '</span>' : '<span class="muted">—</span>' }
        ], d.daily || []) + '</div></div>';
      b.innerHTML = h;
    }
    load();
  }

  /* ==================== 导入（base64 直传，无需插件） ==================== */
  function chooseMode(fileName) {
    return new Promise(res => {
      UI.open({
        title: '导入巡查记录',
        body: '<div style="font-size:13.5px;line-height:1.9">文件：<b>' + U.esc(fileName) + '</b>' +
          '<div class="mt8"><label class="inline"><input type="radio" name="impmode" value="append" checked> <b>追加</b>　保留现有记录，只补新增（新月份数据选此项）</label></div>' +
          '<div class="mt8"><label class="inline"><input type="radio" name="impmode" value="replace"> <b>覆盖</b>　先清空全部记录再导入（重导同一份文件选此项）</label></div></div>',
        okText: '开始导入',
        onOk(mask) {
          const v = mask.querySelector('input[name=impmode]:checked');
          res(v ? v.value : 'append');
        }
      });
    });
  }

  function bindImport(root, after) {
    if (!CAN.import) return;
    root.querySelectorAll('[data-imp]').forEach(btn => {
      btn.onclick = () => {
        const kind = btn.getAttribute('data-imp');
        const isPoints = kind === 'points';
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.xls,.xlsx,.csv';
        inp.onchange = async () => {
          const f = inp.files && inp.files[0];
          if (!f) return;
          const stop = UI.loading('正在解析「' + f.name + '」…');
          try {
            const dataUrl = await new Promise(res => {
              const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f);
            });
            let mode = 'append';
            if (!isPoints) mode = await chooseMode(f.name);
            const body = { fileName: f.name, dataBase64: dataUrl, mode: mode };
            const r = await POST('/api/patrol/import/' + kind, body);
            if (!r.ok) { UI.toast(r.msg || '导入失败', 'err'); return; }
            const d = r.data;
            // 【重复导入提示】后端按「时间+卡号+人员」做了幂等去重，
            // 同一份文件重复追加时 dup > 0。这里必须如实说出来 ——
            // 之前版本只提示「导入成功 N 条」，用户手滑导两次也不知道，
            // 结果实巡点次翻倍、覆盖率虚高，整份月报失真却查不出原因。
            if (!isPoints) {
              const dup = d.dup || 0;
              // 【顺带导入的点位】设备原始导出把点位藏在同一个 xls 的另一个工作表里，
              // 这时后端会连点位一起导进来（归档到 d.month）。
              // 必须明确告诉用户「点位也进来了、归档到哪个月」，
              // 否则他看到覆盖率从 0% 变成 96.5% 会一头雾水。
              const pt = d.points;
              const ptNote = pt && pt.points
                ? '，同时导入点位卡 ' + pt.points + ' 个（归档到 ' + (pt.month || d.month || '通用') + '）'
                : '';
              UI.toast(
                (dup > 0
                  ? ('已导入 ' + d.imported + ' 条新记录，跳过 ' + dup + ' 条重复（这份文件之前已导入过），累计 ' + d.total + ' 条')
                  : ('导入成功：' + d.imported + ' 条，累计 ' + d.total + ' 条')) + ptNote,
                dup > 0 ? 'warn' : 'ok');
            } else {
              UI.toast('导入成功：地点卡 ' + d.points + ' 个、人员卡 ' + d.persons + ' 个', 'ok');
            }
            Cache.bust();
            bustDefaults();
            if (after) after();
          } catch (e) {
            UI.toast('导入异常：' + e.message, 'err');
          } finally { stop(); }
        };
        inp.click();
      };
    });
  }
})();
