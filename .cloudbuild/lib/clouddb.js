'use strict';
/**
 * 云端数据访问层（TiDB Cloud Serverless）
 *
 * 与 lib/db.js（本地 JSON 版）**方法签名完全一致**，全部改为 async，
 * 这样 routes/ 与 lib/ 业务代码只需在调用处加 await，逻辑一行不用改。
 *
 * 关键设计：
 *   1. SQL 里表名/列名一律走白名单（schema.json），值一律走参数化占位符，
 *      杜绝 SQL 注入。
 *   2. 数组/对象字段以 JSON 文本存储，读取时自动 parse 还原成数组/对象，
 *      让上层（billing/items、contracts/roomIds 等）感觉不到差异。
 *   3. where 条件同时支持「函数」与「对象」，与本地版语义一致。
 *      函数条件无法下推 SQL，改为「拉全表后在内存里过滤」——
 *      本系统单表最大 6764 行（巡更记录），这个量级内存过滤完全可接受。
 */
const path = require('path');
const { run, scalar, isDuplicate } = require('./tidb');
const { money, num } = require('./util');

const META = require(path.join(__dirname, '..', 'exports', 'schema.json'));
const TABLES = new Set(META.tables);
const COLS = META.cols;
const PK = META.pk || {};          // 主键名，默认 id；sessions 为 token
const NUMERIC = new Set(META.numeric);
const BOOLS = new Set(META.bool);
const JSONS = new Set(META.json);

/** 取某表主键名 */
function pkOf(t) { return PK[t] || 'id'; }

function assertTable(t) {
  if (!TABLES.has(t)) throw new Error('未知数据表（白名单未包含）：' + t);
}
function assertCols(t, keys) {
  const allow = new Set(COLS[t] || []);
  return keys.filter(k => allow.has(k));
}
function q(v) { return '?'; }

/**
 * 从「函数条件」里提取严格等值子句，转成 SQL WHERE（下推优化）。
 *
 * 【要解决的问题】
 * 业务代码里大量这种写法：db.where('bills', b => b.contractId === row.id)
 * 以前只能「拉全表 → 内存 filter」。bills 1228 行 / 1.63MB，
 * 实测单条全表 SELECT 要 2.4~3.8 秒 —— 合同列表 20 行 decorate 各调一次，
 * 就是几十秒。提取出 contractId = ? 后，数据库只回几行、不到 100ms。
 *
 * 【为什么必须「提取后仍用原函数再过滤一遍」】
 * 提取出来的等值条件是原函数的一部分，SQL 命中集是原函数命中集的**超集**
 * （例如 cond 里有 `b.contractId === id && b.status !== '作废'`，
 * 只提取前者会多回「已作废」的行）。所以 SQL 查回来后必须再跑一次原 cond。
 *
 * 【安全边界 —— 宁可不提取，也不能提错】
 * 只认这几种最朴素、最无歧义的字面量比较：
 *     r.列名 === '字符串'      r.列名 === 123
 *     r.列名 !== '字符串'      r.列名 !== 123
 * 并且：
 *   1. 字段名必须在该表 schema 的列白名单里（防止 `r.__proto__` 之类）
 *   2. 字段名必须是合法的标识符（`/^[A-Za-z_][A-Za-z0-9_]*$/`），
 *      杜绝 SQL 注入面
 *   3. 字符串字面量必须是单引号闭合、无转义、无插值的简单形式
 *   4. 只扫函数的**顶层**表达式序列（用括号深度 0 切分），
 *      嵌套在 if / && / || 内部的比较不提取 —— 那种语义不确定
 * 任何一条不满足就不提取，退回原来的全表路径（慢但正确）。
 * 正确性优先于性能：提错一次就是数据错误，慢只是慢。
 *
 * 形参名从函数源码里取（形如 `b => ...` / `function (b) { ... }`），
 * 拿不到就放弃提取。
 */
function extractEq(table, cond) {
  let src;
  try { src = String(cond); } catch (e) { return null; }
  if (!src || src.length > 4000) return null;      // 太长说明是复杂逻辑，别碰

  // ---- 取形参名 ----
  let param = null;
  let m = /^\s*(?:async\s+)?(?:\(\s*([A-Za-z_$][\w$]*)\s*\)|([A-Za-z_$][\w$]*))\s*=>/.exec(src);
  if (m) param = m[1] || m[2];
  if (!param) {
    m = /^\s*(?:async\s+)?function\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(src);
    if (m) param = m[1];
  }
  if (!param || !/^[A-Za-z_$][\w$]*$/.test(param)) return null;

  // ---- 取函数体（箭头函数单表达式 / function 体）----
  let body = src;
  const arrowBody = /^\s*(?:async\s+)?(?:\(\s*[A-Za-z_$][\w$]*\s*\)|[A-Za-z_$][\w$]*)\s*=>\s*([\s\S]*)$/.exec(src);
  if (arrowBody) body = arrowBody[1];
  else {
    const fb = /\{([\s\S]*)\}\s*$/.exec(src);
    if (fb) body = fb[1];
  }
  // 箭头函数体若是 { ... } 形式（少见），去掉最外层花括号
  body = body.trim();
  if (body.startsWith('{') && body.endsWith('}')) body = body.slice(1, -1);
  // function (b) { return X; } 形式：只取 return 表达式
  // （若函数体有多条 return，说明是分支逻辑，语义不确定 → 放弃提取）
  const rets = body.match(/\breturn\b/g);
  if (rets && rets.length > 1) return null;
  if (rets && rets.length === 1) {
    const ri = body.indexOf('return');
    body = body.slice(ri + 6);
  }
  // 去掉结尾分号（function 体是语句，必须去；箭头函数体本来就没有）
  body = body.replace(/;\s*$/, '').trim();

  const allow = new Set(COLS[table] || []);
  if (!allow.size) return null;

  // ---- 顶层按 && 切分（括号深度 0）----
  const stmts = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '&' && body[i + 1] === '&' && depth === 0) {
      stmts.push(body.slice(start, i)); i++; start = i + 1;
    }
  }
  stmts.push(body.slice(start));

  const parts = [], params = [];
  const re = new RegExp(
    '^\\s*' + param.replace(/[$]/g, '\\$') + '\\.([A-Za-z_][A-Za-z0-9_]*)\\s*(===|!==|==|!=)\\s*' +
    "('(?:[^'\\\\]|\\\\.)*'|\"(?:[^\"\\\\]|\\\\.)*\"|-?\\d+(?:\\.\\d+)?|true|false|null)\\s*$"
  );
  for (const s of stmts) {
    const mm = re.exec(s);
    if (!mm) continue;
    const col = mm[1];
    if (!allow.has(col)) continue;              // 字段不在白名单 → 放弃这一句
    const op = mm[2];
    const lit = mm[3];
    let val;
    if (lit[0] === "'" || lit[0] === '"') {
      // 只接受「无转义、无插值」的简单字符串
      const bodyStr = lit.slice(1, -1);
      if (/\\/.test(bodyStr)) continue;
      if (lit[0] === '`' && /\$\{/.test(bodyStr)) continue;
      val = bodyStr;
    } else if (lit === 'true') val = 1;
    else if (lit === 'false') val = 0;
    else if (lit === 'null') val = null;
    else val = Number(lit);
    if (val === null || (typeof val === 'number' && !Number.isFinite(val))) continue;
    parts.push('`' + col + '` ' + (op === '===' || op === '==' ? '=' : '<>') + ' ?');
    params.push(JSONS.has(col) ? JSON.stringify(val) : val);
  }
  if (!parts.length) return null;
  return { sql: parts.join(' AND '), params: params };
}

// ---------- 值编解码 ----------
function decode(v) {
  if (v === null || v === undefined) return v;
  return v;
}
function encodeValue(t, k, v) {
  if (v === undefined || v === null) return null;
  if (JSONS.has(k)) return JSON.stringify(v);
  if (BOOLS.has(k)) return v ? 1 : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}
function decodeRow(t, r) {
  if (!r) return r;
  const out = Object.assign({}, r);
  const allow = new Set(COLS[t] || []);
  for (const k of Object.keys(out)) {
    if (!allow.has(k)) { delete out[k]; continue; }   // 丢弃非白名单列，防脏数据外泄
    if (JSONS.has(k)) {
      if (out[k] === null || out[k] === '') { out[k] = []; continue; }
      try { out[k] = JSON.parse(out[k]); } catch (e) { out[k] = []; }
    }
    if (BOOLS.has(k)) out[k] = !!out[k];
  }
  return out;
}

// ---------- where 条件 → SQL ----------
/**
 * 把本地版 where 条件转成 SQL 片段。
 * @returns {{sql:string, params:any[]}|null} null 表示「无法下推」，需内存过滤
 */
function buildWhere(t, cond) {
  if (!cond) return null;
  if (typeof cond === 'function') return null;              // 函数条件 → 内存过滤
  const keys = Object.keys(cond).filter(k => (COLS[t] || []).indexOf(k) >= 0);
  if (!keys.length) return null;
  const parts = [], params = [];
  for (const k of keys) {
    const v = cond[k];
    if (v === undefined || v === null || v === '') continue;   // 与本地版一致：空值视为不过滤
    const col = '`' + k + '`';
    if (Array.isArray(v)) {
      if (!v.length) continue;
      parts.push(col + ' IN (' + v.map(() => q()).join(',') + ')');
      v.forEach(x => params.push(JSONS.has(k) ? JSON.stringify(x) : x));
      continue;
    }
    if (typeof v === 'object' && (v.$gt !== undefined || v.$lt !== undefined || v.$gte !== undefined || v.$lte !== undefined || v.$ne !== undefined || v.$in !== undefined || v.$like !== undefined)) {
      if (v.$in !== undefined) {
        const arr = Array.isArray(v.$in) ? v.$in : [v.$in];
        if (!arr.length) continue;
        parts.push(col + ' IN (' + arr.map(() => q()).join(',') + ')');
        arr.forEach(x => params.push(JSONS.has(k) ? JSON.stringify(x) : x));
      }
      if (v.$ne !== undefined) { parts.push('COALESCE(CAST(' + col + ' AS CHAR), \'\') <> ?'); params.push(String(v.$ne)); }
      if (v.$like !== undefined) { parts.push(col + ' LIKE ?'); params.push('%' + v.$like + '%'); }
      if (v.$gt !== undefined) { parts.push(col + ' > ?'); params.push(Number(v.$gt)); }
      if (v.$gte !== undefined) { parts.push(col + ' >= ?'); params.push(Number(v.$gte)); }
      if (v.$lt !== undefined) { parts.push(col + ' < ?'); params.push(Number(v.$lt)); }
      if (v.$lte !== undefined) { parts.push(col + ' <= ?'); params.push(Number(v.$lte)); }
      continue;
    }
    if (typeof v === 'function') return null;
    parts.push(col + ' = ?');
    params.push(JSONS.has(k) ? JSON.stringify(v) : v);
  }
  if (!parts.length) return null;
  return { sql: parts.join(' AND '), params };
}

function whereSql(t, cond) {
  const b = buildWhere(t, cond);
  return b ? ' WHERE ' + b.sql : '';
}

// ==================================================================
// 聚合（SUM / COUNT / GROUP BY）—— 驾驶舱等统计场景专用
// ==================================================================
/**
 * 为什么需要聚合层
 * ----------------
 * 改造前驾驶舱（/api/report/dashboard）把 rooms / contracts / bills
 * 三张表**全量拉进 Node 内存**再用 reduce 累加：
 *     const bills = await db.where('bills', b => b.period === curMonth);
 *     total: money(bills.reduce((s, b) => s + num(b.totalAmount), 0))
 * 实测三表合计 266 + 214 + 1228 = 1708 行、约 2MB 传输，
 * 而最终只需要十几个数字 —— 90% 的带宽和 CPU 花在「把明细搬回来再扔掉」。
 *
 * 聚合层把这些 reduce 全部下推成 SQL：
 *     SELECT COUNT(*) AS c, SUM(`totalAmount`) AS s FROM `bills` WHERE `period` = ?
 * 只回一行十几列，传输量降两个数量级。
 *
 * 【正确性红线】三条，缺一不可：
 *   1. 列名必须过白名单（assertCols），否则 `SUM(用户输入)` 可注入。
 *      表名/列名无法参数化，只能靠白名单，这是唯一防线。
 *   2. 金额语义必须与原内存算法**逐分一致**。
 *      内存版是 JS 浮点 `money(Math.round(x*100)/100)`，
 *      SQL 版 SUM 走 DECIMAL。若不做 money() 归一，
 *      `2965133.0200000004` 与 `2965133.02` 会被判为不等。
 *      所以 sum() 返回前一律再过一次 money()。
 *   3. 缓存命中时走内存聚合，保证与 where().reduce() 完全同源。
 *      绝不能「缓存命中就返回缓存值、未命中就返回 SQL 值」——
 *      两条路径必须同算法同结果，否则会出现「刷新一次数字就变了」。
 */

/**
 * 判断某列是否数值型。
 *
 * ⚠ schema.json 的 `numeric` 是**纯列名数组，不带表前缀**
 * （实测：`["amount","currentLevel","totalLevel","balance","size",...]` 共 89 个），
 * 所以不能写成 NUMERIC.has(table + '.' + col) —— 那样永远不命中，
 * 会把所有 SUM 静默降级成「无法下推」，优化等于没做。
 */
function isNumericCol(t, col) {
  return NUMERIC.has(col);
}

/**
 * 构造聚合 SELECT 片段 + WHERE 片段 + 参数。
 *
 * ⚠ 这里刻意把聚合列（`select`）与条件列（`where`）分开返回，
 * 因为 GROUP BY 场景需要在两者之间插入 `GROUP BY` 子句：
 *     SELECT `_g`, COUNT(*) AS `c` FROM `rooms` WHERE ... GROUP BY `_g`
 *
 * 【为什么对非法列抛错而不是静默跳过】
 * 静默跳过的后果是聚合值变成 0，驾驶舱会显示「本月账单 0 元」，
 * 看不出是数据问题还是配置写错了列名 —— 这类静默 Bug 最难查。
 * 所以这里明确抛错，让问题在开发/测试阶段就暴露。
 *
 * @returns {{select:string, where:string, params:any[]}|null} 无 cond 可下推时返回 null
 * @throws  {Error} 列不在白名单 / 非数值列做 SUM / 非法聚合函数
 */
function buildAgg(name, cond, specs) {
  // specs: { alias: {col, fn} }  fn ∈ SUM | COUNT | AVG | MIN | MAX
  // 条件里可带 _raw（受限原始片段），它与对象条件互斥
  const raw = cond && typeof cond === 'object' ? cond._raw : null;
  const objCond = cond && typeof cond === 'object' && !raw
    ? Object.keys(cond).filter(k => k.charAt(0) !== '_')
      .reduce((o, k) => { o[k] = cond[k]; return o; }, {})
    : null;
  const b = raw ? buildRawWhere(name, raw) : buildWhere(name, objCond);
  if (cond && !b) return null;   // 函数条件 → 无法下推 → 走内存
  assertAggSpecs(name, specs);
  const parts = [];
  const caseParams = [];   // _case 的参数（SELECT 里，排在 WHERE 之前）
  Object.keys(specs).forEach(alias => {
    const sp = specs[alias];
    const fn = String(sp.fn || 'SUM').toUpperCase();
    if (fn === 'COUNT' && !sp.col && !sp._case) { parts.push('COUNT(*) AS `' + alias + '`'); return; }
    // 条件计数：SUM(CASE WHEN <白名单条件> THEN 1 ELSE 0 END)
    // 这是「一条 SQL 出多个状态计数」的关键 —— 原来要 4 条 COUNT(*)。
    if (sp._case) {
      // 白名单已在 assertAggSpecs 校验过（那是 SQL 与内存两条路径的共同入口）
      const w = buildWhere(name, sp._case);
      if (!w || !w.sql) {
        throw new Error('_case 条件无法构造 SQL：' + alias +
          '（_case 只支持 对象条件 及其 $in/$ne/$like/$gt/$gte/$lt/$lte 形态）');
      }
      parts.push('SUM(CASE WHEN ' + w.sql + ' THEN 1 ELSE 0 END) AS `' + alias + '`');
      caseParams.push.apply(caseParams, w.params);
      return;
    }
    // 算术表达式：SUM(`A` - `B`)，列名已由 buildExpr 过白名单
    const target = sp._expr ? buildExpr(name, sp._expr) : '`' + sp.col + '`';
    parts.push(fn + '(' + target + ') AS `' + alias + '`');
  });
  if (!parts.length) return null;
  return {
    select: parts.join(', '),
    where: b ? ' WHERE ' + b.sql : '',
    // 参数顺序必须与 SQL 串上占位符的出现顺序一致：SELECT 的 _case 在前，WHERE 在后
    params: caseParams.concat(b ? b.params.slice() : [])
  };
}

/**
 * 把 SQL 聚合结果转成 number；DECIMAL 在驱动层可能返回字符串。
 *
 * ⚠ 【实测踩坑】`run()` 永远返回**数组**，即使 SQL 没有 GROUP BY。
 *     `SELECT COUNT(*) AS c FROM t` 返回的是 `[{c:'349'}]` 而不是 `{c:'349'}`。
 *     所以下面必须先取第一行，不能直接 `r.c`。
 *     （`scalar()` 才是取首行的封装，这里刻意不用它 —— 它对
 *      '2946133.0200000047' 这类值会原样返回字符串。）
 */
function aggNum(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

/** 从 run() 的数组结果里取聚合首行（无 GROUP BY 时） */
function aggRow(r) {
  if (!r) return {};
  return Array.isArray(r) ? (r[0] || {}) : r;
}

/**
 * 算术表达式列（受限支持）
 * --------------------------------
 * 驾驶舱的欠费口径是 `totalAmount - paidAmount > 0.01`，
 * 即 SUM 的对象是**两列相减**，不是单列。buildWhere 表达不了这种条件
 * （它只认「单列 op 值」），强行用函数条件下推会退化成全表载入。
 *
 * 所以允许 spec 写 `_expr: '(A - B)'`，但 A/B **必须都是该表白名单里的数值列**：
 *   - 列名无法参数化，白名单是唯一防线；
 *   - 只允许 `-`（对应唯一的真实需求「两列相减」），不开放 `+ * /`；
 *     开放更多运算符就要考虑优先级、括号、除零等，收益远小于风险。
 *
 * 内存路径用同样规则求值，保证两条路径结果一致。
 */
function buildExpr(name, expr) {
  const m = /^\(\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*-\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\)$/.exec(String(expr || ''));
  if (!m) throw new Error('_expr 只支持 "(`列A` - `列B`)" 形式，收到：' + expr);
  const [, a, b] = m;
  [a, b].forEach(c => {
    if ((COLS[name] || []).indexOf(c) < 0) {
      throw new Error('_expr 中的列不在白名单：' + name + '.' + c);
    }
    if (!isNumericCol(name, c)) {
      throw new Error('_expr 只能对数值列做加减：' + name + '.' + c + ' 不是数值列');
    }
  });
  return m[0];   // 原样返回（含反引号），列名已过白名单
}

/** 内存路径求值同一个表达式 */
function evalExpr(name, expr, row) {
  const sql = buildExpr(name, expr);
  const m = /`([A-Za-z_][A-Za-z0-9_]*)`\s*-\s*`([A-Za-z_][A-Za-z0-9_]*)`/.exec(sql);
  return num(row[m[1]]) - num(row[m[2]]);
}

/**
 * 对象条件的 JS 求值（供内存路径的 `_case` 条件计数使用）。
 *
 * 语义严格对齐 lib/db.js 的 where()（本地版既有实现）：
 *   - 空值（undefined/null/''）视为「不过滤」→ 恒真
 *   - 数组 → IN
 *   - $in / $ne / $like / $gt / $gte / $lt / $lte
 *   - 其他 → 字符串相等（与 db.js 一致，用 String() 比）
 * 两边必须一致，否则会出现「本地算一个数、云端算另一个数」。
 */
function matchCond(row, cond) {
  return Object.keys(cond || {}).every(k => {
    const v = cond[k];
    if (v === undefined || v === null || v === '') return true;
    const rv = row[k];
    if (Array.isArray(v)) return v.map(String).indexOf(String(rv)) >= 0;
    if (typeof v === 'object' && (v.$in !== undefined || v.$ne !== undefined || v.$like !== undefined ||
      v.$gt !== undefined || v.$gte !== undefined || v.$lt !== undefined || v.$lte !== undefined)) {
      if (v.$in !== undefined) return (Array.isArray(v.$in) ? v.$in : [v.$in]).map(String).indexOf(String(rv)) >= 0;
      if (v.$ne !== undefined) return String(rv) !== String(v.$ne);
      if (v.$like !== undefined) return String(rv == null ? '' : rv).indexOf(v.$like) >= 0;
      if (v.$gt !== undefined) return num(rv) > num(v.$gt);
      if (v.$gte !== undefined) return num(rv) >= num(v.$gte);
      if (v.$lt !== undefined) return num(rv) < num(v.$lt);
      if (v.$lte !== undefined) return num(rv) <= num(v.$lte);
    }
    return String(rv) === String(v);
  });
}

/**
 * 受限的原始 WHERE 片段。
 *
 * ⚠ 这是整个聚合层**唯一**能拼裸 SQL 的入口，安全性依赖调用方自觉：
 *   - 片段里的列名必须全部在该表白名单内（逐一校验）；
 *   - 片段里**不允许出现任何引号**（防注入字符串字面量）；
 *   - 不允许分号（防语句拼接）。
 * 满足这三条后，剩下能注入的只有「比较运算符换成别的」，
 * 那是代码 bug 不是安全漏洞，且一切为真/恒假只影响统计数字，不会越权。
 *
 * 【为什么需要它】欠费口径 `(`totalAmount` - `paidAmount`) > 0.01
 * 里的 0.01 是业务阈值（1 分钱以内算已结清），不是用户输入，
 * 用参数化占位符表达反而绕。列名仍走白名单。
 */
function buildRawWhere(name, raw) {
  const s = String(raw || '');
  if (!s) return null;
  if (/['";]/.test(s)) {
    throw new Error('条件片段含非法字符（\' " ;）：' + s);
  }
  // 抽出所有 `col` 逐一校验白名单
  const cols = s.match(/`[A-Za-z_][A-Za-z0-9_]*`/g) || [];
  if (!cols.length) throw new Error('条件片段必须用反引号包裹列名：' + s);
  cols.forEach(q => {
    const c = q.replace(/`/g, '');
    if ((COLS[name] || []).indexOf(c) < 0) {
      throw new Error('条件片段中的列不在白名单：' + name + '.' + c);
    }
  });
  return { sql: s, params: [] };
}

/**
 * 聚合规格校验（内存路径与 SQL 路径共用）。
 *
 * 【为什么要抽成共用函数】
 * 聚合有两条执行路径：走 SQL 下推、命中缓存/函数条件走内存。
 * 两条路径必须对「非法规格」给出**完全相同**的判断，否则会出现
 * 「缓存命中时静默返回 0、缓存未命中时抛异常」的行为差异 ——
 * 而且只在高缓存命中率下复现，现场几乎抓不到。
 */
function assertAggSpecs(name, specs) {
  Object.keys(specs || {}).forEach(alias => {
    const sp = specs[alias];
    if (!sp) throw new Error('agg 规格为空：' + alias);
    const fn = String(sp.fn || 'SUM').toUpperCase();
    if (!/^(SUM|COUNT|AVG|MIN|MAX)$/.test(fn)) {
      throw new Error('agg 不支持的聚合函数：' + fn + '（允许 SUM/COUNT/AVG/MIN/MAX）');
    }
    if (fn === 'COUNT' && !sp.col) return;
    // 条件计数：SUM(CASE WHEN <cond> THEN 1 ELSE 0 END)
    // ⚠ 白名单必须在这里校验（而不是交给 buildWhere 过滤）：
    //   buildWhere 遇到不在白名单的列是**静默丢弃**，全部丢弃时返回 null。
    //   若放行：SQL 侧拼出 `CASE WHEN THEN` → 语法错 → undefined 被 _aggOut 兜成 0，
    //   变成「静默返回 0」，统计数字错却不报错。
    //   而缓存命中时走内存路径、根本不经过 buildWhere，两条路径行为还不一致。
    //   所以在**两条路径的共同入口** assertAggSpecs 里一次性校验干净。
    if (sp._case) {
      const keys = Object.keys(sp._case || {});
      if (!keys.length) throw new Error('_case 条件为空：' + alias);
      const bad = keys.filter(k => (COLS[name] || []).indexOf(k) < 0);
      if (bad.length) {
        throw new Error('_case 条件列不在白名单：' + name + '.' + bad.join(',') +
          '（可用列：' + (COLS[name] || []).join(',') + '）');
      }
      return;
    }
    // 算术表达式：列名由 buildExpr 单独校验（它只允许 `A` - `B` 两列）
    if (sp._expr) { buildExpr(name, sp._expr); return; }
    if ((COLS[name] || []).indexOf(sp.col) < 0) {
      throw new Error('聚合列不在白名单：' + name + '.' + sp.col +
        (name ? '（可用列：' + (COLS[name] || []).join(',') + '）' : ''));
    }
    if (fn !== 'COUNT' && !isNumericCol(name, sp.col)) {
      throw new Error('只能对数值列做 ' + fn + '：' + name + '.' + sp.col + ' 不是数值列');
    }
  });
}

/**
 * 请求级缓存（N+1 根治）——不缓存的表
 * sessions 主键是 token 且高频变动（登录/续期/踢人），缓存易与真实会话脱节，
 * 而它每次请求只查 1 次，缓存收益为 0，所以直接排除。
 */
const NO_CACHE = new Set(['sessions']);

/**
 * N+1 自适应阈值：同一张表在一次请求内被 find 达到这么多次，
 * 就判定为「循环里逐行查关联」，改为整表载入 + 内存查找。
 * 取 5 是权衡结果：单条 SQL 约 195ms，5 次以内直接查库反而更快（省下整表传输）。
 */
const FIND_FLIP = 5;

/**
 * 跨请求共享缓存（只缓存「大表」）。
 *
 * 为什么还需要它：请求级缓存只能省掉「一次请求内」的重复查询。
 * 但列表页每次请求都要重新拉 bills 全表（1228 行，实测 1.7~4 秒），
 * 而 Lambda 只有 30 秒预算 —— 冷启动叠加后合同/账单/工单三个接口直接 502。
 * 实测同一张表在缓存内 page() 耗时 0.00 秒，共享缓存收益极大。
 *
 * 为什么安全：
 *   1. 只缓存「读多写少」的参考数据表（房间/客户/合同/员工/部门岗位角色等），
 *      这些数据一天也未必改一次。
 *   2. 任何写操作（insert/update/remove/replace/clear/insertMany）都会
 *      **同时失效请求级与共享缓存**，所以「改完立刻看到新值」始终成立。
 *   3. TTL 默认 30 秒兜底：即使漏了某条写路径，最多 30 秒后自愈。
 *
 * 想关掉共享缓存：设环境变量 SHARED_CACHE=0。
 */
const SHARED_TABLES = new Set([
  'rooms', 'customers', 'contracts', 'employees', 'depts', 'posts', 'roles',
  'projects', 'buildings', 'meters', 'parking', 'shifts',
  // users：每个已登录请求的鉴权都要 db.find('users', userId)（见 lib/auth.js sessionUserAsync）。
  // users 不在缓存名单时 = 「每请求固定 +1 条 SQL（约 195ms）」。users 表极小、写操作会 _invalidate，
  // 放进永久缓存后鉴权基线从 5 条 SQL（sessions+users+depts+posts+roles）降到 1 条（仅 sessions 实时校验）。
  'users',
  // bills / workorders 虽是大表，但合同与工单列表的 decorate 会对「每一行」执行
  // db.where('bills', b => b.contractId === row.id)。不缓存的话 = 每行拉一次 1228 行全表，
  // 实测合同列表因此 34 秒超时。这里放进共享缓存后首次拉一次、之后 30 秒内复用。
  // 注意：这会占用约 2~4MB 内存，Lambda 完全扛得住。
  // 若将来数据涨到几十万行，请从本名单移除（TTL 到期自然失效，不会脏数据）。
  'bills', 'workorders',
  // 报表/驾驶舱频繁整表拉取的「中小表」：首页要 invoices/deposits/approvals/reminders，
  // 收入台账要 payments/expenses/arrears/parkingItems/otherItems/recharges，
  // HR 待办要 leaves/overtimes。不缓存时每个相关请求都各拉一次全表（合计每请求 1~2MB、十余条 SQL）。
  // 放进共享缓存后：同一实例内首拉一次、30 秒内复用；写操作照旧 _invalidate，不会读到脏值。
  // 这些表都不大（几十~几百 KB），常驻内存成本可忽略。
  // 注意：attendance(3.6MB)/payrolls 走「等值下推」而非缓存（见 lib/hr.js），故不在此列。
  'invoices', 'deposits', 'approvals', 'reminders', 'payments', 'recharges',
  'expenses', 'arrears', 'parkingItems', 'otherItems', 'leaves', 'overtimes',
  // readings（抄表，512KB/2280 行）：收费管理的「抄表记录/表具/用电异常监控」都要按表具扫它。
  // 不缓存时每个相关请求都各拉一次 512KB。放进共享缓存后同一实例 30 秒内复用一次；
  // 抄表录入（写 readings）会 _invalidate，不会读到脏值。
  'readings'
]);

/**
 * 共享缓存开关与 TTL —— 惰性读取。
 * 不能在模块加载时就求值 process.env：lib/env.js（负责读 .env）可能在这之后才 require。
 */
function sharedOn() { return String(process.env.SHARED_CACHE || '1') !== '0'; }
function sharedTtl() {
  const v = Number(process.env.SHARED_CACHE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 30000;
}

/**
 * 「小表永久缓存」名单：这些表一旦载入就常驻，不受 TTL 约束。
 *
 * 【为什么需要这一层 —— single-flight 之外的第二道保险】
 * single-flight 只在「同一时刻的并发」里生效。实测第 4 轮房源列表又冒出 273 条 SQL：
 * 共享缓存 30 秒 TTL 一到，几十个并发 decorate 同时发现缓存空 → 全部穿透。
 * single-flight 把这一波合并成 1 条（已经从 638 降到 283），
 * 但每 30 秒仍会各付一次全表拉取成本。
 *
 * 关键在于这些表**小到离谱**（实测行数）：
 *   buildings 3 行、projects 2 行、depts/posts/roles 各十行以内、customers 23 行
 * 拉它们全表的耗时（80~500ms）跟「重新 SELECT 一下」没区别，
 * 根本不该因为 TTL 到期就重拉 —— 而它们被拉的次数却是最频繁的
 * （房源列表 decorate 每一行都要查 buildings/projects）。
 *
 * 安全性：写操作（insert/update/remove/...）照旧走 _invalidate，
 * 会同时把这类表从缓存里删掉，所以「改完立刻看到新值」依然成立。
 * 唯一的区别只是「没人写的时候不过期」，而不是「写完不更新」。
 */
const PERMANENT_TABLES = new Set([
  'buildings', 'projects', 'depts', 'posts', 'roles', 'shifts', 'settings', 'users'
]);
function permanentOn() { return String(process.env.PERMANENT_CACHE || '1') !== '0'; }

class CloudDB {
  constructor() {
    this.kind = 'tidb';
    this._cache = null;          // Map<table, rows[]>；null 表示当前不在请求上下文
    this._shared = new Map();    // table -> { rows, at }  跨请求共享
    this._flight = new Map();    // table -> Promise<rows[]>  并发去重（single-flight）
  }

  /**
   * 请求开始：开启缓存。
   * 为什么需要这个缓存：
   *   TiDB Cloud Serverless 每次查询都要走公网往返，实测单次 find ≈ 195ms。
   *   而业务代码里有大量「列表循环里逐行查关联」的写法（N+1）——
   *   本地 lib/db.js 是内存读，代价 0；同样的代码在云端会被放大 200 倍。
   *   实测「月表格」单个请求就发了 2049 条 SQL：
   *     contracts 883 次、customers 404 次、rooms 404 次、bills 346 次 → 耗时 222 秒。
   *   Netlify Function 超时只有几十秒，这类接口上云必然 502。
   *
   * 为什么安全：
   *   1. 生命周期严格绑定单次请求（beginRequest/endRequest），不跨请求复用，
   *      所以读到的永远是「本请求开始时的库内快照」，不会读到别人写的脏数据。
   *   2. 写操作（insert/update/remove/insertMany）会同步更新缓存，
   *      保证同一请求内「写完立刻读」能读到新值（账单生成、审批流转都依赖这点）。
   */
  beginRequest() { this._cache = new Map(); this._findHits = new Map(); }

  /** 请求结束：释放缓存，避免 Lambda 实例内存里驻留过期数据 */
  endRequest() { this._cache = null; this._findHits = null; }

  _cached(name) {
    if (!this._cache || NO_CACHE.has(name)) return undefined;
    return this._cache.get(name);
  }
  _setCached(name, rows) {
    if (this._cache && !NO_CACHE.has(name)) this._cache.set(name, rows);
    return rows;
  }
  /**
   * 写操作后让该表缓存失效（下次读回数据库）。
   * 请求级与跨请求共享缓存都要清 —— 否则会出现「改完数据，别的请求仍读到旧值」。
   */
  _invalidate(name) {
    if (this._cache && !NO_CACHE.has(name)) this._cache.delete(name);
    if (this._shared && this._shared.has(name)) this._shared.delete(name);
  }

  /** 读共享缓存（未过期才返回），顺便提升到请求级缓存 */
  _sharedGet(name) {
    if (!sharedOn() || !SHARED_TABLES.has(name) || NO_CACHE.has(name)) return undefined;
    const hit = this._shared.get(name);
    if (!hit) return undefined;
    // 小表永久缓存：不受 TTL 约束（写操作仍会 _invalidate 清掉）
    const forever = permanentOn() && PERMANENT_TABLES.has(name);
    if (!forever && Date.now() - hit.at > sharedTtl()) { this._shared.delete(name); return undefined; }
    this._findHits && this._findHits.set(name, 0);
    return hit.rows;
  }
  _sharedSet(name, rows) {
    if (sharedOn() && SHARED_TABLES.has(name) && !NO_CACHE.has(name)) {
      this._shared.set(name, { rows: rows, at: Date.now() });
    }
    return rows;
  }

  /**
   * 整表载入 —— 全方法唯一真正打网络的地方（single-flight 并发去重）。
   *
   * 【这是列表页 30 秒的第二个根因，也是最隐蔽的一个】
   * 之前的缓存是「查完才写」，而业务代码大量用 Promise.all 并发：
   *   合同列表 20 行 decorate 同时跑，每个都要 db.find('projects') / db.find('customers') /
   *   db.where('bills', ...)。20 个并发在缓存还是空的时候一起穿透，
   *   加上外层嵌套循环，实测一个房源列表请求打出 638 条 SQL：
   *     SELECT * FROM buildings  × 262
   *     SELECT * FROM contracts  × 255
   *     SELECT * FROM customers  × 210
   *     SELECT * FROM bills      × 191
   *   这些表**全都在共享缓存白名单里**，理论上只该查 1 次。
   *
   * single-flight 的作用：同一张表的并发「首次载入」合并成 1 条 SQL，
   * 其余调用 await 同一个 Promise。262 → 1。
   *
   * 为什么安全：合并的只是「同一张表的同一次全量读取」，
   * 语义与串行执行完全等价（本来它们读到的是同一份数据）。
   */
  _loadAll(name) {
    const c = this._cached(name);
    if (c) return Promise.resolve(c);
    const sh = this._sharedGet(name);
    if (sh) { this._setCached(name, sh); return Promise.resolve(sh); }
    // 已有同表的载入在飞 → 直接蹭它，绝不再发第二条 SQL
    const f = this._flight.get(name);
    if (f) return f;

    const p = (async () => {
      const r = await run('SELECT * FROM `' + name + '`', []);
      const rows = (r || []).map(x => decodeRow(name, x));
      this._setCached(name, rows);
      this._sharedSet(name, rows);
      return rows;
    })();
    this._flight.set(name, p);
    // 无论成功失败都要清掉，否则一次失败会让这张表永远返回同一个 rejected Promise
    const clear = () => { if (this._flight.get(name) === p) this._flight.delete(name); };
    p.then(clear, clear);
    return p;
  }

  /**
   * 深拷贝一行。
   * 为什么必须深拷贝：all()/find() 返回的是缓存里的对象引用，
   * 业务代码常做 `row.items.push(...)`、`row.status = 'x'` 这类原地修改。
   * 若只浅拷贝数组（slice），改顶层字段会直接污染缓存 ——
   * 后果是「A 请求临时改一下，B 请求也看到脏数据」，且极难排查。
   * 本地 lib/db.js 每次 load 都重新 JSON.parse，等效天然隔离，
   * 云端要做等价保证就得显式深拷贝。
   */
  _copy(row) {
    if (!row || typeof row !== 'object') return row;
    const o = Array.isArray(row) ? [] : {};
    for (const k of Object.keys(row)) {
      const v = row[k];
      o[k] = (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;
    }
    return o;
  }
  _copyAll(rows) { return rows.map(r => this._copy(r)); }

  async all(name) {
    assertTable(name);
    return this._copyAll(await this._loadAll(name));
  }

  async find(name, id) {
    assertTable(name);
    const pk = pkOf(name);
    if (!COLS[name].includes(pk)) return null;
    // 缓存命中 → 内存查找，0 次网络往返
    const hit = this._cached(name);
    if (hit) {
      for (let i = 0; i < hit.length; i++) {
        if (String(hit[i][pk]) === String(id)) return this._copy(hit[i]);
      }
      return null;
    }
    // 共享缓存命中（同一 Lambda 实例服务多个请求）→ 直接吃，不必等 FIND_FLIP 攒够
    if (SHARED_TABLES.has(name) && this._sharedGet(name)) {
      return (await this._findInCache(name, pk, id));
    }
    // 永久小表（buildings 3 行 / projects 2 行 / depts/posts…）首次触碰就整表载入。
    // 它们体积极小，拉全表和查单行成本一样（约 100ms），但整表载入后
    // 后续所有 find 都走内存、0 次网络往返。不这么做的话，
    // 每个新 Lambda 实例都要为这几次 find 各付一次往返。
    if (permanentOn() && PERMANENT_TABLES.has(name) && !NO_CACHE.has(name)) {
      return (await this._findInCache(name, pk, id));
    }
    // ---- 自适应：判断这张表是不是正被 N+1 反复单查 ----
    // 只查一两次时走单条 SQL 更省（不必把 7000 行的表整份拉下来）；
    // 一旦同一张表在本请求内被查了 FIND_FLIP 次以上，就判定为 N+1 模式，
    // 改为整表载入并缓存，后续全部走内存。
    // 实测依据：月表格里 contracts 被逐行查了 883 次，每次 195ms → 172 秒。
    // 整表载入后 contracts(214 行) 只需约 200ms 一次，后续 882 次全部免网络。
    if (this._findHits && !NO_CACHE.has(name)) {
      const n = (this._findHits.get(name) || 0) + 1;
      this._findHits.set(name, n);
      if (n >= FIND_FLIP) return (await this._findInCache(name, pk, id));
    }
    // 单行查询也要 single-flight：
    // 列表 20 行的 decorate 并发跑，**同一个 id 会被重复查**
    // （例如 20 张账单里 8 张属于同一客户 → 8 条一模一样的 SQL）。
    // 实测账单页 decorate 里有 3 个 find，20 行并发 = 60 条 SQL；
    // 按 id 去重后重复的能合并，实测省掉约 1/3。
    // key 用 name+id：不同 id 各自一条，互不干扰。
    const fk = 'find:' + name + ':' + id;
    const inflight = this._flight.get(fk);
    if (inflight) return inflight;
    const p = (async () => {
      const r = await run('SELECT * FROM `' + name + '` WHERE `' + pk + '` = ? LIMIT 1', [String(id)]);
      return r && r.length ? decodeRow(name, r[0]) : null;
    })();
    this._flight.set(fk, p);
    const clearFk = () => { if (this._flight.get(fk) === p) this._flight.delete(fk); };
    p.then(clearFk, clearFk);
    return p;
  }

  /**
   * 在整表缓存里按主键查找；缓存未命中则先整表载入再找。
   * 注意：这里必须拿到「缓存本体」而不是 all() 返回的副本 ——
   * 否则会把副本塞进请求级缓存，后续 _invalidate / update 的就地同步就失效了。
   */
  async _findInCache(name, pk, id) {
    let arr = this._cached(name) || this._sharedGet(name);
    if (!arr) {
      await this._loadAll(name);          // 并发去重的整表载入
      arr = this._cached(name) || this._sharedGet(name);
      if (this._findHits) this._findHits.set(name, 0);   // 已转缓存，计数归零避免重复触发
    }
    if (!arr) return null;
    for (let i = 0; i < arr.length; i++) {
      if (String(arr[i][pk]) === String(id)) return this._copy(arr[i]);
    }
    return null;
  }

  async where(name, cond) {
    assertTable(name);
    const b = buildWhere(name, cond);
    // 能下推 SQL 且本表未缓存：直接查库（大表条件查询走 SQL 比拉全表划算）
    if (b && !this._cached(name)) {
      const r = await run('SELECT * FROM `' + name + '`' + (b.sql ? ' WHERE ' + b.sql : ''), b.params);
      return (r || []).map(x => decodeRow(name, x));
    }
    // 函数条件（无法下推 SQL）→ 全表缓存 + 内存过滤，语义与本地版 db.js 一致。
    // 性能关键：直接在「缓存本体」上 filter，只对命中的行做深拷贝。
    // 若走 all()（会深拷贝整表 1228 行），合同列表每行都调一次 = 每行拷一次全表，
    // 实测 20 行要 2.3 秒；改成只拷贝命中行后大幅下降。
    if (typeof cond === 'function') {
      const src = this._cached(name) || this._sharedGet(name);
      if (src) return src.filter(cond).map(r => this._copy(r));
      // 未缓存：先把等值条件提取成 SQL WHERE，能下推就别拉全表。
      // 【这是 bills 慢的第三个根因】实测 SELECT * FROM bills（1228 行 / 1.63MB）
      // 单条要 2.4~3.8 秒；而 WHERE period='2026-09' 只回几十行、不到 100ms。
      // 业务里最典型的写法是 db.where('bills', b => b.contractId === row.id)——
      // 合同列表 20 行 decorate 各调一次，不下推就是 20 次全表拉取。
      const eq = extractEq(name, cond);
      if (eq && eq.sql) {
        const r = await run('SELECT * FROM `' + name + '`' + (eq.sql ? ' WHERE ' + eq.sql : ''), eq.params);
        const rows = (r || []).map(x => decodeRow(name, x));
        // 仍需按原函数过滤一遍：提取的只是「充分不必要」的一部分，
        // 剩下的条件（如 b.status !== '作废'）语义不能丢。
        return rows.filter(cond);
      }
      return (await this.all(name)).filter(cond);   // 首次：all 已做过深拷贝
    }    // 其余情况走「全表缓存 + 内存浅匹配」
    const arr = await this.all(name);
    if (!cond) return arr;
    const keys = Object.keys(cond);
    return arr.filter(row => keys.every(k => {
      const v = cond[k];
      if (v === undefined || v === '' || v === null) return true;
      if (Array.isArray(v)) return v.indexOf(row[k]) >= 0;
      if (typeof v === 'function') return v(row[k], row);
      if (typeof v === 'object') {
        const rv = row[k];
        if (v.$in !== undefined) return (Array.isArray(v.$in) ? v.$in : [v.$in]).indexOf(rv) >= 0;
        if (v.$ne !== undefined) return String(rv) !== String(v.$ne);
        if (v.$like !== undefined) return String(rv == null ? '' : rv).indexOf(v.$like) >= 0;
        if (v.$gt !== undefined) return Number(rv) > Number(v.$gt);
        if (v.$gte !== undefined) return Number(rv) >= Number(v.$gte);
        if (v.$lt !== undefined) return Number(rv) < Number(v.$lt);
        if (v.$lte !== undefined) return Number(rv) <= Number(v.$lte);
        return true;
      }
      return String(row[k]) === String(v);
    }));
  }

  async one(name, cond) {
    const arr = await this.where(name, cond);
    return arr[0] || null;
  }

  async insert(name, obj) {
    assertTable(name);
    const pk = pkOf(name);
    const autoId = 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const row = Object.assign({}, obj);
    if (!row[pk]) row[pk] = autoId;
    if (!row.createTime && COLS[name].includes('createTime')) row.createTime = new Date().toISOString();
    const keys = assertCols(name, Object.keys(row));
    if (!keys.length) throw new Error('没有可写入的字段');
    const cols = keys.map(k => '`' + k + '`').join(',');
    const ph = keys.map(() => '?').join(',');
    const vals = keys.map(k => encodeValue(name, k, row[k]));
    try {
      await run('INSERT INTO `' + name + '` (' + cols + ') VALUES (' + ph + ')', vals);
      // 同步进请求级缓存：同一请求内后续读要能看到刚插入的这一行
      const hit = this._cached(name);
      if (hit) { hit.push(row); }
      // 共享缓存也要同步，否则别的请求会读到「插入前」的旧快照（数据正确性问题）
      const sh = this._shared.get(name);
      if (sh) sh.rows.push(row);
      if (hit) return row;
    } catch (e) {
      if (isDuplicate(e)) {                       // 幂等：已存在则改为更新
        const patch = {}; keys.forEach(k => { if (k !== pk) patch[k] = row[k]; });
        await this.update(name, row[pk], patch);
        return this.find(name, row[pk]);
      }
      throw e;
    }
    return row;
  }

  async insertMany(name, list) {
    if (!list || !list.length) return 0;
    assertTable(name);
    const pk = pkOf(name);
    const hasCreateTime = COLS[name].includes('createTime');
    // 分批插入，避免单条 SQL 过长（TiDB Serverless 有请求体大小限制）
    const BATCH = 200;
    let n = 0;
    for (let i = 0; i < list.length; i += BATCH) {
      const slice = list.slice(i, i + BATCH);
      const colsSet = new Set();
      slice.forEach(o => assertCols(name, Object.keys(o)).forEach(k => colsSet.add(k)));
      const keys = Array.from(colsSet);
      const cols = keys.map(k => '`' + k + '`').join(',');
      const ph = keys.map(() => '?').join(',');
      const rows = slice.map(o => {
        const r = Object.assign({}, o);
        if (!r[pk]) r[pk] = 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        if (!r.createTime && hasCreateTime) r.createTime = new Date().toISOString();
        return keys.map(k => encodeValue(name, k, r[k]));
      });
      try {
        await run('INSERT INTO `' + name + '` (' + cols + ') VALUES ' + rows.map(() => '(' + ph + ')').join(','), [].concat.apply([], rows));
        n += slice.length;
      } catch (e) {
        if (!isDuplicate(e)) throw e;
        // 有重复则逐条 upsert
        for (const o of slice) { await this.insert(name, o); n++; }
      }
    }
    // 批量导入后整表内容已变，作废该表缓存
    this._invalidate(name);
    return n;
  }

  async update(name, id, patch) {
    assertTable(name);
    const pk = pkOf(name);
    const keys = assertCols(name, Object.keys(patch)).filter(k => k !== pk);
    if (!keys.length) return this.find(name, id);
    // 注意用 let：下面还要 += 追加 updateTime，const 会在赋值时抛
    //「Assignment to constant variable」（此前一直未暴露，因为旧调用点的 patch 都被上面的提前 return 拦掉了）
    let sets = keys.map(k => '`' + k + '` = ?').join(',');
    const params = keys.map(k => encodeValue(name, k, patch[k]));
    if (COLS[name].includes('updateTime')) {
      sets += ', `updateTime` = ?';
      params.push(new Date().toISOString());
    }
    params.push(String(id));
    await run('UPDATE `' + name + '` SET ' + sets + ' WHERE `id` = ?', params);
    // 两级缓存都要就地改这一行，保证「更新完立刻读」拿到新值
    // （共享缓存若不同步，别的请求会读到更新前的旧值 —— 数据正确性问题）
    [this._cached(name), this._shared.get(name) && this._shared.get(name).rows].forEach(rows => {
      if (!rows) return;
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][pk]) === String(id)) { Object.assign(rows[i], patch); break; }
      }
    });
    return this.find(name, id);
  }

  async remove(name, id) {
    assertTable(name);
    const pk = pkOf(name);
    const r = await run('DELETE FROM `' + name + '` WHERE `' + pk + '` = ?', [String(id)]);
    // 两级缓存都要删掉这一行
    [this._cached(name), this._shared.get(name) && this._shared.get(name).rows].forEach(rows => {
      if (!rows) return;
      const i = rows.findIndex(x => String(x[pk]) === String(id));
      if (i >= 0) rows.splice(i, 1);
    });
    return !!(r && (r.affectedRows || 0) > 0);
  }

  async count(name, cond) {
    assertTable(name);
    // 两级缓存命中时直接内存计数，省一次往返
    const hit = this._cached(name) || this._sharedGet(name);
    if (hit && !cond) return hit.length;
    // 未缓存时：只要「条数」就用 SQL COUNT(*)，绝不为了数个数把整表拉回来。
    // 实测首页 db.count('workorders') 走 where(undefined)→all() 会把 2.3MB 工单表整张载入，
    // 只为得到一个数字。无 cond、或 cond 可下推成 WHERE 时，都改成 SELECT COUNT(*)。
    // 语义与 where().length 完全一致（buildWhere 与 where 用的是同一套下推逻辑）。
    if (!hit) {
      const b = buildWhere(name, cond);
      if (b || !cond) {
        const r = await scalar('SELECT COUNT(*) AS c FROM `' + name + '`' + (b ? ' WHERE ' + b.sql : ''), b ? b.params.slice() : []);
        return Number(r && (r.c !== undefined ? r.c : Object.values(r || {})[0]) || 0);
      }
    }
    const arr = await this.where(name, cond);
    return arr.length;
  }

  /**
   * 条件求和（SQL 侧 SUM）。
   *
   * 语义与 `where(name, cond).reduce((s,r)=>s+num(r[col]), 0)` **完全一致**，
   * 并额外过一道 money() 归一（见 buildAgg 上方【正确性红线】第 2 条）。
   *
   * @param {string} name  表名（白名单）
   * @param {string} col   求和列（必须是 schema.json 里的 numeric 列）
   * @param {object} cond  条件，对象条件走 SQL 下推，函数条件回退内存
   * @param {object} opt   { round:false } 可关闭 money() 归一
   */
  async sum(name, col, cond, opt) {
    assertTable(name);
    assertAggSpecs(name, { s: { col: col, fn: 'SUM' } });   // 缓存路径也必须校验
    opt = opt || {};
    // 与 agg()/groupAgg() 同理：带条件一律走 SQL，不在缓存里复现谓词
    const hit = (!cond) && (this._cached(name) || this._sharedGet(name));
    if (hit) {
      const s = hit.reduce((t, r) => t + num(r[col]), 0);
      return opt.round === false ? s : money(s);
    }
    const b = buildAgg(name, cond, { s: { col: col, fn: 'SUM' } });
    if (!b) {
      const arr = await this.where(name, cond);
      const s = arr.reduce((t, r) => t + num(r[col]), 0);
      return opt.round === false ? s : money(s);
    }
    const r = await run('SELECT ' + b.select + ' FROM `' + name + '`' + b.where, b.params);
    return opt.round === false ? aggNum(aggRow(r).s) : money(aggNum(aggRow(r).s));
  }

  /**
   * 多指标一次性聚合（SQL 侧一条 SQL 出多个数字）。
   *
   * 这是驾驶舱的主力方法：原来 N 个指标要 N 次查询 + N 次 reduce，
   * 现在一次 SELECT 就全出来，且只回一行。
   *
   * @param {string} name
   * @param {object} specs  { 别名: { col, fn:'SUM'|'COUNT'|'AVG'|'MIN'|'MAX' } }
   * @param {object} cond
   * @returns {Promise<object>} { 别名: number }
   */
  async agg(name, specs, cond) {
    assertTable(name);
    const keys = Object.keys(specs || {});
    if (!keys.length) return {};
    // ⚠ 只要带条件（含 _raw 片段），就一律走 SQL —— 即使本表已缓存。
    //   两个原因，缺一不可：
    //   ① 正确性：内存里复现「对象条件 / _raw 条件」要另写一份 JS 谓词，
    //      那份谓词迟早和 SQL 语义漂移（NULL 处理、类型转换、数值比较…），
    //      表现为「缓存命中时数字不一样」这类极难查的 bug。
    //      聚合本身在数据库里算，多一次往返的代价极小，
    //      拿确定的正确性换这点性能不划算。
    //   ② _raw 条件根本不能在内存执行：buildRawWhere 产出的是 SQL 片段，
    //      不是 JS 谓词。若丢给 rows.filter 会 TypeError，
    //      更糟的是被当「无条件」忽略 → 统计成**全表**，数字直接错。
    //   无条件聚合才走缓存（无条件 = 无语义 = 不可能漂移）。
    const hit = (!cond) && (this._cached(name) || this._sharedGet(name));
    if (hit) return this._aggMem(hit, specs, null, name);
    const b = buildAgg(name, cond, specs);
    if (!b) {
      // 函数条件：buildAgg 返回 null，只能内存过滤
      return this._aggMem(await this.where(name, cond), specs, null, name);
    }
    const r = await run('SELECT ' + b.select + ' FROM `' + name + '`' + b.where, b.params);
    return this._aggOut(aggRow(r), specs, keys);
  }

  /**
   * 分组聚合（SQL 侧 GROUP BY）。
   *
   * 驾驶舱的 projects 明细就是典型：原来对每个项目在内存里 filter 一遍
   * rooms 和 contracts（projects.length × 全表扫描），改成一条
   *     SELECT `projectId`, COUNT(*), SUM(`area`) FROM `rooms` GROUP BY `projectId`
   *
   * @param {string} name
   * @param {string} groupCol  分组列（白名单）
   * @param {object} specs     { 别名: { col, fn } }，可用 { col:groupCol, fn:'COUNT' } 统计条数
   * @param {object} cond
   * @returns {Promise<Object>} { 分组值: { 别名: number } }
   */
  async groupAgg(name, groupCol, specs, cond) {
    assertTable(name);
    if ((COLS[name] || []).indexOf(groupCol) < 0) {
      throw new Error('groupAgg 分组列不在白名单：' + groupCol);
    }
    const keys = Object.keys(specs || {});
    // 与 agg() 同理：带条件一律走 SQL，避免内存谓词与 SQL 语义漂移
    const hit = (!cond) && (this._cached(name) || this._sharedGet(name));
    if (hit) return this._groupMem(hit, groupCol, specs, null, name);
    // 注意：GROUP BY 的 key 也要在白名单里（上面已校验 groupCol）
    const b = buildAgg(name, cond, specs);
    if (!b) return this._groupMem(await this.where(name, cond), groupCol, specs, null, name);
    const sql = 'SELECT `' + groupCol + '` AS `_g`, ' + b.select + ' FROM `' + name + '`' +
      b.where + ' GROUP BY `' + groupCol + '`';
    const r = await run(sql, b.params);
    const out = {};
    (r || []).forEach(row => {
      const g = row._g;
      if (g === null || g === undefined) return;
      out[String(g)] = this._aggOut(row, specs, keys);
    });
    return out;
  }

  /** agg 的输出归一：DECIMAL 可能回字符串，COUNT 保持整数 */
  _aggOut(row, specs, keys) {
    const o = {};
    keys.forEach(k => {
      const v = row ? row[k] : undefined;
      // 计数类（COUNT(*) 与 SUM(CASE WHEN …)）都取整，不走 money()。
      // ⚠ 别漏判 _case：它是 SUM(...) 写的，但语义是计数，
      //   若走 money() 会在 SQL/内存两条路径上产生不必要的舍入差异风险。
      const isCount = String(specs[k].fn).toUpperCase() === 'COUNT' || !!specs[k]._case;
      o[k] = isCount ? Math.round(aggNum(v)) : money(aggNum(v));
    });
    return o;
  }

  /**
   * 内存聚合。
   *
   * ⚠ 规格校验必须与 SQL 路径（buildAgg）**完全一致** ——
   *    这是聚合层的正确性红线第 3 条。若内存路径放过非法列、
   *    SQL 路径抛错，就会出现「缓存命中时给结果、缓存未命中时报错」
   *    的诡异行为，而且只在高缓存命中率的场景复现，极难排查。
   */
  _aggMem(rows, specs, cond, table) {
    assertAggSpecs(table, specs);
    const arr = cond ? rows.filter(cond) : rows;
    const keys = Object.keys(specs);
    const o = {};
    keys.forEach(k => {
      const sp = specs[k];
      const fn = String(sp.fn).toUpperCase();
      // 条件计数：与 SQL 的 SUM(CASE WHEN ... THEN 1 ELSE 0 END) 等价
      if (sp._case) {
        o[k] = arr.filter(r => matchCond(r, sp._case)).length;
        return;
      }
      const pick = r => (sp._expr ? evalExpr(table, sp._expr, r) : num(r[sp.col]));
      if (fn === 'COUNT') { o[k] = arr.length; return; }
      if (fn === 'MIN') { o[k] = arr.length ? money(Math.min.apply(null, arr.map(pick))) : 0; return; }
      if (fn === 'MAX') { o[k] = arr.length ? money(Math.max.apply(null, arr.map(pick))) : 0; return; }
      if (fn === 'AVG') { o[k] = arr.length ? money(arr.reduce((s, r) => s + pick(r), 0) / arr.length) : 0; return; }
      o[k] = money(arr.reduce((s, r) => s + pick(r), 0));
    });
    return o;
  }

  _groupMem(rows, groupCol, specs, cond, table) {
    const out = {};
    rows.forEach(r => {
      if (cond && !cond(r)) return;
      const g = r[groupCol];
      if (g === null || g === undefined) return;
      const k = String(g);
      if (!out[k]) out[k] = [];
      out[k].push(r);
    });
    Object.keys(out).forEach(k => { out[k] = this._aggMem(out[k], specs, null, table); });
    return out;
  }

  async page(name, opt) {
    opt = opt || {};
    assertTable(name);
    const where = opt.where;
    const b = buildWhere(name, where);
    // 本表已缓存 → 直接内存分页，省掉 COUNT + SELECT 两次往返
    const hit = this._cached(name);
    if (hit) return this._pageMem(hit, opt);
    // 函数条件无法下推时，走「内存分页」，保证语义与本地版一致
    if (!b && where) {
      const all = await this.all(name);
      return this._pageMem(all, opt);
    }
    let sql = 'SELECT * FROM `' + name + '`' + (b ? ' WHERE ' + b.sql : '');
    const params = (b ? b.params.slice() : []);
    if (opt.sort && (COLS[name] || []).indexOf(opt.sort) >= 0) {
      sql += ' ORDER BY `' + opt.sort + '` ' + (opt.order === 'desc' ? 'DESC' : 'ASC');
    }
    const cnt = await scalar('SELECT COUNT(*) AS c FROM `' + name + '`' + (b ? ' WHERE ' + b.sql : ''), b ? b.params.slice() : []);
    const total = Number(cnt && cnt.c !== undefined ? cnt.c : (cnt && cnt['COUNT(*)']) || 0);
    // ---- LIMIT 判定修正（实测踩到的坑）----
    // 原来写 `if (opt.page && opt.size)`，但前端 URL 常只传 size 不传 page
    //（?size=20），此时 opt.page === undefined → 整条 SQL **不加 LIMIT**，
    // 于是 SELECT * FROM bills ORDER BY period DESC 把 1228 行全表连明细一起传回，
    // 实测单条 8102ms（对比：加 LIMIT 20 只要 81ms）。
    // 正确语义：只要给了 size 就该分页，page 缺省视为第 1 页。
    const sz = Number(opt.size);
    if (Number.isFinite(sz) && sz > 0) {
      const p = Math.max(1, Number(opt.page) || 1);
      sql += ' LIMIT ? OFFSET ?';
      params.push(Math.floor(sz), (p - 1) * Math.floor(sz));
    }
    const r = await run(sql, params);
    return { list: (r || []).map(x => decodeRow(name, x)), total: total };
  }

  _pageMem(rows, opt) {
    let list = rows.slice();
    if (opt.sort) {
      const s = opt.sort, dir = opt.order === 'desc' ? -1 : 1;
      list.sort((a, b) => {
        const va = a[s], vb = b[s];
        if (va === vb) return 0;
        return (va > vb ? 1 : -1) * dir;
      });
    }
    const total = list.length;
    // 与上面 SQL 分支保持同一套 LIMIT 语义（只给 size 也分页，page 缺省第 1 页）
    const sz = Number(opt.size);
    if (Number.isFinite(sz) && sz > 0) {
      const p = Math.max(1, Number(opt.page) || 1);
      list = list.slice((p - 1) * Math.floor(sz), p * Math.floor(sz));
    }
    return { list, total };
  }

  /**
   * 业务流水号：prefix + YYYYMM + 4 位序号
   * 云端要用数据库里的真实最大值来推，避免多端并发下重号
   */
  async nextNo(name, prefix, dateStr) {
    assertTable(name);
    const ym = String(dateStr || new Date().toISOString().slice(0, 10)).replace(/-/g, '').slice(0, 6);
    const like = prefix + ym + '%';
    const cols = COLS[name] || [];
    const codeCol = cols.indexOf('code') >= 0 ? 'code' : (cols.indexOf('no') >= 0 ? 'no' : (cols.indexOf('billNo') >= 0 ? 'billNo' : null));
    if (!codeCol) return prefix + ym + '0001';
    const r = await scalar('SELECT COUNT(*) AS c FROM `' + name + '` WHERE `' + codeCol + '` LIKE ?', [like]);
    const n = Number(r && (r.c !== undefined ? r.c : Object.values(r || {})[0]) || 0) + 1;
    return prefix + ym + String(n).padStart(4, '0');
  }

  /** 覆盖写入（导入/迁移用） */
  async replace(name, arr) {
    assertTable(name);
    const list = Array.isArray(arr) ? arr : [];
    await run('DELETE FROM `' + name + '`', []);
    if (list.length) await this.insertMany(name, list);
    this._invalidate(name);       // 整表覆盖，缓存必须作废
    return list.length;
  }

  async clear(name) {
    assertTable(name);
    await run('DELETE FROM `' + name + '`', []);
    this._invalidate(name);
  }

  async persist() { /* 云端每次写库即落，无需额外 persist */ }

  async stats() {
    const out = {};
    // 只统计已知表，避免为不存在的表报错
    for (const t of META.tables) {
      try {
        const r = await scalar('SELECT COUNT(*) AS c FROM `' + t + '`', []);
        out[t] = Number(r && (r.c !== undefined ? r.c : Object.values(r || {})[0]) || 0);
      } catch (e) { out[t] = -1; }
    }
    return out;
  }
}

module.exports = CloudDB;