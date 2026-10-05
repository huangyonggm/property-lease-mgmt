/* 视图：驾驶舱 / 组织权限 / 房源管理 / 客户档案 */
(function () {

  /* ============ 驾驶舱 ============ */
  App.view('dashboard', {
    title: '驾驶舱',
    async render(el) {
      const r = await GET('/api/report/dashboard');
      if (!r.ok) { el.innerHTML = '<div class="empty">加载失败</div>'; return; }
      const d = r.data;
      const rm = await GET('/api/reminders');
      const re = rm.ok ? rm.data.summary : { total: 0, urgent: 0, arrearsAmount: 0 };
      const exp = await GET('/api/contract/expiring?months=6');

      let h = '<div class="stat-grid">' +
        stat('blue', '房源总数', d.rooms.total + ' 间', '空置 ' + d.rooms.vacant + ' / 已租 ' + d.rooms.rented) +
        stat('green', '在租合同', d.contracts.active + ' 份', '总合同 ' + d.contracts.total + ' 份') +
        stat('orange', '本月应收', '¥' + U.money(d.bill.total), '已收 ¥' + U.money(d.bill.paid)) +
        stat('red', '欠费金额', '¥' + U.money(d.arrears.amount), d.arrears.count + ' 笔账单待收') +
        stat('cyan', '今日收款', '¥' + U.money(d.todayCollection.total), d.todayCollection.count + ' 笔') +
        stat('purple', '押金在管', '¥' + U.money(d.deposits.holding), d.deposits.pending + ' 笔待退') +
        stat('blue', '待办工单', d.workorders.pending + ' 条', '累计 ' + d.workorders.total + ' 条') +
        stat('orange', '待审批', d.approvals.pending + ' 条', '到期/欠费提醒 ' + re.total + ' 条') +
        '</div>';

      h += '<div class="grid2 mt12">';
      // 项目出租率
      h += '<div class="card"><div class="card-head"><h3>各项目出租情况</h3><span class="spacer"></span>' +
        '<button class="btn btn-sm" onclick="location.hash=\'#/property\'">查看房源</button></div><div class="card-body tight">' +
        '<table class="tbl"><thead><tr><th>项目</th><th class="right">房源</th><th class="right">空置</th><th class="right">在租合同</th><th class="right">出租率</th><th class="right">月租金</th></tr></thead><tbody>' +
        d.projects.map(p => '<tr><td class="b">' + U.esc(p.name) + '</td><td class="num">' + p.rooms + '</td><td class="num">' + p.vacant +
          '</td><td class="num">' + p.contracts + '</td><td class="num">' + bar(p.occupancy) + '</td><td class="num">¥' + U.money(p.monthlyRent) + '</td></tr>').join('') +
        '</tbody></table></div></div>';
      // 到期预警
      h += '<div class="card"><div class="card-head"><h3>合同到期预警（6 个月内）</h3><span class="spacer"></span>' +
        '<button class="btn btn-sm" onclick="location.hash=\'#/contract\'">合同管理</button></div><div class="card-body tight">' +
        '<table class="tbl"><thead><tr><th>合同号</th><th>客户</th><th>房号</th><th class="right">剩余天数</th><th>级别</th></tr></thead><tbody>' +
        (exp.ok && exp.data.list.length ? exp.data.list.slice(0, 8).map(c => '<tr><td class="mono">' + U.esc(c.code) + '</td><td>' + U.esc(c.customerName) +
          '</td><td class="muted">' + U.esc((c.roomCodes || []).join('、')) + '</td><td class="num b">' + c.daysLeft + ' 天</td><td>' + U.statusTag(c.level) + '</td></tr>').join('')
          : '<tr><td colspan="5" class="empty">暂无到期预警</td></tr>') +
        '</tbody></table></div></div>';
      h += '</div>';

      // 提醒中心
      const rlist = (rm.ok ? rm.data.list : []).slice(0, 10);
      h += '<div class="card mt12"><div class="card-head"><h3>提醒中心</h3><span class="spacer"></span>' +
        '<span class="muted">紧急 ' + re.urgent + ' 条 / 欠费合计 ¥' + U.money(re.arrearsAmount) + '</span></div>' +
        '<div class="card-body tight"><table class="tbl"><thead><tr><th>类型</th><th>内容</th><th>级别</th><th>操作</th></tr></thead><tbody>' +
        (rlist.length ? rlist.map(x => '<tr><td>' + U.tag(x.type, x.type === '合同到期' ? 'blue' : 'orange') + '</td><td>' + U.esc(x.content) +
          '</td><td>' + U.statusTag(x.level) + '</td><td><button class="btn btn-sm" data-handle="' + x.id + '">处理</button></td></tr>').join('')
          : '<tr><td colspan="4" class="empty">暂无提醒</td></tr>') +
        '</tbody></table></div></div>';

      el.innerHTML = h;
      el.querySelectorAll('[data-handle]').forEach(b => {
        b.onclick = async () => {
          UI.open({
            title: '处理提醒', body: '<label class="fld">处理结果</label><textarea id="hRes" placeholder="填写跟进结果"></textarea>',
            onOk(m) { const v = m.querySelector('#hRes').value; return POST('/api/reminders/' + b.getAttribute('data-handle') + '/handle', { result: v }).then(() => { UI.toast('已处理', 'ok'); setTimeout(() => App.render(), 400); }); }
          });
        };
      });

      function stat(c, k, v, s) { return '<div class="stat ' + c + '"><span class="bar"></span><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s">' + s + '</div></div>'; }
      function bar(p) {
        const c = p >= 80 ? 'var(--success)' : (p >= 50 ? 'var(--warn)' : 'var(--danger)');
        return '<span style="display:inline-block;width:70px;height:6px;background:#eef1f6;border-radius:3px;overflow:hidden;vertical-align:middle">' +
          '<span style="display:block;width:' + p + '%;height:100%;background:' + c + '"></span></span> <b>' + p + '%</b>';
      }
    }
  });

  /* ============ 角色权限标签（列表展示用） ============ */
  /**
   * 把角色持有的权限码渲染成「菜单名 + 额外操作数」的标签。
   *
   * 【为什么不再显示裸编码】原来这一列是「47 项」这种数字，
   * 管理员看不出这个角色到底能干什么、看不见合同还是看不见发票。
   * 现在按菜单聚合：合同管理(2) / 发票管理(1) … 一眼能对上职责。
   *
   * 菜单勾选状态 = 有没有该模块的 view 权限（与后端 menusOf 同一把尺子），
   * 所以这里显示的菜单和该角色登录后侧边栏能看到的**必然一致**。
   *
   * @param {Array<string>} perms 权限码数组
   * @returns {string} HTML
   */
  function menuTags(perms) {
    const arr = Array.isArray(perms) ? perms.map(String) : [];
    if (arr.indexOf('*') >= 0) return '<span class="tag blue">全部权限</span>';
    const tree = (App.permTree || []);
    if (!tree.length) return '<span class="muted">' + arr.length + ' 项</span>';
    const parts = [];
    tree.forEach(menu => {
      if (arr.indexOf(menu.viewCode) < 0) return;   // 没 view → 菜单不会出现，不列
      const sub = menu.actions.filter(a => a.code !== menu.viewCode && arr.indexOf(a.code) >= 0);
      // 「合同管理」+「+2」表示除查看外还有 2 项操作权限
      parts.push('<span class="tag blue">' + U.esc(menu.label) +
        (sub.length ? '<b style="font-weight:400;opacity:.75"> +' + sub.length + '</b>' : '') + '</span>');
    });
    return parts.length ? parts.join(' ') : '<span class="muted">未授权任何菜单</span>';
  }

  /* ============ 组织权限 ============ */
  App.view('org', {
    title: '组织架构与权限',
    async render(el) {
      const tabs = [
        { key: 'dept', name: '部门' }, { key: 'post', name: '岗位' },
        { key: 'role', name: '角色与权限' }, { key: 'user', name: '用户' }, { key: 'flow', name: '审批流配置' }
      ];
      let cur = 'dept';
      el.innerHTML = '<div class="tabs">' + tabs.map(t => '<div class="tab' + (t.key === cur ? ' active' : '') + '" data-tab="' + t.key + '">' + t.name + '</div>').join('') +
        '</div><div id="orgBody"></div>';
      el.querySelectorAll('[data-tab]').forEach(t => {
        t.onclick = () => {
          el.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('active'));
          t.classList.add('active'); cur = t.getAttribute('data-tab'); renderTab();
        };
      });
      async function renderTab() {
        const box = el.querySelector('#orgBody');
        box.innerHTML = '';
        if (cur === 'dept') {
          const v = CrudView({
            title: '部门', name: '部门', api: '/api/org/depts', size: 100,
            columns: [{ title: '编码', key: 'code', width: 100 }, { title: '部门名称', key: 'name' },
            { title: '上级', key: 'parentId', render: r => (r.parentId ? '' : '—') }, { title: '负责人', key: 'manager' },
            { title: '状态', key: 'status', render: r => U.statusTag(r.status) }, { title: '备注', key: 'remark' }],
            fields: [{ key: 'code', label: '部门编码', required: true }, { key: 'name', label: '部门名称', required: true },
            { key: 'parentId', label: '上级部门' }, { key: 'manager', label: '负责人' },
            { key: 'status', label: '状态', type: 'select', options: ['启用', '停用'], default: '启用' },
            { key: 'remark', label: '备注', span: 'full' }],
            // 【补操作列】CrudView 的「操作」列只在传了 actions 时才渲染
            //（Table.render: if (opt.actions) 才加 <th>操作</th>）。
            // 漏配就没有编辑入口，只能手改 JSON —— 部门 / 项目都踩过这个坑。
            actions: () => '<button class="btn btn-sm" data-act2="edit">编辑</button>',
            rowActions: {
              edit(row, done) { v.cfg._openForm(row, done); }
            }
          });
          await v.render(box);
        } else if (cur === 'post') {
          const depts = await Cache.depts();
          const v = CrudView({
            title: '岗位', name: '岗位', api: '/api/org/posts', size: 200,
            columns: [{ title: '岗位名称', key: 'name' }, { title: '所属部门', key: 'deptName' }, { title: '说明', key: 'desc' }, { title: '状态', key: 'status', render: r => U.statusTag(r.status) }],
            fields: [{ key: 'name', label: '岗位名称', required: true },
            { key: 'deptId', label: '所属部门', type: 'select', options: depts.map(d => ({ value: d.id, text: d.name })), required: true },
            { key: 'desc', label: '岗位说明', span: 'full' },
            { key: 'status', label: '状态', type: 'select', options: ['启用', '停用'], default: '启用' }]
          });
          await v.render(box);
        } else if (cur === 'role') {
          const pm = await GET('/api/auth/perms');
          const tree = (pm.data && pm.data.tree) || [];
          // 数据范围中文名映射（选项用对象 {value,text}，避免后续翻译逻辑散落到各处）
          const DSA = { all: '全公司', dept: '本部门', project: '按项目', self: '本人' };
          // 缓存权限树：角色列表的「可见菜单」列要靠它把编码翻译成中文菜单名。
          // App 是全局的，跨视图复用，避免每个列表都去请求一次
          App.permTree = tree;
          const v = CrudView({
            title: '角色', name: '角色', api: '/api/org/roles', size: 200, formWidth: 'wide',
            columns: [{ title: '角色编码', key: 'code', width: 100 }, { title: '角色名称', key: 'name' },
            { title: '可见菜单', key: 'perms', width: 190, render: r => menuTags(r.perms) },
            { title: '数据范围', key: 'dataScope', render: r => U.esc(DSA[r.dataScope] || r.dataScope) },
            { title: '权限数', key: 'perms', width: 80, render: r => (r.perms || []).length + ' 项' },
            { title: '说明', key: 'remark' }],
            // 【补上操作列】CrudView 的「操作」列只有在传了 actions 时才渲染
            // （Table.render 里 `if (opt.actions)` 才加 <th>操作</th>）。
            // 原来这个页面没配 actions，角色列表根本没有编辑入口 ——
            // 权限只能靠手改 roles.json 配。这次要把「按菜单勾选」做成界面，
            // 编辑入口是前提。
            actions: () => '<button class="btn btn-sm" data-act2="edit">编辑权限</button>',
            rowActions: {
              edit(row, done) { v.cfg._openForm(row, done); }
            },
            fields: [{ key: 'code', label: '角色编码', required: true }, { key: 'name', label: '角色名称', required: true },
            { key: 'dataScope', label: '数据范围', type: 'select', options: [
              { value: 'all', text: '全公司' },
              { value: 'dept', text: '本部门' },
              { value: 'project', text: '按项目' },
              { value: 'self', text: '本人' }
            ], default: 'all' },
            { key: 'remark', label: '说明' },
            {
              key: 'perms', label: '功能权限（按菜单勾选）', type: 'perms', span: 'full', tree: tree,
              hint: '先勾菜单（决定侧边栏是否出现），再勾该菜单下能做的操作。' +
                '勾了子权限会自动补上该菜单的「查看」——否则菜单不显示、页面也打不开。'
            }]
          });
          await v.render(box);
        } else if (cur === 'user') {
          const [depts, posts, roles, projects] = await Promise.all([Cache.depts(), Cache.posts(), Cache.roles(), Cache.projects()]);
          const v = CrudView({
            title: '用户', name: '用户', api: '/api/org/users', size: 100, formWidth: 'wide',
            filters: [{ key: 'keyword', label: '搜索姓名/账号' }],
            columns: [{ title: '登录账号', key: 'username', width: 110 }, { title: '姓名', key: 'name', width: 90 },
            { title: '部门', key: 'deptName', width: 90 }, { title: '岗位', key: 'postName', width: 100 },
            { title: '角色', key: 'roleName', width: 100 }, { title: '数据范围', key: 'dataScope', width: 80 },
            { title: '电话', key: 'phone', width: 110 }, { title: '状态', key: 'status', render: r => U.statusTag(r.status) }],
            actions: r => '<button class="btn btn-sm" data-act2="edit">编辑</button> <button class="btn btn-sm" data-act2="reset">重置密码</button>',
            rowActions: {
              edit(row, done) { v.cfg._openForm(row, done); },
              reset(row) {
                UI.open({
                  title: '重置密码：' + row.name, body: '<label class="fld">新密码</label><input type="text" id="np" value="123456">',
                  onOk(m) { return POST('/api/org/users/' + row.id + '/reset', { password: m.querySelector('#np').value }).then(() => UI.toast('已重置', 'ok')); }
                });
              }
            },
            fields: [{ key: 'username', label: '登录账号', required: true }, { key: 'name', label: '姓名', required: true },
            { key: 'password', label: '密码（留空默认 123456）', type: 'password' },
            { key: 'deptId', label: '部门', type: 'select', options: depts.map(d => ({ value: d.id, text: d.name })) },
            { key: 'postId', label: '岗位', type: 'select', options: posts.map(p => ({ value: p.id, text: p.name })) },
            { key: 'roleId', label: '角色', type: 'select', options: roles.map(r => ({ value: r.id, text: r.name })) },
            { key: 'phone', label: '联系电话' },
            { key: 'dataScope', label: '数据范围', type: 'select', options: [
              { value: 'all', text: '全公司' },
              { value: 'dept', text: '本部门' },
              { value: 'project', text: '按项目' },
              { value: 'self', text: '本人' }
            ], default: 'all' },
            { key: 'dingtalkUserId', label: '钉钉 UserID' },
            { key: 'status', label: '状态', type: 'select', options: ['启用', '停用'], default: '启用' },
            { key: 'projectIds', label: '可见项目（逗号分隔 id，留空=全部）', span: 'full' },
            {
              key: 'perms', label: '实际权限（跟随上方所选角色）', type: 'static', span: 'full',
              render: () => '<div class="muted" style="font-size:12.5px">权限统一由角色管理，此处只读展示。' +
                '如需给个别人临时加权限，请新建一个角色（如「合同只读」）再指派给他。</div>'
            }],
            beforeSave(v) {
              if (typeof v.projectIds === 'string') v.projectIds = v.projectIds.split(',').map(s => s.trim()).filter(Boolean);
              if (!v.password) delete v.password;
              return true;
            }
          });
          await v.render(box);
        } else {
          const flows = await GET('/api/org/flows');
          const users = await Cache.users();
          box.innerHTML = '<div class="card"><div class="card-head"><h3>多级审批流配置</h3><span class="spacer"></span>' +
            '<button class="btn btn-primary btn-sm" id="addFlow">+ 新增审批流</button></div><div class="card-body">' +
            '<div class="muted mb12">合同审批默认 2 级：招商经理（价格审核）→ 财务经理（租金审核）；免租期 ≥ 2 个月时追加总经理（免租期审核）。</div>' +
            Table.render([{ title: '审批类型', key: 'type' }, { title: '适用条件', key: 'condition' },
            { title: '节点', key: 'steps', render: r => (r.steps || []).map(s => U.tag(s.name)).join(' → ') || '—' },
            { title: '状态', key: 'status', render: r => U.statusTag(r.status || '启用') }],
              flows.data || [], {
              actions: r => '<button class="btn btn-sm" data-editflow="' + r.id + '">编辑</button>'
            }) + '</div></div>';
          box.querySelector('#addFlow').onclick = () => editFlow(null);
          box.querySelectorAll('[data-editflow]').forEach(b => b.onclick = () => editFlow(b.getAttribute('data-editflow')));
          function editFlow(id) {
            const f = id ? (flows.data || []).filter(x => x.id === id)[0] : {};
            UI.open({
              title: (id ? '编辑' : '新增') + '审批流', width: 'wide',
              body: Form.html([
                { key: 'type', label: '审批类型', type: 'select', options: ['合同审批', '价格审核', '租金审核', '免租期审核', '退租审批', '押金退回'], default: f.type || '合同审批' },
                { key: 'condition', label: '适用条件', default: f.condition || '', placeholder: '如：免租期≥2个月' },
                { key: 'stepsText', label: '审批节点（每行一个：节点名称|角色编码|用户）', span: 'full', type: 'textarea', default: (f.steps || []).map(s => s.name + '|' + (s.roleCode || '') + '|' + (s.userId || '')).join('\n') },
                { key: 'status', label: '状态', type: 'select', options: ['启用', '停用'], default: f.status || '启用' }
              ], f),
              onOk(m) {
                const v = Form.read(m, [{ key: 'type' }, { key: 'condition' }, { key: 'stepsText' }, { key: 'status' }]);
                const steps = v.stepsText.split('\n').filter(Boolean).map((line, i) => {
                  const p = line.split('|');
                  return { level: i + 1, name: p[0], roleCode: p[1] || '', userId: p[2] || '', status: '待审批' };
                });
                return POST('/api/org/flows', Object.assign({ id: id || undefined }, v, { steps: steps })).then(() => { UI.toast('已保存', 'ok'); setTimeout(renderTab, 300); });
              }
            });
          }
        }
      }
      await renderTab();
    }
  });

  /* ============ 房源管理 ============ */
  App.view('property', {
    title: '房源（不动产）管理',
    async render(el) {
      const tabs = [{ key: 'project', name: '项目' }, { key: 'building', name: '楼栋与楼层' }, { key: 'room', name: '房间' }, { key: 'stats', name: '房源统计' }];
      let cur = 'room';
      el.innerHTML = '<div class="tabs">' + tabs.map(t => '<div class="tab' + (t.key === cur ? ' active' : '') + '" data-tab="' + t.key + '">' + t.name + '</div>').join('') +
        '</div><div id="ptBody"></div>';
      el.querySelectorAll('[data-tab]').forEach(t => {
        t.onclick = () => { el.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('active')); t.classList.add('active'); cur = t.getAttribute('data-tab'); renderTab(); };
      });

      async function renderTab() {
        const box = el.querySelector('#ptBody');
        box.innerHTML = '';
        if (cur === 'project') {
          const users = await Cache.users();
          const v = CrudView({
            title: '项目', name: '项目', api: '/api/property/projects', size: 100, formWidth: 'wide',
            columns: [{ title: '编码', key: 'code', width: 90 }, { title: '项目名称', key: 'name', render: r => '<b>' + U.esc(r.name) + '</b>' },
            { title: '招商端口', key: 'portName' }, { title: '地址', key: 'address' },
            { title: '负责人', key: 'managerName', width: 90 }, { title: '楼栋', key: 'buildingCount', width: 60, num: true },
            { title: '房间', key: 'roomCount', width: 60, num: true }, { title: '空置', key: 'vacantCount', width: 60, num: true },
            { title: '出租率', key: 'occupancy', width: 80, render: r => r.occupancy + '%' },
            { title: '状态', key: 'status', render: r => U.statusTag(r.status) }],
            // 【补操作列】CrudView 的「操作」列只在传了 actions 时才渲染
            //（Table.render: if (opt.actions) 才加 <th>操作</th>）。
            // 漏配就没有编辑入口，只能手改 JSON —— 部门 / 项目都踩过这个坑。
            actions: () => '<button class="btn btn-sm" data-act2="edit">编辑</button>',
            rowActions: {
              edit(row, done) { v.cfg._openForm(row, done); }
            },
            fields: [{ key: 'code', label: '项目编码', required: true }, { key: 'name', label: '项目名称', required: true },
            { key: 'portName', label: '招商端口名称' }, { key: 'address', label: '不动产地址', span: 'full' },
            { key: 'lessorName', label: '出租方主体（合同默认）' },
            { key: 'lessorCreditCode', label: '出租方统一信用代码' },
            { key: 'managerId', label: '项目负责人', type: 'select', options: users.map(u => ({ value: u.id, text: u.name })) },
            { key: 'area', label: '总建筑面积(㎡)', type: 'number' },
            { key: 'status', label: '状态', type: 'select', options: ['启用', '停用'], default: '启用' },
            { key: 'remark', label: '备注', span: 'full' }]
          });
          await v.render(box);
        } else if (cur === 'building') {
          const projects = await Cache.projects();
          const v = CrudView({
            title: '楼栋', name: '楼栋', api: '/api/property/buildings', size: 200, formWidth: 'wide',
            filters: [{ key: 'projectId', label: '项目', type: 'select', options: projects.map(p => ({ value: p.id, text: p.name })) }],
            columns: [{ title: '编码', key: 'code', width: 80 }, { title: '楼栋', key: 'name' }, { title: '项目', key: 'projectName' },
            { title: '层数', key: 'floors', width: 60, num: true }, { title: '房间', key: 'roomCount', width: 60, num: true },
            { title: '空置', key: 'vacantCount', width: 60, num: true },
            { title: '空调层', key: 'acFloors', render: r => (r.acFloors || []).map(f => U.tag(f, 'cyan')).join(' ') || '—' },
            { title: '消防层', key: 'fireFloors', render: r => (r.fireFloors || []).map(f => U.tag(f, 'red')).join(' ') || '—' },
            { title: '跳层规则', key: 'floorAlias', render: r => '<span class="muted">4→3A，14→13A</span>' }],
            actions: r => '<button class="btn btn-sm" data-act2="floors">楼层</button> <button class="btn btn-sm" data-act2="edit">编辑</button>',
            rowActions: {
              edit(row, done) { v.cfg._openForm(row, done); },
              async floors(row) {
                const r = await GET('/api/property/buildings/' + row.id + '/floors');
                UI.open({
                  title: row.name + ' 楼层一览（含跳层）', width: 'wide', hideCancel: true,
                  body: '<div class="mb8 muted">跳层规则：4 楼用 3A 代替、14 楼用 13A 代替；蓝色为中央空调层，红色为消防楼层。</div>' +
                    Table.render([{ title: '楼层', key: 'label', width: 70 }, { title: '房间数', key: 'roomCount', width: 70, num: true },
                    { title: '空置', key: 'vacantCount', width: 70, num: true }, { title: '面积(㎡)', key: 'area', width: 100, num: true },
                    { title: '标记', key: 'x', render: r => (r.isSkip ? U.tag('跳层', 'purple') : '') + ' ' + (r.isAc ? U.tag('中央空调', 'cyan') : '') + ' ' + (r.isFire ? U.tag('消防楼层', 'red') : '') }],
                      r.data || [])
                });
              }
            },
            fields: [{ key: 'projectId', label: '所属项目', type: 'select', options: projects.map(p => ({ value: p.id, text: p.name })), required: true },
            { key: 'code', label: '楼栋编码' }, { key: 'name', label: '楼栋名称', required: true },
            { key: 'floors', label: '层数', type: 'number', default: 10 },
            { key: 'buildArea', label: '建筑面积(㎡)', type: 'number' },
            { key: 'acFloorsText', label: '中央空调楼层（逗号分隔）', default: (row => '') },
            { key: 'fireFloorsText', label: '消防楼层（逗号分隔）' },
            { key: 'remark', label: '备注', span: 'full' }],
            onFormMount(mask, values) {
              if (values.acFloors) mask.querySelector('[data-f="acFloorsText"]').value = (values.acFloors || []).join(',');
              if (values.fireFloors) mask.querySelector('[data-f="fireFloorsText"]').value = (values.fireFloors || []).join(',');
            },
            beforeSave(v) {
              v.acFloors = String(v.acFloorsText || '').split(',').map(s => parseInt(s.trim(), 10)).filter(x => !isNaN(x));
              v.fireFloors = String(v.fireFloorsText || '').split(',').map(s => parseInt(s.trim(), 10)).filter(x => !isNaN(x));
              delete v.acFloorsText; delete v.fireFloorsText;
              return true;
            }
          });
          await v.render(box);
        } else if (cur === 'room') {
          const [projects, buildings] = await Promise.all([Cache.projects(), Cache.buildings()]);
          const v = CrudView({
            title: '房间', name: '房间', api: '/api/property/rooms', size: 20, formWidth: 'wide',
            filters: [
              { key: 'projectId', label: '项目', type: 'select', options: projects.map(p => ({ value: p.id, text: p.name })) },
              { key: 'buildingId', label: '楼栋', type: 'select', options: buildings.map(b => ({ value: b.id, text: b.name })) },
              { key: 'floor', label: '楼层', width: 70 },
              { key: 'status', label: '状态', type: 'select', options: ['空置', '已租', '维修', '预留', '停用'] }
            ],
            exportUrl: '/api/report/export/rooms',
            columns: [
              { title: '房源编码', key: 'code', render: r => '<b class="mono">' + U.esc(r.code) + '</b>' },
              { title: '项目', key: 'projectName', width: 100 },
              { title: '楼层', key: 'floorLabel', width: 60, render: r => (r.floorLabel === String(r.floor) ? U.esc(r.floorLabel) : U.esc(r.floorLabel) + ' <span class="tag purple">跳</span>') },
              { title: '面积(㎡)', key: 'area', width: 85, num: true },
              { title: '业态', key: 'bizType', width: 70 },
              { title: '状态', key: 'status', width: 70, render: r => U.statusTag(r.status) },
              { title: '客户', key: 'customerName', width: 160 },
              { title: '合同号', key: 'contractCode', width: 130, render: r => r.contractCode ? '<span class="mono">' + U.esc(r.contractCode) + '</span>' : '<span class="muted">—</span>' },
              { title: '到期日', key: 'endDate', width: 95 },
              { title: '配套', key: 'facilities', render: r => (r.facilities || []).map(f => U.tag(f, f === '消防楼层' ? 'red' : (f === '中央空调' ? 'cyan' : ''))).join(' ') || '<span class="muted">—</span>' },
              { title: '备注', key: 'remark', render: r => '<span class="ellipsis">' + U.esc(r.remark || '') + '</span>' }
            ],
            actions: r => '<button class="btn btn-sm" data-act2="detail">详情</button> <button class="btn btn-sm" data-act2="edit">编辑</button> <button class="btn btn-sm" data-act2="transfer">迁移</button>',
            rowActions: {
              detail(row, done) { RoomDetail(row, done); },
              edit(row, done) { v.cfg._openForm(row, done); },
              transfer(row, done) { RoomTransfer(row, done); }
            },
            buttons: [
              { key: 'batch', label: '批量生成房间', cls: '', onClick: () => BatchRooms(v) },
              { key: 'merge', label: '房间合并', onClick: () => MergeRooms(v) },
              { key: 'split', label: '房间拆分', onClick: () => SplitRoom(v) },
              { key: 'attrs', label: '批量改属性', onClick: () => BatchAttrs(v) }
            ],
            fields: [
              { key: 'projectId', label: '项目', type: 'select', options: projects.map(p => ({ value: p.id, text: p.name })), required: true },
              { key: 'buildingId', label: '楼栋', type: 'select', options: buildings.map(b => ({ value: b.id, text: b.name })), required: true },
              { key: 'floor', label: '楼层（数字，跳层自动转换）', type: 'number', required: true },
              { key: 'roomNo', label: '房号', required: true },
              { key: 'area', label: '建筑面积(㎡)', type: 'number', required: true },
              { key: 'useArea', label: '使用面积(㎡)', type: 'number' },
              { key: 'bizType', label: '业态', type: 'select', options: ['办公', '商铺', '仓储', '餐饮', '其他'] },
              { key: 'status', label: '状态', type: 'select', options: ['空置', '已租', '维修', '预留', '停用'], default: '空置' },
              { key: 'level', label: '楼层类型', type: 'select', options: ['低层', '中间楼层', '高层'] },
              { key: 'propertyCert', label: '不动产权证书', span: 'full' },
              { key: 'certNo', label: '证书编号' }, { key: 'ownerName', label: '权利人' },
              { key: 'facilitiesText', label: '配套（逗号分隔，如 中央空调,消防楼层）', span: 'full' },
              { key: 'cadFile', label: 'CAD 图纸', type: 'files' },
              { key: 'remark', label: '备注', span: 'full', type: 'textarea' }
            ],
            onFormMount(mask, values) {
              if (values.facilities) mask.querySelector('[data-f="facilitiesText"]').value = (values.facilities || []).join(',');
            },
            beforeSave(v) {
              v.facilities = String(v.facilitiesText || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
              delete v.facilitiesText;
              return true;
            }
          });
          await v.render(box);
        } else {
          const r = await GET('/api/property/stats');
          const vacant = await GET('/api/report/vacant');
          box.innerHTML = '<div class="card"><div class="card-head"><h3>各项目房源统计</h3></div><div class="card-body tight">' +
            Table.render([{ title: '项目', key: 'projectName' }, { title: '招商端口', key: 'portName' },
            { title: '总房间', key: 'total', num: true }, { title: '已租', key: 'rented', num: true },
            { title: '空置', key: 'vacant', num: true }, { title: '维修', key: 'repair', num: true },
            { title: '建筑面积(㎡)', key: 'area', num: true }, { title: '空置面积(㎡)', key: 'vacantArea', num: true },
            { title: '出租率', key: 'occupancy', render: r => '<b>' + r.occupancy + '%</b>' }], r.data || []) +
            '</div></div>' +
            '<div class="card mt12"><div class="card-head"><h3>空置房间清单</h3><span class="spacer"></span>' +
            '<button class="btn btn-sm" onclick="window.open(\'/api/report/export/rooms?status=\')">导出</button></div><div class="card-body tight">' +
            Table.render([{ title: '房源编码', key: 'code' }, { title: '项目', key: 'projectName' }, { title: '楼栋', key: 'buildingName' },
            { title: '楼层', key: 'floorLabel' }, { title: '面积(㎡)', key: 'area', num: true }, { title: '业态', key: 'bizType' },
            { title: '配套', key: 'facilities' }], (vacant.data || {}).list || []) + '</div></div>';
        }
      }
      await renderTab();
    }
  });

  /* ---------- 房源详情 ---------- */
  window.RoomDetail = async function (row, done) {
    const [bills, meters] = await Promise.all([
      GET('/api/finance/bills?size=200&contractId='), GET('/api/finance/meters?roomId=' + row.id)
    ]);
    UI.drawer('房源详情：' + row.code,
      '<div class="kv">' +
      kv('房源编码', row.code) + kv('项目', row.projectName || '') + kv('楼栋', row.buildingName || '') +
      kv('楼层', (row.floorLabel || row.floor) + (row.floorLabel != String(row.floor) ? '（跳层）' : '')) +
      kv('房号', row.roomNo) + kv('建筑面积', row.area + ' ㎡') + kv('使用面积', row.useArea + ' ㎡') +
      kv('业态', row.bizType) + kv('状态', U.statusTag(row.status)) + kv('楼层类型', row.level) +
      kv('产权证书', row.propertyCert || '—') + kv('权利人', row.ownerName || '—') +
      kv('配套', (row.facilities || []).join('、') || '—') +
      kv('当前客户', row.customerName || '—') + kv('合同号', row.contractCode || '—') +
      kv('租金单价', row.rentUnitPrice ? U.money(row.rentUnitPrice) + ' 元/㎡/月' : '—') +
      kv('合并来源', (row.mergedNames || []).join('、') || '—') +
      kv('备注', row.remark || '—') +
      '</div>' +
      '<h4 class="mt12 mb8">表具</h4>' +
      Table.render([{ title: '类型', key: 'type' }, { title: '表号', key: 'meterNo' }, { title: '底数', key: 'initValue', num: true },
      { title: '最近抄表', key: 'lastReading', render: r => r.lastReading ? (r.lastReading.value + '（' + r.lastReading.period + '）') : '—' }],
        meters.data ? (meters.data.list || meters.data) : []) +
      '<div class="mt12"><button class="btn btn-primary" id="editRoom">编辑属性</button> ' +
      '<button class="btn" id="transferRoom">跨楼栋迁移</button></div>',
      mask => {
        mask.querySelector('#editRoom').onclick = () => { UI.close(mask); RoomAttrs(row, done); };
        mask.querySelector('#transferRoom').onclick = () => { UI.close(mask); RoomTransfer(row, done); };
      });
    function kv(k, v) { return '<div class="k">' + k + '</div><div>' + (v || '—') + '</div>'; }
  };

  window.RoomAttrs = function (row, done) {
    UI.open({
      title: '修改房源属性：' + row.code, width: 'wide',
      body: Form.html([
        { key: 'area', label: '建筑面积(㎡)', type: 'number', default: row.area },
        { key: 'useArea', label: '使用面积(㎡)', type: 'number', default: row.useArea },
        { key: 'level', label: '楼层类型', type: 'select', options: ['低层', '中间楼层', '高层'], default: row.level },
        { key: 'bizType', label: '业态', type: 'select', options: ['办公', '商铺', '仓储', '餐饮', '其他'], default: row.bizType },
        { key: 'status', label: '状态', type: 'select', options: ['空置', '已租', '维修', '预留', '停用'], default: row.status },
        { key: 'propertyCert', label: '不动产权证书', default: row.propertyCert },
        { key: 'certNo', label: '证书编号', default: row.certNo },
        { key: 'certArea', label: '证载面积(㎡)', type: 'number', default: row.certArea },
        { key: 'ownerName', label: '权利人', default: row.ownerName },
        { key: 'sharedElectric', label: '参与公摊电费', type: 'select', options: ['是', '否'], default: row.sharedElectric === false ? '否' : '是' },
        { key: 'priceStandard', label: '标准单价(元/㎡/月)', type: 'number', default: row.priceStandard },
        { key: 'remark', label: '备注', span: 'full', type: 'textarea', default: row.remark }
      ], row),
      onOk(m) {
        const v = Form.read(m, [{ key: 'area', type: 'number' }, { key: 'useArea', type: 'number' }, { key: 'level' }, { key: 'bizType' },
        { key: 'status' }, { key: 'propertyCert' }, { key: 'certNo' }, { key: 'certArea', type: 'number' }, { key: 'ownerName' },
        { key: 'sharedElectric' }, { key: 'priceStandard', type: 'number' }, { key: 'remark' }]);
        v.sharedElectric = v.sharedElectric === '是';
        return POST('/api/property/rooms/' + row.id + '/attrs', v).then(r => {
          if (!r.ok) { UI.toast(r.msg, 'err'); return false; }
          UI.toast('已保存', 'ok'); Cache.bust(); if (done) done();
        });
      }
    });
  };

  window.RoomTransfer = async function (row, done) {
    const buildings = await Cache.buildings();
    const projects = await Cache.projects();
    UI.open({
      title: '房源跨楼栋迁移：' + row.code, width: 'wide',
      body: '<div class="mb12" style="background:var(--warn-soft);padding:10px;border-radius:6px;font-size:13px">' +
        '迁移后该房间的<b>历史账单、水电费用、合同</b>将同步迁移到目标楼栋，并保留迁移痕迹。</div>' +
        Form.html([
          { key: 'toBuildingId', label: '目标楼栋', type: 'select', options: buildings.map(b => ({ value: b.id, text: b.name + '（' + ((projects.filter(p => p.id === b.projectId)[0] || {}).name || '') + '）' })), required: true },
          { key: 'toFloor', label: '目标楼层（数字）', type: 'number', default: row.floor },
          { key: 'toRoomNo', label: '目标房号', default: row.roomNo }
        ], {}),
      onOk(m) {
        const v = Form.read(m, [{ key: 'toBuildingId' }, { key: 'toFloor', type: 'number' }, { key: 'toRoomNo' }]);
        return POST('/api/property/rooms/transfer', Object.assign({ roomId: row.id }, v)).then(r => {
          if (!r.ok) { UI.toast(r.msg, 'err'); return false; }
          UI.toast('迁移成功：账单 ' + r.data.bills + ' 条、合同 ' + r.data.contracts + ' 份同步迁移', 'ok');
          Cache.bust(); if (done) done();
        });
      }
    });
  };

  window.BatchRooms = async function (v) {
    const [projects, buildings] = await Promise.all([Cache.projects(), Cache.buildings()]);
    UI.open({
      title: '批量生成房间', width: 'wide',
      body: Form.html([
        { key: 'projectId', label: '项目', type: 'select', options: projects.map(p => ({ value: p.id, text: p.name })) },
        { key: 'buildingId', label: '楼栋', type: 'select', options: buildings.map(b => ({ value: b.id, text: b.name })), required: true },
        { key: 'floor', label: '楼层（数字，跳层自动命名）', type: 'number', required: true },
        { key: 'from', label: '起始房号', type: 'number', default: 1, required: true },
        { key: 'to', label: '结束房号', type: 'number', default: 10, required: true },
        { key: 'width', label: '房号位数', type: 'number', default: 2 },
        { key: 'area', label: '每间面积(㎡)', type: 'number', default: 100 },
        { key: 'bizType', label: '业态', type: 'select', options: ['办公', '商铺', '仓储', '餐饮', '其他'], default: '办公' },
        { key: 'ownerName', label: '权利人' }, { key: 'propertyCert', label: '不动产权证书' }
      ], {}),
      onOk(m) {
        const f = ['projectId', 'buildingId', 'floor', 'from', 'to', 'width', 'area', 'bizType', 'ownerName', 'propertyCert'];
        const v2 = Form.read(m, f.map(k => ({ key: k, type: ['floor', 'from', 'to', 'width', 'area'].indexOf(k) >= 0 ? 'number' : 'text' })));
        return POST('/api/property/rooms/batch', v2).then(r => {
          if (!r.ok) { UI.toast(r.msg, 'err'); return false; }
          UI.toast('生成 ' + r.data.created + ' 间，跳过 ' + r.data.skipped + ' 间', 'ok'); Cache.bust(); v.cfg._refresh();
        });
      }
    });
  };

  window.MergeRooms = async function (v) {
    const list = await Cache.rooms();
    const sel = [];
    UI.open({
      title: '房间合并（08-10 号合并为一套房源）', width: 'wide',
      body: '<div class="mb8 muted">勾选要合并的房间，第一间为主房源；合并后面积汇总，其余房间停用。</div>' +
        '<div class="mb8"><input type="text" id="mk" placeholder="搜索房号" style="width:220px"></div>' +
        '<div class="table-wrap" style="max-height:340px"><table class="tbl"><thead><tr><th style="width:40px"></th><th>房源编码</th><th>项目</th><th>面积</th><th>状态</th></tr></thead><tbody id="ml"></tbody></table></div>' +
        '<label class="inline mt12"><input type="checkbox" id="force"> 强制合并（房间已有合同时）</label>',
      onMount(mask) {
        const tb = mask.querySelector('#ml');
        const draw = kw => tb.innerHTML = list.filter(r => !kw || r.code.indexOf(kw) >= 0).slice(0, 300)
          .map(r => '<tr><td><input type="checkbox" class="mc" value="' + r.id + '"></td><td>' + U.esc(r.code) + '</td><td class="muted">' +
            U.esc(r.projectName || '') + '</td><td class="num">' + r.area + '</td><td>' + U.statusTag(r.status) + '</td></tr>').join('');
        draw(''); mask.querySelector('#mk').oninput = e => draw(e.target.value.trim());
      },
      onOk(mask) {
        const ids = Array.from(mask.querySelectorAll('.mc:checked')).map(x => x.value);
        if (ids.length < 2) { UI.toast('请至少选择 2 间', 'err'); return false; }
        return POST('/api/property/rooms/merge', { roomIds: ids, force: mask.querySelector('#force').checked }).then(r => {
          if (!r.ok) { UI.toast(r.msg, 'err'); return false; }
          UI.toast('合并成功', 'ok'); Cache.bust(); v.cfg._refresh();
        });
      }
    });
  };

  window.SplitRoom = async function (v) {
    const list = await Cache.rooms();
    UI.open({
      title: '房间拆分（一套房源拆分给多个客户 / 合租）', width: 'wide',
      body: Form.html([
        { key: 'roomId', label: '选择要拆分的房间', type: 'select', options: list.slice(0, 800).map(r => ({ value: r.id, text: r.code + '（' + r.area + '㎡）' })), span: 'full' },
        { key: 'p1', label: '拆分后房号 1', default: '01-A' }, { key: 'a1', label: '面积 1(㎡)', type: 'number' },
        { key: 'p2', label: '拆分后房号 2', default: '01-B' }, { key: 'a2', label: '面积 2(㎡)', type: 'number' },
        { key: 'p3', label: '拆分后房号 3（可选）' }, { key: 'a3', label: '面积 3(㎡)', type: 'number' }
      ], {}),
      onOk(m) {
        const v2 = Form.read(m, [{ key: 'roomId' }, { key: 'p1' }, { key: 'a1', type: 'number' }, { key: 'p2' }, { key: 'a2', type: 'number' }, { key: 'p3' }, { key: 'a3', type: 'number' }]);
        const parts = [];
        if (v2.p1) parts.push({ roomNo: v2.p1, area: v2.a1 });
        if (v2.p2) parts.push({ roomNo: v2.p2, area: v2.a2 });
        if (v2.p3) parts.push({ roomNo: v2.p3, area: v2.a3 });
        if (!parts.length) { UI.toast('请填写拆分房号', 'err'); return false; }
        return POST('/api/property/rooms/split', { roomId: v2.roomId, parts: parts }).then(r => {
          if (!r.ok) { UI.toast(r.msg, 'err'); return false; }
          UI.toast('已拆分为 ' + r.data.created + ' 间', 'ok'); Cache.bust(); v.cfg._refresh();
        });
      }
    });
  };

  window.BatchAttrs = function (v) {
    UI.toast('请在房间列表中选择房间后使用“编辑”修改属性', 'warn');
  };

  /* ============ 客户档案 ============ */
  App.view('customer', {
    title: '客户档案',
    async render(el) {
      const v = CrudView({
        title: '客户档案', name: '客户', api: '/api/customer/customers', size: 20, formWidth: 'wide', bizType: 'customer',
        exportUrl: '/api/report/export/customers',
        filters: [
          { key: 'type', label: '客户类型', type: 'select', options: ['企业客户', '个人客户'] },
          { key: 'riskFlag', label: '风险标记', type: 'select', options: ['正常', '逾期风险', '违约风险'] }
        ],
        columns: [
          { title: '客户名称', key: 'name', render: r => '<b>' + U.esc(r.name) + '</b>' },
          { title: '类型', key: 'type', width: 85, render: r => U.tag(r.type, r.type === '企业客户' ? 'blue' : 'cyan') },
          { title: '联系人', key: 'contact', width: 85 },
          { title: '电话', key: 'phone', width: 110 },
          { title: '通讯地址', key: 'address', render: r => '<span class="ellipsis">' + U.esc(r.address || '') + '</span>' },
          { title: '在租房源', key: 'roomCodes', width: 150, render: r => '<span class="muted">' + U.esc((r.roomCodes || []).join('、') || '—') + '</span>' },
          { title: '在租面积', key: 'area', width: 90, num: true },
          { title: '月租金', key: 'monthlyRent', width: 100, render: r => '¥' + U.money(r.monthlyRent) },
          { title: '欠费', key: 'arrearsAmount', width: 100, render: r => r.arrearsAmount > 0 ? '<span style="color:var(--danger)">¥' + U.money(r.arrearsAmount) + '</span>' : '<span class="muted">—</span>' },
          { title: '风险', key: 'riskFlag', width: 90, render: r => U.statusTag(r.riskFlag || '正常') }
        ],
        actions: r => '<button class="btn btn-sm" data-act2="history">历史</button> <button class="btn btn-sm" data-act2="risk">风险</button> <button class="btn btn-sm" data-act2="edit">编辑</button>',
        rowActions: {
          edit(row, done) { v.cfg._openForm(row, done); },
          async history(row) {
            const r = await GET('/api/customer/customers/' + row.id + '/history');
            const d = r.data || {};
            UI.drawer('客户历史：' + row.name,
              '<div class="kv">' + kv('客户类型', row.type) + kv('统一社会信用代码', row.creditCode || '—') +
              kv('法人', row.legalPerson || '—') + kv('身份证', row.idCard || '—') +
              kv('开户行', row.bankName || '—') + kv('账号', row.bankAccount || '—') +
              kv('通讯地址', row.address || '—') + kv('联系电话', row.phone || '—') +
              kv('风险标记', U.statusTag(row.riskFlag || '正常')) + kv('风险说明', row.riskNote || '—') +
              kv('附件', (row.attachments || []).map(a => '<a href="' + U.esc(a.url) + '" target="_blank">📎 ' + U.esc(a.name) + '</a>').join(' ') || '—') +
              '</div>' +
              '<h4 class="mt12 mb8">历史租赁合同（' + (d.contracts || []).length + ' 份）</h4>' +
              Table.render([{ title: '合同号', key: 'code' }, { title: '房号', key: 'roomCodes', render: r => (r.roomCodes || []).join('、') },
              { title: '租期', key: 'x', render: r => r.startDate + ' ~ ' + r.endDate },
              { title: '月租金', key: 'rentMonthly', num: true }, { title: '状态', key: 'status', render: r => U.statusTag(r.status) }], d.contracts || []) +
              '<h4 class="mt12 mb8">收款记录（近 60 条）</h4>' +
              Table.render([{ title: '日期', key: 'date' }, { title: '账单号', key: 'billCode' }, { title: '金额', key: 'amount', num: true },
              { title: '方式', key: 'method' }], d.payments || []) +
              '<h4 class="mt12 mb8">开票记录</h4>' +
              Table.render([{ title: '发票号', key: 'invoiceNo' }, { title: '日期', key: 'invoiceDate' }, { title: '类型', key: 'type' },
              { title: '内容', key: 'category' }, { title: '金额', key: 'amount', num: true }], d.invoices || [])
            );
            function kv(k, val) { return '<div class="k">' + k + '</div><div>' + (val || '—') + '</div>'; }
          },
          risk(row, done) {
            UI.open({
              title: '风险标记：' + row.name,
              body: Form.html([
                { key: 'riskFlag', label: '风险等级', type: 'select', options: ['正常', '逾期风险', '违约风险', '重点关注'], default: row.riskFlag || '正常' },
                { key: 'riskNote', label: '风险说明', span: 'full', type: 'textarea', default: row.riskNote || '' }
              ], row),
              onOk(m) {
                const v2 = Form.read(m, [{ key: 'riskFlag' }, { key: 'riskNote' }]);
                return POST('/api/customer/customers/' + row.id + '/risk', v2).then(() => { UI.toast('已更新', 'ok'); Cache.bust(); done(); });
              }
            });
          }
        },
        fields: [
          { key: 'name', label: '客户名称', required: true },
          { key: 'type', label: '客户类型', type: 'select', options: ['企业客户', '个人客户'], default: '企业客户', required: true },
          { key: 'creditCode', label: '统一社会信用代码' },
          { key: 'legalPerson', label: '法人代表' },
          { key: 'idCard', label: '身份证号' },
          { key: 'contact', label: '联系人' },
          { key: 'phone', label: '联系电话' },
          { key: 'address', label: '通讯地址', span: 'full' },
          { key: 'bankName', label: '开户银行' },
          { key: 'bankAccount', label: '银行账号' },
          { key: 'invoiceTitle', label: '发票抬头' },
          { key: 'invoiceTaxNo', label: '纳税人识别号' },
          { key: 'invoiceBank', label: '开票开户行' },
          { key: 'invoiceAccount', label: '开票银行账号' },
          { key: 'invoiceAddress', label: '开票地址电话', span: 'full' },
          { key: 'attachments', label: '附件（营业执照 / 法人身份证 / 银行账户）', type: 'files', span: 'full' },
          { key: 'riskNote', label: '风险说明', span: 'full', type: 'textarea' },
          { key: 'status', label: '状态', type: 'select', options: ['正常', '停用'], default: '正常' }
        ]
      });
      await v.render(el);
    }
  });

})();
