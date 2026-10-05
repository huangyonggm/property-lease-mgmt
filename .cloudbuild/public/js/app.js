/* 应用启动：登录检测、菜单与顶栏渲染 */
(function () {
  const ICON = {
    dashboard: '🏠', org: '🏛', property: '🏢', customer: '👥', contract: '📄',
    billing: '💰', invoice: '🧾', approval: '🔀', workorder: '🔧', hr: '👷', patrol: '🛡', income: '📗', report: '📊', system: '⚙'
  };

  async function boot() {
    const r = await GET('/api/auth/me');
    if (!r.ok || !r.data) return showLogin();
    App.user = r.data;
    App.menus = r.data.menus || [];
    renderLayout();
    App.render();
  }

  function showLogin() {
    document.getElementById('app').innerHTML = '';
    const lp = document.getElementById('loginPage');
    lp.style.display = 'flex';
    document.getElementById('loginForm').onsubmit = async e => {
      e.preventDefault();
      const btn = document.getElementById('loginBtn');
      btn.disabled = true; btn.textContent = '登录中…';
      const r = await POST('/api/auth/login', {
        username: document.getElementById('loginUser').value.trim(),
        password: document.getElementById('loginPwd').value
      });
      btn.disabled = false; btn.textContent = '登 录';
      if (!r.ok) { UI.toast(r.msg || '登录失败', 'err'); return; }
      lp.style.display = 'none';
      App.user = r.data.user; App.menus = r.data.user.menus || [];
      renderLayout();
      App.render();
    };
  }

  // 兜底菜单：仅在后端未返回 menus 时使用。必须与 routes/auth.js 的 menusOf 保持一致，
  // 否则新增模块会「后端有、前端没有」，表现为侧边栏缺项。
  const FALLBACK_MENUS = [
    { key: 'dashboard', name: '驾驶舱', path: '#/dashboard' },
    { key: 'org', name: '组织权限', path: '#/org' },
    { key: 'property', name: '房源管理', path: '#/property' },
    { key: 'customer', name: '客户档案', path: '#/customer' },
    { key: 'contract', name: '合同管理', path: '#/contract' },
    { key: 'billing', name: '收费管理', path: '#/billing' },
    { key: 'invoice', name: '发票管理', path: '#/invoice' },
    { key: 'approval', name: '审批流程', path: '#/approval' },
    { key: 'workorder', name: '工单巡检', path: '#/workorder' },
    { key: 'hr', name: '人事薪酬', path: '#/hr' },
    { key: 'patrol', name: '巡更检查', path: '#/patrol' },
    { key: 'income', name: '收入台账', path: '#/income' },
    { key: 'report', name: '报表统计', path: '#/report' },
    { key: 'system', name: '系统设置', path: '#/system' }
  ];

  function renderLayout() {
    const u = App.user || {};
    const menus = App.menus.length ? App.menus : FALLBACK_MENUS;
    document.getElementById('app').innerHTML =
      '<div class="layout">' +
      '<aside class="sidebar"><div class="brand"><div class="logo">租</div><div>物业租赁系统<small>不动产租赁全流程管理</small></div></div>' +
      '<nav class="menu">' +
      '<div class="menu-group">业务模块</div>' +
      menus.map(m => '<div class="menu-item" data-key="' + m.key + '" onclick="location.hash=\'' + (m.path || ('#/' + m.key)) + '\'">' +
        '<span class="ic">' + (ICON[m.key] || '▪') + '</span>' + U.esc(m.name) + '</div>').join('') +
      '</nav></aside>' +
      '<div class="main"><header class="topbar">' +
      '<div><div class="title" id="pageTitle">驾驶舱</div><div class="crumb">物业不动产租赁管理系统</div></div>' +
      '<span class="spacer"></span>' +
      '<span class="bell" id="bellBtn" title="提醒中心">🔔<span class="dot" id="bellDot" style="display:none">0</span></span>' +
      '<span class="user-chip" id="userChip"><span class="avatar">' + U.esc((u.name || 'U').slice(0, 1)) + '</span>' +
      U.esc(u.name || '') + ' · ' + U.esc(u.deptName || '') + ' · ' + U.esc(u.postName || u.roleName || '') + '</span>' +
      '<button class="btn btn-sm" id="mBtn">移动端</button>' +
      '<button class="btn btn-sm" id="logoutBtn">退出</button>' +
      '</header><main class="content" id="pageContent"></main></div></div>';

    document.getElementById('logoutBtn').onclick = async () => {
      await POST('/api/auth/logout', {});
      location.reload();
    };
    document.getElementById('mBtn').onclick = () => location.href = '/m.html';
    document.getElementById('userChip').onclick = () => {
      const u2 = App.user || {};
      UI.open({
        title: '当前登录信息', hideCancel: true, okText: '关闭',
        body: '<div class="kv">' +
          '<div class="k">姓名</div><div>' + U.esc(u2.name) + '</div>' +
          '<div class="k">账号</div><div>' + U.esc(u2.username || '') + '</div>' +
          '<div class="k">部门</div><div>' + U.esc(u2.deptName || '') + '</div>' +
          '<div class="k">岗位</div><div>' + U.esc(u2.postName || '') + '</div>' +
          '<div class="k">角色</div><div>' + U.esc(u2.roleName || '') + '</div>' +
          '<div class="k">数据范围</div><div>' + U.esc(u2.dataScope || '') + '</div>' +
          '<div class="k">权限点</div><div>' + ((u2.perms || []).length ? (u2.perms || []).map(p => '<span class="tag" style="margin:0 4px 4px 0">' + U.esc(p) + '</span>').join('') : '全部') + '</div>' +
          '</div><div class="mt12"><button class="btn" id="chgPwd">修改密码</button></div>',
        onMount(m) {
          m.querySelector('#chgPwd').onclick = () => {
            UI.open({
              title: '修改密码',
              body: '<label class="fld">原密码</label><input type="password" id="op">' +
                '<label class="fld">新密码</label><input type="password" id="np">',
              onOk(mm) {
                return POST('/api/auth/password', { oldPassword: mm.querySelector('#op').value, newPassword: mm.querySelector('#np').value })
                  .then(r => { UI.toast(r.ok ? '密码已修改' : r.msg, r.ok ? 'ok' : 'err'); if (r.ok) setTimeout(() => location.reload(), 600); });
              }
            });
          };
        }
      });
    };
    document.getElementById('bellBtn').onclick = async () => {
      const r = await GET('/api/reminders');
      const list = (r.data.list || []).slice(0, 50);
      UI.open({
        title: '提醒中心', width: 'wide', hideCancel: true, okText: '关闭',
        body: '<div class="mb8 muted">未处理 ' + (r.data.summary.total || 0) + ' 条（紧急 ' + (r.data.summary.urgent || 0) + ' 条）</div>' +
          Table.render([{ title: '类型', key: 'type', width: 100 }, { title: '级别', key: 'level', width: 70, render: r2 => U.statusTag(r2.level) },
          { title: '内容', key: 'content' }, { title: '状态', key: 'status', width: 80 },
          { title: '操作', key: 'id', render: r2 => r2.status === '未处理' ? '<button class="btn btn-sm" data-h="' + r2.id + '">处理</button>' : '' }], list),
        onMount(m) {
          m.querySelectorAll('[data-h]').forEach(b => b.onclick = () => {
            POST('/api/reminders/' + b.getAttribute('data-h') + '/handle', { result: '已跟进' }).then(() => { UI.toast('已处理', 'ok'); b.disabled = true; b.textContent = '已处理'; });
          });
        }
      });
    };
    loadBell();
  }

  async function loadBell() {
    try {
      const r = await GET('/api/reminders');
      const n = (r.data.summary || {}).total || 0;
      const dot = document.getElementById('bellDot');
      if (dot) { dot.style.display = n ? 'flex' : 'none'; dot.textContent = n > 99 ? '99+' : n; }
    } catch (e) { }
  }

  if (!location.hash) location.hash = '#/dashboard';
  boot();
})();
