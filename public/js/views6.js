'use strict';
/* 收入台账 —— 对齐公司真实在用的「月表格」体系
 * 6 个子页：收入日报 / 停车费 / 上期尾款 / 支出台账 / 水电充值 / 月表格
 * 字段命名严格对齐 CrudView + Form 的实际 API：fields[].key / columns[].key
 */
(function () {
  const { CrudView, Table, UI, App, U } = window;

  // 权限判定（与 views4/views5 保持一致的实现，避免依赖局部函数）
  function zapPerm(code) {
    try {
      const u = App.user || {};
      if (u.isAdmin) return true;
      const p = u.perms || [];
      return p.indexOf('*') >= 0 || p.indexOf(code) >= 0;
    } catch (e) { return false; }
  }

  const CHANNELS = ['转账', '现金', '其他'];
  const EXP_CATS = ['物业费用支出', '日常费用支出', '预提款支出', '招商费用支出', '其他支出', '垫付支出'];

  const todayStr = () => new Date().toISOString().slice(0, 10);
  const curMonth = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
  // 财务看数默认看「本季 + 上一季」，即当前月往前 5 个月
  function quarterRange(month) {
    const m = String(month || curMonth());
    const y = Number(m.slice(0, 4)), mm = Number(m.slice(5, 7));
    const back = new Date(y, mm - 1 - 5, 1);
    return {
      start: back.getFullYear() + '-' + String(back.getMonth() + 1).padStart(2, '0'),
      end: m
    };
  }
  const fmtM = v => Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isNumCell = c => typeof c === 'number' ||
    (c !== null && c !== undefined && c !== '' && /^-?\d+(\.\d+)?$/.test(String(c).trim()));

  App.view('income', {
    title: '收入台账',
    async render(el) {
      const tabs = [
        { key: 'daily', name: '收入日报' },
        { key: 'parking', name: '停车费' },
        { key: 'arrears', name: '上期尾款' },
        { key: 'expense', name: '支出台账' },
        { key: 'other', name: '表9 其他费用' },
        { key: 'recharge', name: '水电充值' },
        { key: 'monthly', name: '月表格' }
      ];
      let cur = 'daily';
      el.innerHTML = '<div class="tabs">' +
        tabs.map(t => '<div class="tab' + (t.key === cur ? ' active' : '') + '" data-tab="' + t.key + '">' + t.name + '</div>').join('') +
        '</div><div id="incBody"></div>';
      el.querySelectorAll('[data-tab]').forEach(t => {
        t.onclick = () => {
          el.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('active'));
          t.classList.add('active'); cur = t.getAttribute('data-tab'); render();
        };
      });
      async function render() {
        const box = el.querySelector('#incBody');
        box.innerHTML = '<div class="muted" style="padding:24px;text-align:center">加载中…</div>';
        if (cur === 'daily') return renderDaily(box);
        if (cur === 'parking') return renderParking(box);
        if (cur === 'arrears') return renderArrears(box);
        if (cur === 'expense') return renderExpense(box);
        if (cur === 'other') return renderOther(box);
        if (cur === 'recharge') return renderRecharge(box);
        if (cur === 'monthly') return renderMonthly(box);
      }
      render();
    }
  });

  /* ==================== 1. 收入日报 ==================== */
  async function renderDaily(box) {
    const m0 = curMonth();
    box.innerHTML = '<div class="card"><div class="card-head"><h3>日收入统计表</h3><span class="spacer"></span>' +
      '<input type="month" id="incMonth" value="' + m0 + '" style="width:150px">' +
      '<button class="btn btn-sm" id="incGo">查询</button>' +
      (zapPerm('income:export') ? '<button class="btn btn-sm btn-primary" id="incExp">导出 CSV</button>' : '') +
      '</div><div class="card-body tight" id="incSum"></div></div>' +
      '<div class="card"><div class="card-head"><h3>科目口径</h3></div><div class="card-body tight" id="incCats"></div></div>';

    const load = async () => {
      const m = box.querySelector('#incMonth').value;
      const s = box.querySelector('#incSum');
      s.innerHTML = '<div class="empty">加载中…</div>';
      const r = await GET('/api/income/daily?month=' + m);
      if (!r.ok) { s.innerHTML = '<div class="empty">' + U.esc(r.msg || '加载失败') + '</div>'; return; }
      const d = r.data, cats = d.cats || [];

      // 科目汇总卡片
      let cards = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:8px;padding:10px 12px;background:#f7f9fc;border-bottom:1px solid #e8eef5">';
      cats.forEach(c => {
        const v = d.totalByCat[c.code] || 0;
        cards += '<div style="background:#fff;border:1px solid #e3eaf3;border-radius:6px;padding:8px 10px">' +
          '<div class="muted" style="font-size:11.5px">' + U.esc(c.name) + '</div>' +
          '<div style="font-size:15px;font-weight:600;color:' + (v > 0 ? '#1a7f37' : '#a0aec0') + '">' + fmtM(v) + '</div></div>';
      });
      cards += '<div style="background:#fffaf0;border:1px solid #f0d9a0;border-radius:6px;padding:8px 10px">' +
        '<div class="muted" style="font-size:11.5px">月合计</div>' +
        '<div style="font-size:17px;font-weight:700;color:#b7791f">' + fmtM(d.total) + '</div></div></div>';

      const head = [{ title: '日期', key: 'date', width: 100 }]
        .concat(cats.map(c => ({ title: c.name, key: c.code, width: 92, num: true })))
        .concat([{ title: '日汇总', key: 'total', width: 100, num: true }]);
      const rows = (d.days || []).slice();
      const tot = { date: '合计' };
      cats.forEach(c => tot[c.code] = d.totalByCat[c.code]);
      tot.total = d.total;
      rows.push(tot);
      s.innerHTML = cards + Table.render(head, rows);

      box.querySelector('#incCats').innerHTML = Table.render([
        { title: '科目', key: 'name', width: 130 }, { title: '分组', key: 'group', width: 110 },
        { title: '税率(%)', key: 'taxRate', width: 80, num: true }, { title: '业务说明', key: 'remark' }
      ], cats);
    };
    box.querySelector('#incGo').onclick = load;
    const eb = box.querySelector('#incExp');
    if (eb) eb.onclick = () => { location.href = '/api/income/export/daily?month=' + box.querySelector('#incMonth').value; };
    load();
  }

  /* ==================== 2. 停车费 ==================== */
  async function renderParking(box) {
    const tabs = [{ k: 'items', n: '明细台账' }, { k: 'cars', n: '车位档案' }, { k: 'sum', n: '月度汇总' }];
    let sub = 'items';
    box.innerHTML = '<div class="tabs" style="margin-bottom:10px">' +
      tabs.map(t => '<div class="tab' + (t.k === sub ? ' active' : '') + '" data-sub="' + t.k + '">' + t.n + '</div>').join('') +
      '</div><div id="pkBody"></div>';
    box.querySelectorAll('[data-sub]').forEach(t => {
      t.onclick = () => {
        box.querySelectorAll('[data-sub]').forEach(x => x.classList.remove('active'));
        t.classList.add('active'); sub = t.getAttribute('data-sub'); draw();
      };
    });

    const amtCalc = r => Math.round((Number(r.carCount || 1) * Number(r.price || 0) * Number(r.qty || 1)) * 100) / 100;

    function draw() {
      const b = box.querySelector('#pkBody'); b.innerHTML = '';
      if (sub === 'sum') return drawParkingSum(b);

      const isCar = sub === 'cars';
      const view = CrudView({
        api: isCar ? '/api/income/parking' : '/api/income/parkingItems',
        name: isCar ? '车位档案' : '停车费明细',
        searchPlaceholder: '单元 / 公司 / 车牌 / 摘要',
        filters: [
          { key: 'parkType', label: '全部类型', type: 'select', options: ['月租车位', '临时停车'] },
          { key: 'channel', label: '全部途径', type: 'select', options: CHANNELS }
        ],
        columns: [
          { title: '单元', key: 'unitNo', width: 90 },
          { title: '公司名称', key: 'companyName', width: 180 },
          { title: '车牌', key: 'plateNo', width: 105 },
          { title: '车量', key: 'carCount', width: 60, num: true },
          { title: '单价', key: 'price', width: 80, num: true },
          { title: '数量', key: 'qty', width: 60, num: true },
          { title: '金额', key: 'amount', width: 95, num: true, render: r => '<b>' + fmtM(amtCalc(r)) + '</b>' },
          { title: '类型', key: 'parkType', width: 100, render: r => U.tag(r.parkType || '月租车位', r.parkType === '临时停车' ? 'orange' : 'blue') },
          { title: '交款日期', key: 'payDate', width: 110 },
          { title: '收入途径', key: 'channel', width: 85 },
          { title: '余款', key: 'remain', width: 85, num: true, render: r => Number(r.remain) < 0 ? '<span style="color:#c53030">' + fmtM(r.remain) + '</span>' : fmtM(r.remain) },
          { title: '租赁起始', key: 'startDate', width: 105 },
          { title: '租赁截止', key: 'endDate', width: 105 },
          { title: '备注', key: 'remark', width: 150 }
        ],
        fields: [
          { key: 'unitNo', label: '单元号', width: 110 },
          { key: 'companyName', label: '公司名称', width: 200 },
          { key: 'plateNo', label: '车牌', width: 120, required: true },
          { key: 'carCount', label: '车量（辆）', type: 'number', width: 90, default: 1 },
          { key: 'price', label: '单价（元）', type: 'number', width: 100, default: 396, required: true, placeholder: '月租车位合同价 396 元/个/月' },
          { key: 'qty', label: '数量', type: 'number', width: 80, default: 1 },
          { key: 'parkType', label: '车位类型', type: 'select', options: ['月租车位', '临时停车'], width: 130, default: '月租车位' },
          { key: 'payDate', label: '交款日期', type: 'date', width: 120, default: todayStr() },
          { key: 'channel', label: '收入途径', type: 'select', options: CHANNELS, width: 100, default: '转账' },
          { key: 'remain', label: '余款（负数为欠费）', type: 'number', width: 130, default: 0 },
          { key: 'startDate', label: '租赁起始', type: 'date', width: 120 },
          { key: 'endDate', label: '租赁截止', type: 'date', width: 120 },
          { key: 'remark', label: '备注', type: 'textarea', span: 'full' }
        ],
        beforeSave: v => {
          if (Number(v.amount) === 0 || v.amount === undefined) v.amount = amtCalc(v);
          return true;
        },
        buttons: zapPerm('income:export') ? [{
          key: 'exp', label: '导出 CSV',
          onClick: () => { location.href = '/api/income/export/parking?start=' + curMonth() + '-01'; }
        }] : []
      });
      view.render(b);
    }
    draw();
  }

  async function drawParkingSum(b) {
    const qr = quarterRange();
    b.innerHTML = '<div class="card"><div class="card-head"><h3>停车费月度汇总（月租车 / 临时停车分列）</h3><span class="spacer"></span>' +
      '<input type="month" id="pkM1" value="' + qr.start + '" style="width:140px">' +
      '<input type="month" id="pkM2" value="' + qr.end + '" style="width:140px">' +
      '<button class="btn btn-sm" id="pkGo">查询</button></div><div class="card-body" id="pkSum"></div></div>';
    const load = async () => {
      const s = b.querySelector('#pkM1').value, e = b.querySelector('#pkM2').value;
      const box2 = b.querySelector('#pkSum');
      box2.innerHTML = '<div class="empty">加载中…</div>';
      const r = await GET('/api/income/parkingSummary?start=' + s + '-01&end=' + e + '-31');
      if (!r.ok) { box2.innerHTML = '<div class="empty">' + U.esc(r.msg || '加载失败') + '</div>'; return; }
      box2.innerHTML = '<div class="muted mb8">区间合计 <b style="color:#b7791f;font-size:15px">' + fmtM(r.data.total) + '</b> 元</div>' +
        Table.render([
          { title: '月份', key: 'month', width: 100 },
          { title: '月租车金额', key: 'monthly', width: 130, num: true },
          { title: '月租车笔数', key: 'monthlyCount', width: 110, num: true },
          { title: '临时停车金额', key: 'temp', width: 130, num: true },
          { title: '临时停车笔数', key: 'tempCount', width: 110, num: true },
          { title: '合计', key: 'total', width: 130, num: true }
        ], r.data.rows);
    };
    b.querySelector('#pkGo').onclick = load;
    load();
  }

  /* ==================== 3. 上期尾款 ==================== */
  async function renderArrears(box) {
    const view = CrudView({
      api: '/api/income/arrears', name: '上期尾款',
      searchPlaceholder: '单元 / 公司 / 摘要 / 期间',
      filters: [
        { key: 'settled', label: '全部状态', type: 'select', options: ['未结清', '已结清'] },
        { key: 'period', label: '按期间', width: 100, placeholder: '2026-06' }
      ],
      columns: [
        { title: '单元号', key: 'unitNo', width: 100 },
        { title: '公司名称', key: 'companyName', width: 190 },
        { title: '摘要', key: 'summary', width: 200 },
        { title: '金额', key: 'amount', width: 110, num: true },
        { title: '收入日期', key: 'incomeDate', width: 115 },
        { title: '余额', key: 'balance', width: 110, num: true, render: r => Number(r.balance) > 0 ? '<span style="color:#c53030;font-weight:600">' + fmtM(r.balance) + '</span>' : fmtM(r.balance) },
        { title: '收入途径', key: 'channel', width: 95 },
        { title: '所属期间', key: 'period', width: 100 },
        { title: '状态', key: 'settled', width: 100, render: r => U.tag(r.settled || '未结清', r.settled === '已结清' ? 'green' : 'orange') },
        { title: '备注', key: 'remark', width: 160 }
      ],
      fields: [
        { key: 'unitNo', label: '单元号', width: 110 },
        { key: 'companyName', label: '公司名称', width: 200, required: true },
        { key: 'summary', label: '摘要', width: 220, required: true, placeholder: '如：2026年5月房租尾款' },
        { key: 'amount', label: '金额（元）', type: 'number', width: 120, default: 0, required: true },
        { key: 'incomeDate', label: '收入日期', type: 'date', width: 120, default: todayStr() },
        { key: 'balance', label: '余额（未结清余额）', type: 'number', width: 140, default: 0 },
        { key: 'channel', label: '收入途径', type: 'select', options: CHANNELS, width: 100, default: '转账' },
        { key: 'period', label: '所属期间', width: 110, placeholder: '2026-06' },
        { key: 'settled', label: '是否结清', type: 'select', options: ['未结清', '已结清'], width: 110, default: '未结清' },
        { key: 'remark', label: '备注', type: 'textarea', span: 'full' }
      ],
      buttons: [
        { key: 'sum', label: '汇总统计', onClick: () => sumDlg() },
        ...(zapPerm('income:export') ? [{ key: 'exp', label: '导出 CSV', onClick: () => location.href = '/api/income/export/arrears' }] : [])
      ]
    });
    view.render(box);

    async function sumDlg() {
      const r = await GET('/api/income/arrearsSummary');
      if (!r.ok) return UI.toast(r.msg || '加载失败', 'err');
      const d = r.data;
      const html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
        '<div style="background:#fff;border:1px solid #e3eaf3;border-radius:6px;padding:10px 12px">' +
        '<div class="muted" style="font-size:12px">未结清余额</div>' +
        '<div style="font-size:20px;font-weight:700;color:#c53030">' + fmtM(d.unsettled) + '</div></div>' +
        '<div style="background:#f0fff4;border:1px solid #9ae6b4;border-radius:6px;padding:10px 12px">' +
        '<div class="muted" style="font-size:12px">已结清</div>' +
        '<div style="font-size:20px;font-weight:700;color:#1a7f37">' + fmtM(d.settled) + '</div></div></div>' +
        '<div class="mt12"><b>按收入途径</b><div class="mt8">' +
        Table.render([{ title: '途径', key: 'k', width: 110 }, { title: '金额', key: 'v', num: true }],
          Object.keys(d.byChannel).map(k => ({ k: k, v: d.byChannel[k] }))) + '</div></div>';
      UI.open({ title: '上期尾款汇总', body: html, width: 'md', hideCancel: true, okText: '关闭', onOk: () => { } });
    }
  }

  /* ==================== 4. 支出台账 ==================== */
  async function renderExpense(box) {
    const tabs = [{ k: 'list', n: '支出明细' }, { k: 'sum', n: '季度汇总' }];
    let sub = 'list';
    box.innerHTML = '<div class="tabs" style="margin-bottom:10px">' +
      tabs.map(t => '<div class="tab' + (t.k === sub ? ' active' : '') + '" data-sub="' + t.k + '">' + t.n + '</div>').join('') +
      '</div><div id="exBody"></div>';
    box.querySelectorAll('[data-sub]').forEach(t => {
      t.onclick = () => {
        box.querySelectorAll('[data-sub]').forEach(x => x.classList.remove('active'));
        t.classList.add('active'); sub = t.getAttribute('data-sub'); draw();
      };
    });
    function draw() {
      const b = box.querySelector('#exBody'); b.innerHTML = '';
      if (sub === 'sum') return drawExpSum(b);
      const view = CrudView({
        api: '/api/income/expenses', name: '支出记录',
        searchPlaceholder: '摘要 / 收款人 / 公司',
        filters: [
          { key: 'expCat', label: '全部类别', type: 'select', options: EXP_CATS },
          { key: 'channel', label: '全部途径', type: 'select', options: CHANNELS }
        ],
        columns: [
          { title: '日期', key: 'expDate', width: 110 },
          { title: '支出类别', key: 'expCat', width: 145, render: r => U.tag(r.expCat || '', r.expCat === '垫付支出' ? 'purple' : (r.expCat === '预提款支出' ? 'orange' : 'blue')) },
          { title: '摘要', key: 'summary', width: 210 },
          { title: '支出金额', key: 'amount', width: 110, num: true, render: r => '<b style="color:#c53030">' + fmtM(r.amount) + '</b>' },
          { title: '支付途径', key: 'channel', width: 95 },
          { title: '收款人', key: 'payee', width: 140 },
          { title: '单元号', key: 'unitNo', width: 95 },
          { title: '公司名称', key: 'companyName', width: 175 },
          { title: '所属期间', key: 'period', width: 100 },
          { title: '备注', key: 'remark', width: 150 }
        ],
        fields: [
          { key: 'expCat', label: '支出类别', type: 'select', options: EXP_CATS, width: 165, default: '日常费用支出', required: true },
          { key: 'expDate', label: '日期', type: 'date', width: 120, default: todayStr(), required: true },
          { key: 'summary', label: '摘要', width: 220, required: true },
          { key: 'amount', label: '支出金额（元）', type: 'number', width: 130, default: 0, required: true },
          { key: 'channel', label: '支付途径', type: 'select', options: CHANNELS, width: 100, default: '转账' },
          { key: 'payee', label: '收款人', width: 140, required: true },
          { key: 'unitNo', label: '关联单元号', width: 110, placeholder: '垫付支出时填写' },
          { key: 'companyName', label: '关联公司', width: 190 },
          { key: 'period', label: '所属期间', width: 110, placeholder: '2026-08' },
          { key: 'remark', label: '备注', type: 'textarea', span: 'full' }
        ],
        buttons: zapPerm('income:export') ? [{ key: 'exp', label: '导出 CSV', onClick: () => location.href = '/api/income/export/expense?start=' + curMonth() + '-01' }] : []
      });
      view.render(b);
    }
    draw();
  }

  async function drawExpSum(b) {
    const qr = quarterRange();
    b.innerHTML = '<div class="card"><div class="card-head"><h3>支出季度汇总（表8 同构）</h3><span class="spacer"></span>' +
      '<input type="month" id="exM1" value="' + qr.start + '" style="width:140px">' +
      '<input type="month" id="exM2" value="' + qr.end + '" style="width:140px">' +
      '<button class="btn btn-sm" id="exGo">查询</button></div><div class="card-body" id="exSum"></div>' +
      '<div class="card-head" style="border-top:1px solid #e3eaf3"><h3>预提款分段（按月摊销看数）</h3>' +
      '<span class="muted" style="margin-left:10px">预提款按季一次性计提，必须能拆到月看实际支出</span></div>' +
      '<div class="card-body" id="exSeg"></div></div>';
    b.querySelector('#exGo').onclick = load;
    b.querySelector('#exM2').onchange = load;

    // 预提款分段：跟着上面的区间一起刷
    async function loadSeg() {
      const s = b.querySelector('#exM1').value, e = b.querySelector('#exM2').value;
      const box3 = b.querySelector('#exSeg');
      box3.innerHTML = '<div class="empty">加载中…</div>';
      const r = await GET('/api/income/prepaidSegments?start=' + s + '-01&end=' + e + '-31');
      if (!r.ok) { box3.innerHTML = '<div class="empty">' + U.esc(r.msg || '加载失败') + '</div>'; return; }
      const d = r.data;
      const segs = d.segments || [];
      let h = '<div class="muted mb8">区间预提款 <b style="color:#b7791f;font-size:15px">' + fmtM(d.totalPrepaid) +
        '</b> 元 · 实际支出 <b style="color:#c53030;font-size:15px">' + fmtM(d.totalActual) + '</b> 元</div>';
      h += Table.render([
        { title: '月份', key: 'month', width: 100 },
        { title: '笔数', key: 'count', width: 70, num: true },
        { title: '预提款笔数', key: 'prepaidCount', width: 100, num: true },
        { title: '预提款支出', key: 'prepaid', width: 130, num: true, render: r2 => '<b style="color:#b7791f">' + fmtM(r2.prepaid) + '</b>' },
        { title: '实际支出', key: 'actual', width: 130, num: true, render: r2 => '<b style="color:#c53030">' + fmtM(r2.actual) + '</b>' },
        { title: '合计', key: 'total', width: 140, num: true }
      ], segs.concat([{ month: '总计', count: d.totalCount, prepaidCount: d.totalPrepaidCount, prepaid: d.totalPrepaid, actual: d.totalActual, total: d.totalAll }]));
      box3.innerHTML = h;
    }
    loadSeg();

    async function load() {
      const s = b.querySelector('#exM1').value, e = b.querySelector('#exM2').value;
      const box2 = b.querySelector('#exSum');
      box2.innerHTML = '<div class="empty">加载中…</div>';
      const r = await GET('/api/income/expenseSummary?start=' + s + '-01&end=' + e + '-31');
      if (!r.ok) { box2.innerHTML = '<div class="empty">' + U.esc(r.msg || '加载失败') + '</div>'; return; }
      const d = r.data, cats = d.cats || [];
      let h = '<div class="muted mb8">区间支出合计 <b style="color:#c53030;font-size:15px">' + fmtM(d.total) + '</b> 元</div>';
      h += Table.render([{ title: '月份', key: 'month', width: 100 }]
        .concat(cats.map(c => ({ title: c.name, key: c.name, width: 108, num: true })))
        .concat([{ title: '合计', key: 'total', width: 118, num: true }]),
        d.rows.map(row => {
          const o = { month: row.month, total: row.total };
          cats.forEach(c => o[c.name] = row.byCat[c.name] || 0);
          return o;
        }));
      box2.innerHTML = h;
    };
    b.querySelector('#exGo').onclick = load;
    load();
  }

  /* ==================== 4之二、表9 其他费用（六张台账） ====================
   * 对应真实文件（表9）其他费用.xlsx 的 6 个工作表：
   *   其他收入 / 其他支出 / 中介费 / 会议室收入 / 垫付收入 / 垫付支出
   * 每张表上方一条「按月分段小计」条，下方是该表的明细台账。
   */
  async function renderOther(box) {
    const qr = quarterRange();
    let meta = null, curKind = '';
    box.innerHTML = '<div class="card"><div class="card-head"><h3>表9 其他费用（六张台账）</h3><span class="spacer"></span>' +
      '<input type="month" id="otM1" value="' + qr.start + '" style="width:140px">' +
      '<input type="month" id="otM2" value="' + qr.end + '" style="width:140px">' +
      '<button class="btn btn-sm" id="otGo">查询</button>' +
      (zapPerm('income:export') ? '<button class="btn btn-sm btn-primary" id="otExp">导出表9 Excel</button>' : '') +
      '</div><div class="card-body tight"><div id="otTabs" class="tabs"></div><div id="otSum"></div></div></div>' +
      '<div id="otList"></div>';

    box.querySelector('#otGo').onclick = () => { loadSum(); drawList(); };
    box.querySelector('#otM2').onchange = () => { loadSum(); drawList(); };
    const eb = box.querySelector('#otExp');
    if (eb) eb.onclick = () => {
      location.href = '/api/income/export/other?start=' + box.querySelector('#otM1').value +
        '-01&end=' + box.querySelector('#otM2').value + '-31';
    };

    // 取一次元数据（六张表的列定义由后端下发，避免前后端各写一份字段表）
    async function ensureMeta() {
      if (meta) return meta;
      const r = await GET('/api/income/otherKinds');
      meta = (r.ok && r.data) ? r.data : { kinds: [], channels: CHANNELS };
      return meta;
    }

    async function loadSum() {
      const s = box.querySelector('#otM1').value, e = box.querySelector('#otM2').value;
      const tabsEl = box.querySelector('#otTabs'), sumEl = box.querySelector('#otSum');
      await ensureMeta();
      if (!curKind && meta.kinds.length) curKind = meta.kinds[0].key;
      tabsEl.innerHTML = meta.kinds.map(k =>
        '<div class="tab' + (k.key === curKind ? ' active' : '') + '" data-k="' + k.key + '">' +
        U.esc(k.name) + '</div>').join('');
      tabsEl.querySelectorAll('[data-k]').forEach(el => {
        el.onclick = () => { curKind = el.getAttribute('data-k'); loadSum(); drawList(); };
      });

      sumEl.innerHTML = '<div class="empty">加载中…</div>';
      const r = await GET('/api/income/otherSummary?start=' + s + '-01&end=' + e + '-31');
      if (!r.ok) { sumEl.innerHTML = '<div class="empty">' + U.esc(r.msg || '加载失败') + '</div>'; return; }
      const d = r.data;
      const t = (d.tables || []).find(x => x.key === curKind);
      if (!t) { sumEl.innerHTML = '<div class="empty">无数据</div>'; return; }
      const isIn = t.direction === 'in';
      const color = isIn ? '#1a7f37' : '#c53030';
      let h = '<div style="padding:10px 12px;background:#f7f9fc;border-bottom:1px solid #e8eef5">' +
        '区间合计 <b style="color:' + color + ';font-size:15px">' + fmtM(t.rangeTotal) + '</b> 元　' +
        '本月区间 ' + d.months[0] + ' ~ ' + d.months[d.months.length - 1] +
        '　<span class="muted">（该台账历史共 ' + t.count + ' 笔）</span></div>';
      // 按月分段小计 —— 真实表9 每张表右侧都有一列「汇总表：月份 / 金额」
      h += Table.render([
        { title: '月份', key: 'month', width: 110 },
        { title: '笔数', key: 'count', width: 80, num: true },
        { title: '金额', key: 'amount', width: 150, num: true, render: r2 => '<b style="color:' + color + '">' + fmtM(r2.amount) + '</b>' }
      ], (t.months || []).concat([{ month: '总计', count: (t.months || []).reduce((s2, x) => s2 + x.count, 0), amount: t.rangeTotal }]));
      sumEl.innerHTML = h;
    }

    // 明细台账：字段按当前台账类型动态生成（中介费/会议室有独有列）
    async function drawList() {
      const holder = box.querySelector('#otList');
      holder.innerHTML = '';
      await ensureMeta();
      const k = meta.kinds.find(x => x.key === curKind);
      if (!k) return;
      const isAgency = k.key === 'agency', isMeeting = k.key === 'meeting';
      const cols = [{ title: '收/支时间', key: 'occurDate', width: 110 }];
      if (isAgency) {
        cols.unshift({ title: '收款单位/人', key: 'companyName', width: 180 });
        cols.push({ title: '单据编号', key: 'docNo', width: 125 });
        cols.push({ title: '单元号', key: 'unitNo', width: 90 });
        cols.push({ title: '面积(㎡)', key: 'area', width: 90, num: true });
        cols.push({ title: '费用总金额', key: 'totalAmount', width: 115, num: true });
        cols.push({ title: '已付金额', key: 'paidAmount', width: 110, num: true });
        cols.push({ title: '未付金额', key: 'unpaidAmount', width: 110, num: true, render: r2 => Number(r2.unpaidAmount) > 0 ? '<b style="color:#c53030">' + fmtM(r2.unpaidAmount) + '</b>' : '0.00' });
        cols.push({ title: '备注', key: 'remark', width: 150 });
      } else if (isMeeting) {
        cols.push({ title: '单元号', key: 'unitNo', width: 90 });
        cols.push({ title: '公司名称', key: 'companyName', width: 180 });
        cols.push({ title: '金额', key: 'amount', width: 110, num: true, render: r2 => '<b style="color:#1a7f37">' + fmtM(r2.amount) + '</b>' });
        cols.push({ title: '使用日期', key: 'useDate', width: 105 });
        cols.push({ title: '使用时间', key: 'useTime', width: 130 });
        cols.push({ title: '税票情况', key: 'taxStatus', width: 110 });
        cols.push({ title: '余款', key: 'remain', width: 90, num: true });
        cols.push({ title: '备注', key: 'remark', width: 140 });
      } else {
        cols.push({ title: '单元号', key: 'unitNo', width: 90 });
        cols.push({ title: '公司名称', key: 'companyName', width: 180 });
        cols.push({ title: k.name.indexOf('支出') >= 0 ? '支出金额' : '收入金额', key: 'amount', width: 115, num: true, render: r2 => '<b style="color:' + (k.direction === 'in' ? '#1a7f37' : '#c53030') + '">' + fmtM(r2.amount) + '</b>' });
        cols.push({ title: '收/支途径', key: 'channel', width: 100 });
        cols.push({ title: '余款', key: 'remain', width: 90, num: true });
        cols.push({ title: '备注', key: 'remark', width: 150 });
      }
      const fields = [{ key: 'kind', label: '归属台账', type: 'select', options: meta.kinds.map(x => x.name), width: 165, default: k.name, required: true }];
      if (isAgency) {
        fields.push({ key: 'occurDate', label: '日期', type: 'date', width: 120, default: todayStr(), required: true });
        fields.push({ key: 'companyName', label: '收款单位/人', width: 200, required: true });
        fields.push({ key: 'docNo', label: '单据编号', width: 140 });
        fields.push({ key: 'unitNo', label: '单元号', width: 100 });
        fields.push({ key: 'area', label: '面积(㎡)', type: 'number', width: 110 });
        fields.push({ key: 'totalAmount', label: '费用总金额', type: 'number', width: 140, required: true });
        fields.push({ key: 'paidAmount', label: '已付金额', type: 'number', width: 130, default: 0 });
        fields.push({ key: 'channel', label: '收款途径', type: 'select', options: CHANNELS, width: 100, default: '转账' });
        fields.push({ key: 'remark', label: '备注', type: 'textarea', span: 'full' });
      } else if (isMeeting) {
        fields.push({ key: 'occurDate', label: '收入时间', type: 'date', width: 130, default: todayStr(), required: true });
        fields.push({ key: 'companyName', label: '公司名称', width: 200, required: true });
        fields.push({ key: 'unitNo', label: '单元号', width: 100 });
        fields.push({ key: 'amount', label: '收入金额（元）', type: 'number', width: 140, required: true });
        fields.push({ key: 'useDate', label: '使用日期', type: 'date', width: 140 });
        fields.push({ key: 'useTime', label: '使用时间', width: 150, placeholder: '如 09:00-12:00' });
        fields.push({ key: 'taxStatus', label: '税票情况', width: 130, placeholder: '已开普票 / 未开' });
        fields.push({ key: 'channel', label: '收款途径', type: 'select', options: CHANNELS, width: 100, default: '转账' });
        fields.push({ key: 'remark', label: '备注', type: 'textarea', span: 'full' });
      } else {
        fields.push({ key: 'occurDate', label: k.direction === 'in' ? '收入时间' : '支出时间', type: 'date', width: 130, default: todayStr(), required: true });
        fields.push({ key: 'unitNo', label: '单元号', width: 100 });
        fields.push({ key: 'companyName', label: '公司名称', width: 200, required: true });
        fields.push({ key: 'amount', label: (k.direction === 'in' ? '收入' : '支出') + '金额（元）', type: 'number', width: 140, required: true });
        fields.push({ key: 'channel', label: '收/支途径', type: 'select', options: CHANNELS, width: 100, default: '转账' });
        fields.push({ key: 'payee', label: '收款人', width: 140 });
        fields.push({ key: 'remain', label: '余款', type: 'number', width: 100, default: 0 });
        fields.push({ key: 'remark', label: '备注', type: 'textarea', span: 'full' });
      }
      const view = CrudView({
        api: '/api/income/otherItems', name: k.name,
        searchPlaceholder: '公司名称 / 单元号 / 单据编号 / 备注',
        // 用 extraQuery 而非 filters 默认值锁定当前台账（CrudView 的 filters 不支持初始值）
        extraQuery: { kind: k.name },
        hideSearch: false,
        columns: cols, fields: fields
      });
      const b = document.createElement('div');
      holder.appendChild(b);
      view.render(b);
    }

    loadSum(); drawList();
  }

  /* ==================== 5. 水电充值台账 ==================== */
  async function renderRecharge(box) {
    box.innerHTML = '<div class="card"><div class="card-head"><h3>水电充值台账（缴费账单同构）</h3><span class="spacer"></span>' +
      '<input type="text" id="rcKw" placeholder="搜索表号 / 户号 / 订单号 / 备注" style="width:230px">' +
      '<button class="btn btn-sm" id="rcGo">查询</button>' +
      (zapPerm('income:import') ? '<button class="btn btn-sm btn-primary" id="rcImp">导入缴费账单</button>' : '') +
      '</div><div class="card-body tight" id="rcBody"></div></div>';
    const load = async () => {
      const kw = box.querySelector('#rcKw').value;
      const s = box.querySelector('#rcBody');
      s.innerHTML = '<div class="empty">加载中…</div>';
      const r = await GET('/api/income/recharges?keyword=' + encodeURIComponent(kw) + '&size=300');
      if (!r.ok) { s.innerHTML = '<div class="empty">' + U.esc(r.msg || '加载失败') + '</div>'; return; }
      const d = r.data;
      s.innerHTML = '<div style="padding:10px 12px;background:#f7f9fc;border-bottom:1px solid #e8eef5">' +
        '共 <b>' + d.totalCount + '</b> 笔　充值 <b style="color:#1a7f37">' + fmtM(d.chargeTotal) + '</b> 元　' +
        '退费 <b style="color:#c53030">' + fmtM(d.refundTotal) + '</b> 元　净额 <b>' + fmtM(d.total) + '</b> 元' +
        '<span class="muted">（退费为负数，常见于照明/空调两表间挪账）</span></div>' +
        Table.render([
          { title: '时间', key: 'time', width: 145 },
          { title: '表号', key: 'meterNo', width: 100 },
          { title: '户号', key: 'accountNo', width: 100 },
          { title: '用户名', key: 'userName', width: 100 },
          { title: '安装地址', key: 'installAddr', width: 90 },
          { title: '充值方式', key: 'chargeType', width: 90 },
          { title: '操作员', key: 'operator', width: 80 },
          { title: '金额', key: 'amount', width: 95, num: true, render: r => '<span style="color:' + (Number(r.amount) < 0 ? '#c53030' : '#1a7f37') + ';font-weight:600">' + fmtM(r.amount) + '</span>' },
          { title: '操作', key: 'operation', width: 80, render: r => U.tag(r.operation, r.operation === '退费' ? 'red' : 'green') },
          { title: '订单号', key: 'orderNo', width: 200 },
          { title: '备注', key: 'remark', width: 160 }
        ], d.list);
    };
    box.querySelector('#rcGo').onclick = load;
    const ib = box.querySelector('#rcImp');
    if (ib) ib.onclick = () => UI.open({
      title: '导入水电充值台账', width: 'md',
      body: '<div class="muted mb8">支持该公司导出的「缴费账单.xlsx」。' +
        '识别列：时间 / 表号 / 户号 / 用户名 / 联系方式 / 表安装地址 / 充值方式 / 操作员 / 金额 / 操作 / 订单号 / 备注。<br>' +
        '「操作」列为<b>退费</b>或金额为负时，记为退费（挪账）。</div>' +
        '<select id="imMode" style="width:100%;margin-bottom:10px"><option value="append">追加（保留已有记录）</option><option value="cover">覆盖（清空后导入）</option></select>' +
        '<input type="file" id="imFile" accept=".xlsx,.xls" style="width:100%">',
      okText: '开始导入',
      onOk: mask => {
        const f = mask.querySelector('#imFile').files[0];
        if (!f) { UI.toast('请先选择文件', 'err'); return false; }
        const mode = mask.querySelector('#imMode').value;
        const fr = new FileReader();
        fr.onload = async () => {
          const r = await POST('/api/income/import/recharge', { fileName: f.name, fileBase64: fr.result, mode: mode });
          if (r.ok) { UI.toast('导入成功 ' + r.data.count + ' 条（退费 ' + r.data.refund + ' 条）', 'ok'); load(); }
          else UI.toast(r.msg || '导入失败', 'err');
        };
        fr.readAsDataURL(f);
        return false;
      }
    });
    load();
  }

  /* ==================== 6. 月表格一键生成 ==================== */
  async function renderMonthly(box) {
    const m0 = curMonth();
    box.innerHTML = '<div class="card"><div class="card-head"><h3>月表格一键生成</h3><span class="spacer"></span>' +
      '<input type="month" id="mtM" value="' + m0 + '" style="width:150px">' +
      '<button class="btn btn-sm" id="mtGo">生成</button>' +
      (zapPerm('income:export') ? '<button class="btn btn-sm btn-primary" id="mtExp">导出多表 Excel</button>' : '') +
      '</div><div class="card-body" id="mtBody"><div class="empty">选择月份后点「生成」</div></div></div>';
    box.querySelector('#mtGo').onclick = () => load(box.querySelector('#mtM').value);
    const eb = box.querySelector('#mtExp');
    if (eb) eb.onclick = () => { location.href = '/api/income/export/monthlyTables?month=' + box.querySelector('#mtM').value; };

    async function load(m) {
      const b = box.querySelector('#mtBody');
      b.innerHTML = '<div class="empty">生成中…</div>';
      const r = await GET('/api/income/monthlyTables?month=' + m);
      if (!r.ok) { b.innerHTML = '<div class="empty">' + U.esc(r.msg || '生成失败') + '</div>'; return; }
      const d = r.data;
      b.innerHTML = '<div class="muted mb8">共 ' + d.tables.length + ' 张表，与公司实际在用的「月表格」结构一致</div>' +
        '<div class="tabs" id="mtTabs">' + d.tables.map((t, i) =>
          '<div class="tab' + (i === 0 ? ' active' : '') + '" data-t="' + i + '">' + U.esc(t.name) + '</div>').join('') +
        '</div><div id="mtSheet"></div>';
      b.querySelectorAll('#mtTabs .tab').forEach(el => {
        el.onclick = () => {
          b.querySelectorAll('#mtTabs .tab').forEach(x => x.classList.remove('active'));
          el.classList.add('active');
          drawTable(d.tables[Number(el.getAttribute('data-t'))]);
        };
      });
      drawTable(d.tables[0]);

      function drawTable(t) {
        const box2 = b.querySelector('#mtSheet');
        box2.innerHTML = '<div class="muted mb8">' + U.esc(t.note || '') + '</div>' +
          '<div class="tabs" style="margin-bottom:8px">' + t.sheets.map((s, i) =>
            '<div class="tab' + (i === 0 ? ' active' : '') + '" data-s="' + i + '">' + U.esc(s.name) +
            '（' + ((s.rows && s.rows.length) || 0) + '）</div>').join('') + '</div><div id="mtOne"></div>';
        box2.querySelectorAll('[data-s]').forEach(el => {
          el.onclick = () => {
            box2.querySelectorAll('[data-s]').forEach(x => x.classList.remove('active'));
            el.classList.add('active');
            drawSheet(t.sheets[Number(el.getAttribute('data-s'))]);
          };
        });
        drawSheet(t.sheets[0]);
      }

      function drawSheet(s) {
        const head = s.head || [];
        const rows = (s.rows || []).slice(0, 500);
        let h = '<div style="max-height:540px;overflow:auto;border:1px solid #e3eaf3;border-radius:4px"><table class="tbl"><thead><tr>' +
          head.map(x => '<th>' + U.esc(x) + '</th>').join('') + '</tr></thead><tbody>';
        rows.forEach(r => {
          const cells = Array.isArray(r) ? r : head.map(x => r[x]);
          h += '<tr>' + cells.map(c => '<td>' + (isNumCell(c) ? fmtM(c) : U.esc(c === null || c === undefined ? '' : c)) + '</td>').join('') + '</tr>';
        });
        if (!rows.length) h += '<tr><td colspan="' + Math.max(1, head.length) + '" class="muted" style="text-align:center;padding:24px">本月暂无数据</td></tr>';
        h += '</tbody></table></div>';
        if (s.total !== undefined) {
          const tt = typeof s.total === 'number' ? { 合计: s.total } : s.total;
          h += '<div class="mt8 muted">合计：' + Object.keys(tt).map(k =>
            '<span style="margin-right:16px">' + U.esc(k) + ' <b style="color:#b7791f">' + fmtM(tt[k]) + '</b></span>').join('') + '</div>';
        }
        if ((s.rows || []).length > 500) h += '<div class="muted mt8">仅显示前 500 行，完整数据请导出 Excel</div>';
        b.querySelector('#mtOne').innerHTML = h;
      }
    }
  }
})();
