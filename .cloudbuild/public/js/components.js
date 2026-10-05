/* 通用组件：数据缓存、表格、表单弹窗、CRUD 页面工厂、选择器 */
window.Cache = {
  _c: {},
  async get(key, url, force) {
    if (!force && Cache._c[key]) return Cache._c[key];
    const r = await GET(url);
    const list = (r.data && r.data.list) ? r.data.list : (r.data || []);
    Cache._c[key] = Array.isArray(list) ? list : [];
    return Cache._c[key];
  },
  bust() { Cache._c = {}; },
  projects() { return Cache.get('projects', '/api/property/projects?size=500'); },
  buildings() { return Cache.get('buildings', '/api/property/buildings?size=500'); },
  rooms() { return Cache.get('rooms', '/api/property/rooms?size=2000'); },
  customers() { return Cache.get('customers', '/api/customer/customers?size=2000'); },
  contracts() { return Cache.get('contracts', '/api/contract/contracts?size=2000'); },
  depts() { return Cache.get('depts', '/api/org/depts?size=200'); },
  posts() { return Cache.get('posts', '/api/org/posts?size=300'); },
  roles() { return Cache.get('roles', '/api/org/roles?size=200'); },
  users() { return Cache.get('users', '/api/org/users?size=500'); },
  async projectName(id) { const l = await Cache.projects(); const x = l.filter(p => p.id === id)[0]; return x ? x.name : ''; },
  async roomCode(id) { const l = await Cache.rooms(); const x = l.filter(p => p.id === id)[0]; return x ? x.code : ''; }
};

/* ---------- 表格 ---------- */
window.Table = {
  render(cols, rows, opt) {
    opt = opt || {};
    if (!rows.length) return '<div class="empty"><div class="big">🗂</div>暂无数据</div>';
    let h = '<div class="table-wrap"><table class="tbl"><thead><tr>';
    if (opt.checkable) h += '<th style="width:36px"><input type="checkbox" data-checkall></th>';
    cols.forEach(c => {
      const st = c.width ? ' style="width:' + c.width + 'px"' : '';
      h += '<th' + st + '>' + U.esc(c.title) + '</th>';
    });
    if (opt.actions) h += '<th style="width:' + (opt.actionWidth || 150) + 'px">操作</th>';
    h += '</tr></thead><tbody>';
    rows.forEach((r, i) => {
      const cls = (opt.selected && opt.selected.indexOf(r.id) >= 0) ? ' class="sel"' : '';
      h += '<tr' + cls + ' data-row="' + U.esc(r.id) + '">';
      if (opt.checkable) h += '<td><input type="checkbox" class="rowck" value="' + U.esc(r.id) + '"></td>';
      cols.forEach(c => {
        let v = c.render ? c.render(r, i) : r[c.key];
        if (v === undefined || v === null) v = '';
        const num = (c.type === 'number' || c.num) ? ' class="num"' : '';
        h += '<td' + num + '>' + v + '</td>';
      });
      if (opt.actions) h += '<td class="nowrap">' + opt.actions(r) + '</td>';
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    return h;
  },
  pager(total, page, size) {
    const pages = Math.max(1, Math.ceil(total / size));
    let h = '<div class="pager"><span>共 <b>' + total + '</b> 条 / ' + pages + ' 页</span><span class="spacer"></span>';
    h += '<button class="btn btn-sm" data-page="1"' + (page <= 1 ? ' disabled' : '') + '>首页</button>';
    h += '<button class="btn btn-sm" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>';
    h += '<span>第 ' + page + ' 页</span>';
    h += '<button class="btn btn-sm" data-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>下一页</button>';
    h += '<button class="btn btn-sm" data-page="' + pages + '"' + (page >= pages ? ' disabled' : '') + '>末页</button>';
    h += '</div>';
    return h;
  }
};

/* ---------- 表单 ---------- */
window.Form = {
  // fields: [{key,label,type,options,required,span,default,placeholder,readonly,optionsFrom}]
  html(fields, values) {
    values = values || {};
    let h = '<div class="form-grid">';
    fields.forEach(f => {
      const v = values[f.key] !== undefined && values[f.key] !== null ? values[f.key] : (f.default !== undefined ? f.default : '');
      const span = f.span === 'full' ? ' full' : '';
      h += '<div class="' + span + '"><label class="fld">' + U.esc(f.label) + (f.required ? ' <span style="color:var(--danger)">*</span>' : '') + '</label>';
      if (f.type === 'select') {
        h += '<select data-f="' + f.key + '">';
        if (!f.required) h += '<option value="">— 请选择 —</option>';
        (f.options || []).forEach(o => {
          const val = typeof o === 'object' ? o.value : o;
          const txt = typeof o === 'object' ? o.text : o;
          h += '<option value="' + U.esc(val) + '"' + (String(v) === String(val) ? ' selected' : '') + '>' + U.esc(txt) + '</option>';
        });
        h += '</select>';
      } else if (f.type === 'textarea') {
        h += '<textarea data-f="' + f.key + '" placeholder="' + U.esc(f.placeholder || '') + '">' + U.esc(v) + '</textarea>';
      } else if (f.type === 'checkbox') {
        h += '<label class="inline"><input type="checkbox" data-f="' + f.key + '"' + (v ? ' checked' : '') + '> ' + U.esc(f.label) + '</label>';
      } else if (f.type === 'rooms') {
        h += '<div class="inline" style="width:100%"><input type="text" data-f="' + f.key + '" value="' + U.esc(Array.isArray(v) ? v.join(',') : v) +
          '" placeholder="点击右侧选择房源"><button type="button" class="btn btn-sm" data-pick-rooms="' + f.key + '">选择房源</button></div>' +
          '<div class="muted" style="font-size:11.5px;margin-top:3px" data-rooms-text="' + f.key + '"></div>';
      } else if (f.type === 'files') {
        h += '<div data-files="' + f.key + '"><button type="button" class="btn btn-sm" data-pick-files="' + f.key + '">上传附件</button>' +
          '<input type="hidden" data-f="' + f.key + '" value="' + U.esc(typeof v === 'object' ? JSON.stringify(v) : v) + '">' +
          '<div class="mt8" data-files-list="' + f.key + '"></div></div>';
      } else if (f.type === 'static') {
        h += '<div style="padding:7px 0">' + (f.render ? f.render(values) : U.esc(v)) + '</div>';
      } else if (f.type === 'perms') {
        /* ==================== 权限树勾选 ====================
         *
         * 【为什么不用 textarea 手填编码】原来是让管理员照着下方那张
         * 「权限点一览」把 47 个编码一个一个抄进文本框。抄错不报错，
         * 只是那个权限悄悄失效，排查起来毫无头绪。
         * 改成按菜单分组、每个菜单下把子权限列成复选框 ——
         * 看的是中文（「查看」「审批」「终止/退租」），不是编码。
         *
         * 【结构】
         *   ☑ 合同管理            ← 这行是菜单开关（= 有 contract:view）
         *     ☑ 查看               ← 子权限，逐项勾
         *     ☐ 新增/编辑/删除
         *     ☑ 审批
         *   ☐ 发票管理            ← 没勾 view，整个菜单在侧边栏不出现
         *     ☐ 查看
         *
         * 【父子联动规则】
         *   · 勾任意子权限 → 自动补上该菜单的 view（否则菜单不显示，
         *     配了 manage 却打不开页面，是很难自己发现的错配）
         *   · 取消 view → 该菜单下所有子权限一起取消（菜单都看不见了，
         *     留着子权限没有意义）
         *   · 菜单行的勾选状态 = viewCode 是否已勾（全选/半选/未选三态）
         *
         * value 用逗号分隔的字符串存在 [data-f=key] 的隐藏 input 里，
         * 这样 Form.read 不用改，直接 el.value 就能拿到。
         */
        const tree = f.tree || [];
        const cur = new Set(Array.isArray(v) ? v.map(String) : String(v || '').split(',').filter(Boolean));
        h += '<div data-perms="' + f.key + '" style="border:1px solid var(--line);border-radius:8px;padding:10px;max-height:46vh;overflow:auto">' +
          '<div class="flex mb8" style="gap:6px;flex-wrap:wrap">' +
          '<button type="button" class="btn btn-sm" data-pa="all">全选</button>' +
          '<button type="button" class="btn btn-sm" data-pa="none">全不选</button>' +
          '<button type="button" class="btn btn-sm" data-pa="view">只保留「查看」</button>' +
          '<span class="muted" style="font-size:11.5px;margin-left:auto">已选 <b data-pa-cnt>0</b> 项</span>' +
          '</div>';
        tree.forEach(menu => {
          // 【只读模式】用于用户表单的「额外权限」——展示即可，不允许勾
          const dis = f.readonlyTree ? ' disabled' : '';
          h += '<div style="border-top:1px solid var(--line);padding:7px 0">' +
            '<label class="inline" style="font-weight:600;cursor:pointer">' +
            '<input type="checkbox" data-pm="' + U.esc(menu.key) + '" data-view="' + U.esc(menu.viewCode) + '"' +
            (cur.has(menu.viewCode) ? ' checked' : '') + dis + '> ' +
            U.esc(menu.label) + ' <span class="muted" style="font-weight:400;font-size:11.5px">（菜单）</span>' +
            '</label>';
          h += '<div style="padding-left:22px;display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:4px">';
          menu.actions.forEach(a => {
            h += '<label class="inline" style="font-size:12.5px;cursor:pointer">' +
              '<input type="checkbox" data-pact="' + U.esc(a.code) + '"' + (cur.has(a.code) ? ' checked' : '') + dis + '> ' +
              U.esc(a.label) + '</label>';
          });
          h += '</div></div>';
        });
        h += '<input type="hidden" data-f="' + f.key + '" value="' + U.esc(Array.from(cur).join(',')) + '"></div>';
      } else {
        h += '<input type="' + (f.type || 'text') + '" data-f="' + f.key + '" value="' + U.esc(v) +
          '" placeholder="' + U.esc(f.placeholder || '') + '"' + (f.readonly ? ' readonly' : '') + (f.step ? ' step="' + f.step + '"' : '') + '>';
      }
      // 【字段级提示】像巡更点位的「归属月份」这类需要解释规则的字段，
      // 光靠 label 说明不了「留空 = 每个月都算」这种反直觉含义，需要补一句。
      if (f.hint) h += '<div class="muted" style="font-size:11.5px;margin-top:3px;line-height:1.6">' + U.esc(f.hint) + '</div>';
      h += '</div>';
    });
    h += '</div>';
    return h;
  },
  read(root, fields) {
    const obj = {};
    fields.forEach(f => {
      const el = root.querySelector('[data-f="' + f.key + '"]');
      if (!el) return;
      if (f.type === 'checkbox') obj[f.key] = el.checked;
      else if (f.type === 'perms') obj[f.key] = el.value ? el.value.split(',').filter(Boolean) : [];
      else if (f.type === 'number' || f.type === 'money') obj[f.key] = U.num(el.value, 0);
      else if (f.type === 'rooms') obj[f.key] = el.value ? String(el.value).split(',').filter(Boolean) : [];
      else if (f.type === 'files') { try { obj[f.key] = JSON.parse(el.value || '[]'); } catch (e) { obj[f.key] = []; } }
      else obj[f.key] = el.value;
    });
    return obj;
  },
  validate(values, fields) {
    for (const f of fields) {
      if (!f.required) continue;
      const v = values[f.key];
      if (v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length)) return f.label + ' 不能为空';
    }
    return null;
  },
  bind(root, fields, bizType) {
    // 房源选择
    root.querySelectorAll('[data-pick-rooms]').forEach(btn => {
      btn.onclick = async () => {
        const key = btn.getAttribute('data-pick-rooms');
        const input = root.querySelector('[data-f="' + key + '"]');
        const cur = input.value ? input.value.split(',').filter(Boolean) : [];
        Picker.rooms(cur, ids => {
          input.value = ids.join(',');
          Cache.rooms().then(list => {
            const t = root.querySelector('[data-rooms-text="' + key + '"]');
            if (t) t.textContent = '已选 ' + ids.length + ' 间：' + ids.map(i => { const r = list.filter(x => x.id === i)[0]; return r ? r.code : i; }).join('、');
          });
        });
      };
    });
    // 附件上传
    root.querySelectorAll('[data-pick-files]').forEach(btn => {
      btn.onclick = () => {
        const key = btn.getAttribute('data-pick-files');
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true;
        inp.onchange = async () => {
          const files = Array.from(inp.files || []);
          const store = root.querySelector('[data-f="' + key + '"]');
          let arr = []; try { arr = JSON.parse(store.value || '[]'); } catch (e) { arr = []; }
          for (const f of files) {
            const dataUrl = await new Promise(res => {
              const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(f);
            });
            const r = await POST('/api/system/upload', { fileName: f.name, dataBase64: dataUrl, bizType: bizType || 'file' });
            if (r.ok) arr.push(r.data);
          }
          store.value = JSON.stringify(arr);
          Form.renderFiles(root, key);
        };
        inp.click();
      };
    });
    fields.filter(f => f.type === 'files').forEach(f => Form.renderFiles(root, f.key));

    /* ==================== 权限树勾选：父子联动 ==================== */
    fields.filter(f => f.type === 'perms').forEach(f => {
      const wrap = root.querySelector('[data-perms="' + f.key + '"]');
      if (!wrap) return;
      const store = wrap.querySelector('[data-f="' + f.key + '"]');
      const cntEl = wrap.querySelector('[data-pa-cnt]');

      /** 把当前勾选状态写回隐藏 input + 刷新计数 */
      const sync = () => {
        const codes = [];
        wrap.querySelectorAll('[data-pact]').forEach(x => { if (x.checked) codes.push(x.getAttribute('data-pact')); });
        store.value = codes.join(',');
        if (cntEl) cntEl.textContent = codes.length;
        // 菜单行三态：全选 / 半选 / 未选
        wrap.querySelectorAll('[data-pm]').forEach(m => {
          const menuKey = m.getAttribute('data-pm');
          const subs = Array.from(wrap.querySelectorAll('[data-pact]'))
            .filter(x => x.getAttribute('data-pact').indexOf(menuKey + ':') === 0);
          const on = subs.filter(x => x.checked).length;
          m.checked = on > 0 && on === subs.length;
          m.indeterminate = on > 0 && on < subs.length;
        });
      };

      // 菜单开关（= 该模块的 view 权限）
      wrap.querySelectorAll('[data-pm]').forEach(m => {
        m.onchange = () => {
          const menuKey = m.getAttribute('data-pm');
          const subs = Array.from(wrap.querySelectorAll('[data-pact]'))
            .filter(x => x.getAttribute('data-pact').indexOf(menuKey + ':') === 0);
          subs.forEach(x => { x.checked = m.checked; });
          sync();
        };
      });
      // 子权限
      wrap.querySelectorAll('[data-pact]').forEach(x => {
        x.onchange = () => {
          const code = x.getAttribute('data-pact');
          const menuKey = code.slice(0, code.indexOf(':'));
          const m = wrap.querySelector('[data-pm="' + menuKey + '"]');
          /* 【关键联动】勾了子权限却没勾菜单的 view，会出现
           * 「有 contract:manage 但打不开合同页」——因为前端菜单是按
           * 有没有 xxx:view 决定的。角色配错了自己很难发现，
           * 因为按钮权限看着都对。所以这里自动补上 view。 */
          if (x.checked && m && !m.checked) {
            m.checked = true;
            const view = wrap.querySelector('[data-pact="' + m.getAttribute('data-view') + '"]');
            if (view) view.checked = true;
          }
          /* 反向：取消菜单的 view 就把该菜单下子权限全清掉。
           * 菜单都看不见了，留着子权限纯属误导。 */
          if (!x.checked && code === m.getAttribute('data-view')) {
            const subs = Array.from(wrap.querySelectorAll('[data-pact]'))
              .filter(y => y.getAttribute('data-pact').indexOf(menuKey + ':') === 0);
            subs.forEach(y => { y.checked = false; });
          }
          sync();
        };
      });
      // 批量按钮
      wrap.querySelectorAll('[data-pa]').forEach(b => {
        b.onclick = () => {
          const mode = b.getAttribute('data-pa');
          if (mode === 'all') {
            wrap.querySelectorAll('[data-pact]').forEach(x => { x.checked = true; });
          } else if (mode === 'none') {
            wrap.querySelectorAll('[data-pm],[data-pact]').forEach(x => { x.checked = false; });
          } else if (mode === 'view') {
            // 「只保留查看」：每个菜单只留 view，等价于只读账号
            wrap.querySelectorAll('[data-pm],[data-pact]').forEach(x => { x.checked = false; });
            wrap.querySelectorAll('[data-pm]').forEach(m => {
              m.checked = true;
              const v = wrap.querySelector('[data-pact="' + m.getAttribute('data-view') + '"]');
              if (v) v.checked = true;
            });
          }
          sync();
        };
      });
      sync();
    });
  },
  renderFiles(root, key) {
    const store = root.querySelector('[data-f="' + key + '"]');
    const box = root.querySelector('[data-files-list="' + key + '"]');
    if (!store || !box) return;
    let arr = []; try { arr = JSON.parse(store.value || '[]'); } catch (e) { arr = []; }
    box.innerHTML = arr.map((a, i) => '<span class="file-chip">📎 <a href="' + U.esc(a.url) + '" target="_blank">' + U.esc(a.name) +
      '</a> <span class="link" data-delfile="' + i + '" data-fk="' + key + '">×</span></span>').join('') || '<span class="muted">未上传附件</span>';
    box.querySelectorAll('[data-delfile]').forEach(x => {
      x.onclick = () => { arr.splice(Number(x.getAttribute('data-delfile')), 1); store.value = JSON.stringify(arr); Form.renderFiles(root, key); };
    });
  }
};

/* ---------- 选择器 ---------- */
window.Picker = {
  async rooms(selected, cb) {
    const list = await Cache.rooms();
    const body = '<div class="mb8"><input type="text" id="rmKw" placeholder="搜索房号 / 房源编码" style="width:100%"></div>' +
      '<div class="table-wrap" style="max-height:380px"><table class="tbl"><thead><tr><th style="width:40px"></th><th>房源编码</th><th>项目</th><th>面积(㎡)</th><th>状态</th></tr></thead><tbody id="rmList"></tbody></table></div>';
    const m = UI.open({
      title: '选择房源（可多选，支持合并/合租）', width: 'wide', body: body, okText: '确定选择',
      onMount(mask) {
        const tb = mask.querySelector('#rmList');
        const draw = kw => {
          const rows = list.filter(r => !kw || (r.code || '').indexOf(kw) >= 0 || (r.roomNo || '').indexOf(kw) >= 0);
          tb.innerHTML = rows.slice(0, 300).map(r =>
            '<tr><td><input type="checkbox" class="rmck" value="' + U.esc(r.id) + '"' + (selected.indexOf(r.id) >= 0 ? ' checked' : '') + '></td>' +
            '<td>' + U.esc(r.code) + '</td><td class="muted">' + U.esc(r.projectName || '') + '</td>' +
            '<td class="num">' + r.area + '</td><td>' + U.statusTag(r.status) + '</td></tr>').join('');
        };
        draw('');
        mask.querySelector('#rmKw').oninput = e => draw(e.target.value.trim());
      },
      onOk(mask) {
        const ids = Array.from(mask.querySelectorAll('.rmck:checked')).map(x => x.value);
        cb(ids);
      }
    });
    return m;
  }
};

/* ---------- CRUD 页面工厂 ---------- */
window.CrudView = function (cfg) {
  const state = { page: 1, size: cfg.size || 20, filters: {}, keyword: '', sort: cfg.sort || '' };
  let lastRows = [];

  async function load() {
    const q = [];
    q.push('page=' + state.page + '&size=' + state.size);
    if (state.keyword) q.push('keyword=' + encodeURIComponent(state.keyword));
    Object.keys(state.filters).forEach(k => { if (state.filters[k]) q.push(k + '=' + encodeURIComponent(state.filters[k])); });
    if (cfg.extraQuery) Object.keys(cfg.extraQuery).forEach(k => q.push(k + '=' + encodeURIComponent(cfg.extraQuery[k])));
    const r = await GET(cfg.api + (cfg.api.indexOf('?') > 0 ? '&' : '?') + q.join('&'));
    if (!r.ok) { UI.toast(r.msg || '加载失败', 'err'); return { list: [], total: 0 }; }
    lastRows = r.data.list || [];
    return { list: r.data.list || [], total: r.data.total || 0 };
  }

  async function render(el, arg) {
    if (cfg.onArg && arg) cfg.onArg(decodeURIComponent(arg), state);
    // 预加载下拉选项
    const sources = {};
    if (cfg.optionSources) {
      for (const k of Object.keys(cfg.optionSources)) { sources[k] = await cfg.optionSources[k](); }
    }
    cfg._sources = sources;

    el.innerHTML =
      '<div class="toolbar" id="tb">' +
      '<div class="spacer"></div>' +
      (cfg.hideAdd ? '' : '<button class="btn btn-primary" data-act="add">+ 新增</button>') +
      (cfg.buttons || []).map(b => '<button class="btn ' + (b.cls || '') + '" data-custom="' + b.key + '">' + U.esc(b.label) + '</button>').join('') +
      (cfg.exportUrl ? '<button class="btn" data-act="export">导出 CSV</button><button class="btn" data-act="exportXls">导出 Excel</button>' : '') +
      '<button class="btn" data-act="reload">刷新</button>' +
      '</div>' +
      '<div class="card"><div class="card-body tight" id="listBox"></div></div>';

    // 筛选栏
    if (cfg.filters && cfg.filters.length) {
      const tb = el.querySelector('#tb');
      const wrap = document.createElement('div');
      wrap.className = 'flex';
      wrap.style.flexWrap = 'wrap';
      wrap.innerHTML = cfg.filters.map(f => {
        const opts = f.optionsFrom ? (sources[f.optionsFrom] || []) : (f.options || []);
        if (f.type === 'select') {
          return '<select data-filter="' + f.key + '" style="width:auto;min-width:120px"><option value="">' + U.esc(f.label) + '</option>' +
            opts.map(o => {
              const v = typeof o === 'object' ? o.value : o, t = typeof o === 'object' ? o.text : o;
              return '<option value="' + U.esc(v) + '"' + (String(state.filters[f.key] || '') === String(v) ? ' selected' : '') + '>' + U.esc(t) + '</option>';
            }).join('') + '</select>';
        }
        return '<input type="' + (f.type || 'text') + '" data-filter="' + f.key + '" placeholder="' + U.esc(f.label) +
          '" value="' + U.esc(state.filters[f.key] || '') + '" style="width:auto;min-width:' + (f.width || 110) + 'px">';
      }).join('') +
        (!cfg.hideSearch ? '<input type="text" data-kw placeholder="' + U.esc(cfg.searchPlaceholder || '关键字搜索') + '" value="' + U.esc(state.keyword) + '" style="width:180px">' : '');
      tb.insertBefore(wrap, tb.firstChild);
      wrap.querySelectorAll('[data-filter]').forEach(x => {
        x.onchange = () => { state.filters[x.getAttribute('data-filter')] = x.value; state.page = 1; refresh(); };
        x.onkeydown = e => { if (e.key === 'Enter') { state.filters[x.getAttribute('data-filter')] = x.value; state.page = 1; refresh(); } };
      });
      const kw = wrap.querySelector('[data-kw]');
      if (kw) kw.onkeydown = e => { if (e.key === 'Enter') { state.keyword = kw.value.trim(); state.page = 1; refresh(); } };
    }

    async function refresh() {
      const box = el.querySelector('#listBox');
      box.innerHTML = '<div class="empty">加载中…</div>';
      const { list, total } = await load();
      const cols = typeof cfg.columns === 'function' ? cfg.columns(list) : cfg.columns;
      const actionsFn = cfg.actions ? (typeof cfg.actions === 'function' ? cfg.actions : () => cfg.actions) : null;
      box.innerHTML = Table.render(cols, list, {
        actions: actionsFn || null, actionWidth: cfg.actionWidth,
        checkable: !!cfg.checkable, selected: []
      });
      box.insertAdjacentHTML('beforeend', Table.pager(total, state.page, state.size));
      // 分页
      box.querySelectorAll('[data-page]').forEach(b => {
        b.onclick = () => { const p = Number(b.getAttribute('data-page')); if (p >= 1) { state.page = p; refresh(); } };
      });
      // 行操作
      if (cfg.rowActions) {
        box.querySelectorAll('[data-act2]').forEach(b => {
          b.onclick = () => {
            const id = b.closest('[data-row]').getAttribute('data-row');
            const row = list.filter(x => String(x.id) === String(id))[0];
            const fn = cfg.rowActions[b.getAttribute('data-act2')];
            if (fn) fn(row, () => refresh(), list);
          };
        });
      }
      // 行点击
      if (cfg.onRowClick) {
        box.querySelectorAll('[data-row]').forEach(tr => {
          tr.style.cursor = 'pointer';
          tr.onclick = e => {
            if (e.target.closest('[data-act2]') || e.target.closest('input')) return;
            const row = list.filter(x => String(x.id) === String(tr.getAttribute('data-row')))[0];
            if (row) cfg.onRowClick(row, () => refresh());
          };
        });
      }
      if (cfg.onRendered) cfg.onRendered(el, list, () => refresh());
    }

    el.querySelectorAll('[data-act]').forEach(b => {
      b.onclick = async () => {
        const act = b.getAttribute('data-act');
        if (act === 'add') openForm(null, () => refresh());
        if (act === 'reload') { Cache.bust(); refresh(); }
        if (act === 'export') download(cfg.exportUrl, 'csv');
        if (act === 'exportXls') download(cfg.exportUrl, 'xls');
      };
    });
    el.querySelectorAll('[data-custom]').forEach(b => {
      b.onclick = () => {
        const key = b.getAttribute('data-custom');
        const btn = (cfg.buttons || []).filter(x => x.key === key)[0];
        if (btn && btn.onClick) btn.onClick(el, () => refresh(), lastRows);
      };
    });

    function download(url, fmt) {
      const q = [];
      Object.keys(state.filters).forEach(k => { if (state.filters[k]) q.push(k + '=' + encodeURIComponent(state.filters[k])); });
      if (state.keyword) q.push('keyword=' + encodeURIComponent(state.keyword));
      q.push('format=' + fmt);
      window.open(url + (url.indexOf('?') > 0 ? '&' : '?') + q.join('&'), '_blank');
      UI.toast('已开始导出' + (fmt === 'xls' ? ' Excel' : ' CSV') + '，请查看下载');
    }

    function openForm(row, done) {
      const fields = (typeof cfg.fields === 'function' ? cfg.fields(row || {}) : cfg.fields) || [];
      const values = row ? Object.assign({}, row) : {};
      // 下拉选项注入
      fields.forEach(f => {
        if (f.optionsFrom && cfg._sources) f.options = cfg._sources[f.optionsFrom] || [];
      });
      UI.open({
        title: (row ? '编辑' : '新增') + (cfg.name || ''),
        width: cfg.formWidth,
        body: Form.html(fields, values),
        onMount(mask) { Form.bind(mask, fields, cfg.bizType || cfg.key); if (cfg.onFormMount) cfg.onFormMount(mask, values, fields); },
        onOk(mask) {
          const v = Form.read(mask, fields);
          const err = Form.validate(v, fields);
          if (err) { UI.toast(err, 'err'); return false; }
          if (cfg.beforeSave) { const r = cfg.beforeSave(v, row); if (r === false) return false; }
          return POST(cfg.api, row ? Object.assign({ id: row.id }, v) : v).then(r => {
            if (!r.ok) { UI.toast(r.msg || '保存失败', 'err'); return false; }
            UI.toast('保存成功', 'ok'); Cache.bust(); done();
          });
        }
      });
    }

    cfg._openForm = openForm;
    cfg._refresh = () => refresh();
    await refresh();
  }

  return { title: cfg.title, render: render, cfg: cfg };
};
