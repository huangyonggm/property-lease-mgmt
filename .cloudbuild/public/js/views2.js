/* 视图：合同管理 / 收费管理 / 发票管理 */
(function () {

  /* ============ 合同管理 ============ */
  App.view('contract', {
    title: '合同管理',
    async render(el) {
      const projects = await Cache.projects();
      const statuses = await GET('/api/contract/status');
      const v = CrudView({
        title: '合同管理', name: '合同', api: '/api/contract/contracts', size: 20, formWidth: 'wide', bizType: 'contract',
        exportUrl: '/api/report/export/contracts',
        filters: [
          { key: 'projectId', label: '项目', type: 'select', options: projects.map(p => ({ value: p.id, text: p.name })) },
          { key: 'status', label: '状态', type: 'select', options: statuses.data || [] },
          { key: 'expireSoon', label: '到期天数内', width: 90, type: 'number' }
        ],
        columns: [
          { title: '合同号', key: 'code', render: r => '<b class="mono">' + U.esc(r.code) + '</b>' },
          { title: '项目', key: 'projectName', width: 95 },
          { title: '房号', key: 'roomCodes', width: 150, render: r => '<span class="muted">' + U.esc((r.roomCodes || []).join('、')) + '</span>' },
          { title: '承租方', key: 'customerName', width: 170 },
          { title: '类型', key: 'customerType', width: 85, render: r => U.tag(r.customerType || '', (r.customerType === '个人客户' ? 'orange' : 'blue')) },
          { title: '面积', key: 'area', width: 75, num: true },
          { title: '单价', key: 'rentUnitPrice', width: 80, num: true, render: r => U.money(r.rentUnitPrice) + (r.taxIncluded ? '<span class="tag">含税</span>' : '<span class="tag cyan">不含税</span>') },
          { title: '月租金', key: 'rentMonthly', width: 100, render: r => '¥' + U.money(r.rentMonthly) },
          { title: '租期', key: 'x', width: 160, render: r => r.startDate + ' ~ ' + r.endDate },
          { title: '免租期', key: 'freeText', width: 90 },
          { title: '押金', key: 'deposit', width: 90, render: r => '¥' + U.money(r.deposit) },
          { title: '状态', key: 'status', width: 85, render: r => U.statusTag(r.status) },
          { title: '剩余', key: 'daysLeft', width: 75, render: r => r.daysLeft >= 0 ? r.daysLeft + ' 天' : '<span style="color:var(--danger)">已过期</span>' }
        ],
        actionWidth: 250,
        actions: r => '<button class="btn btn-sm" data-act2="detail">详情</button> <button class="btn btn-sm" data-act2="change">变更</button> ' +
          '<button class="btn btn-sm" data-act2="terminate">退租</button> <button class="btn btn-sm" data-act2="edit">编辑</button>',
        rowActions: {
          detail(row, done) { ContractDetail(row, done); },
          edit(row, done) { v.cfg._openForm(row, done); },
          change(row, done) { ContractChange(row, done); },
          terminate(row, done) { ContractTerminate(row, done); }
        },
        buttons: [
          { key: 'cmp', label: '★ 模板比对', cls: 'btn-primary', onClick: () => ContractCompareUpload() },
          { key: 'expire', label: '到期预警', onClick: () => ExpireList() },
          { key: 'recheck', label: '合同复核', onClick: () => RecheckList(v) },
          { key: 'cmpledger', label: '比对台账', onClick: () => ContractCompareLedger() },
          { key: 'cmptpl', label: '模板基线', onClick: () => ContractCompareTemplate() },
          { key: 'rent', label: '导出出租明细', onClick: () => window.open('/api/report/export/rent-detail?format=csv', '_blank') }
        ],
        fields: [
          { key: 'customerId', label: '承租方（客户）', type: 'select', options: [], optionsFrom: 'customers', required: true, span: 'full' },
          { key: 'projectId', label: '项目', type: 'select', options: projects.map(p => ({ value: p.id, text: p.name })) },
          { key: 'lessorName', label: '出租方名称' },
          { key: 'lessorCreditCode', label: '出租方信用代码' },
          { key: 'lessorContact', label: '出租方联系人' },
          { key: 'lessorPhone', label: '出租方电话' },
          { key: 'roomIds', label: '房源（可多选，支持合并/合租）', type: 'rooms', span: 'full', required: true },
          { key: 'startDate', label: '租期开始', type: 'date', required: true },
          { key: 'endDate', label: '租期结束', type: 'date', required: true },
          { key: 'rentUnitPrice', label: '租金单价（元/㎡/月）', type: 'number', required: true },
          { key: 'taxIncluded', label: '是否含税', type: 'select', options: ['是', '否'], default: '否' },
          { key: 'freeMonths', label: '免租期（月）', type: 'number', default: 0 },
          { key: 'deposit', label: '押金（元）', type: 'number' },
          { key: 'payCycle', label: '付款周期', type: 'select', options: ['月付', '季付', '半年付', '年付'], default: '月付' },
          { key: 'propertyUnit', label: '物业费单价（元/㎡/月）', type: 'number', default: 8 },
          { key: 'electricPrice', label: '电费单价（元/度）', type: 'number', default: 1 },
          { key: 'waterPrice', label: '水费单价（元/吨）', type: 'number', default: 4 },
          { key: 'cleaning', label: '室内保洁费（元/月）', type: 'number', default: 0 },
          { key: 'repair', label: '维修费（元/月，含专项维保）', type: 'number', default: 0 },
          { key: 'billingMode', label: '多房源核算方式', type: 'select', options: ['分开核算', '合并核算'], default: '分开核算' },
          { key: 'lesseeContact', label: '承租方联系人' },
          { key: 'lesseePhone', label: '承租方电话' },
          { key: 'attachments', label: '合同附件（扫描件）', type: 'files', span: 'full' },
          { key: 'remark', label: '备注', span: 'full', type: 'textarea' }
        ],
        optionSources: {
          customers: async () => (await Cache.customers()).map(c => ({ value: c.id, text: c.name }))
        },
        onFormMount(mask, values) {
          // 编辑时回填费用字段
          if (values.fees) {
            const f = values.fees;
            const set = (k, val) => { const e = mask.querySelector('[data-f="' + k + '"]'); if (e && val !== undefined) e.value = val; };
            set('propertyUnit', f.propertyUnit); set('electricPrice', f.electricPrice);
            set('waterPrice', f.waterPrice); set('cleaning', f.cleaning); set('repair', f.repair); set('billingMode', f.billingMode);
          }
          const ti = mask.querySelector('[data-f="taxIncluded"]');
          if (ti) ti.value = values.taxIncluded ? '是' : '否';
        },
        beforeSave(v) {
          v.taxIncluded = v.taxIncluded === '是';
          v.fees = {
            propertyUnit: U.num(v.propertyUnit), electricPrice: U.num(v.electricPrice), waterPrice: U.num(v.waterPrice),
            cleaning: U.num(v.cleaning), repair: U.num(v.repair), billingMode: v.billingMode || '分开核算'
          };
          ['propertyUnit', 'electricPrice', 'waterPrice', 'cleaning', 'repair', 'billingMode'].forEach(k => delete v[k]);
          if (v.freeMonths > 0 && v.startDate) { v.freeStart = v.startDate; v.freeEnd = U.addMonths(v.startDate, v.freeMonths); }
          return true;
        }
      });
      await v.render(el);
    }
  });

  window.ContractDetail = async function (row, done) {
    const r = await GET('/api/contract/contracts/' + row.id + '/detail');
    const d = r.data || {};
    const c = d.contract || row;
    UI.drawer('合同详情：' + c.code,
      '<div class="kv">' +
      kv('承租方', c.customerName) + kv('出租方', c.lessorName) +
      kv('房源', (c.roomCodes || []).join('、')) + kv('面积', c.area + ' ㎡') +
      kv('租金单价', U.money(c.rentUnitPrice) + ' 元/㎡/月（' + (c.taxIncluded ? '含税' : '不含税') + '）') +
      kv('月租金', '¥' + U.money(c.rentMonthly)) + kv('租期', c.startDate + ' ~ ' + c.endDate) +
      kv('免租期', c.freeMonths ? c.freeMonths + ' 个月（' + c.freeStart + ' ~ ' + c.freeEnd + '）' : '无') +
      kv('押金', '¥' + U.money(c.deposit) + '（' + (c.depositStatus || '未收') + ' / ' + (c.depositRefundStatus || '未退') + '）') +
      kv('付款周期', c.payCycle) + kv('状态', U.statusTag(c.status)) +
      kv('合同版本', 'v' + (c.version || 1)) +
      '</div>' +
      '<h4 class="mt12 mb8">费用设置</h4><div class="kv">' +
      kv('物业费单价', ((c.fees || {}).propertyUnit || 0) + ' 元/㎡/月') + kv('电费单价', ((c.fees || {}).electricPrice || 0) + ' 元/度') +
      kv('水费单价', ((c.fees || {}).waterPrice || 0) + ' 元/吨') + kv('保洁费', '¥' + U.money((c.fees || {}).cleaning)) +
      kv('维修费', '¥' + U.money((c.fees || {}).repair)) + kv('核算方式', (c.fees || {}).billingMode || '分开核算') +
      '</div>' +
      '<h4 class="mt12 mb8">账单（' + (d.bills || []).length + ' 条）</h4>' +
      Table.render([{ title: '账期', key: 'period' }, { title: '应收', key: 'totalAmount', num: true }, { title: '已收', key: 'paidAmount', num: true },
      { title: '状态', key: 'status', render: r => U.statusTag(r.status) }, { title: '开票', key: 'invoiceStatus' }], d.bills || []) +
      '<h4 class="mt12 mb8">变更留痕</h4>' +
      ((c.changeLog || []).length ? '<div class="timeline">' + c.changeLog.map(x =>
        '<div class="item"><div class="t">' + U.esc(x.time) + ' · ' + U.esc(x.user || '') + '</div><div><b>' + U.esc(x.action) + '</b> ' + U.esc(x.detail || '') + '</div></div>').join('') + '</div>'
        : '<div class="muted">暂无变更记录</div>') +
      '<h4 class="mt12 mb8">审批记录</h4>' +
      Table.render([{ title: '审批单', key: 'code' }, { title: '状态', key: 'status', render: r => U.statusTag(r.status) }], d.approvals || []) +
      '<div class="mt12"><button class="btn btn-primary" id="cChange">合同变更</button> <button class="btn btn-warn" id="cTerm">退租办理</button> ' +
      '<button class="btn" id="cPrint">打印合同信息</button></div>',
      mask => {
        mask.querySelector('#cChange').onclick = () => { UI.close(mask); ContractChange(row, done); };
        mask.querySelector('#cTerm').onclick = () => { UI.close(mask); ContractTerminate(row, done); };
        mask.querySelector('#cPrint').onclick = () => window.print();
      });
    function kv(k, val) { return '<div class="k">' + k + '</div><div>' + (val || '—') + '</div>'; }
  };

  window.ContractChange = function (row, done) {
    UI.open({
      title: '合同变更：' + row.code, width: 'wide',
      body: '<div class="mb12 muted">变更将生成留痕记录，版本号 +1。</div>' +
        Form.html([
          { key: 'rentUnitPrice', label: '租金单价（元/㎡/月）', type: 'number', default: row.rentUnitPrice },
          { key: 'taxIncluded', label: '是否含税', type: 'select', options: ['是', '否'], default: row.taxIncluded ? '是' : '否' },
          { key: 'startDate', label: '租期开始', type: 'date', default: row.startDate },
          { key: 'endDate', label: '租期结束', type: 'date', default: row.endDate },
          { key: 'freeMonths', label: '免租期（月）', type: 'number', default: row.freeMonths || 0 },
          { key: 'deposit', label: '押金', type: 'number', default: row.deposit },
          { key: 'payCycle', label: '付款周期', type: 'select', options: ['月付', '季付', '半年付', '年付'], default: row.payCycle },
          { key: 'roomIds', label: '房源（换房/增减）', type: 'rooms', span: 'full', default: row.roomIds },
          { key: 'electricPrice', label: '电费单价', type: 'number', default: (row.fees || {}).electricPrice },
          { key: 'waterPrice', label: '水费单价', type: 'number', default: (row.fees || {}).waterPrice },
          { key: 'propertyUnit', label: '物业费单价', type: 'number', default: (row.fees || {}).propertyUnit },
          { key: 'cleaning', label: '保洁费', type: 'number', default: (row.fees || {}).cleaning },
          { key: 'changeReason', label: '变更原因', span: 'full', type: 'textarea', required: true }
        ], row),
      onMount(m) { Form.bind(m, [{ key: 'roomIds', type: 'rooms' }], 'contract'); },
      onOk(m) {
        const v = Form.read(m, [{ key: 'rentUnitPrice', type: 'number' }, { key: 'taxIncluded' }, { key: 'startDate' }, { key: 'endDate' },
        { key: 'freeMonths', type: 'number' }, { key: 'deposit', type: 'number' }, { key: 'payCycle' }, { key: 'roomIds', type: 'rooms' },
        { key: 'electricPrice', type: 'number' }, { key: 'waterPrice', type: 'number' }, { key: 'propertyUnit', type: 'number' },
        { key: 'cleaning', type: 'number' }, { key: 'changeReason' }]);
        if (!v.changeReason) { UI.toast('请填写变更原因', 'err'); return false; }
        v.taxIncluded = v.taxIncluded === '是';
        v.fees = Object.assign({}, row.fees, { electricPrice: v.electricPrice, waterPrice: v.waterPrice, propertyUnit: v.propertyUnit, cleaning: v.cleaning });
        ['electricPrice', 'waterPrice', 'propertyUnit', 'cleaning'].forEach(k => delete v[k]);
        if (v.freeMonths > 0 && v.startDate) { v.freeStart = v.startDate; v.freeEnd = U.addMonths(v.startDate, v.freeMonths); }
        return POST('/api/contract/contracts/' + row.id + '/change', v).then(r => {
          if (!r.ok) { UI.toast(r.msg, 'err'); return false; }
          UI.toast('变更已保存，版本 v' + r.data.version, 'ok'); Cache.bust(); if (done) done();
        });
      }
    });
  };

  window.ContractTerminate = function (row, done) {
    UI.open({
      title: '退租 / 合同终止：' + row.code, width: 'wide',
      body: '<div class="mb12" style="background:var(--warn-soft);padding:10px;border-radius:6px;font-size:13px">' +
        '退租将生成退房单据，进入押金退回流程；系统自动核算欠费并列出水电表读数供核验。</div>' +
        Form.html([
          { key: 'outDate', label: '退租日期', type: 'date', default: U.today() },
          { key: 'mode', label: '处理方式', type: 'select', options: ['退租', '终止'], default: '退租' },
          { key: 'reason', label: '退租原因', type: 'select', options: ['合同到期', '客户主动退租', '违约清退', '房屋调换', '其他'] },
          { key: 'meterConfirmed', label: '水电读数已核对', type: 'select', options: ['否', '是'], default: '否' },
          { key: 'deductAmount', label: '押金扣款金额', type: 'number', default: 0 },
          { key: 'deductReason', label: '扣款原因' },
          { key: 'refundAmount', label: '应退押金（留空=押金-欠费）', type: 'number' },
          { key: 'remark', label: '备注', span: 'full', type: 'textarea' }
        ], {}),
      onOk(m) {
        const v = Form.read(m, [{ key: 'outDate' }, { key: 'mode' }, { key: 'reason' }, { key: 'meterConfirmed' },
        { key: 'deductAmount', type: 'number' }, { key: 'deductReason' }, { key: 'refundAmount', type: 'number' }, { key: 'remark' }]);
        v.meterConfirmed = v.meterConfirmed === '是';
        return POST('/api/contract/contracts/' + row.id + '/terminate', v).then(r => {
          if (!r.ok) { UI.toast(r.msg, 'err'); return false; }
          UI.toast('退房单 ' + r.data.checkout.code + ' 已生成，欠费 ¥' + U.money(r.data.arrears), 'ok');
          Cache.bust(); if (done) done();
        });
      }
    });
  };

  window.ExpireList = async function () {
    const r = await GET('/api/contract/expiring?months=6');
    UI.open({
      title: '合同到期预警（6 个月内）', width: 'wide', hideCancel: true,
      body: Table.render([{ title: '合同号', key: 'code' }, { title: '客户', key: 'customerName' }, { title: '房号', key: 'roomCodes', render: r => (r.roomCodes || []).join('、') },
      { title: '到期日', key: 'endDate' }, { title: '剩余天数', key: 'daysLeft', num: true }, { title: '级别', key: 'level', render: r => U.statusTag(r.level) },
      { title: '联系人', key: 'contact' }, { title: '电话', key: 'phone' }], r.data.list || [])
    });
  };

  window.RecheckList = async function (v) {
    const r = await GET('/api/contract/recheck?months=3');
    UI.open({
      title: '合同履约复核（3 个月未复核）', width: 'wide', hideCancel: true,
      body: Table.render([{ title: '合同号', key: 'code' }, { title: '客户', key: 'customerName' }, { title: '房号', key: 'roomCodes', render: r => (r.roomCodes || []).join('、') },
      { title: '上次复核', key: 'lastRecheck' }, { title: '已过天数', key: 'elapsedDays', num: true },
      { title: '操作', key: 'id', render: r => '<button class="btn btn-sm" data-recheck="' + r.id + '">标记已复核</button>' }], r.data.list || []),
      onMount(mask) {
        mask.querySelectorAll('[data-recheck]').forEach(b => {
          b.onclick = () => POST('/api/contract/contracts/' + b.getAttribute('data-recheck') + '/recheck', { result: '已完成履约复核' })
            .then(() => { UI.toast('已复核', 'ok'); b.disabled = true; b.textContent = '已复核'; });
        });
      }
    });
  };

  /* ============ 收费管理 ============ */
  App.view('billing', {
    title: '收费管理',
    async render(el) {
      const tabs = [
        { key: 'bill', name: '账单' }, { key: 'pay', name: '收款' }, { key: 'meter', name: '抄表' },
        { key: 'shared', name: '公摊电费' }, { key: 'deposit', name: '押金' }, { key: 'arrears', name: '欠费催收' }
      ];
      let cur = 'bill';
      el.innerHTML = '<div class="tabs">' + tabs.map(t => '<div class="tab' + (t.key === cur ? ' active' : '') + '" data-tab="' + t.key + '">' + t.name + '</div>').join('') +
        '</div><div id="blBody"></div>';
      el.querySelectorAll('[data-tab]').forEach(t => {
        t.onclick = () => { el.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('active')); t.classList.add('active'); cur = t.getAttribute('data-tab'); renderTab(); };
      });

      async function renderTab() {
        const box = el.querySelector('#blBody');
        box.innerHTML = '';
        const projects = await Cache.projects();
        if (cur === 'bill') {
          const v = CrudView({
            title: '账单', name: '账单', api: '/api/finance/bills', size: 20, formWidth: 'wide', hideAdd: true,
            exportUrl: '/api/report/export/bills',
            filters: [
              { key: 'projectId', label: '项目', type: 'select', options: projects.map(p => ({ value: p.id, text: p.name })) },
              { key: 'period', label: '账期', width: 110, type: 'month' },
              { key: 'status', label: '状态', type: 'select', options: ['未收款', '部分收款', '已收款', '逾期'] },
              { key: 'customerName', label: '客户' }
            ],
            columns: [
              { title: '账单号', key: 'code', render: r => '<b class="mono">' + U.esc(r.code) + '</b>' + (r.crossMonth ? ' <span class="tag purple">跨月</span>' : '') },
              { title: '账期', key: 'period', width: 80 },
              { title: '项目', key: 'projectName', width: 90 },
              { title: '房号', key: 'roomCodes', width: 150, render: r => '<span class="muted">' + U.esc((r.roomCodes || []).join('、')) + '</span>' },
              { title: '客户', key: 'customerName', width: 160 },
              { title: '应收', key: 'totalAmount', width: 100, num: true, render: r => '¥' + U.money(r.totalAmount) },
              { title: '已收', key: 'paidAmount', width: 100, num: true },
              { title: '欠费', key: 'arrears', width: 100, render: r => r.arrears > 0 ? '<b style="color:var(--danger)">' + U.money(r.arrears) + '</b>' : '<span class="muted">0.00</span>' },
              { title: '状态', key: 'status', width: 85, render: r => U.statusTag(r.status) },
              { title: '开票', key: 'invoiceStatus', width: 80 },
              { title: '逾期天数', key: 'overdueDays', width: 80, render: r => r.overdueDays ? '<span style="color:var(--danger)">' + r.overdueDays + ' 天</span>' : '—' }
            ],
            actionWidth: 220,
            actions: r => '<button class="btn btn-sm" data-act2="detail">明细</button> ' +
              (r.arrears > 0.01 ? '<button class="btn btn-sm btn-success" data-act2="pay">收款</button> ' : '') +
              '<button class="btn btn-sm" data-act2="adjust">调整</button>',
            rowActions: {
              detail(row) { BillDetail(row); },
              pay(row, done) { BillPay(row, done); },
              adjust(row, done) { BillAdjust(row, done); }
            },
            buttons: [
              { key: 'gen', label: '生成月账单', cls: 'btn-primary', onClick: () => GenBills(v) },
              { key: 'vacant', label: '空置房基础电费', onClick: () => GenVacant(v) },
              { key: 'close', label: '月末记账', onClick: () => CloseMonth(v) },
              { key: 'daily', label: '当日收款汇总', onClick: () => DailySum() },
              { key: 'monthly', label: '月度费用汇总', onClick: () => MonthlySum() }
            ]
          });
          await v.render(box);
        } else if (cur === 'pay') {
          const r = await GET('/api/finance/payments?size=300');
          const today = await GET('/api/finance/daily');
          box.innerHTML = '<div class="stat-grid mb12">' +
            '<div class="stat green"><span class="bar"></span><div class="k">今日收款</div><div class="v">¥' + U.money(today.data.total) + '</div><div class="s">' + today.data.count + ' 笔</div></div>' +
            Object.keys(today.data.byMethod || {}).map(k => '<div class="stat blue"><span class="bar"></span><div class="k">' + U.esc(k) + '</div><div class="v">¥' + U.money(today.data.byMethod[k]) + '</div></div>').join('') +
            '</div>' +
            '<div class="card"><div class="card-head"><h3>收款记录</h3><span class="spacer"></span>' +
            '<input type="date" id="payDate" value="' + U.today() + '" style="width:auto">' +
            '<button class="btn btn-sm" id="qPay">查询当日</button>' +
            '<button class="btn btn-sm" onclick="window.open(\'/api/report/export/payments?format=csv\',\'_blank\')">导出</button></div>' +
            '<div class="card-body tight" id="payList">' +
            Table.render([{ title: '收款单号', key: 'code' }, { title: '日期', key: 'date' }, { title: '账单号', key: 'billCode' },
            { title: '房号', key: 'roomCodes', render: r => (r.roomCodes || []).join('、') }, { title: '客户', key: 'customerName' },
            { title: '金额', key: 'amount', num: true }, { title: '方式', key: 'method' }, { title: '收款人', key: 'by' }], r.data.list || []) +
            '</div></div>';
          box.querySelector('#qPay').onclick = async () => {
            const d = box.querySelector('#payDate').value;
            const r2 = await GET('/api/finance/payments?date=' + d + '&size=300');
            box.querySelector('#payList').innerHTML = Table.render([{ title: '收款单号', key: 'code' }, { title: '日期', key: 'date' },
            { title: '账单号', key: 'billCode' }, { title: '房号', key: 'roomCodes', render: r => (r.roomCodes || []).join('、') },
            { title: '客户', key: 'customerName' }, { title: '金额', key: 'amount', num: true }, { title: '方式', key: 'method' }, { title: '收款人', key: 'by' }], r2.data.list || []);
          };
        } else if (cur === 'meter') {
          const m = await GET('/api/finance/meters?size=500');
          const rd = await GET('/api/finance/readings?size=500');
          box.innerHTML = '<div class="card"><div class="card-head"><h3>表具与抄表</h3><span class="spacer"></span>' +
            '<button class="btn btn-primary btn-sm" id="addMeter">+ 新增表具</button> ' +
            '<button class="btn btn-sm" id="batchRead">批量抄表录入</button> ' +
            '<button class="btn btn-sm" id="importElectric">⬇ 电表导入</button> ' +
            '<button class="btn btn-sm" id="importWater">⬇ 水表导入</button> ' +
            '<button class="btn btn-sm" id="anomaly">用电异常监控</button> ' +
            '<button class="btn btn-sm" id="verify">数据核对</button></div><div class="card-body tight">' +
            '<div class="tabs" style="margin:0 0 8px"><div class="tab active" data-mt="电表">电表</div><div class="tab" data-mt="水表">水表</div></div>' +
            '<div id="meterBox"></div></div></div>' +
            '<div class="card mt12"><div class="card-head"><h3>最近抄表记录</h3></div><div class="card-body tight">' +
            Table.render([{ title: '表号', key: 'meterNo' }, { title: '类型', key: 'meterType' }, { title: '房号', key: 'roomCode' },
            { title: '账期', key: 'period' }, { title: '抄表日期', key: 'date' }, { title: '本期读数', key: 'value', num: true },
            { title: '上期读数', key: 'prevValue', num: true }, { title: '用量', key: 'usage', num: true },
            { title: '抄表人', key: 'by' },
            { title: '操作', key: 'id', render: r => '<button class="btn btn-sm" data-fix="' + r.id + '">修正</button>' }],
              (rd.data.list || []).slice(0, 200)) + '</div></div>';

          const drawMeters = type => {
            const list = (m.data.list || []).filter(x => x.type === type);
            box.querySelector('#meterBox').innerHTML = Table.render([
              { title: '表号', key: 'meterNo' }, { title: '类型', key: 'type' }, { title: '房号', key: 'roomCode' },
              { title: '底数', key: 'initValue', num: true },
              { title: '最近读数', key: 'lastReading', render: r => r.lastReading ? r.lastReading.value + '（' + r.lastReading.period + '）' : '—' },
              { title: '抄表次数', key: 'readingCount', num: true }, { title: '状态', key: 'status' }], list);
          };
          drawMeters('电表');
          box.querySelectorAll('[data-mt]').forEach(t => t.onclick = () => {
            box.querySelectorAll('[data-mt]').forEach(x => x.classList.remove('active'));
            t.classList.add('active'); drawMeters(t.getAttribute('data-mt'));
          });
          box.querySelector('#addMeter').onclick = async () => {
            const rooms = await Cache.rooms();
            UI.open({
              title: '新增表具', body: Form.html([
                { key: 'type', label: '表具类型', type: 'select', options: ['电表', '水表'], default: '电表' },
                { key: 'meterNo', label: '表号', required: true },
                { key: 'roomId', label: '所属房间', type: 'select', options: rooms.slice(0, 1500).map(r => ({ value: r.id, text: r.code })), required: true },
                { key: 'initValue', label: '初始底数', type: 'number', default: 0 },
                { key: 'remark', label: '备注', span: 'full' }
              ], {}),
              onOk(mask) {
                const v = Form.read(mask, [{ key: 'type' }, { key: 'meterNo' }, { key: 'roomId' }, { key: 'initValue', type: 'number' }, { key: 'remark' }]);
                const room = rooms.filter(r => r.id === v.roomId)[0] || {};
                return POST('/api/finance/meters', Object.assign(v, { buildingId: room.buildingId, projectId: room.projectId, rate: 1, status: '启用' }))
                  .then(() => { UI.toast('已新增', 'ok'); setTimeout(renderTab, 300); });
              }
            });
          };
          box.querySelector('#batchRead').onclick = () => BatchRead(renderTab);
          // 电表导入
          box.querySelector('#importElectric').onclick = () => MeterImport('electric', renderTab);
          // 水表导入
          box.querySelector('#importWater').onclick = () => MeterImport('water', renderTab);
          box.querySelector('#anomaly').onclick = async () => {
            const r2 = await GET('/api/finance/electric-anomaly?period=' + U.month());
            UI.open({
              title: '用电异常监控（偷电排查）', width: 'wide', hideCancel: true,
              body: r2.data.length ? Table.render([{ title: '房号', key: 'roomCode' }, { title: '表号', key: 'meterNo' },
              { title: '面积', key: 'area', num: true }, { title: '本期用电', key: 'usage', num: true },
              { title: '单位面积用电', key: 'perSqm', num: true }, { title: '客户', key: 'customerName' },
              { title: '异常判定', key: 'flag', render: r => U.tag(r.flag, 'red') }], r2.data)
                : '<div class="empty">本期未发现用电异常</div>'
            });
          };
          box.querySelector('#verify').onclick = async () => {
            const r2 = await GET('/api/system/verify?period=' + U.month());
            UI.open({
              title: '旧系统数据核对（电表读数）', width: 'wide', hideCancel: true,
              body: '<div class="mb8 muted">共发现 ' + r2.data.count + ' 条异常</div>' +
                Table.render([{ title: '表号', key: 'meterNo' }, { title: '房号', key: 'roomCode' }, { title: '问题', key: 'issue' }], r2.data.issues)
            });
          };
          box.querySelectorAll('[data-fix]').forEach(b => b.onclick = () => FixReading(b.getAttribute('data-fix'), renderTab));
        } else if (cur === 'shared') {
          const buildings = await Cache.buildings();
          const recs = await GET('/api/finance/shared-electric');
          box.innerHTML = '<div class="card"><div class="card-head"><h3>整层公摊电费分摊</h3><span class="spacer"></span>' +
            '<button class="btn btn-primary btn-sm" id="doShared">+ 新建分摊</button></div>' +
            '<div class="card-body"><div class="muted mb12">按楼层总表用电量，按 <b>面积 / 平均 / 用量</b> 三种方式分摊到各房间，并写入当期账单。</div>' +
            Table.render([{ title: '账期', key: 'period' }, { title: '楼栋', key: 'buildingId', render: r => ((buildings.filter(b => b.id === r.buildingId)[0] || {}).name || r.buildingId) },
            { title: '楼层', key: 'floor' }, { title: '总电量', key: 'totalKwh', num: true }, { title: '总电费', key: 'totalFee', num: true },
            { title: '方式', key: 'mode' }, { title: '分摊间数', key: 'rows', render: r => (r.rows || []).length }, { title: '经办人', key: 'by' },
            { title: '操作', key: 'id', render: r => '<button class="btn btn-sm" data-view="' + r.id + '">明细</button>' }], recs.data || []) +
            '</div></div>';
          box.querySelector('#doShared').onclick = () => SharedForm(buildings, renderTab);
          box.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
            const rec = (recs.data || []).filter(x => x.id === b.getAttribute('data-view'))[0];
            UI.open({
              title: '分摊明细', width: 'wide', hideCancel: true,
              body: Table.render([{ title: '房号', key: 'roomCode' }, { title: '面积(㎡)', key: 'area', num: true },
              { title: '用电量', key: 'usage', num: true }, { title: '分摊电费', key: 'shareFee', num: true }], rec.rows || [])
            });
          });
        } else if (cur === 'deposit') {
          const r = await GET('/api/finance/deposits');
          const s = r.data.sum || {};
          box.innerHTML = '<div class="stat-grid mb12">' +
            '<div class="stat blue"><span class="bar"></span><div class="k">押金收取总额</div><div class="v">¥' + U.money(s.total) + '</div></div>' +
            '<div class="stat green"><span class="bar"></span><div class="k">在管押金</div><div class="v">¥' + U.money(s.holding) + '</div></div>' +
            '<div class="stat orange"><span class="bar"></span><div class="k">待退回</div><div class="v">¥' + U.money(s.pending) + '</div></div>' +
            '<div class="stat cyan"><span class="bar"></span><div class="k">已退回</div><div class="v">¥' + U.money(s.refunded) + '</div></div>' +
            '</div><div class="card"><div class="card-head"><h3>押金台账</h3><span class="spacer"></span>' +
            '<button class="btn btn-sm" onclick="window.open(\'/api/report/export/deposits?format=csv\',\'_blank\')">导出</button></div>' +
            '<div class="card-body tight">' +
            Table.render([{ title: '合同号', key: 'contractCode' }, { title: '客户', key: 'customerName' }, { title: '类型', key: 'type' },
            { title: '金额', key: 'amount', num: true }, { title: '日期', key: 'date' }, { title: '状态', key: 'status', render: r => U.statusTag(r.status) },
            { title: '已退', key: 'refundAmount', num: true }, { title: '扣款', key: 'deductAmount', num: true }, { title: '扣款原因', key: 'deductReason' },
            { title: '操作', key: 'id', render: r => (r.status !== '已退回' ? '<button class="btn btn-sm btn-success" data-refund="' + r.id + '">退回</button>' : '') }],
              r.data.list || []) + '</div></div>';
          box.querySelectorAll('[data-refund]').forEach(b => b.onclick = () => {
            UI.open({
              title: '押金退回', body: Form.html([
                { key: 'refundAmount', label: '退回金额', type: 'number', required: true },
                { key: 'deductAmount', label: '扣款金额', type: 'number', default: 0 },
                { key: 'deductReason', label: '扣款原因' },
                { key: 'refundDate', label: '退回日期', type: 'date', default: U.today() }
              ], {}),
              onOk(m) {
                const v = Form.read(m, [{ key: 'refundAmount', type: 'number' }, { key: 'deductAmount', type: 'number' }, { key: 'deductReason' }, { key: 'refundDate' }]);
                return POST('/api/finance/deposits/' + b.getAttribute('data-refund') + '/refund', v).then(() => { UI.toast('已退回', 'ok'); setTimeout(renderTab, 300); });
              }
            });
          });
        } else {
          const r = await GET('/api/report/arrears');
          const d = r.data || {};
          box.innerHTML = '<div class="card"><div class="card-head"><h3>欠费客户清单</h3><span class="spacer"></span>' +
            '<span class="muted">合计欠费 ¥' + U.money(d.amount) + ' / ' + (d.total || 0) + ' 笔</span> ' +
            '<button class="btn btn-sm" onclick="window.open(\'/api/report/export/bills?format=csv\',\'_blank\')">导出账单</button></div>' +
            '<div class="card-body tight">' +
            Table.render([{ title: '客户', key: 'customerName' }, { title: '联系人', key: 'contact' }, { title: '电话', key: 'phone' },
            { title: '通讯地址', key: 'address' }, { title: '欠费金额', key: 'amount', num: true, render: r => '<b style="color:var(--danger)">¥' + U.money(r.amount) + '</b>' },
            { title: '笔数', key: 'count', num: true }, { title: '最长逾期', key: 'maxOverdue', num: true },
            { title: '操作', key: 'customerName', render: r => '<button class="btn btn-sm" data-detail="' + U.esc(r.customerName) + '">账单明细</button>' }],
              d.byCustomer || []) + '</div></div>' +
            '<div class="card mt12"><div class="card-head"><h3>欠费账单明细</h3></div><div class="card-body tight">' +
            Table.render([{ title: '账单号', key: 'billCode' }, { title: '账期', key: 'period' }, { title: '客户', key: 'customerName' },
            { title: '房号', key: 'roomCodes', render: r => (r.roomCodes || []).join('、') }, { title: '项目', key: 'projectName' },
            { title: '欠费', key: 'arrears', num: true }, { title: '逾期天数', key: 'overdueDays', num: true },
            { title: '状态', key: 'status', render: r => U.statusTag(r.status) }], (d.list || []).slice(0, 200)) + '</div></div>';
        }
      }
      await renderTab();
    }
  });

  window.BillDetail = async function (row) {
    const r = await GET('/api/finance/bills/' + row.id);
    const b = r.data || row;
    UI.drawer('账单明细：' + b.code,
      '<div class="kv">' +
      '<div class="k">账单号</div><div class="mono">' + U.esc(b.code) + '</div>' +
      '<div class="k">账期</div><div>' + U.esc(b.period) + (b.crossMonth ? ' <span class="tag purple">跨月</span>' : '') + '</div>' +
      '<div class="k">客户</div><div>' + U.esc(b.customerName) + '</div>' +
      '<div class="k">房号</div><div>' + U.esc((b.roomCodes || []).join('、')) + '</div>' +
      '<div class="k">合同号</div><div class="mono">' + U.esc(b.contractCode || '—') + '</div>' +
      '<div class="k">应收日期</div><div>' + U.esc(b.dueDate) + '</div>' +
      '<div class="k">状态</div><div>' + U.statusTag(b.status) + '</div>' +
      '</div>' +
      '<h4 class="mt12 mb8">费用明细（数量 / 单价 / 金额 / 税率 / 税额）</h4>' +
      '<table class="tbl"><thead><tr><th>费用项</th><th class="right">数量</th><th>单位</th><th class="right">单价</th><th class="right">金额</th><th class="right">税率</th><th class="right">税额</th></tr></thead><tbody>' +
      (b.items || []).map(it => '<tr><td>' + U.esc(it.name) + '</td><td class="num">' + U.money(it.qty, 2) + '</td><td>' + U.esc(it.unit || '') +
        '</td><td class="num">' + U.money(it.price) + '</td><td class="num"><b>' + U.money(it.amount) + '</b></td><td class="num">' + (it.taxRate || 0) + '%</td><td class="num">' + U.money(it.taxAmount) + '</td></tr>').join('') +
      '<tr><td colspan="4" class="right b">合计</td><td class="num b">' + U.money(b.totalAmount) + '</td><td></td><td class="num">' + U.money(b.taxAmount) + '</td></tr>' +
      '</tbody></table>' +
      '<div class="mt12"><button class="btn btn-primary" id="bPay">登记收款</button> <button class="btn" id="bAdj">费用调整</button></div>',
      mask => {
        mask.querySelector('#bPay').onclick = () => { UI.close(mask); BillPay(b); };
        mask.querySelector('#bAdj').onclick = () => { UI.close(mask); BillAdjust(b); };
      });
  };

  window.BillPay = function (row, done) {
    const arrears = U.money(row.totalAmount - row.paidAmount);
    UI.open({
      title: '收款登记：' + row.code,
      body: '<div class="mb12 muted">账单金额 ¥' + U.money(row.totalAmount) + '，已收 ¥' + U.money(row.paidAmount) + '，<b>欠费 ¥' + arrears + '</b></div>' +
        Form.html([
          { key: 'amount', label: '收款金额', type: 'number', required: true, default: row.totalAmount - row.paidAmount },
          { key: 'date', label: '收款日期', type: 'date', default: U.today() },
          { key: 'method', label: '收款方式', type: 'select', options: ['银行转账', '支付宝', '微信', '现金', '电汇', '支票'], default: '银行转账' },
          { key: 'remark', label: '备注（核对房号/电表号）', span: 'full', type: 'textarea' }
        ], {}),
      onOk(m) {
        const v = Form.read(m, [{ key: 'amount', type: 'number' }, { key: 'date' }, { key: 'method' }, { key: 'remark' }]);
        return POST('/api/finance/bills/' + row.id + '/pay', v).then(r => {
          if (!r.ok) { UI.toast(r.msg, 'err'); return false; }
          UI.toast('收款成功', 'ok'); Cache.bust(); if (done) done();
        });
      }
    });
  };

  window.BillAdjust = async function (row, done) {
    const r = await GET('/api/finance/bills/' + row.id);
    const b = r.data || row;
    UI.open({
      title: '费用调整：' + b.code, width: 'wide',
      body: '<div class="mb8 muted">可修改数量 / 单价 / 金额，勾选“按 数量×单价 重算”自动刷新金额。</div>' +
        '<div id="itemsBox">' + (b.items || []).map((it, i) =>
          '<div class="flex mb8" data-item="' + i + '">' +
          '<input type="text" value="' + U.esc(it.name) + '" data-k="name" style="width:110px">' +
          '<input type="number" value="' + U.num(it.qty) + '" data-k="qty" style="width:80px" title="数量">' +
          '<input type="text" value="' + U.esc(it.unit || '') + '" data-k="unit" style="width:60px">' +
          '<input type="number" value="' + U.num(it.price) + '" data-k="price" style="width:80px" step="0.01" title="单价">' +
          '<input type="number" value="' + U.num(it.amount) + '" data-k="amount" style="width:100px" step="0.01" title="金额">' +
          '<input type="number" value="' + U.num(it.taxRate) + '" data-k="taxRate" style="width:60px" title="税率%">' +
          '</div>').join('') + '</div>' +
        '<label class="inline mt8"><input type="checkbox" id="recalc" checked> 按 数量×单价 重算金额</label>' +
        '<div class="mt8"><label class="fld">调整原因（留痕）</label><input type="text" id="adjReason" placeholder="如：单价调整 / 房间调整"></div>' +
        '<div class="mt8"><label class="fld">备注</label><input type="text" id="adjRemark" value="' + U.esc(b.remark || '') + '"></div>',
      onOk(m) {
        const items = [];
        m.querySelectorAll('[data-item]').forEach(div => {
          const g = k => div.querySelector('[data-k="' + k + '"]').value;
          items.push({
            name: g('name'), qty: U.num(g('qty')), unit: g('unit'), price: U.num(g('price')),
            amount: U.num(g('amount')), taxRate: U.num(g('taxRate')), category: (b.items[Number(div.getAttribute('data-item'))] || {}).category || '杂费',
            taxAmount: 0
          });
        });
        return POST('/api/finance/bills/' + b.id + '/adjust', {
          items: items, recalc: m.querySelector('#recalc').checked,
          reason: m.querySelector('#adjReason').value, remark: m.querySelector('#adjRemark').value
        }).then(r => {
          if (!r.ok) { UI.toast(r.msg, 'err'); return false; }
          UI.toast('已调整', 'ok'); Cache.bust(); if (done) done();
        });
      }
    });
  };

  window.GenBills = function (v) {
    UI.open({
      title: '生成月账单',
      body: '<div class="mb12 muted">按生效合同逐月生成账单：租金（免租期自动减免）、物业费、水电（按抄表用量）、保洁费、维修费。</div>' +
        Form.html([
          { key: 'period', label: '账期', type: 'month', default: U.month(), required: true },
          { key: 'vacantElectric', label: '同时生成空置房基础电费', type: 'select', options: ['是', '否'], default: '是' },
          { key: 'crossMonth', label: '标记为跨月账单', type: 'select', options: ['否', '是'], default: '否' }
        ], {}),
      onOk(m) {
        const v2 = Form.read(m, [{ key: 'period' }, { key: 'vacantElectric' }, { key: 'crossMonth' }]);
        return POST('/api/finance/bills/generate', {
          period: v2.period, vacantElectric: v2.vacantElectric === '是', crossMonth: v2.crossMonth === '是'
        }).then(r => {
          if (!r.ok) { UI.toast(r.msg, 'err'); return false; }
          UI.toast('生成 ' + r.data.created + ' 条，跳过 ' + r.data.skipped + ' 条；空置电费 ' + (r.data.vacant || {}).created + ' 条', 'ok');
          Cache.bust(); v.cfg._refresh();
        });
      }
    });
  };

  window.GenVacant = function (v) {
    UI.open({
      title: '生成空置房基础电费',
      body: '<div class="muted mb12">空置房间也会产生基础电费（5~10 元/月），按设置的区间取中值生成。</div>' +
        Form.html([{ key: 'period', label: '账期', type: 'month', default: U.month() }], {}),
      onOk(m) {
        return POST('/api/finance/vacant-electric', { period: Form.read(m, [{ key: 'period' }]).period })
          .then(r => { UI.toast('生成 ' + r.data.created + ' 条，金额 ¥' + U.money(r.data.amount), 'ok'); Cache.bust(); v.cfg._refresh(); });
      }
    });
  };

  window.CloseMonth = function (v) {
    UI.open({
      title: '月末记账',
      body: '<div class="muted mb12">将本期未收清账单标记为逾期，并锁定账期。</div>' +
        Form.html([{ key: 'period', label: '账期', type: 'month', default: U.month() }], {}),
      onOk(m) {
        return POST('/api/finance/bills/close', { period: Form.read(m, [{ key: 'period' }]).period })
          .then(r => { UI.toast('已记账 ' + r.data.count + ' 条', 'ok'); v.cfg._refresh(); });
      }
    });
  };

  window.DailySum = async function () {
    const r = await GET('/api/finance/daily');
    const d = r.data;
    UI.open({
      title: '当日收款汇总（' + d.date + '）', width: 'wide', hideCancel: true,
      body: '<div class="stat-grid mb12"><div class="stat green"><span class="bar"></span><div class="k">当日收款合计</div><div class="v">¥' + U.money(d.total) + '</div><div class="s">' + d.count + ' 笔</div></div>' +
        Object.keys(d.byProject || {}).map(k => '<div class="stat blue"><span class="bar"></span><div class="k">' + U.esc(k) + '</div><div class="v">¥' + U.money(d.byProject[k]) + '</div></div>').join('') + '</div>' +
        Table.render([{ title: '收款单号', key: 'code' }, { title: '客户', key: 'customerName' }, { title: '房号', key: 'roomCodes', render: r => (r.roomCodes || []).join('、') },
        { title: '金额', key: 'amount', num: true }, { title: '方式', key: 'method' }, { title: '收款人', key: 'by' }], d.list || [])
    });
  };

  window.MonthlySum = async function () {
    const period = U.month();
    const r = await GET('/api/finance/monthly?period=' + period);
    const d = r.data || {};
    UI.open({
      title: '月度费用汇总（' + period + '）', width: 'wide', hideCancel: true,
      body: '<div class="stat-grid mb12">' +
        '<div class="stat blue"><span class="bar"></span><div class="k">应收合计</div><div class="v">¥' + U.money(d.total) + '</div></div>' +
        '<div class="stat green"><span class="bar"></span><div class="k">已收</div><div class="v">¥' + U.money(d.paid) + '</div></div>' +
        '<div class="stat red"><span class="bar"></span><div class="k">未收</div><div class="v">¥' + U.money(d.unpaid) + '</div></div>' +
        '<div class="stat orange"><span class="bar"></span><div class="k">账单数</div><div class="v">' + (d.count || 0) + '</div></div></div>' +
        Table.render([{ title: '费用类别', key: 'k' }, { title: '金额', key: 'v', num: true }],
          Object.keys(d.byCategory || {}).map(k => ({ k: k, v: d.byCategory[k] })))
    });
  };

  window.BatchRead = async function (done) {
    const meters = await GET('/api/finance/meters?size=3000');
    const ml = (meters.data || {}).list || [];
    UI.open({
      title: '批量抄表录入', width: 'wide',
      body: '<div class="mb8 muted">每行一条：<b>表号,抄表日期,表底读数</b>（账期自动取抄表日期所在月）；系统共 ' + ml.length + ' 个表具。</div>' +
        '<textarea id="brText" style="min-height:220px" placeholder="DB100001,2026-09-05,12345&#10;DB100002,2026-09-05,9876"></textarea>',
      okText: '导入',
      onOk(m) {
        const lines = m.querySelector('#brText').value.split('\n').map(s => s.trim()).filter(Boolean);
        const list = [];
        const miss = [];
        lines.forEach(l => {
          const p = l.split(/[,，\t]/);
          const meterNo = (p[0] || '').trim();
          const mm = ml.filter(t => t.meterNo === meterNo)[0];
          if (!mm) { miss.push(meterNo); return; }
          list.push({ meterId: mm.id, date: (p[1] || '').trim() || U.today(), value: U.num((p[2] || '').trim()) });
        });
        if (!list.length) { UI.toast('没有匹配到表具', 'err'); return false; }
        return POST('/api/finance/readings', { list: list }).then(r => {
          UI.toast('导入成功 ' + r.data.saved + ' 条' + (miss.length ? '，未匹配表号 ' + miss.length + ' 个：' + miss.slice(0, 5).join('、') : ''), 'ok');
          done();
        });
      }
    });
  };

  window.FixReading = function (id, done) {
    UI.open({
      title: '抄表修正（录入错误 / 电费差额）',
      body: '<div class="mb8 muted">修正后系统自动重算当期电费账单，并生成差额记录与操作日志。</div>' +
        Form.html([
          { key: 'value', label: '正确读数', type: 'number', required: true },
          { key: 'reason', label: '修正原因', span: 'full', type: 'textarea', required: true }
        ], {}),
      onOk(m) {
        const v = Form.read(m, [{ key: 'value', type: 'number' }, { key: 'reason' }]);
        return POST('/api/finance/readings/' + id + '/fix', v).then(r => {
          if (!r.ok) { UI.toast(r.msg, 'err'); return false; }
          const msg = '已修正，电量差 ' + r.data.diffKwh + ' 度' + (r.data.bill ? '；账单 ' + r.data.bill.billCode + ' 电费由 ¥' + U.money(r.data.bill.oldAmount) + ' 调整为 ¥' + U.money(r.data.bill.newAmount) : '');
          UI.toast(msg, 'ok'); done();
        });
      }
    });
  };

  window.SharedForm = function (buildings, done) {
    UI.open({
      title: '整层公摊电费分摊', width: 'wide',
      body: '<div class="mb8 muted">填写整层总表用电量与单价（或直接填总电费），选择分摊方式后自动分摊到该层各房间并写入当期账单。</div>' +
        Form.html([
          { key: 'period', label: '账期', type: 'month', default: U.month(), required: true },
          { key: 'buildingId', label: '楼栋', type: 'select', options: buildings.map(b => ({ value: b.id, text: b.name })), required: true },
          { key: 'floor', label: '楼层（数字）', type: 'number', required: true },
          { key: 'totalKwh', label: '整层总表用电量（度）', type: 'number' },
          { key: 'price', label: '单价（元/度）', type: 'number', default: 1 },
          { key: 'totalFee', label: '或直接填总电费（元）', type: 'number' },
          { key: 'mode', label: '分摊方式', type: 'select', options: ['area', 'equal', 'usage'], default: 'area' }
        ], {}),
      onOk(m) {
        const v = Form.read(m, [{ key: 'period' }, { key: 'buildingId' }, { key: 'floor', type: 'number' }, { key: 'totalKwh', type: 'number' },
        { key: 'price', type: 'number' }, { key: 'totalFee', type: 'number' }, { key: 'mode' }]);
        return POST('/api/finance/shared-electric', v).then(r => {
          if (!r.ok) { UI.toast(r.msg, 'err'); return false; }
          UI.toast('已分摊到 ' + r.data.applied + ' 间房间', 'ok'); done();
        });
      }
    });
  };

  /* ============ 发票管理 ============ */
  App.view('invoice', {
    title: '发票管理',
    async render(el) {
      const projects = await Cache.projects();
      const sum = await GET('/api/invoice/summary');
      const v = CrudView({
        title: '发票管理', name: '发票', api: '/api/invoice/invoices', size: 20, formWidth: 'wide',
        exportUrl: '/api/report/export/invoices',
        filters: [
          { key: 'projectId', label: '项目', type: 'select', options: projects.map(p => ({ value: p.id, text: p.name })) },
          { key: 'category', label: '开票内容', type: 'select', options: ['租金', '物业费', '电费', '水费', '杂费', '保洁费'] },
          { key: 'type', label: '发票类型', type: 'select', options: ['增值税普票', '增值税专票'] },
          { key: 'month', label: '开票月份', width: 110, type: 'month' }
        ],
        columns: [
          { title: '单据号', key: 'code', render: r => '<b class="mono">' + U.esc(r.code) + '</b>' },
          { title: '发票号码', key: 'invoiceNo', width: 110 },
          { title: '开票日期', key: 'invoiceDate', width: 100 },
          { title: '类型', key: 'type', width: 100, render: r => U.tag(r.type, r.type === '增值税专票' ? 'blue' : 'cyan') },
          { title: '内容', key: 'category', width: 80, render: r => U.tag(r.category, 'purple') },
          { title: '客户', key: 'customerName', width: 170 },
          { title: '房号', key: 'roomCodes', width: 140, render: r => '<span class="muted">' + U.esc((r.roomCodes || []).join('、')) + '</span>' },
          { title: '金额', key: 'amount', width: 100, num: true },
          { title: '税率', key: 'taxRate', width: 60, render: r => (r.taxRate || 0) + '%' },
          { title: '税额', key: 'taxAmount', width: 90, num: true },
          { title: '模板', key: 'template', width: 70 },
          { title: '状态', key: 'status', width: 80, render: r => U.statusTag(r.status) },
          { title: '开票人', key: 'by', width: 80 }
        ],
        actionWidth: 150,
        actions: r => '<button class="btn btn-sm" data-act2="edit">编辑</button> ' + (r.status !== '已作废' ? '<button class="btn btn-sm" data-act2="cancel">作废</button>' : ''),
        rowActions: {
          edit(row, done) { v.cfg._openForm(row, done); },
          cancel(row, done) {
            UI.confirm('确定作废发票 ' + row.code + '？').then(ok => {
              if (!ok) return;
              POST('/api/invoice/invoices/' + row.id + '/cancel', { reason: '手工作废' }).then(() => { UI.toast('已作废', 'ok'); done(); });
            });
          }
        },
        buttons: [
          { key: 'split', label: '按账单拆分开票', cls: 'btn-primary', onClick: () => SplitInvoice(v) },
          { key: 'validate', label: '开票校验', onClick: () => ValidateInvoice() },
          { key: 'tpl', label: '发票模板', onClick: () => ShowTemplates() }
        ],
        fields: [
          { key: 'customerId', label: '开票客户', type: 'select', options: [], optionsFrom: 'customers', required: true },
          { key: 'type', label: '发票类型', type: 'select', options: ['增值税普票', '增值税专票'], default: '增值税普票' },
          { key: 'category', label: '开票内容', type: 'select', options: ['租金', '物业费', '电费', '水费', '杂费', '保洁费'], required: true },
          { key: 'invoiceNo', label: '发票号码' },
          { key: 'invoiceDate', label: '开票日期', type: 'date', default: U.today() },
          { key: 'amount', label: '开票金额', type: 'number', required: true },
          { key: 'taxRate', label: '税率(%)', type: 'number', default: 9 },
          { key: 'template', label: '发票模板', type: 'select', options: ['模板1', '模板2', '模板3', '模板4'], default: '模板1' },
          { key: 'title', label: '发票抬头' },
          { key: 'taxNo', label: '纳税人识别号' },
          { key: 'bankInfo', label: '开户行及账号' },
          { key: 'address', label: '地址电话' },
          { key: 'remark', label: '备注', span: 'full', type: 'textarea' }
        ],
        optionSources: {
          customers: async () => (await Cache.customers()).map(c => ({ value: c.id, text: c.name }))
        }
      });
      await v.render(el);
      const s = sum.data || {};
      el.insertAdjacentHTML('afterbegin',
        '<div class="stat-grid mb12">' +
        '<div class="stat blue"><span class="bar"></span><div class="k">开票总额</div><div class="v">¥' + U.money(s.total) + '</div><div class="s">' + (s.count || 0) + ' 张</div></div>' +
        '<div class="stat green"><span class="bar"></span><div class="k">税额合计</div><div class="v">¥' + U.money(s.tax) + '</div></div>' +
        Object.keys(s.byCategory || {}).map(k => '<div class="stat purple"><span class="bar"></span><div class="k">' + U.esc(k) + '</div><div class="v">¥' + U.money(s.byCategory[k]) + '</div></div>').join('') +
        '</div>');
    }
  });

  window.SplitInvoice = async function (v) {
    const r = await GET('/api/finance/bills?size=300&status=已收款');
    const bills = r.data.list || [];
    const sel = [];
    UI.open({
      title: '按账单拆分开票（租金 / 物业费 / 电费 / 杂费 / 保洁费 各一张票）', width: 'wide',
      body: '<div class="mb8 muted">选择已收款账单，系统按费用类别分别开票。</div>' +
        '<div class="table-wrap" style="max-height:360px"><table class="tbl"><thead><tr><th style="width:40px"></th><th>账单号</th><th>账期</th><th>客户</th><th>房号</th><th class="right">金额</th><th>开票状态</th></tr></thead><tbody>' +
        bills.map(b => '<tr><td><input type="checkbox" class="bck" value="' + b.id + '"></td><td class="mono">' + U.esc(b.code) + '</td><td>' + U.esc(b.period) +
          '</td><td>' + U.esc(b.customerName) + '</td><td class="muted">' + U.esc((b.roomCodes || []).join('、')) + '</td><td class="num">' + U.money(b.totalAmount) +
          '</td><td>' + U.esc(b.invoiceStatus) + '</td></tr>').join('') + '</tbody></table></div>' +
        '<div class="mt8"><label class="fld">开票日期</label><input type="date" id="spDate" value="' + U.today() + '"></div>',
      onOk(m) {
        const ids = Array.from(m.querySelectorAll('.bck:checked')).map(x => x.value);
        if (!ids.length) { UI.toast('请选择账单', 'err'); return false; }
        return POST('/api/invoice/split', { billIds: ids, invoiceDate: m.querySelector('#spDate').value }).then(r => {
          if (!r.ok) { UI.toast(r.msg, 'err'); return false; }
          UI.toast('已生成 ' + r.data.created + ' 张发票', 'ok'); Cache.bust(); v.cfg._refresh();
        });
      }
    });
  };

  window.ValidateInvoice = async function () {
    const customers = await Cache.customers();
    UI.open({
      title: '开票校验', width: 'wide',
      body: '<div class="muted mb8">校验租户是否提供完整发票信息，并核对开票金额与账单余额。</div>' +
        Form.html([
          { key: 'customerId', label: '客户', type: 'select', options: customers.map(c => ({ value: c.id, text: c.name })), required: true, span: 'full' },
          { key: 'type', label: '发票类型', type: 'select', options: ['增值税普票', '增值税专票'], default: '增值税专票' },
          { key: 'amount', label: '拟开票金额', type: 'number', required: true },
          { key: 'category', label: '开票内容', type: 'select', options: ['租金', '物业费', '电费', '水费', '杂费', '保洁费'] }
        ], {}),
      onOk(m) {
        const v = Form.read(m, [{ key: 'customerId' }, { key: 'type' }, { key: 'amount', type: 'number' }, { key: 'category' }]);
        return POST('/api/invoice/validate', v).then(r => {
          const d = r.data;
          UI.open({
            title: '校验结果', hideCancel: true, okText: '知道了',
            body: (d.pass ? '<div style="color:var(--success);font-size:15px">✔ 校验通过，可以开票</div>'
              : '<div style="color:var(--danger);font-size:15px;margin-bottom:8px">✘ 存在以下问题：</div>' +
              '<ul style="margin:0 0 12px 18px;font-size:13px">' + d.issues.map(i => '<li>' + U.esc(i) + '</li>').join('') + '</ul>') +
              '<div class="kv"><div class="k">账单金额</div><div>¥' + U.money(d.billAmount) + '</div>' +
              '<div class="k">已开票</div><div>¥' + U.money(d.invoiced) + '</div>' +
              '<div class="k">可开票余额</div><div><b>¥' + U.money(d.remain) + '</b></div></div>'
          });
        });
      }
    });
  };

  window.ShowTemplates = async function () {
    const r = await GET('/api/invoice/templates');
    UI.open({
      title: '发票模板（4 套）', width: 'wide', hideCancel: true,
      body: Table.render([{ title: '模板', key: 'id', width: 80 }, { title: '名称', key: 'name' },
      { title: '适用内容', key: 'category', width: 90 }, { title: '税率', key: 'taxRate', width: 70, render: r => r.taxRate + '%' },
      { title: '开票项目', key: 'title' }, { title: '说明', key: 'remark' }], r.data || [])
    });
  };

  window.MeterImport = async function (type, done) {
    const meterType = type === 'electric' ? '电表' : '水表';
    const url = type === 'electric' ? '/api/finance/meters/import/electric' : '/api/finance/meters/import/water';
    const tplUrl = type === 'electric' ? '/api/finance/meters/import/electric-template' : '/api/finance/meters/import/water-template';
    UI.open({
      title: meterType + '抄表导入', width: 480,
      body: '<div class="import-panel">' +
        '<p class="muted mb12">支持 .xlsx/.xls 文件；按<b>表号、抄表日期、本期读数</b>填写，同一表同一账期重复则覆盖。</p>' +
        '<button class="btn btn-sm mb12" id="dlTpl' + type + '">⬇ 下载' + meterType + '导入模板</button>' +
        '<input type="file" id="impFile' + type + '" accept=".xlsx,.xls" style="display:none">' +
        '<button class="btn btn-primary" id="impBtn' + type + '">选择文件并上传</button>' +
        '<div id="impResult' + type + '" class="mt12"></div>' +
        '</div>',
      okText: '关闭', cancelText: '',
      onMount(m) {
        const fileIn = m.querySelector('#impFile' + type);
        const dlBtn = m.querySelector('#dlTpl' + type);
        const btn = m.querySelector('#impBtn' + type);
        const result = m.querySelector('#impResult' + type);
        // 下载模板（带 cookie）
        dlBtn.onclick = async () => {
          dlBtn.disabled = true; dlBtn.textContent = '下载中…';
          try {
            const r = await fetch(tplUrl, { credentials: 'same-origin' });
            if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
            const blob = await r.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            const fn = type === 'electric' ? '电表抄表导入模板.xlsx' : '水表抄表导入模板.xlsx';
            a.download = fn;
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(a.href);
          } catch (e) { UI.toast('下载模板失败：' + e.message, 'err'); }
          finally { dlBtn.disabled = false; dlBtn.textContent = '⬇ 下载' + meterType + '导入模板'; }
        };
        btn.onclick = () => fileIn.click();
        fileIn.onchange = async () => {
          const f = fileIn.files[0];
          if (!f) return;
          btn.disabled = true; btn.textContent = '上传中…'; result.innerHTML = '';
          const fd = new FormData(); fd.append('file', f);
          try {
            const r = await fetch(url, { method: 'POST', body: fd, credentials: 'same-origin' });
            const j = await r.json();
            if (j.ok) {
              result.innerHTML = '<div class="tag green">✓ 导入完成：' + j.imported + ' 条记录</div>' +
                (j.errors && j.errors.length ? '<div class="muted mt8">失败 ' + j.errors.length + ' 行：</div><ul class="muted">' + j.errors.map(e => '<li>第' + e.row + '行：' + U.esc(e.err) + '</li>').join('') + '</ul>' : '');
              if (j.ok) done();
            } else {
              result.innerHTML = '<div class="tag red">✗ ' + U.esc(j.msg || '导入失败') + '</div>';
            }
          } catch (e) {
            result.innerHTML = '<div class="tag red">✗ 网络错误：' + U.esc(e.message) + '</div>';
          } finally {
            btn.disabled = false; btn.textContent = '选择文件并上传';
          }
        };
      }
    });
  };

})();
