/* 前端核心：API 请求、工具函数、UI 组件（Toast / Modal / Drawer）、路由 */
window.U = {
  esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },
  money(v, dec) {
    const n = Number(v || 0);
    return n.toLocaleString('zh-CN', { minimumFractionDigits: dec === undefined ? 2 : dec, maximumFractionDigits: dec === undefined ? 2 : dec });
  },
  num(v, d) { const n = Number(v); return (v === '' || v === null || v === undefined || isNaN(n)) ? (d || 0) : n; },
  date(v) { return v ? String(v).slice(0, 10) : ''; },
  month() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); },
  today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); },
  addDays(dateStr, n) { const d = new Date(dateStr || this.today()); d.setDate(d.getDate() + n); return this.date(d.toISOString()); },
  addMonths(dateStr, n) {
    const d = new Date(dateStr || this.today()); const day = d.getDate();
    d.setDate(1); d.setMonth(d.getMonth() + n);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last)); return this.date(d.toISOString());
  },
  diffDays(a, b) { return Math.round((new Date(b || this.today()) - new Date(a)) / 86400000); },
  tag(text, type) { return '<span class="tag ' + (type || '') + '">' + U.esc(text) + '</span>'; },
  // 状态 → 标签配色
  statusTag(s) {
    const map = {
      '正常履约': 'green', '已收款': 'green', '已通过': 'green', '已完成': 'green', '在管': 'green', '启用': 'green', '正常': 'green', '已开具': 'green',
      '逾期': 'red', '未收款': 'red', '已驳回': 'red', '已作废': 'red', '紧急': 'red', '违约风险': 'red', '逾期风险': 'red', '待处理': 'red',
      '部分收款': 'orange', '审批中': 'orange', '处理中': 'orange', '待退': 'orange', '待退回': 'orange', '变更': 'orange', '重要': 'orange', '待核验': 'orange',
      '退租': 'purple', '终止': 'purple', '空置': 'purple', '已拆分': 'purple',
      '未开票': 'cyan', '提示': 'cyan', '已租': 'blue', '未处理': 'blue'
    };
    return U.tag(s, map[s] || '');
  },
  // 生成唯一 DOM id
  id(p) { return (p || 'e') + Math.random().toString(36).slice(2, 8); }
};

/* ---------- API ---------- */
window.api = async function (method, url, body) {
  const opt = { method: method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(url, opt); }
  catch (e) { UI.toast('网络异常：' + e.message, 'err'); throw e; }
  if (res.status === 401) { UI.toast('登录已失效，请重新登录', 'err'); setTimeout(() => location.reload(), 800); throw new Error('401'); }
  let data;
  try { data = await res.json(); } catch (e) { data = { ok: false, msg: '返回解析失败' }; }
  if (!data.ok && data.code !== undefined) { }
  return data;
};
window.GET = (u) => api('GET', u);
window.POST = (u, b) => api('POST', u, b);
window.DEL = (u) => api('DELETE', u);

/* ---------- UI ---------- */
window.UI = {
  toast(msg, type) {
    let box = document.getElementById('toastBox');
    if (!box) { box = document.createElement('div'); box.id = 'toastBox'; document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.innerHTML = U.esc(msg);
    box.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 2600);
  },
  open(opts) {
    // opts: {title, body(html), width, okText, onOk, onMount, cancelText}
    const mask = document.createElement('div');
    mask.className = 'mask';
    mask.innerHTML =
      '<div class="modal ' + (opts.width || '') + '">' +
      '<div class="modal-head"><h3>' + U.esc(opts.title || '') + '</h3><span class="x" data-close>&times;</span></div>' +
      '<div class="modal-body">' + (opts.body || '') + '</div>' +
      '<div class="modal-foot">' +
      (opts.hideCancel ? '' : '<button class="btn" data-close>' + U.esc(opts.cancelText || '取消') + '</button>') +
      (opts.onOk ? '<button class="btn btn-primary" data-ok>' + U.esc(opts.okText || '保存') + '</button>' : '') +
      '</div></div>';
    document.body.appendChild(mask);
    mask.addEventListener('click', e => {
      if (e.target === mask || e.target.hasAttribute('data-close')) mask.remove();
      if (e.target.hasAttribute('data-ok')) {
        const r = opts.onOk(mask);
        if (r === false) return;
        if (r && r.then) { r.then(x => { if (x !== false) mask.remove(); }); }
        else mask.remove();
      }
    });
    if (opts.onMount) opts.onMount(mask);
    return mask;
  },
  close(el) { if (el) el.remove(); },
  confirm(msg, title) {
    return new Promise(resolve => {
      UI.open({
        title: title || '确认操作', body: '<div style="font-size:13.5px;line-height:1.8">' + msg + '</div>',
        okText: '确定', onOk: () => { resolve(true); }
      });
    });
  },
  // 抽屉详情
  drawer(title, bodyHtml, onMount) {
    const mask = document.createElement('div');
    mask.className = 'mask';
    mask.innerHTML = '<div class="drawer"><div class="modal-head"><h3>' + U.esc(title) +
      '</h3><span class="x" data-close>&times;</span></div><div class="modal-body">' + bodyHtml + '</div></div>';
    document.body.appendChild(mask);
    mask.addEventListener('click', e => { if (e.target === mask || e.target.hasAttribute('data-close')) mask.remove(); });
    if (onMount) onMount(mask);
    return mask;
  },
  loading(msg) {
    const el = document.createElement('div');
    el.className = 'mask';
    el.innerHTML = '<div style="background:#fff;padding:20px 30px;border-radius:8px;font-size:14px">' + U.esc(msg || '处理中…') + '</div>';
    document.body.appendChild(el);
    return () => el.remove();
  }
};

/* ---------- 路由 ---------- */
window.App = {
  views: {},
  current: '',
  user: null,
  menus: [],
  view(key, def) { App.views[key] = def; },
  go(hash) { location.hash = hash; },
  async render() {
    const hash = (location.hash || '#/dashboard').replace('#/', '');
    const key = hash.split('?')[0] || 'dashboard';
    const arg = hash.indexOf('?') > 0 ? hash.split('?')[1] : '';
    App.current = key;
    const def = App.views[key] || App.views.dashboard;
    document.querySelectorAll('.menu-item').forEach(m => m.classList.toggle('active', m.dataset.key === key));
    const el = document.getElementById('pageContent');
    if (!el) return;
    el.innerHTML = '<div class="empty">加载中…</div>';
    try {
      await def.render(el, arg);
    } catch (e) {
      el.innerHTML = '<div class="empty">页面加载失败：' + U.esc(e.message) + '</div>';
      console.error(e);
    }
    const t = document.getElementById('pageTitle');
    if (t) t.textContent = def.title || '';
  }
};
window.addEventListener('hashchange', () => App.render());
