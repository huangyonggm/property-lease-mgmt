/* 移动端：待办工单 / 巡检录入 / 抄表录入 / 提醒（适配夜班人员手机操作） */
(function () {
  let USER = null;
  let CUR = 'todo';

  async function boot() {
    const r = await GET('/api/auth/me');
    if (!r.ok || !r.data) { document.getElementById('mLogin').style.display = 'flex'; return; }
    USER = r.data;
    document.getElementById('mLogin').style.display = 'none';
    document.getElementById('mContent').style.display = 'block';
    document.getElementById('mSub').textContent = USER.name + ' · ' + (USER.deptName || '') + ' · ' + (USER.postName || USER.roleName || '');
    document.querySelectorAll('.m-tabbar .t').forEach(t => {
      t.onclick = () => {
        document.querySelectorAll('.m-tabbar .t').forEach(x => x.classList.remove('on'));
        t.classList.add('on'); CUR = t.getAttribute('data-t'); render();
      };
    });
    await render();
  }

  document.getElementById('mLoginForm').onsubmit = async e => {
    e.preventDefault();
    const r = await POST('/api/auth/login', {
      username: document.getElementById('mUser').value.trim(),
      password: document.getElementById('mPwd').value
    });
    if (!r.ok) { UI.toast(r.msg || '登录失败', 'err'); return; }
    boot();
  };

  async function render() {
    const box = document.getElementById('mBody');
    box.innerHTML = '<div class="m-card">加载中…</div>';
    if (CUR === 'todo') return renderTodo(box);
    if (CUR === 'patrol') return renderPatrol(box);
    if (CUR === 'meter') return renderMeter(box);
    if (CUR === 'remind') return renderRemind(box);
  }

  /* ---------- 待办工单 ---------- */
  async function renderTodo(box) {
    const r = await GET('/api/ops/workorders?size=100&status=待处理');
    const r2 = await GET('/api/ops/workorders?size=100&status=处理中');
    const list = (r.data.list || []).concat(r2.data.list || []);
    document.getElementById('mTitle').textContent = '待办工单';
    document.getElementById('mStat').innerHTML =
      '<div class="s"><div class="v">' + (r.data.total || 0) + '</div><div class="k">待处理</div></div>' +
      '<div class="s"><div class="v">' + (r2.data.total || 0) + '</div><div class="k">处理中</div></div>';
    box.innerHTML = '<div class="m-card"><h4>我的工单（' + list.length + '）</h4><div class="m-list">' +
      (list.length ? list.map(w => '<div class="li"><div>' +
        '<div class="b">' + U.esc(w.title) + '</div>' +
        '<div class="muted" style="font-size:12px">' + U.esc(w.type) + ' · ' + U.esc(w.roomCode || '') + ' · ' + U.esc(w.planDate || '') + '</div>' +
        '<div class="mt8">' + U.tag(w.priority, w.priority === '紧急' ? 'red' : '') + ' ' + U.statusTag(w.status) + '</div>' +
        '</div><div class="r"><button class="btn btn-sm btn-success" data-fin="' + w.id + '">完成</button></div></div>').join('')
        : '<div class="empty">暂无待办工单</div>') +
      '</div></div>';
    box.querySelectorAll('[data-fin]').forEach(b => b.onclick = () => finishWO(b.getAttribute('data-fin')));
  }

  function finishWO(id) {
    UI.open({
      title: '完成工单',
      body: '<label class="fld">处理状态</label><select id="fSt"><option>已完成</option><option>已关闭</option></select>' +
        '<label class="fld">处理结果</label><textarea id="fRes" placeholder="现场处理情况"></textarea>' +
        '<label class="fld">现场照片</label><div class="photo-grid" id="fPhoto"><div class="p" id="fAdd">＋</div></div>' +
        '<input type="hidden" id="fPhotos" value="[]">',
      onMount(m) {
        const arr = [];
        m.querySelector('#fAdd').onclick = () => {
          const inp = document.createElement('input');
          inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
          inp.onchange = async () => {
            for (const f of Array.from(inp.files)) {
              const d = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f); });
              const up = await POST('/api/system/upload', { fileName: f.name, dataBase64: d, bizType: 'workorder', bizId: id });
              if (up.ok) { arr.push(up.data); m.querySelector('#fPhotos').value = JSON.stringify(arr); draw(); }
            }
          };
          inp.click();
        };
        function draw() {
          m.querySelector('#fPhoto').innerHTML = arr.map(p => '<div class="p"><img src="' + U.esc(p.url) + '"></div>').join('') +
            '<div class="p" id="fAdd">＋</div>';
          m.querySelector('#fAdd').onclick = () => m.querySelector('#fAdd').click;
        }
      },
      onOk(m) {
        const photos = JSON.parse(m.querySelector('#fPhotos').value || '[]');
        return POST('/api/ops/workorders/' + id + '/finish', {
          status: m.querySelector('#fSt').value, result: m.querySelector('#fRes').value,
          finishDate: U.today(), photos: photos
        }).then(() => { UI.toast('已提交', 'ok'); render(); });
      }
    });
  }

  /* ---------- 巡检录入 ---------- */
  async function renderPatrol(box) {
    document.getElementById('mTitle').textContent = '巡检录入';
    const projects = await GET('/api/property/projects?size=100');
    const buildings = await GET('/api/property/buildings?size=200');
    document.getElementById('mStat').innerHTML =
      '<div class="s"><div class="v">🔍</div><div class="k">现场巡检</div></div>' +
      '<div class="s"><div class="v">📷</div><div class="k">拍照上传</div></div>';
    box.innerHTML = '<div class="m-card"><h4>快速录入巡检 / 维修工单</h4>' +
      '<div class="m-input-row"><label>项目</label><select id="pPj">' + (projects.data.list || []).map(p => '<option value="' + p.id + '">' + U.esc(p.name) + '</option>').join('') + '</select></div>' +
      '<div class="m-input-row"><label>楼栋</label><select id="pBd">' + (buildings.data.list || []).map(b => '<option value="' + b.id + '">' + U.esc(b.name) + '</option>').join('') + '</select></div>' +
      '<div class="m-input-row"><label>楼层</label><input type="number" id="pFl" value="7"></div>' +
      '<div class="m-input-row"><label>房号</label><input type="text" id="pRoom" placeholder="如 07"></div>' +
      '<div class="m-input-row"><label>工单类型</label><select id="pType"><option>巡检工单</option><option>维修工单</option><option>消防巡检</option><option>空调巡检</option><option>抄表工单</option></select></div>' +
      '<div class="m-input-row"><label>标题</label><input type="text" id="pTitle" placeholder="如：7 楼中央空调白班巡检"></div>' +
      '<div class="m-input-row"><label>现场情况</label><input type="text" id="pContent" placeholder="设备运行正常 / 发现异常"></div>' +
      '<div class="m-input-row"><label>优先级</label><select id="pPri"><option>普通</option><option>紧急</option></select></div>' +
      '<div class="m-input-row"><label>计划日期</label><input type="date" id="pDate" value="' + U.today() + '"></div>' +
      '<label class="fld mt8">现场照片</label><div class="photo-grid" id="pPhoto"><div class="p" id="pAdd">＋</div></div>' +
      '<input type="hidden" id="pPhotos" value="[]">' +
      '<button class="btn btn-primary btn-block mt12" id="pSubmit">提交工单</button>' +
      '</div>';
    let arr = [];
    const addBtn = () => {
      box.querySelector('#pAdd').onclick = () => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment'; inp.multiple = true;
        inp.onchange = async () => {
          for (const f of Array.from(inp.files)) {
            const d = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f); });
            const up = await POST('/api/system/upload', { fileName: f.name, dataBase64: d, bizType: 'workorder' });
            if (up.ok) { arr.push(up.data); box.querySelector('#pPhotos').value = JSON.stringify(arr); draw(); }
          }
        };
        inp.click();
      };
    };
    function draw() {
      box.querySelector('#pPhoto').innerHTML = arr.map(p => '<div class="p"><img src="' + U.esc(p.url) + '"></div>').join('') + '<div class="p" id="pAdd">＋</div>';
      addBtn();
    }
    addBtn();
    box.querySelector('#pSubmit').onclick = async () => {
      const bd = (buildings.data.list || []).filter(b => b.id === box.querySelector('#pBd').value)[0] || {};
      const payload = {
        type: box.querySelector('#pType').value,
        title: box.querySelector('#pTitle').value || box.querySelector('#pType').value,
        projectId: box.querySelector('#pPj').value, buildingId: bd.id,
        roomCode: (bd.name || '') + '-' + floorLabel(box.querySelector('#pFl').value) + '-' + box.querySelector('#pRoom').value,
        priority: box.querySelector('#pPri').value, content: box.querySelector('#pContent').value,
        planDate: box.querySelector('#pDate').value, photos: JSON.parse(box.querySelector('#pPhotos').value || '[]'),
        assignee: USER.name, assigneeId: USER.id, status: '待处理'
      };
      if (!payload.title) { UI.toast('请填写标题', 'err'); return; }
      const r = await POST('/api/ops/workorders', payload);
      UI.toast(r.ok ? '工单已提交：' + r.data.code : r.msg, r.ok ? 'ok' : 'err');
      if (r.ok) { arr = []; render(); }
    };
    function floorLabel(f) { const A = { 4: '3A', 13: '12A', 14: '13A', 24: '23A' }; return A[f] || String(f); }
  }

  /* ---------- 抄表录入 ---------- */
  async function renderMeter(box) {
    document.getElementById('mTitle').textContent = '抄表录入';
    const m = await GET('/api/finance/meters?size=1000');
    const meters = (m.data.list || []).filter(x => x.type === '电表');
    const rd = await GET('/api/finance/readings?size=500');
    const last = {};
    (rd.data.list || []).forEach(x => { if (!last[x.meterId] || x.period > last[x.meterId].period) last[x.meterId] = x; });
    document.getElementById('mStat').innerHTML =
      '<div class="s"><div class="v">' + meters.length + '</div><div class="k">电表总数</div></div>' +
      '<div class="s"><div class="v">' + (rd.data.total || 0) + '</div><div class="k">抄表记录</div></div>';
    box.innerHTML = '<div class="m-card"><h4>本月抄表（' + U.month() + '）</h4>' +
      '<div class="m-input-row"><label>搜索表号/房号</label><input type="text" id="mKw" placeholder="输入表号或房号"></div>' +
      '<div class="m-list" id="mList"></div>' +
      '<button class="btn btn-primary btn-block mt12" id="mSubmit">提交本期抄表</button></div>';
    const draw = kw => {
      const list = meters.filter(x => !kw || (x.meterNo || '').indexOf(kw) >= 0 || (x.roomCode || '').indexOf(kw) >= 0).slice(0, 60);
      box.querySelector('#mList').innerHTML = list.map(x =>
        '<div class="li"><div style="flex:1"><div class="b">' + U.esc(x.meterNo) + '</div>' +
        '<div class="muted" style="font-size:12px">' + U.esc(x.roomCode || '') + ' · 上期 ' + ((last[x.id] || {}).value || x.initValue) + '</div></div>' +
        '<input type="number" data-mid="' + x.id + '" data-prev="' + ((last[x.id] || {}).value || x.initValue) + '" placeholder="本期读数" style="width:110px"></div>').join('')
        || '<div class="empty">未找到表具</div>';
    };
    draw('');
    box.querySelector('#mKw').oninput = e => draw(e.target.value.trim());
    box.querySelector('#mSubmit').onclick = async () => {
      const list = [];
      box.querySelectorAll('[data-mid]').forEach(inp => {
        const v = inp.value.trim();
        if (!v) return;
        if (Number(v) < Number(inp.getAttribute('data-prev'))) { UI.toast('读数不能小于上期（' + inp.getAttribute('data-prev') + '）', 'err'); throw new Error('stop'); }
        list.push({ meterId: inp.getAttribute('data-mid'), date: U.today(), value: Number(v) });
      });
      if (!list.length) { UI.toast('请至少录入一个读数', 'err'); return; }
      const r = await POST('/api/finance/readings', { list: list });
      UI.toast(r.ok ? ('已提交 ' + r.data.saved + ' 条抄表') : r.msg, r.ok ? 'ok' : 'err');
      if (r.ok) render();
    };
  }

  /* ---------- 提醒 ---------- */
  async function renderRemind(box) {
    document.getElementById('mTitle').textContent = '提醒中心';
    const r = await GET('/api/reminders');
    const list = r.data.list || [];
    const s = r.data.summary || {};
    document.getElementById('mStat').innerHTML =
      '<div class="s"><div class="v">' + (s.total || 0) + '</div><div class="k">未处理</div></div>' +
      '<div class="s"><div class="v">' + (s.expire || 0) + '</div><div class="k">合同到期</div></div>';
    box.innerHTML = '<div class="m-card"><h4>到期 / 欠费提醒</h4><div class="m-list">' +
      (list.length ? list.slice(0, 60).map(x => '<div class="li"><div style="flex:1">' +
        '<div>' + U.tag(x.type, x.type === '合同到期' ? 'blue' : 'orange') + ' ' + U.statusTag(x.level) + '</div>' +
        '<div style="font-size:12.5px;margin-top:4px">' + U.esc(x.content) + '</div></div>' +
        '<div class="r">' + (x.status === '未处理' ? '<button class="btn btn-sm" data-h="' + x.id + '">处理</button>' : '<span class="muted">已处理</span>') + '</div></div>').join('')
        : '<div class="empty">暂无提醒</div>') +
      '</div></div>';
    box.querySelectorAll('[data-h]').forEach(b => b.onclick = () => {
      POST('/api/reminders/' + b.getAttribute('data-h') + '/handle', { result: '移动端已跟进' }).then(() => { UI.toast('已处理', 'ok'); render(); });
    });
  }

  boot();
})();
