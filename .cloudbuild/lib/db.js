'use strict';
// 轻量 JSON 持久化存储引擎（零第三方依赖，原子写入）
const fs = require('fs');
const path = require('path');
const { uid, num, money } = require('./util');

/**
 * 解析 `_expr` 表达式（与 clouddb 的 buildExpr 同一套限制）。
 * 本地版没有 SQL 注入面，所以只做**形态校验**（必须是 `(`A` - `B`)`），
 * 列名白名单校验交给云端；这里是双引擎的语义对齐点。
 */
function dbExpr(expr, row) {
  const m = /`([A-Za-z_][A-Za-z0-9_]*)`\s*-\s*`([A-Za-z_][A-Za-z0-9_]*)`/.exec(String(expr || ''));
  if (!m) throw new Error('_expr 只支持 "(`列A` - `列B`)" 形式，收到：' + expr);
  return num(row[m[1]]) - num(row[m[2]]);
}

/**
 * 对象条件的 JS 求值（供 `_case` 条件计数用）。
 * 语义与上面 where() 里的分支**逐条对齐**，也必须与云端 buildWhere 对齐 ——
 * 三处（db.js where / clouddb matchCond / SQL）任一漂移，
 * 就会出现「本地算一个数、云端算另一个数」。
 */
function matchCond(row, cond) {
  return Object.keys(cond || {}).every(k => {
    const v = cond[k];
    if (v === undefined || v === null || v === '') return true;
    if (Array.isArray(v)) return v.indexOf(row[k]) >= 0;
    if (typeof v === 'object' && (v.$gt !== undefined || v.$lt !== undefined || v.$gte !== undefined ||
      v.$lte !== undefined || v.$ne !== undefined || v.$in !== undefined || v.$like !== undefined)) {
      const rv = row[k];
      if (v.$in) return (Array.isArray(v.$in) ? v.$in : [v.$in]).indexOf(rv) >= 0;
      if (v.$ne !== undefined) return String(rv) !== String(v.$ne);
      if (v.$like !== undefined) return String(rv == null ? '' : rv).indexOf(v.$like) >= 0;
      if (v.$gt !== undefined) return Number(rv) > Number(v.$gt);
      if (v.$gte !== undefined) return Number(rv) >= Number(v.$gte);
      if (v.$lt !== undefined) return Number(rv) < Number(v.$lt);
      if (v.$lte !== undefined) return Number(rv) <= Number(v.$lte);
    }
    return String(row[k]) === String(v);
  });
}

class DB {
  constructor(dir) {
    this.dir = dir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map();
    this.seq = new Map();
  }

  file(name) { return path.join(this.dir, String(name).replace(/[^\w\u4e00-\u9fa5-]/g, '_') + '.json'); }

  load(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    let arr = [];
    const f = this.file(name);
    if (fs.existsSync(f)) {
      try {
        const txt = fs.readFileSync(f, 'utf8').trim();
        arr = txt ? JSON.parse(txt) : [];
      } catch (e) {
        // 【严重】原来这里 arr = [] 就完事了 —— 后果是「数据凭空消失」：
        //   1) 文件截断（写入中断/磁盘满/被杀）→ JSON.parse 失败
        //   2) 这里静默返回空数组，调用方以为「本来就没数据」
        //   3) 之后任何一次 persist(name) 都会把空数组写回，
        //      **原文件被彻底覆盖，真实数据永久丢失**。
        // 实测踩过：reminders.json（105 条）和 patrolRecords.json（13669 条）
        // 都这样没了，而且每次都会先备份一个同样损坏的 .bak，
        // 6 个备份全是坏的，等于没有任何可恢复副本。
        //
        // 现在改成：损坏时**抛错**，让请求层返回 500，
        // 宁可「接口报错」也不能「静默清空数据」。
        // 同时把损坏文件另存为 .corrupt.<ts> 便于事后修复。
        const stamp = Date.now();
        const quarantine = f + '.corrupt.' + stamp;
        try { fs.copyFileSync(f, quarantine); } catch (e2) { }
        const err = new Error(
          '数据文件 ' + path.basename(f) + ' 解析失败（文件可能被截断或损坏），' +
          '已另存为 ' + path.basename(quarantine) + '。' +
          '为避免数据被静默清空，本次操作已中止 —— ' +
          '请先用备份文件修复该文件再继续。原始错误：' + e.message);
        err.code = 'DB_FILE_CORRUPT';
        err.file = f;
        err.quarantine = quarantine;
        console.error('[DB] ' + err.message);
        throw err;
      }
    }
    if (!Array.isArray(arr)) arr = [];
    this.cache.set(name, arr);
    return arr;
  }

  persist(name) {
    const arr = this.cache.get(name) || [];
    const f = this.file(name);
    const tmp = f + '.tmp';
    // 【新增】写入前先备份上一版。
    // 为什么需要：writeFileSync 在磁盘满 / 进程被杀时会留下「写了一半」的文件，
    // 而且 tmp+rename 的原子性在 NTFS 上也不是 100% 保证。
    // 没有备份的话，一次异常写入就等于数据永久丢失（实测已发生过）。
    if (fs.existsSync(f)) {
      try {
        const st = fs.statSync(f);
        // 只在有实质内容时才备份，避免空文件刷出一堆 .bak
        if (st.size > 0) fs.copyFileSync(f, f + '.bak.' + Date.now());
      } catch (e2) { }
    }
    fs.writeFileSync(tmp, JSON.stringify(arr), 'utf8');
    fs.renameSync(tmp, f);
  }

  all(name) { return this.load(name); }

  find(name, id) {
    const arr = this.load(name);
    for (let i = 0; i < arr.length; i++) if (String(arr[i].id) === String(id)) return arr[i];
    return null;
  }

  // where: 函数 或 对象（浅匹配，支持数组包含）
  where(name, cond) {
    const arr = this.load(name);
    if (!cond) return arr.slice();
    if (typeof cond === 'function') return arr.filter(cond);
    // ⚠ `_raw` 是给云端 SQL 下推用的原始片段（见 lib/clouddb.js buildRawWhere），
    //   本地版**无法执行**。若不拦，它会掉到下面第 85 行
    //   `String(row['_raw']) === String(整段SQL)` → 恒 false → 结果恒为空集，
    //   表现为「欠费 0 条 / 账单 0 元」这种静默错误，极难发现。
    //   所以这里显式抛错，强制调用方在本地模式改用函数条件。
    if (cond._raw) {
      throw new Error('where：本地模式不支持 _raw 条件（表=' + name + '）。' +
        '请改用函数条件，或在云端模式下运行。');
    }
    const keys = Object.keys(cond);
    return arr.filter(row => keys.every(k => {
      const v = cond[k];
      if (v === undefined || v === '' || v === null) return true;
      if (Array.isArray(v)) return v.indexOf(row[k]) >= 0;
      if (typeof v === 'function') return v(row[k], row);
      if (typeof v === 'object' && (v.$gt !== undefined || v.$lt !== undefined || v.$gte !== undefined || v.$lte !== undefined || v.$ne !== undefined || v.$in !== undefined || v.$like !== undefined)) {
        const rv = row[k];
        if (v.$in) return (Array.isArray(v.$in) ? v.$in : [v.$in]).indexOf(rv) >= 0;
        if (v.$ne !== undefined) return String(rv) !== String(v.$ne);
        if (v.$like !== undefined) return String(rv == null ? '' : rv).indexOf(v.$like) >= 0;
        if (v.$gt !== undefined) return Number(rv) > Number(v.$gt);
        if (v.$gte !== undefined) return Number(rv) >= Number(v.$gte);
        if (v.$lt !== undefined) return Number(rv) < Number(v.$lt);
        if (v.$lte !== undefined) return Number(rv) <= Number(v.$lte);
      }
      return String(row[k]) === String(v);
    }));
  }

  one(name, cond) { return this.where(name, cond)[0] || null; }

  insert(name, obj) {
    const arr = this.load(name);
    const row = Object.assign({ id: obj.id || uid('id'), createTime: new Date().toISOString() }, obj);
    arr.push(row);
    this.persist(name);
    return row;
  }

  insertMany(name, list) {
    const arr = this.load(name);
    list.forEach(o => arr.push(Object.assign({ id: o.id || uid('id'), createTime: new Date().toISOString() }, o)));
    this.persist(name);
    return list.length;
  }

  update(name, id, patch) {
    const arr = this.load(name);
    for (let i = 0; i < arr.length; i++) {
      if (String(arr[i].id) === String(id)) {
        arr[i] = Object.assign(arr[i], patch, { updateTime: new Date().toISOString() });
        this.persist(name);
        return arr[i];
      }
    }
    return null;
  }

  remove(name, id) {
    const arr = this.load(name);
    const idx = arr.findIndex(r => String(r.id) === String(id));
    if (idx < 0) return false;
    arr.splice(idx, 1);
    this.persist(name);
    return true;
  }

  count(name, cond) { return this.where(name, cond).length; }

  // ==================================================================
  // 聚合（SUM / COUNT / GROUP BY）—— 与 lib/clouddb.js 签名完全一致
  // ==================================================================
  /**
   * 【为什么本地版也必须有这三个方法】
   * 系统是「双引擎」：DB_MODE=local 走这个 JSON 版，DB_MODE=cloud 走 TiDB 版。
   * 两边方法签名必须严格一致，否则 routes/ 里的业务代码换个模式就跑不起来 ——
   * 实测踩过：只在 clouddb.js 加了 groupAgg，驾驶舱在本地模式下直接 500
   *   「服务端异常：db.groupAgg is not a function」。
   * 新增数据层能力时，**两个文件必须同步改**，这是本项目的硬规矩。
   *
   * 语义对齐点：
   *   1. 金额一律过 money()，与云端 SUM(DECIMAL) 归一后的结果一致；
   *   2. COUNT 返回整数，SUM/AVG 返回两位小数；
   *   3. 空集返回 0（不是 NaN、不是 null），与 SQL SUM 返回 NULL 时被 aggNum 兜成 0 一致；
   *   4. _expr 只支持 `(`A` - `B`)` 两列相减（云端 buildExpr 的同一限制）。
   */

  /** 求某个「取值函数」在所有行上的聚合 */
  _aggregate(rows, specs) {
    const out = {};
    Object.keys(specs).forEach(k => {
      const sp = specs[k];
      const fn = String(sp.fn || 'SUM').toUpperCase();
      // 条件计数：与云端 SUM(CASE WHEN ... THEN 1 ELSE 0 END) 等价。
      // 白名单校验与云端 assertAggSpecs 一致 —— 不因「本地没注入风险」就放过，
      // 否则写错列名时本地返回 0、云端抛错，两边行为分裂反而更难查。
      if (sp._case) {
        const keys = Object.keys(sp._case || {});
        if (!keys.length) throw new Error('_case 条件为空：' + k);
        out[k] = rows.filter(r => matchCond(r, sp._case)).length;
        return;
      }
      const pick = r => (sp._expr ? dbExpr(sp._expr, r) : num(r[sp.col]));
      if (fn === 'COUNT') { out[k] = rows.length; return; }
      if (fn === 'MIN') { out[k] = rows.length ? money(Math.min.apply(null, rows.map(pick))) : 0; return; }
      if (fn === 'MAX') { out[k] = rows.length ? money(Math.max.apply(null, rows.map(pick))) : 0; return; }
      if (fn === 'AVG') { out[k] = rows.length ? money(rows.reduce((s, r) => s + pick(r), 0) / rows.length) : 0; return; }
      out[k] = money(rows.reduce((s, r) => s + pick(r), 0));
    });
    return out;
  }

  /** 条件求和（与 clouddb.sum 同签名） */
  async sum(name, col, cond, opt) {
    opt = opt || {};
    const rows = this.where(name, cond);
    const s = rows.reduce((t, r) => t + num(r[col]), 0);
    return opt.round === false ? s : money(s);
  }

  /** 多指标一次性聚合（与 clouddb.agg 同签名） */
  async agg(name, specs, cond) {
    return this._aggregate(this.where(name, cond), specs);
  }

  /** 分组聚合（与 clouddb.groupAgg 同签名） */
  async groupAgg(name, groupCol, specs, cond) {
    const out = {};
    this.where(name, cond).forEach(r => {
      const g = r[groupCol];
      if (g === null || g === undefined) return;
      const k = String(g);
      if (!out[k]) out[k] = [];
      out[k].push(r);
    });
    Object.keys(out).forEach(k => { out[k] = this._aggregate(out[k], specs); });
    return out;
  }

  // 分页查询
  page(name, opt) {
    opt = opt || {};
    let rows = this.where(name, opt.where);
    if (opt.sort) {
      const s = opt.sort;
      const dir = (opt.order === 'desc') ? -1 : 1;
      rows.sort((a, b) => {
        const va = a[s], vb = b[s];
        if (va === vb) return 0;
        return (va > vb ? 1 : -1) * dir;
      });
    }
    const total = rows.length;
    if (opt.page && opt.size) {
      const p = Math.max(1, Number(opt.page) || 1), sz = Math.max(1, Number(opt.size) || 20);
      rows = rows.slice((p - 1) * sz, p * sz);
    }
    return { list: rows, total: total };
  }

  // 生成业务流水号：prefix + YYYYMM + 4 位序号
  nextNo(name, prefix, dateStr) {
    const ym = String(dateStr || new Date().toISOString().slice(0, 10)).replace(/-/g, '').slice(0, 6);
    const key = prefix + ym;
    let n = (this.seq.get(key) || 0);
    const arr = this.load(name);
    const exist = arr.filter(r => String(r.code || '').indexOf(prefix + ym) === 0).length;
    n = Math.max(n, exist) + 1;
    this.seq.set(key, n);
    return prefix + ym + String(n).padStart(4, '0');
  }

  // 覆盖写入（用于导入/迁移）
  replace(name, arr) {
    this.cache.set(name, Array.isArray(arr) ? arr : []);
    this.persist(name);
  }

  clear(name) { this.cache.set(name, []); this.persist(name); }

  stats() {
    const r = {};
    this.cache.forEach((v, k) => { r[k] = v.length; });
    return r;
  }
}

module.exports = DB;
