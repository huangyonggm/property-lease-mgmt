/* 视图：人事薪酬（员工档案 / 考勤管理 / 请假加班 / 薪资核算 / 社保规则） */
(function () {

  // 扩展缓存：员工、班次
  Cache.employees = function () { return Cache.get('employees', '/api/hr/employees?size=500'); };
  Cache.shifts = function () { return Cache.get('shifts', '/api/hr/shifts'); };

  const EMP_STATUS = ['在职', '试用', '离职', '停薪'];
  const ATT_STATUS = ['正常', '迟到', '早退', '迟到且早退', '缺卡', '旷工', '请假', '出差', '休息'];
  const LEAVE_TYPES = ['事假', '病假', '年假', '调休', '婚假', '产假', '陪产假', '丧假', '工伤假', '出差', '外勤'];
  const OT_TYPES = ['工作日', '休息日', '法定节假日'];
  const PAY_STATUS = ['草稿', '已核算', '已发放'];

  function zapPerm(code) {
    const u = App.user || {};
    if (u.isAdmin) return true;
    const p = u.perms || [];
    return p.indexOf('*') >= 0 || p.indexOf(code) >= 0;
  }

  // U.addMonths 接收 YYYY-MM-DD（不可再拼 -01）
  function prevMonth() { return U.addMonths(U.today(), -1).slice(0, 7); }
  function money2(v) { return '¥' + U.money(v, 2); }

  function attTag(s) {
    const map = { '正常': 'green', '休息': '', '请假': 'blue', '出差': 'blue', '迟到': 'orange', '早退': 'orange', '迟到且早退': 'orange', '旷工': 'red', '缺卡': 'orange' };
    return U.tag(s, map[s] || '');
  }

  /* ==================== 主视图 ==================== */
  App.view('hr', {
    title: '人事薪酬管理',
    async render(el) {
      const tabs = [
        { key: 'emp', name: '员工档案' }, { key: 'att', name: '考勤管理' },
        { key: 'lv', name: '请假加班' },
        { key: 'pay', name: zapPerm('hr:payroll') ? '薪资核算' : '我的工资条' },
        { key: 'ins', name: '社保规则' }
      ].filter(t => t.name !== '');
      let cur = 'emp';
      el.innerHTML = '<div class="tabs">' + tabs.map(t => '<div class="tab' + (t.key === cur ? ' active' : '') + '" data-tab="' + t.key + '">' + t.name + '</div>').join('') +
        '</div><div id="hrBody"></div>';
      el.querySelectorAll('[data-tab]').forEach(t => {
        t.onclick = () => {
          el.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('active'));
          t.classList.add('active'); cur = t.getAttribute('data-tab'); renderTab();
        };
      });
      async function renderTab() {
        const box = el.querySelector('#hrBody');
        box.innerHTML = '';
        if (cur === 'emp') return renderEmployees(box);
        if (cur === 'att') return renderAttendance(box);
        if (cur === 'lv') return renderLeave(box);
        if (cur === 'pay') return renderPayroll(box);
        if (cur === 'ins') return renderInsurance(box);
      }
      renderTab();
    }
  });

  /* ==================== 1. 员工档案 ==================== */
  function renderEmployees(box) {
    const view = CrudView({
      key: 'employee', name: '员工', api: '/api/hr/employees', size: 20, sort: 'no',
      searchPlaceholder: '姓名 / 工号 / 手机号',
      exportUrl: '/api/hr/export/employees',
      buttons: [
        { key: 'import', label: '导入员工', cls: 'btn-primary', onClick: ImportEmployees }
      ],
      formWidth: 860,
      optionSources: {
        depts: async () => (await Cache.depts()).map(d => ({ value: d.id, text: d.name })),
        posts: async () => (await Cache.posts()).map(p => ({ value: p.id, text: p.name })),
        shifts: async () => (await Cache.shifts()).map(s => ({ value: s.id, text: s.name + '（' + s.workStart + '-' + s.workEnd + '）' })),
        projects: async () => (await Cache.projects()).map(p => ({ value: p.id, text: p.name })),
        users: async () => (await Cache.users()).map(u => ({ value: u.id, text: u.username + ' · ' + u.name }))
      },
      filters: [
        { key: 'status', label: '状态', type: 'select', options: EMP_STATUS },
        { key: 'deptId', label: '部门', type: 'select', optionsFrom: 'depts' }
      ],
      columns: [
        { title: '工号', key: 'no', width: 90, render: r => '<b class="mono">' + U.esc(r.no) + '</b>' },
        { title: '姓名', key: 'name', width: 90 },
        { title: '性别', key: 'gender', width: 56 },
        { title: '部门', key: 'deptName', width: 100 },
        { title: '岗位', key: 'postName', width: 110 },
        { title: '职级', key: 'level', width: 60 },
        { title: '手机号', key: 'phone', width: 120 },
        { title: '入职日期', key: 'hireDate', width: 105 },
        { title: '合同到期', key: 'contractEnd', width: 105, render: r => ContractTag(r.contractEnd) },
        { title: '工龄', key: 'seniority', width: 70 },
        { title: '状态', key: 'status', width: 80, render: r => U.statusTag(r.status) }
      ],
      actions: r => '<button class="btn btn-sm" data-act2="detail">档案</button>',
      actionWidth: 90,
      rowActions: {
        detail(row) { EmployeeDetail(row.id); }
      },
      fields: [
        { key: 'no', label: '工号', required: true, placeholder: '留空自动生成' },
        { key: 'name', label: '姓名', required: true },
        { key: 'gender', label: '性别', type: 'select', options: ['男', '女'] },
        { key: 'birthday', label: '出生日期', type: 'date' },
        { key: 'idCard', label: '身份证号', span: 'full', placeholder: '18 位' },
        { key: 'phone', label: '手机号' },
        { key: 'deptId', label: '所属部门', type: 'select', optionsFrom: 'depts', required: true },
        { key: 'postId', label: '岗位', type: 'select', optionsFrom: 'posts' },
        { key: 'userId', label: '关联登录账号', type: 'select', optionsFrom: 'users' },
        { key: 'projectId', label: '所属项目', type: 'select', optionsFrom: 'projects' },
        { key: 'shiftId', label: '班制班次', type: 'select', optionsFrom: 'shifts' },
        { key: 'level', label: '职级', placeholder: '如 B2 / C3' },
        { key: 'education', label: '学历', type: 'select', options: ['高中', '大专', '本科', '硕士', '博士'] },
        { key: 'marital', label: '婚姻状况', type: 'select', options: ['未婚', '已婚', '离异'] },
        { key: 'nativePlace', label: '籍贯' },
        { key: 'address', label: '通讯地址', span: 'full' },
        { key: 'emergencyContact', label: '紧急联系人' },
        { key: 'emergencyPhone', label: '紧急联系电话' },
        { key: 'hireDate', label: '入职日期', type: 'date' },
        { key: 'regularDate', label: '转正日期', type: 'date' },
        { key: 'contractStart', label: '合同起始', type: 'date' },
        { key: 'contractEnd', label: '合同到期', type: 'date' },
        { key: 'status', label: '在职状态', type: 'select', options: EMP_STATUS, default: '在职' },
        { key: 'leaveDate', label: '离职日期', type: 'date' },
        { key: 'bankName', label: '开户行' },
        { key: 'bankCard', label: '银行卡号', span: 'full' },
        // 薪酬档案
        { key: 'baseSalary', label: '基本工资', type: 'number', step: '0.01' },
        { key: 'postSalary', label: '岗位工资', type: 'number', step: '0.01' },
        { key: 'perfSalary', label: '绩效工资基数', type: 'number', step: '0.01' },
        { key: 'perfRate', label: '绩效系数', step: '0.01', default: 1 },
        { key: 'allowanceTraffic', label: '交通补贴/月', type: 'number', step: '0.01' },
        { key: 'allowanceMeal', label: '餐费补贴/月', type: 'number', step: '0.01' },
        { key: 'allowancePhone', label: '通讯补贴/月', type: 'number', step: '0.01' },
        { key: 'allowanceNight', label: '夜班补贴/次', type: 'number', step: '0.01' },
        { key: 'attendanceBonus', label: '全勤奖', type: 'number', step: '0.01' },
        { key: 'lateFine', label: '迟到早退扣款/次', type: 'number', step: '0.01' },
        // 社保
        { key: 'socialBase', label: '社保缴费基数', type: 'number', step: '0.01' },
        { key: 'fundBase', label: '公积金基数', type: 'number', step: '0.01' },
        { key: 'fundRate', label: '公积金个人比例', step: '0.001', default: 0.08, placeholder: '0.08 = 8%' },
        { key: 'insureEnabled', label: '参保状态', type: 'select', options: ['是', '否'], default: '是' },
        { key: 'fundEnabled', label: '缴存公积金', type: 'select', options: ['是', '否'], default: '是' },
        { key: 'specialDeduction', label: '专项附加扣除/月', type: 'number', step: '0.01', placeholder: '子女教育+房贷/房租+赡养老人' },
        { key: 'remark', label: '备注', type: 'textarea', span: 'full' }
      ],
      beforeSave(v) {
        ['insureEnabled', 'fundEnabled'].forEach(k => { v[k] = (v[k] === undefined || v[k] === '') ? '是' : v[k]; });
        return true;
      }
    });
    return view.render(box);
  }

  function ContractTag(d) {
    if (!d) return '<span class="muted">—</span>';
    const left = U.diffDays(U.today(), d);
    if (left < 0) return '<span class="tag red">' + U.esc(d) + ' 已到期</span>';
    if (left <= 30) return '<span class="tag orange">' + U.esc(d) + '（剩 ' + left + ' 天）</span>';
    if (left <= 60) return '<span class="tag blue">' + U.esc(d) + '（剩 ' + left + ' 天）</span>';
    return U.esc(d);
  }

  async function ImportEmployees(el, refresh) {
    const body = '<div class="import-panel">' +
      '<p class="muted mb12">支持 .xlsx 文件；工号相同则更新，不存在则新建。模板使用中文表头，导入时支持中文名/英文名两种格式。</p>' +
      '<button class="btn btn-sm mb12" id="dlTpl">⬇ 下载导入模板</button>' +
      '<input type="file" id="impFile" accept=".xlsx,.xls" style="display:none">' +
      '<button class="btn btn-primary" id="impBtn">选择文件并上传</button>' +
      '<div id="impResult" class="mt12"></div>' +
      '</div>';
    UI.open({
      title: '导入员工档案', width: 480, body,
      okText: '关闭', cancelText: '',
      onMount(m) {
        const fileIn = m.querySelector('#impFile');
        const dlBtn = m.querySelector('#dlTpl');
        const btn = m.querySelector('#impBtn');
        const result = m.querySelector('#impResult');
        // 下载模板（带 cookie）
        dlBtn.onclick = async () => {
          dlBtn.disabled = true; dlBtn.textContent = '下载中…';
          try {
            const r = await fetch('/api/hr/import/employee-template', { credentials: 'same-origin' });
            if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
            const blob = await r.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = '员工档案导入模板.xlsx';
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
          } catch (e) { UI.toast('下载模板失败：' + e.message, 'err'); }
          finally { dlBtn.disabled = false; dlBtn.textContent = '⬇ 下载导入模板'; }
        };
        btn.onclick = () => fileIn.click();
        fileIn.onchange = async () => {
          const f = fileIn.files[0];
          if (!f) return;
          btn.disabled = true; btn.textContent = '上传中…'; result.innerHTML = '';
          // base64 JSON 上传（不要用 FormData：服务端 readBody 对 multipart 只回
          // { _raw: Buffer }，拿不到文件字节 → 会报「文件为空」。详见 lib/http.js）
          const fr = new FileReader();
          fr.onload = async () => {
            try {
              const j = await POST('/api/hr/import/employees', { fileName: f.name, fileBase64: fr.result });
              if (j.ok) {
                const d = j.data || j;
                result.innerHTML = '<div class="tag green">✓ 导入完成：' + d.imported + ' 条记录（新增 ' + d.imported + ' / 跳过重复 ' + (d.total - d.imported - (d.skipped || 0)) + '）</div>' +
                  (d.errors && d.errors.length ? '<div class="muted mt8">失败 ' + d.errors.length + ' 行：</div><ul class="muted">' + d.errors.map(e => '<li>第' + e.row + '行：' + e.err + '</li>').join('') + '</ul>' : '');
                refresh();
              } else {
                result.innerHTML = '<div class="tag red">✗ ' + U.esc(j.msg || '导入失败') + '</div>';
              }
            } catch (e) {
              result.innerHTML = '<div class="tag red">✗ 网络错误：' + U.esc(e.message) + '</div>';
            } finally {
              btn.disabled = false; btn.textContent = '选择文件并上传';
            }
          };
          fr.readAsDataURL(f);
        };
      }
    });
  }

  async function EmployeeDetail(id) {
    const r = await GET('/api/hr/employees/' + id);
    if (!r.ok) return UI.toast(r.msg || '加载失败', 'err');
    const e = r.data;
    const ins = await calcInsuranceView(e);
    UI.drawer('员工档案 · ' + e.name + '（' + e.no + '）',
      '<div class="card mb12"><div class="card-head"><h3>基本信息</h3></div><div class="card-body">' +
      kv('工号', e.no) + kv('姓名', e.name) + kv('性别', e.gender) + kv('出生日期', e.birthday) +
      kv('身份证号', e.idCard) + kv('手机号', e.phone) + kv('籍贯', e.nativePlace) + kv('学历', e.education) +
      kv('部门', e.deptName) + kv('岗位', e.postName) + kv('职级', e.level) + kv('入驻项目', e.projectName) +
      kv('入职日期', e.hireDate) + kv('转正日期', e.regularDate) + kv('合同到期', e.contractEnd) +
      kv('通讯地址', e.address) + kv('紧急联系人', (e.emergencyContact || '') + (e.emergencyPhone ? ' / ' + e.emergencyPhone : '')) +
      kv('银行', (e.bankName || '') + ' ' + (e.bankCard || '')) + kv('在职状态', e.status) +
      '</div></div>' +
      // 薪酬 / 社保档案受保密约束：无 hr:payroll 不展示
      (zapPerm('hr:payroll') ? (function () {
        return '<div class="card mb12"><div class="card-head"><h3>薪酬档案</h3></div><div class="card-body">' +
          kv('基本工资', money2(e.baseSalary)) + kv('岗位工资', money2(e.postSalary)) + kv('绩效基数', money2(e.perfSalary)) +
          kv('绩效系数', e.perfRate) + kv('交通补贴', money2(e.allowanceTraffic)) + kv('餐费补贴', money2(e.allowanceMeal)) +
          kv('通讯补贴', money2(e.allowancePhone)) + kv('夜班补贴/次', money2(e.allowanceNight)) +
          kv('全勤奖', money2(e.attendanceBonus)) + kv('迟到扣款/次', money2(e.lateFine)) +
          '</div></div>' +
          '<div class="card"><div class="card-head"><h3>社保公积金（按当前政策测算）</h3></div><div class="card-body">' +
          kv('社保基数', money2(e.socialBase) + '（封顶/保底后 ' + money2(ins.socialBase) + '）') +
          kv('公积金基数', money2(ins.fundBase)) + kv('公积金比例', (ins.fundRate * 100).toFixed(0) + '%') +
          kv('个人月缴合计', '<b class="mono">' + money2(ins.personal) + '</b>') +
          kv('单位月缴合计', '<b class="mono">' + money2(ins.unit) + '</b>') +
          kv('专项附加扣除', money2(e.specialDeduction) + '/月') +
          '<div style="width:100%;margin-top:8px">' + Table.render([
            { title: '险种', key: 'name', width: 70 },
            { title: '个人比例', key: 'personalRate', width: 90, render: r => (r.personalRate * 100).toFixed(1) + '%' },
            { title: '个人缴纳', key: 'personal', num: true },
            { title: '单位比例', key: 'unitRate', width: 90, render: r => (r.unitRate * 100).toFixed(1) + '%' },
            { title: '单位缴纳', key: 'unit', num: true }
          ], ins.details.concat([{ name: '公积金', personalRate: ins.fundRate, personal: ins.fundPersonal, unitRate: ins.fundRate, unit: ins.fundUnit }]), {}) +
          '</div></div></div>';
      })() : '<div class="card"><div class="card-body muted">薪酬与社保档案属保密信息，仅人事 / 财务可见</div></div>')
    );
  }

  function kv(k, v) {
    return '<div style="width:50%;display:inline-block;padding:5px 0"><span class="muted" style="display:inline-block;width:110px">' + U.esc(k) + '</span>' +
      (String(v).indexOf('<') === 0 ? v : '<b>' + U.esc(v === undefined || v === null || v === '' ? '—' : v) + '</b>') + '</div>';
  }

  async function calcInsuranceView(e) {
    const cfg = await GET('/api/hr/insurance');
    const p = cfg.data || {};
    const items = p.items || [];
    const socialBase = Math.min(p.socialMax, Math.max(p.socialMin, U.num(e.socialBase) || 0));
    const fundBase = Math.min(p.fundMax, Math.max(p.fundMin, U.num(e.fundBase) || 0));
    const details = items.map(it => ({
      name: it.name, personalRate: U.num(it.personalRate), unitRate: U.num(it.unitRate),
      personal: U.money(socialBase * U.num(it.personalRate), 2), unit: U.money(socialBase * U.num(it.unitRate), 2)
    }));
    const rate = U.num(e.fundRate) || p.fundRate || 0.08;
    const fundPersonal = U.money(fundBase * rate, 2), fundUnit = U.money(fundBase * rate, 2);
    const ps = U.money(details.reduce((a, d) => a + d.personal, 0), 2);
    const un = U.money(details.reduce((a, d) => a + d.unit, 0), 2);
    return {
      socialBase: socialBase, fundBase: fundBase, fundRate: rate, details: details,
      fundPersonal: fundPersonal, fundUnit: fundUnit,
      personal: U.money(ps + fundPersonal, 2), unit: U.money(un + fundUnit, 2)
    };
  }

  /* ==================== 2. 考勤管理 ==================== */
  function renderAttendance(box) {
    const subTabs = [{ key: 'detail', name: '考勤明细' }, { key: 'sum', name: '月度汇总' }, { key: 'cal', name: '考勤日历' }, { key: 'my', name: '我的考勤' }];
    let cur = 'detail';
    box.innerHTML = '<div class="sub-tabs">' + subTabs.map(t => '<span class="chip' + (t.key === cur ? ' active' : '') + '" data-sub="' + t.key + '">' + t.name + '</span>').join('') + '</div><div id="attBody"></div>';
    box.querySelectorAll('[data-sub]').forEach(t => {
      t.onclick = () => {
        box.querySelectorAll('[data-sub]').forEach(x => x.classList.remove('active'));
        t.classList.add('active'); cur = t.getAttribute('data-sub'); render();
      };
    });
    async function render() {
      const b = box.querySelector('#attBody');
      b.innerHTML = '';
      if (cur === 'detail') return attDetail(b);
      if (cur === 'sum') return attSummary(b);
      if (cur === 'cal') return attCalendar(b);
      return renderMyAttendance(b);
    }
    render();
  }

  async function attDetail(box) {
    const [depts, emps] = await Promise.all([Cache.depts(), Cache.employees()]);
    let fMonth = U.month(), fDept = '', fEmp = '', fStatus = '';
    box.innerHTML =
      '<div class="toolbar"><input type="month" id="aMonth" value="' + fMonth + '" style="width:150px">' +
      '<select id="aDept" style="width:auto;min-width:120px"><option value="">全部部门</option>' +
      depts.map(d => '<option value="' + d.id + '">' + U.esc(d.name) + '</option>').join('') + '</select>' +
      '<select id="aEmp" style="width:auto;min-width:130px"><option value="">全部员工</option>' +
      emps.map(e => '<option value="' + e.id + '">' + U.esc(e.name + '（' + e.no + '）') + '</option>').join('') + '</select>' +
      '<select id="aSt" style="width:auto;min-width:110px"><option value="">全部状态</option>' +
      ATT_STATUS.map(s => '<option>' + s + '</option>').join('') + '</select>' +
      '<span class="spacer"></span>' +
      '<button class="btn btn-primary" id="btnGen">生成考勤</button> ' +
      '<button class="btn" id="btnCheck">打卡 / 补卡</button> ' +
      '<button class="btn" id="btnQ">查询</button> ' +
      '<button class="btn" id="btnExp">导出考勤月报</button></div>' +
      '<div class="card"><div class="card-body tight" id="aList"></div></div>';

    async function load() {
      const box2 = box.querySelector('#aList');
      box2.innerHTML = '<div class="empty">加载中…</div>';
      const q = ['month=' + fMonth];
      if (fDept) q.push('deptId=' + encodeURIComponent(fDept));
      if (fEmp) q.push('employeeId=' + encodeURIComponent(fEmp));
      if (fStatus) q.push('status=' + encodeURIComponent(fStatus));
      q.push('size=500');
      const r = await GET('/api/hr/attendance?' + q.join('&'));
      const list = (r.ok && r.data) ? r.data.list : [];
      if (!list.length) { box2.innerHTML = '<div class="empty"><div class="big">📅</div>该条件下暂无考勤数据，可点击「生成考勤」创建</div>'; return; }
      box2.innerHTML = Table.render([
        { title: '日期', key: 'date', width: 105 },
        { title: '工号', key: 'employeeNo', width: 90 },
        { title: '姓名', key: 'employeeName', width: 90 },
        { title: '班次', key: 'shiftName', width: 100 },
        { title: '上班打卡', key: 'checkIn', width: 90, render: r => r.checkIn ? '<b class="mono">' + U.esc(r.checkIn) + '</b>' : '<span class="muted">—</span>' },
        { title: '下班打卡', key: 'checkOut', width: 90, render: r => r.checkOut ? U.esc(r.checkOut) : '<span class="muted">—</span>' },
        { title: '状态', key: 'status', width: 95, render: r => attTag(r.status) },
        { title: '迟到(分)', key: 'lateMin', width: 85, num: true },
        { title: '早退(分)', key: 'earlyMin', width: 85, num: true },
        { title: '加班(h)', key: 'otHours', width: 80, render: r => r.otHours ? '<b class="mono">' + r.otHours + '</b><span class="muted">×' + (r.otType === '休息日' ? 2 : r.otType === '法定节假日' ? 3 : 1.5) + '</span>' : '<span class="muted">—</span>' },
        { title: '备注', key: 'remark', width: 200 }
      ], list, {
        actions: r => '<button class="btn btn-sm" data-fix="' + r.id + '">修正</button>', actionWidth: 80
      });
      box2.querySelectorAll('[data-fix]').forEach(btn => {
        btn.onclick = () => FixAttendance(btn.getAttribute('data-fix'), load);
      });
    }

    box.querySelector('#aMonth').onchange = e => { fMonth = e.target.value; load(); };
    box.querySelector('#aDept').onchange = e => { fDept = e.target.value; load(); };
    box.querySelector('#aEmp').onchange = e => { fEmp = e.target.value; load(); };
    box.querySelector('#aSt').onchange = e => { fStatus = e.target.value; load(); };
    box.querySelector('#btnQ').onclick = load;
    box.querySelector('#btnExp').onclick = () => window.open('/api/hr/export/attendance?month=' + fMonth + '&format=csv', '_blank');
    box.querySelector('#btnGen').onclick = () => GenAttendance(fMonth, load);
    box.querySelector('#btnCheck').onclick = () => CheckIn(load);
    load();
  }

  async function attSummary(box) {
    const fMonth = U.month();
    box.innerHTML = '<div class="toolbar"><input type="month" id="sMonth" value="' + fMonth + '" style="width:150px">' +
      '<span class="spacer"></span><button class="btn" id="sQ">查询</button>' +
      '<button class="btn" id="sExp">导出 CSV</button><button class="btn" id="sExpX">导出 Excel</button></div><div id="sBox"></div>';
    async function load() {
      const b = box.querySelector('#sBox');
      b.innerHTML = '<div class="empty">加载中…</div>';
      const r = await GET('/api/hr/attendance/summary?month=' + box.querySelector('#sMonth').value);
      if (!r.ok) { b.innerHTML = '<div class="empty">加载失败</div>'; return; }
      const d = r.data;
      b.innerHTML =
        '<div class="stat-grid">' +
        stat('考勤人数', d.employees, '人') + stat('考勤记录', d.records, '条') +
        stat('迟到次数', d.lateCount, '次', d.lateCount > 20 ? 'warn' : '') +
        stat('旷工天数', d.absentDays, '天', d.absentDays > 3 ? 'red' : '') +
        stat('请假天数', d.leaveDays, '天') + stat('加班工时', d.otHours, '小时') +
        '</div>' +
        '<div class="card"><div class="card-head"><h3>' + U.esc(d.month) + ' 考勤汇总</h3></div><div class="card-body tight">' +
        Table.render([
          { title: '工号', key: 'employeeNo', width: 90, render: r => '<b class="mono">' + U.esc(r.employeeNo) + '</b>' },
          { title: '姓名', key: 'employeeName', width: 90 },
          { title: '部门', key: 'deptName', width: 110 },
          { title: '应出勤', key: 'shouldDays', width: 80, num: true },
          { title: '实出勤', key: 'realDays', width: 80, num: true },
          { title: '出勤率', key: '_rate', width: 80, render: r => r.shouldDays ? (Math.round(r.realDays / r.shouldDays * 100)) + '%' : '—' },
          { title: '迟到', key: 'lateCount', width: 60, num: true, render: r => r.lateCount ? '<b class="mono" style="color:var(--warn)">' + r.lateCount + '</b>' : '0' },
          { title: '早退', key: 'earlyCount', width: 60, num: true },
          { title: '旷工', key: 'absentDays', width: 60, num: true, render: r => r.absentDays ? '<b class="mono" style="color:var(--danger)">' + r.absentDays + '</b>' : '0' },
          { title: '请假', key: 'leaveDays', width: 60, num: true },
          { title: '其中无薪', key: 'unpaidLeaveDays', width: 80, num: true },
          { title: '出差', key: 'businessTripDays', width: 60, num: true },
          { title: '加班(h)', key: 'otHours', width: 80, num: true },
          { title: '夜班', key: 'nightCount', width: 60, num: true }
        ], d.list, {}) + '</div></div>';
    }
    box.querySelector('#sQ').onclick = load;
    box.querySelector('#sExp').onclick = () => window.open('/api/hr/export/attendance?month=' + box.querySelector('#sMonth').value + '&format=csv', '_blank');
    box.querySelector('#sExpX').onclick = () => window.open('/api/hr/export/attendance?month=' + box.querySelector('#sMonth').value + '&format=xls', '_blank');
    load();
  }

  // 考勤日历：单人一个月的可视化
  async function attCalendar(box) {
    const emps = await Cache.employees();
    const empId = emps.length ? emps[0].id : '';
    let month = U.month();
    box.innerHTML = '<div class="toolbar">' +
      '<select id="cEmp" style="width:auto;min-width:140px">' + emps.map(e => '<option value="' + e.id + '">' + U.esc(e.name + '（' + e.no + '）') + '</option>').join('') + '</select>' +
      '<input type="month" id="cMonth" value="' + month + '" style="width:150px">' +
      '<span class="spacer"></span><button class="btn" id="cQ">查询</button></div>' +
      '<div id="cBox"></div>';
    async function load() {
      const b = box.querySelector('#cBox');
      b.innerHTML = '<div class="empty">加载中…</div>';
      const id = box.querySelector('#cEmp').value, m = box.querySelector('#cMonth').value;
      const [ar, sr] = await Promise.all([GET('/api/hr/attendance?employeeId=' + encodeURIComponent(id) + '&month=' + m + '&size=400'), GET('/api/hr/my/attendance?month=' + m)]);
      const list = (ar.ok && ar.data) ? ar.data.list : [];
      const map = {};
      list.forEach(r => map[r.date] = r);
      const [y, mo] = String(m).split('-').map(Number);
      const dim = new Date(y, mo, 0).getDate();
      const first = new Date(y, mo - 1, 1).getDay();
      let cells = '';
      for (let i = 0; i < first; i++) cells += '<div class="cal-empty"></div>';
      for (let d = 1; d <= dim; d++) {
        const ds = m + '-' + String(d).padStart(2, '0');
        const r = map[ds];
        const color = !r ? 'none' : (r.status === '正常' ? 'ok' : r.status === '休息' ? 'gray' :
          (r.status === '旷工' ? 'red' : (['迟到', '早退', '迟到且早退', '缺卡'].indexOf(r.status) >= 0 ? 'warn' : 'blue')));
        cells += '<div class="cal-cell ' + color + '"><div class="d">' + d + '</div>' +
          (r ? '<div class="t">' + U.esc(r.status) + '</div>' + (r.checkIn ? '<div class="c">' + U.esc(r.checkIn) + '</div>' : '') : '') + '</div>';
      }
      b.innerHTML = '<div class="card"><div class="card-head"><h3>考勤日历</h3><span class="spacer"></span>' +
        '<span class="muted" style="font-size:12px">🟩正常 🟧迟到/缺卡 🟦请假/出差 🟥旷工 ⬜休息</span></div>' +
        '<div class="card-body"><div class="cal-grid">' + cells + '</div></div></div>';
    }
    box.querySelector('#cQ').onclick = load;
    box.querySelector('#cMonth').onchange = load;
    box.querySelector('#cEmp').onchange = load;
    load();
  }

  function stat(label, value, unit, cls) {
    return '<div class="stat' + (cls ? ' ' + cls : '') + '"><div class="bar"></div><div class="k">' + U.esc(label) +
      '</div><div class="v">' + U.esc(value) + '</div><div class="s">' + U.esc(unit || '') + '</div></div>';
  }

  function GenAttendance(month, done) {
    UI.open({
      title: '生成月度排班考勤', width: 460,
      body: Form.html([
        { key: 'month', label: '考勤月份', type: 'month', default: month },
        { key: 'overwrite', label: '覆盖已存在记录', type: 'select', options: ['否', '是'], default: '否' },
        { key: 'tip', label: '说明', type: 'static', render: () => '<span class="muted">按员工所属班次自动排班，周末自动置为休息；已通过的请假单会同步标记为请假。</span>' }
      ], {}),
      onMount(m) { Form.bind(m, [{ key: 'month' }, { key: 'overwrite' }], 'attendance'); },
      onOk(m) {
        const v = Form.read(m, [{ key: 'month' }, { key: 'overwrite' }]);
        return POST('/api/hr/attendance/generate', { month: v.month, overwrite: v.overwrite === '是' }).then(r => {
          if (!r.ok) { UI.toast(r.msg || '生成失败', 'err'); return false; }
          UI.toast('生成 ' + r.data.created + ' 条' + (r.data.skipped ? '，跳过 ' + r.data.skipped + ' 条' : ''), 'ok');
          if (done) done();
        });
      }
    });
  }

  async function CheckIn(done) {
    const emps = await Cache.employees();
    UI.open({
      title: '打卡 / 补卡登记', width: 420,
      body: Form.html([
        { key: 'employeeId', label: '员工', type: 'select', required: true, options: emps.map(e => ({ value: e.id, text: e.name + '（' + e.no + '）' })) },
        { key: 'date', label: '日期', type: 'date', default: U.today() },
        { key: 'type', label: '打卡类型', type: 'select', options: ['上班打卡', '下班打卡'], default: '上班打卡' },
        { key: 'time', label: '打卡时间', default: new Date().toTimeString().slice(0, 5) }
      ], {}),
      onMount(m) { Form.bind(m, [], 'attendance'); },
      onOk(m) {
        const v = Form.read(m, [{ key: 'employeeId' }, { key: 'date' }, { key: 'type' }, { key: 'time' }]);
        if (!v.employeeId) { UI.toast('请选择员工', 'err'); return false; }
        return POST('/api/hr/attendance/check', { employeeId: v.employeeId, date: v.date, type: v.type === '下班打卡' ? 'out' : 'in', time: v.time }).then(r => {
          if (!r.ok) { UI.toast(r.msg || '打卡失败', 'err'); return false; }
          UI.toast('打卡成功：' + (r.data.status || ''), 'ok'); if (done) done();
        });
      }
    });
  }

  async function FixAttendance(id, done) {
    const r = await GET('/api/hr/attendance/' + id);
    if (!r.ok) return UI.toast('记录不存在', 'err');
    const row = r.data;
    UI.open({
      title: '考勤修正 · ' + row.employeeName + ' ' + row.date, width: 460,
      body: Form.html([
        { key: 'status', label: '考勤状态', type: 'select', options: ATT_STATUS, default: row.status },
        { key: 'checkIn', label: '上班打卡', default: row.checkIn },
        { key: 'checkOut', label: '下班打卡', default: row.checkOut },
        { key: 'lateMin', label: '迟到分钟', type: 'number', default: row.lateMin },
        { key: 'earlyMin', label: '早退分钟', type: 'number', default: row.earlyMin },
        { key: 'otType', label: '加班类型', type: 'select', options: OT_TYPES, default: row.otType },
        { key: 'otHours', label: '加班小时', type: 'number', step: '0.5', default: row.otHours },
        { key: 'remark', label: '说明', type: 'textarea', span: 'full', default: row.remark }
      ], {}),
      onMount(m) { Form.bind(m, [], 'attendance'); },
      onOk(m) {
        const v = Form.read(m, [{ key: 'status' }, { key: 'checkIn' }, { key: 'checkOut' }, { key: 'lateMin' }, { key: 'earlyMin' }, { key: 'otType' }, { key: 'otHours' }, { key: 'remark' }]);
        return POST('/api/hr/attendance/' + id + '/fix', v).then(r2 => {
          if (!r2.ok) { UI.toast(r2.msg || '保存失败', 'err'); return false; }
          UI.toast('已修正并留痕', 'ok'); if (done) done();
        });
      }
    });
  }

  /* ==================== 3. 请假 / 加班 ==================== */
  function renderLeave(box) {
    const subTabs = [{ key: 'lv', name: '请假单' }, { key: 'ot', name: '加班单' }];
    let cur = 'lv';
    box.innerHTML = '<div class="sub-tabs">' + subTabs.map(t => '<span class="chip' + (t.key === cur ? ' active' : '') + '" data-lv="' + t.key + '">' + t.name + '</span>').join('') + '</div><div id="lvBody"></div>';
    box.querySelectorAll('[data-lv]').forEach(t => {
      t.onclick = () => {
        box.querySelectorAll('[data-lv]').forEach(x => x.classList.remove('active'));
        t.classList.add('active'); cur = t.getAttribute('data-lv'); render();
      };
    });
    async function render() {
      const b = box.querySelector('#lvBody'); b.innerHTML = '';
      if (cur === 'lv') return leaveView(b);
      return otView(b);
    }
    render();
  }

  async function leaveView(box) {
    const emps = await Cache.employees();
    const view = CrudView({
      key: 'leave', name: '请假单', api: '/api/hr/leaves', size: 20, sort: 'createTime',
      searchPlaceholder: '员工 / 单号',
      filters: [
        { key: 'type', label: '类型', type: 'select', options: LEAVE_TYPES },
        { key: 'status', label: '状态', type: 'select', options: ['待审批', '已通过', '已驳回'] }
      ],
      columns: [
        { title: '单号', key: 'code', width: 150, render: r => '<b class="mono">' + U.esc(r.code) + '</b>' },
        { title: '员工', key: 'employeeName', width: 90 },
        { title: '部门', key: 'deptName', width: 100 },
        { title: '类型', key: 'type', width: 80, render: r => U.tag(r.type, 'blue') },
        { title: '开始', key: 'startDate', width: 105 },
        { title: '结束', key: 'endDate', width: 105 },
        { title: '天数', key: 'days', width: 60, num: true },
        { title: '计薪规则', key: 'type', width: 110, render: r => leavePaidText(r.type) },
        { title: '事由', key: 'reason', width: 180 },
        { title: '状态', key: 'status', width: 90, render: r => U.statusTag(r.status) }
      ],
      actions: r => (r.status === '待审批'
        ? '<button class="btn btn-sm btn-primary" data-act2="ok">通过</button> <button class="btn btn-sm" data-act2="no">驳回</button>'
        : '<span class="muted">' + U.esc(r.approver || '—') + '</span>'),
      actionWidth: 130,
      rowActions: {
        async ok(row, done) {
          const r = await POST('/api/hr/leaves/' + row.id + '/approve', { result: '已通过' });
          UI.toast(r.ok ? ('已通过，同步写入考勤 ' + r.data.synced + ' 天') : (r.msg || '操作失败'), r.ok ? 'ok' : 'err'); done();
        },
        async no(row, done) {
          if (!(await UI.confirm('确定驳回 ' + row.employeeName + ' 的请假单？', '驳回确认'))) return;
          const r = await POST('/api/hr/leaves/' + row.id + '/approve', { result: '已驳回' });
          UI.toast(r.ok ? '已驳回' : (r.msg || '操作失败'), r.ok ? 'ok' : 'err'); done();
        }
      },
      fields: [
        { key: 'employeeId', label: '员工', type: 'select', required: true, options: emps.map(e => ({ value: e.id, text: e.name + '（' + e.no + '）' })) },
        { key: 'type', label: '请假类型', type: 'select', required: true, options: LEAVE_TYPES },
        { key: 'startDate', label: '开始日期', type: 'date', required: true },
        { key: 'endDate', label: '结束日期', type: 'date', required: true },
        { key: 'days', label: '请假天数', type: 'number', step: '0.5' },
        { key: 'status', label: '状态', type: 'select', options: ['待审批', '已通过', '已驳回'], default: '待审批' },
        { key: 'reason', label: '请假事由', type: 'textarea', span: 'full' }
      ]
    });
    return view.render(box);
  }

  function leavePaidText(t) {
    const m = { '事假': '无薪', '病假': '按 80% 计薪', '年假': '全薪', '调休': '全薪', '婚假': '全薪', '丧假': '全薪', '产假': '全薪', '陪产假': '全薪', '工伤假': '全薪', '出差': '全薪', '外勤': '全薪' };
    return '<span class="muted">' + U.esc(m[t] || '全薪') + '</span>';
  }

  async function otView(box) {
    const emps = await Cache.employees();
    const view = CrudView({
      key: 'overtime', name: '加班单', api: '/api/hr/overtimes', size: 20, sort: 'date',
      filters: [
        { key: 'status', label: '状态', type: 'select', options: ['待审批', '已通过', '已驳回'] },
        { key: 'type', label: '加班类型', type: 'select', options: OT_TYPES }
      ],
      columns: [
        { title: '单号', key: 'code', width: 150, render: r => '<b class="mono">' + U.esc(r.code) + '</b>' },
        { title: '员工', key: 'employeeName', width: 90 },
        { title: '部门', key: 'deptName', width: 100 },
        { title: '日期', key: 'date', width: 105 },
        { title: '类型', key: 'type', width: 100, render: r => U.tag(r.type, 'blue') },
        { title: '时长(h)', key: 'hours', width: 80, num: true },
        { title: '计薪倍率', key: 'rate', width: 90, render: r => '<b class="mono">' + U.num(r.rate, 1.5) + '×</b>' },
        { title: '补偿方式', key: 'compensate', width: 90 },
        { title: '事由', key: 'reason', width: 200 },
        { title: '状态', key: 'status', width: 90, render: r => U.statusTag(r.status) }
      ],
      actions: r => (r.status === '待审批'
        ? '<button class="btn btn-sm btn-primary" data-act2="ok">通过</button> <button class="btn btn-sm" data-act2="no">驳回</button>'
        : '<span class="muted">' + U.esc(r.approver || '—') + '</span>'),
      actionWidth: 130,
      rowActions: {
        async ok(row, done) {
          const r = await POST('/api/hr/overtimes/' + row.id + '/approve', { result: '已通过' });
          UI.toast(r.ok ? '已通过，加班时长已计入当月考勤' : (r.msg || '操作失败'), r.ok ? 'ok' : 'err'); done();
        },
        async no(row, done) {
          const r = await POST('/api/hr/overtimes/' + row.id + '/approve', { result: '已驳回' });
          UI.toast(r.ok ? '已驳回' : (r.msg || '操作失败'), r.ok ? 'ok' : 'err'); done();
        }
      },
      fields: [
        { key: 'employeeId', label: '员工', type: 'select', required: true, options: emps.map(e => ({ value: e.id, text: e.name + '（' + e.no + '）' })) },
        { key: 'date', label: '加班日期', type: 'date', required: true },
        { key: 'type', label: '加班类型', type: 'select', options: OT_TYPES, default: '工作日' },
        { key: 'hours', label: '加班小时', type: 'number', step: '0.5', required: true },
        { key: 'compensate', label: '补偿方式', type: 'select', options: ['加班费', '调休'], default: '加班费' },
        { key: 'status', label: '状态', type: 'select', options: ['待审批', '已通过', '已驳回'], default: '待审批' },
        { key: 'reason', label: '加班事由', type: 'textarea', span: 'full' }
      ]
    });
    return view.render(box);
  }

  /* ==================== 4. 薪资核算 ==================== */
  function renderPayroll(box) {
    // 薪酬保密：无 hr:payroll 权限时只能查看本人工资条
    if (!zapPerm('hr:payroll')) return renderMyPayroll(box);
    let month = prevMonth();
    box.innerHTML =
      '<div class="toolbar"><input type="month" id="pMonth" value="' + month + '" style="width:150px">' +
      '<span class="spacer"></span>' +
      '<button class="btn" id="pCalc">试算</button> ' +
      '<button class="btn btn-primary" id="pGen">生成工资表</button> ' +
      '<button class="btn" id="pPay">批量发放</button> ' +
      '<button class="btn" id="pExp">导出 CSV</button>' +
      '<button class="btn" id="pExpX">导出 Excel</button></div>' +
      '<div id="pBox"></div>';
    box.querySelector('#pMonth').onchange = e => { month = e.target.value; load(); };
    async function load() {
      const b = box.querySelector('#pBox');
      b.innerHTML = '<div class="empty">加载中…</div>';
      const [sr, cr, lr] = await Promise.all([
        GET('/api/hr/payroll/summary?month=' + month),
        GET('/api/hr/payrolls?month=' + month + '&size=500'),
        GET('/api/hr/payroll/labor-cost')
      ]);
      const s = (sr.ok && sr.data) ? sr.data : {};
      const list = (cr.ok && cr.data) ? cr.data.list : [];
      const cost = (lr.ok && lr.data) ? lr.data : [];

      let h = '<div class="stat-grid">' +
        stat('核算人数', s.empCount || 0, '人') +
        stat('应发合计', U.money(s.gross, 0), '元') +
        stat('实发合计', U.money(s.net, 0), '元') +
        stat('个人所得税', U.money(s.tax, 0), '元') +
        stat('代扣社保公积金', U.money(s.insurancePersonal, 0), '元') +
        stat('单位承担社保', U.money(s.insuranceUnit, 0), '元') +
        '</div>';

      h += '<div class="stat-grid">' +
        stat('人均薪酬', U.money(s.avg, 0), '元') +
        stat('加班费总额', U.money(s.overtime, 0), '元') +
        stat('人力总成本', U.money((s.gross || 0) + (s.insuranceUnit || 0), 0), '元') +
        stat('已发放', s.paidCount || 0, '人') +
        stat('待发放', s.unpaidCount || 0, '人') +
        '</div>';

      // 部门分布
      if ((s.byDept || []).length) {
        h += '<div class="card mb12"><div class="card-head"><h3>部门薪酬分布</h3></div><div class="card-body tight">' +
          Table.render([
            { title: '部门', key: 'deptName', width: 140 },
            { title: '人数', key: 'count', width: 70, num: true },
            { title: '应发合计', key: 'gross', num: true },
            { title: '实发合计', key: 'net', num: true },
            { title: '个税', key: 'tax', num: true },
            { title: '代扣社保', key: 'insurance', num: true },
            { title: '人均应发', key: 'avg', num: true }
          ], s.byDept, {}) + '</div></div>';
      }

      // 近 6 月人力成本趋势
      if (cost.length) {
        const maxV = Math.max.apply(null, cost.map(c => c.cost)) || 1;
        h += '<div class="card mb12"><div class="card-head"><h3>近 6 个月人力成本趋势</h3></div><div class="card-body">' +
          '<div class="chart-bars">' + cost.map(c => {
            const w = Math.round(c.cost / maxV * 100);
            return '<div class="bar-col"><div class="bar-wrap"><div class="bar" style="height:' + Math.max(2, w) + '%" title="' + U.esc(money2(c.cost)) + '"></div></div>' +
              '<div class="bar-lb">' + U.esc(c.month.slice(2)) + '</div><div class="bar-vl">' + Math.round(c.cost / 1000) + 'k</div></div>';
          }).join('') + '</div>' +
          '<div class="muted" style="font-size:12px;margin-top:6px">人力成本 = 应发工资 + 单位承担的社保公积金</div></div></div>';
      }

      h += '<div class="card"><div class="card-head"><h3>' + U.esc(month) + ' 工资表明细</h3><span class="spacer"></span>' +
        '<span class="muted" style="font-size:12px">' + list.length + ' 条</span></div><div class="card-body tight">' +
        (list.length ? Table.render([
          { title: '工号', key: 'employeeNo', width: 90, render: r => '<b class="mono">' + U.esc(r.employeeNo) + '</b>' },
          { title: '姓名', key: 'employeeName', width: 90 },
          { title: '部门', key: 'deptName', width: 100 },
          { title: '岗位', key: 'postName', width: 110 },
          { title: '出勤', key: '_att', width: 80, render: r => (r.attendance ? (r.attendance.realDays + '/' + r.attendance.shouldDays) : '—') },
          { title: '加班费', key: '_ot', num: true, width: 90, render: r => r.overtime && r.overtime.total ? '<b class="mono">' + money2(r.overtime.total) + '</b>' : '<span class="muted">—</span>' },
          { title: '应发合计', key: 'grossPay', num: true, width: 110 },
          { title: '社保/公积金', key: '_ins', width: 110, render: r => money2(r.insurancePersonal) },
          { title: '个税', key: 'tax', num: true, width: 90 },
          { title: '实发工资', key: 'netPay', num: true, width: 120, render: r => '<b class="mono">' + money2(r.netPay) + '</b>' },
          { title: '状态', key: 'status', width: 85, render: r => U.statusTag(r.status) }
        ], list, {
          actions: r => '<button class="btn btn-sm" data-pv="' + r.id + '">工资条</button> ' +
            (r.status !== '已发放' ? '<button class="btn btn-sm btn-primary" data-pay="' + r.id + '">发放</button>' : ''),
          actionWidth: 140
        }) : '<div class="empty"><div class="big">💴</div>本月暂无工资数据，点击「生成工资表」</div>') +
        '</div></div>';

      b.innerHTML = h;
      b.querySelectorAll('[data-pv]').forEach(x => x.onclick = () => PaySlip(x.getAttribute('data-pv')));
      b.querySelectorAll('[data-pay]').forEach(x => x.onclick = async () => {
        if (!(await UI.confirm('确认发放该员工工资？', '发放确认'))) return;
        const r = await POST('/api/hr/payrolls/' + x.getAttribute('data-pay') + '/pay', {});
        UI.toast(r.ok ? '发放成功' : (r.msg || '发放失败'), r.ok ? 'ok' : 'err'); load();
      });
    }

    box.querySelector('#pCalc').onclick = async () => {
      const ld = UI.loading('正在试算…');
      const r = await POST('/api/hr/payroll/calc', { month: month });
      ld();
      if (!r.ok) return UI.toast(r.msg || '试算失败', 'err');
      const d = r.data;
      UI.open({
        title: month + ' 薪资试算（未落库）', width: 620,
        body: '<div class="stat-grid">' + stat('人数', d.summary.empCount, '人') + stat('应发合计', U.money(d.summary.gross, 0), '元') +
          stat('实发合计', U.money(d.summary.net, 0), '元') + stat('个税', U.money(d.summary.tax, 0), '元') + '</div>' +
          '<div class="card"><div class="card-body tight">' +
          Table.render([
            { title: '姓名', key: 'employeeName', width: 90 },
            { title: '应发', key: 'grossPay', num: true },
            { title: '社保公积金', key: 'insurancePersonal', num: true },
            { title: '个税', key: 'tax', num: true },
            { title: '实发', key: 'netPay', num: true }
          ], d.list, {}) + '</div></div>',
        hideOk: true
      });
    };
    box.querySelector('#pGen').onclick = async () => {
      if (!(await UI.confirm('将按当月考勤、请假、加班自动生成 ' + month + ' 工资表。已发放的记录不会被覆盖。', '生成确认'))) return;
      const r = await POST('/api/hr/payroll/generate', { month: month });
      UI.toast(r.ok ? ('生成成功：新增 ' + r.data.created + ' 条，更新 ' + r.data.updated + ' 条') : (r.msg || '生成失败'), r.ok ? 'ok' : 'err');
      load();
    };
    box.querySelector('#pPay').onclick = async () => {
      if (!(await UI.confirm('确认批量发放 ' + month + ' 全部待发工资？', '批量发放'))) return;
      const r = await POST('/api/hr/payroll/pay-all', { month: month });
      UI.toast(r.ok ? ('发放 ' + r.data.count + ' 人，合计 ' + money2(r.data.amount)) : (r.msg || '发放失败'), r.ok ? 'ok' : 'err');
      load();
    };
    box.querySelector('#pExp').onclick = () => window.open('/api/hr/export/payroll?month=' + month + '&format=csv', '_blank');
    box.querySelector('#pExpX').onclick = () => window.open('/api/hr/export/payroll?month=' + month + '&format=xls', '_blank');
    load();
  }

  /* ---------- 员工自助：我的工资条 ---------- */
  async function renderMyPayroll(box) {
    let year = U.today().slice(0, 4);
    box.innerHTML = '<div class="toolbar"><b>我的工资条</b><span class="muted" style="font-size:12px">　薪酬数据仅本人可见</span>' +
      '<span class="spacer"></span><select id="myYear" style="width:auto"></select></div><div id="myBox"></div>';
    const sel = box.querySelector('#myYear');
    const ys = [];
    for (let i = 0; i < 3; i++) ys.push(String(Number(year) - i));
    sel.innerHTML = ys.map(y => '<option value="' + y + '">' + y + ' 年</option>').join('');
    async function load() {
      const b = box.querySelector('#myBox');
      b.innerHTML = '<div class="empty">加载中…</div>';
      const r = await GET('/api/hr/my/payrolls?year=' + sel.value);
      const emp = (r.ok && r.data) ? r.data.emp : null;
      const list = (r.ok && r.data) ? r.data.list : [];
      if (!emp) { b.innerHTML = '<div class="empty"><div class="big">💳</div>当前账号未关联员工档案，请联系人事</div>'; return; }
      const totalNet = U.money(list.reduce((a, p) => a + U.num(p.netPay), 0), 2);
      const totalTax = U.money(list.reduce((a, p) => a + U.num(p.tax), 0), 2);
      b.innerHTML = '<div class="card mb12"><div class="card-body">' +
        kv('员工', emp.no + '　' + emp.name) + kv('部门岗位', emp.deptName + ' / ' + emp.postName) +
        kv('统计年度', sel.value + ' 年') + kv('实发累计', '<b class="mono">' + totalNet + '</b>') +
        kv('个税累计', totalTax) + kv('工资条数量', list.length + ' 个月') +
        '</div></div>' +
        (list.length ? '<div class="card"><div class="card-body tight">' + Table.render([
          { title: '月份', key: 'month', width: 90 },
          { title: '应发工资', key: 'grossPay', num: true },
          { title: '社保公积金', key: 'insurancePersonal', num: true },
          { title: '个税', key: 'tax', num: true },
          { title: '实发工资', key: 'netPay', num: true, render: r => '<b class="mono">' + money2(r.netPay) + '</b>' },
          { title: '状态', key: 'status', width: 90, render: r => U.statusTag(r.status) }
        ], list, {
          actions: r => '<button class="btn btn-sm" data-myslip="' + r.id + '">明细</button>', actionWidth: 80
        }) + '</div></div>' : '<div class="empty">暂无工资记录</div>');
      b.querySelectorAll('[data-myslip]').forEach(x => x.onclick = () => {
        const row = list.filter(i => String(i.id) === String(x.getAttribute('data-myslip')))[0];
        if (row) PaySlip(row);
      });
    }
    sel.onchange = load;
    load();
  }

  /* ---------- 员工自助：我的考勤 ---------- */
  async function renderMyAttendance(box) {
    let month = U.month();
    box.innerHTML = '<div class="toolbar"><b>我的考勤</b><span class="spacer"></span>' +
      '<input type="month" id="myaMonth" value="' + month + '" style="width:150px"></div><div id="myaBox"></div>';
    async function load() {
      const b = box.querySelector('#myaBox');
      b.innerHTML = '<div class="empty">加载中…</div>';
      const r = await GET('/api/hr/my/attendance?month=' + box.querySelector('#myaMonth').value);
      const s = (r.ok && r.data) ? r.data.summary : null;
      const list = (r.ok && r.data) ? r.data.list : [];
      if (!s) { b.innerHTML = '<div class="empty"><div class="big">📅</div>当前账号未关联员工档案</div>'; return; }
      b.innerHTML = '<div class="stat-grid">' +
        stat('应出勤', s.shouldDays, '天') + stat('实出勤', s.realDays, '天') +
        stat('迟到', s.lateCount, '次', s.lateCount ? 'orange' : '') +
        stat('早退', s.earlyCount, '次', s.earlyCount ? 'orange' : '') +
        stat('旷工', s.absentDays, '天', s.absentDays ? 'red' : '') +
        stat('请假', s.leaveDays, '天') + stat('加班', s.otHours, '小时') + stat('夜班', s.nightCount, '次') +
        '</div>' +
        (list.length ? '<div class="card"><div class="card-body tight">' + Table.render([
          { title: '日期', key: 'date', width: 105 },
          { title: '班次', key: 'shiftName', width: 100 },
          { title: '上班', key: 'checkIn', width: 90 }, { title: '下班', key: 'checkOut', width: 90 },
          { title: '状态', key: 'status', width: 100, render: r => attTag(r.status) },
          { title: '迟到(分)', key: 'lateMin', width: 85, num: true },
          { title: '加班(h)', key: 'otHours', width: 80, num: true }
        ], list, {}) + '</div></div>' : '<div class="empty">本月暂无考勤记录</div>');
    }
    box.querySelector('#myaMonth').onchange = load;
    load();
  }

  async function PaySlip(idOrObj) {
    let p = idOrObj;
    if (typeof idOrObj === 'string') {
      const rr = await GET('/api/hr/payrolls/' + idOrObj);
      if (!rr.ok) { UI.toast('无法查看该工资明细：' + (rr.msg || ''), 'err'); return; }
      p = rr.data;
    }
    const add = (p.items || []).filter(i => i.type === 'add');
    const sub = (p.items || []).filter(i => i.type === 'sub');
    const rows = add.map(i => ({ t: i.name, a: i.amount, b: '' }))
      .concat(sub.map(i => ({ t: i.name, a: '', b: i.amount })));
    UI.drawer('工资条 · ' + p.employeeName + ' · ' + p.month,
      '<div class="card mb12"><div class="card-head"><h3>' + U.esc(p.code || '') + '　' + U.esc(p.employeeNo) + '　' + U.esc(p.deptName) + ' / ' + U.esc(p.postName) + '</h3></div>' +
      '<div class="card-body">' + kv('发放状态', p.status) + kv('发放日期', p.payDate || '—') + kv('发放人', p.payee || '—') + kv('发放渠道', p.payChannel || '—') + '</div></div>' +

      '<div class="card mb12"><div class="card-head"><h3>工资构成</h3></div><div class="card-body tight">' +
      Table.render([
        { title: '项目', key: 't', width: 220 },
        { title: '收入金额', key: 'a', num: true, width: 130, render: r => r.a === '' ? '' : '<b class="mono">' + money2(r.a) + '</b>' },
        { title: '扣款金额', key: 'b', num: true, width: 130, render: r => r.b === '' ? '' : '<b class="mono" style="color:var(--danger)">-' + money2(r.b) + '</b>' }
      ], rows, {}) +
      '</div></div>' +

      '<div class="card mb12"><div class="card-head"><h3>核算结果</h3></div><div class="card-body">' +
      '<div class="pay-sum"><div><span class="muted">收入合计</span><b>' + money2(p.addTotal) + '</b></div>' +
      '<div><span class="muted">扣款合计</span><b style="color:var(--danger)">-' + money2(p.subTotal) + '</b></div>' +
      '<div><span class="muted">应发工资</span><b>' + money2(p.grossPay) + '</b></div>' +
      '<div><span class="muted">社保+公积金（个人）</span><b style="color:var(--danger)">-' + money2(p.insurancePersonal) + '</b></div>' +
      '<div><span class="muted">个人所得税</span><b style="color:var(--danger)">-' + money2(p.tax) + '</b></div>' +
      '<div class="net"><span class="muted">实发工资</span><b>' + money2(p.netPay) + '</b></div>' +
      '</div></div></div>' +

      '<div class="card mb12"><div class="card-head"><h3>社保公积金明细</h3></div><div class="card-body">' +
      kv('社保缴费基数', money2(p.socialBase)) + kv('公积金基数', money2(p.fundBase)) +
      kv('个人承担（社保）', money2(p.socialPersonal)) + kv('个人承担（公积金）', money2(p.fundPersonal)) +
      kv('单位承担合计', money2(p.insuranceUnit)) + kv('单位人力成本', '<b class="mono">' + money2((p.grossPay || 0) + (p.insuranceUnit || 0)) + '</b>') +
      '<div style="width:100%;margin-top:8px">' + Table.render([
        { title: '险种', key: 'name', width: 80 },
        { title: '个人比例', key: 'personalRate', width: 90, render: r => (U.num(r.personalRate) * 100).toFixed(1) + '%' },
        { title: '个人缴纳', key: 'personal', num: true },
        { title: '单位比例', key: 'unitRate', width: 90, render: r => (U.num(r.unitRate) * 100).toFixed(1) + '%' },
        { title: '单位缴纳', key: 'unit', num: true }
      ], (p.insuranceDetail || []).concat([{ name: '公积金', personalRate: U.num(p.fundPersonal) / (U.num(p.fundBase) || 1), personal: p.fundPersonal, unitRate: U.num(p.fundPersonal) / (U.num(p.fundBase) || 1), unit: p.fundPersonal }]), {}) +
      '</div></div></div>' +

      '<div class="card mb12"><div class="card-head"><h3>个税计算（累计预扣预缴法）</h3></div><div class="card-body">' +
      kv('累计收入（含期初）', money2(p.accumIncome)) + kv('累计减除费用', money2(p.basicDeduct)) +
      kv('累计专项扣除', money2(p.accumInsurance)) + kv('累计专项附加扣除', money2(p.accumSpecial)) +
      kv('累计应纳税所得额', '<b class="mono">' + money2(p.accumTaxable) + '</b>') +
      kv('适用税率', (U.num(p.taxRate) * 100).toFixed(0) + '%') +
      kv('本月应预扣个税', '<b class="mono">' + money2(p.tax) + '</b>') +
      '<div class="muted" style="width:100%;margin-top:8px;font-size:12px">按国家税务总局 2019 年起居民个人工资薪金所得预扣预缴口径：本期应预扣 = (累计应纳税所得额 × 预扣率 − 速算扣除数) − 累计已预扣。</div>' +
      '</div></div>' +

      '<div class="card"><div class="card-head"><h3>考勤与加班</h3></div><div class="card-body">' +
      kv('应出勤', U.num((p.attendance || {}).shouldDays) + ' 天') + kv('实出勤', U.num((p.attendance || {}).realDays) + ' 天') +
      kv('迟到次数', U.num((p.attendance || {}).lateCount) + ' 次') + kv('旷工天数', U.num((p.attendance || {}).absentDays) + ' 天') +
      kv('请假日合计', U.num((p.attendance || {}).leaveDays) + ' 天') + kv('其中无薪假', U.num((p.attendance || {}).unpaidLeaveDays) + ' 天') +
      kv('加班合计', U.num((p.attendance || {}).otHours) + ' 小时') + kv('加班费', money2((p.overtime || {}).total)) +
      '<div style="width:100%;margin-top:8px">' + Table.render([
        { title: '加班类型', key: 'type', width: 100 }, { title: '小时', key: 'hours', num: true, width: 80 },
        { title: '倍率', key: 'rate', width: 70, render: r => r.rate + '×' },
        { title: '小时工资', key: 'hourRate', num: true }, { title: '金额', key: 'amount', num: true }
      ], (p.overtime || {}).items || [], {}) + '</div></div></div>'
    );
  }

  /* ==================== 5. 社保规则 ==================== */
  async function renderInsurance(box) {
    const r = await GET('/api/hr/insurance');
    const p = (r.ok && r.data) ? r.data : {};
    const items = p.items || [];
    box.innerHTML = '<div class="card"><div class="card-head"><h3>社保公积金缴费政策</h3><span class="spacer"></span>' +
      '<button class="btn btn-primary" id="btnSaveIns">保存</button></div><div class="card-body">' +
      '<div class="form-grid">' +
      '<div><label class="fld">参保城市</label><input id="iCity" value="' + U.esc(p.city || '') + '"></div>' +
      '<div><label class="fld">社保基数下限</label><input id="iSMin" type="number" value="' + U.num(p.socialMin) + '"></div>' +
      '<div><label class="fld">社保基数上限</label><input id="iSMax" type="number" value="' + U.num(p.socialMax) + '"></div>' +
      '<div><label class="fld">公积金基数下限</label><input id="iFMin" type="number" value="' + U.num(p.fundMin) + '"></div>' +
      '<div><label class="fld">公积金基数上限</label><input id="iFMax" type="number" value="' + U.num(p.fundMax) + '"></div>' +
      '<div><label class="fld">公积金比例（个人=单位）</label><input id="iFRate" type="number" step="0.001" value="' + U.num(p.fundRate) + '"></div>' +
      '</div>' +
      '<div class="mt12"><b>险种比例（可编辑，按当地人社/公积金年度政策调整）</b></div>' +
      '<div id="insItems" class="card-body tight">' +
      Table.render([
        { title: '险种', key: 'name', width: 100, render: (r, i) => '<input class="it-name" data-i="' + i + '" value="' + U.esc(r.name) + '" style="width:90px">' },
        { title: '单位比例', key: 'unitRate', width: 120, render: (r, i) => '<input class="it-unit" data-i="' + i + '" type="number" step="0.001" value="' + U.num(r.unitRate) + '" style="width:100px">' },
        { title: '个人比例', key: 'personalRate', width: 120, render: (r, i) => '<input class="it-personal" data-i="' + i + '" type="number" step="0.001" value="' + U.num(r.personalRate) + '" style="width:100px">' },
        { title: '操作', key: '_x', width: 70, render: (r, i) => '<button class="btn btn-sm" data-del-ins="' + i + '">删除</button>' }
      ], items, {}) +
      '</div>' +
      '<div class="mt8"><button class="btn btn-sm" id="btnAddIns">+ 增加险种</button></div>' +
      '<div class="muted mt12" style="font-size:12px">说明：缴费基数 = 员工档案基数（空则取基本+岗位工资），再按上下限自动封顶保底。比例按小数填写，如 0.08 表示 8%。</div>' +
      '</div></div>';

    function collectItems() {
      const trs = box.querySelectorAll('#insItems .it-name');
      const out = [];
      trs.forEach(inp => {
        const i = inp.getAttribute('data-i');
        const unit = box.querySelector('.it-unit[data-i="' + i + '"]');
        const per = box.querySelector('.it-personal[data-i="' + i + '"]');
        out.push({ name: inp.value, unitRate: U.num(unit && unit.value), personalRate: U.num(per && per.value) });
      });
      return out;
    }
    box.querySelector('#btnAddIns').onclick = async () => {
      const arr = collectItems().concat([{ name: '新险种', unitRate: 0, personalRate: 0 }]);
      const saved = await POST('/api/hr/insurance', {
        city: box.querySelector('#iCity').value,
        socialMin: U.num(box.querySelector('#iSMin').value), socialMax: U.num(box.querySelector('#iSMax').value),
        fundMin: U.num(box.querySelector('#iFMin').value), fundMax: U.num(box.querySelector('#iFMax').value),
        fundRate: U.num(box.querySelector('#iFRate').value), items: arr
      });
      UI.toast(saved.ok ? '已保存并新增险种' : (saved.msg || '保存失败'), saved.ok ? 'ok' : 'err');
      Cache.bust(); renderInsurance(box);
    };
    box.querySelectorAll('[data-del-ins]').forEach(b => b.onclick = async () => {
      const arr = collectItems();
      arr.splice(Number(b.getAttribute('data-del-ins')), 1);
      await POST('/api/hr/insurance', {
        city: box.querySelector('#iCity').value,
        socialMin: U.num(box.querySelector('#iSMin').value), socialMax: U.num(box.querySelector('#iSMax').value),
        fundMin: U.num(box.querySelector('#iFMin').value), fundMax: U.num(box.querySelector('#iFMax').value),
        fundRate: U.num(box.querySelector('#iFRate').value), items: arr
      });
      Cache.bust(); renderInsurance(box);
    });
    box.querySelector('#btnSaveIns').onclick = async () => {
      const r2 = await POST('/api/hr/insurance', {
        city: box.querySelector('#iCity').value,
        socialMin: U.num(box.querySelector('#iSMin').value), socialMax: U.num(box.querySelector('#iSMax').value),
        fundMin: U.num(box.querySelector('#iFMin').value), fundMax: U.num(box.querySelector('#iFMax').value),
        fundRate: U.num(box.querySelector('#iFRate').value), items: collectItems()
      });
      UI.toast(r2.ok ? '社保规则已保存（后续生成工资表立即生效）' : (r2.msg || '保存失败'), r2.ok ? 'ok' : 'err');
    };
  }

})();
