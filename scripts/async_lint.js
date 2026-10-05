/**
 * async 兼容性静态体检（云端适配的守门人）
 *
 * 背景：lib/db.js 全同步，lib/clouddb.js 全 async。同一套业务代码要同时跑两种存储，
 * 唯一差异就是所有 db.xxx 调用都得 await。云端一旦漏 await，返回的是 Promise，
 * 业务代码当数组/对象用，报错五花八门（.filter is not a function / Cannot read property of undefined）。
 * 这些错只在跑云端时才暴露，所以必须在静态阶段全部揪出来。
 *
 * 能查出的坑：
 *   1. 非 async 函数里出现 await            → 语法错，或 await 静默不生效
 *   2. 同步回调（forEach/map/filter…）里出现 await  → 回调是同步函数，await 无效
 *   3. db.xxx 调用漏了 await                 → 云端拿到 Promise，运行时才炸
 *   4. db.xxx 落在同步回调内                 → 补 await 会语法报错，必须先改结构
 *
 * 用法：
 *   node scripts/async_lint.js          仅体检，列出问题（CI/自检可拦）
 *   node scripts/async_lint.js --fix    给「缺 async 的函数」自动补 async，并打印受影响函数清单
 *
 * --fix 的边界（刻意保守）：
 *   只在函数头加 async 关键字，绝不自动改调用点。
 *   因为「函数变 async 后调用点要不要补 await」取决于返回值是否被使用，必须人判断。
 *   脚本会打印 newlyAsync 清单，照着清单把调用点补齐，然后重跑 --check 确认。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIX = process.argv.includes('--fix');

const FILES = [];
(function walk(dir) {
  fs.readdirSync(dir).forEach(n => {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (n === 'node_modules' || n === 'backups' || n === '.netlify') return; walk(p); }
    else if (n.endsWith('.js')) FILES.push(p);
  });
})(path.join(ROOT, 'lib'));
FILES.push(...fs.readdirSync(path.join(ROOT, 'routes')).filter(n => n.endsWith('.js')).map(n => path.join(ROOT, 'routes', n)));
FILES.push(path.join(ROOT, 'server.js'));

// 会开启一个回调的数组方法：其回调体必须是 async，否则里面的 await 无效
const SYNC_CB = /\.(?:forEach|map|filter|some|every|find|findIndex|reduce|sort|flatMap)\s*\(\s*(?:async\s+)?(?:function|\()/;
const DB_CALL = /\bdb\.(all|one|find|where|insert|update|remove|save|count|nextId|table|page)\s*\(/;
const KEYWORDS = /^(if|for|while|switch|catch|return|typeof|new|function|switch|do|else|await)$/;

const problems = [];
const newlyAsync = [];   // { rel, name, kind, line }

FILES.forEach(file => {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');

  const fnStack = [];    // { name, isAsync, depth, line, kind }
  let depth = 0;

  // 本文件里 async 定义的函数名（用于查「裸调用漏 await」）
  const localAsyncNames = [];
  {
    const re = /^async\s+function\s+([A-Za-z_$][\w$]*)/gm;
    let m2;
    while ((m2 = re.exec(src))) localAsyncNames.push(m2[1]);
  }

  lines.forEach((raw, i) => {
    const line = raw;
    const ln = i + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;

    // 弹出已经闭合的函数上下文
    while (fnStack.length && depth <= fnStack[fnStack.length - 1].depth) fnStack.pop();

    // ---- 识别函数入口 ----
    let m;
    // 注意：`(await db.all('x'))` 这种「赋值给一个看起来像箭头参数的括号」不是函数。
    // 判定要点：箭头参数里不能出现 await，且后面必须紧跟 =>。
    const arrowAssign = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s+)?((?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>)/);
    const looksLikeArrowParam = /\(\s*await\b/.test(line) || /\(\s*\(/.test(line);

    if ((m = line.match(/(?:^|[^\w$.])(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) {
      fnStack.push({ name: m[2], isAsync: !!m[1], depth, line: ln, kind: 'function' });
    } else if ((m = line.match(/^\s*return\s+(async\s+)?function\s*\(([^()]*)\)\s*\{/))) {
      // 工厂返回的闭包：attachUser(db) { return async function (req,res) { ... } }
      // 闭包体是新的函数上下文，是否 async 取决于 return 后有没有 async。
      // 这条必须排在「普通方法」之前：否则同一行会先被 method 规则匹配上，
      // 把闭包体里的 await 误判成在同步函数里（踩过一次）。
      fnStack.push({ name: '<returned-fn>', isAsync: !!m[1], depth, line: ln, kind: 'closure' });
    } else if (arrowAssign && !looksLikeArrowParam) {
      fnStack.push({ name: arrowAssign[1], isAsync: !!arrowAssign[2], depth, line: ln, kind: 'arrow' });
    } else if ((m = line.match(/(?:^|[^\w$.])(static\s+)?(async\s+)?(get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\*?\s*\([^()]*\)\s*\{\s*$/)) &&
               !KEYWORDS.test(m[4])) {
      // 对象方法 / class 方法简写：foo() {  /  async foo() {  /  get url() {
      fnStack.push({ name: m[4], isAsync: !!m[2], depth, line: ln, kind: 'method' });
    } else if (/(?:^|[=(:,]\s*)async\s*\([^()]*\)\s*=>\s*\{\s*$/.test(line)) {
      fnStack.push({ name: '<async-arrow-cb>', isAsync: true, depth, line: ln, kind: 'arrowcb' });
    } else if (/(?:^|[=(:,]\s*)\([^()]*\)\s*=>\s*\{\s*$/.test(line) &&
               !SYNC_CB.test(line)) {
      // 作为参数传入的非 async 箭头：router.get('/x', (req, res) => {
      fnStack.push({ name: '<sync-arrow-cb>', isAsync: false, depth, line: ln, kind: 'arrowcb' });
    }

    // ---- await 的宿主 ----
    // 同一行可能既有回调箭头又有 await，要按位置区分 await 在箭头「前」还是「后」：
    //   const x = (await db.all('t')).filter(r => ..)  → await 在箭头前，属外层
    //   list.forEach(async r => { await f(r) })         → await 在箭头后，属回调
    const arrowAt = line.search(/=>/);
    const awaitAt = line.search(/\bawait\b/);
    if (awaitAt >= 0) {
      const owner = (arrowAt >= 0 && arrowAt < awaitAt) ? fnStack[fnStack.length - 2] : fnStack[fnStack.length - 1];
      if (!owner) problems.push({ rel, ln, type: 'await 出现在任何函数之外', text: trimmed });
      else if (!owner.isAsync) {
        problems.push({ rel, ln, type: '非 async 上下文里出现 await → ' + owner.name + '() [定义于 L' + owner.line + ']', text: trimmed });
        newlyAsync.push({ rel, name: owner.name, kind: owner.kind, line: owner.line });
      }
    }

    // ---- 同步回调 ----
    if (SYNC_CB.test(line)) {
      const isAsync = /async\s+(?:function|\()/.test(line);
      fnStack.push({ name: '<array-callback>', isAsync, depth, line: ln, kind: 'cb' });
    }

    /* ---- 「await f(x).prop」的优先级陷阱 ----
     * 成员访问 .prop 的优先级高于 await，所以
     *   await f(x).list      实际等价于  await (f(x).list)   → Promise 上取属性 = undefined
     *   (await f(x)).list    才是正确写法
     * 症状极隐蔽：接口返回 ok 但 list 是 undefined，前端「暂无数据」，不报任何错。
     */
    {
      const trap = /\bawait\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\([^()]*\)\s*\./g;
      let mt;
      while ((mt = trap.exec(line))) {
        problems.push({ rel, ln, type: 'await 优先级陷阱：`await ' + mt[1] + '(...).` 恒为 undefined，应写成 `(await ' + mt[1] + '(...)).`', text: trimmed });
      }
    }

    /* ---- 本文件内「裸调用」的 async 函数（本模块函数名，不带 A./B. 前缀）----
     * 这类最容易漏：db 检测看不见，check_lib_calls 只查跨模块调用。
     * 典型事故：safeUser 改成 async 后 login() 里忘了 await，
     * 前端拿到 user.menus=[] 与空 perms → 侧边栏全空 + 全部接口 403。
     * 判定条件收紧为「本行 await 了 db 但自身返回值被使用」时才报，避免误报纯计算。
     */
    if (localAsyncNames.length && !DB_CALL.test(line) && /\bawait\s+db\./.test(line)) {
      const re = new RegExp('(?<![A-Za-z0-9_.$])(' + localAsyncNames.join('|') + ')\\s*\\(', 'g');
      let mm;
      while ((mm = re.exec(line))) {
        const before = line.slice(Math.max(0, mm.index - 6), mm.index);
        if (/await\s+$/.test(before)) continue;      // 已 await
        if (/function\s+$/.test(before)) continue;   // 定义处
        problems.push({ rel, ln, type: '本文件 async 函数缺 await: ' + mm[1] + '()', text: trimmed });
      }
    }

    // ---- db.xxx 的 await 情况 ----
    const dbAt = line.search(DB_CALL);
    if (dbAt >= 0) {
      const owner = (arrowAt >= 0 && arrowAt < dbAt) ? fnStack[fnStack.length - 1] : fnStack[fnStack.length - 2];
      const top = fnStack[fnStack.length - 1];
      if (owner && owner.kind === 'cb' && !owner.isAsync) {
        problems.push({ rel, ln, type: 'db 调用落在同步回调内（需改 for...of）: 回调始于 L' + owner.line, text: trimmed });
      } else if (top && top.isAsync) {
        const before = line.replace(/\/\/.*$/, '');
        // 「已正确等待」的判据（任一成立即可）：
        //   await db.x(...)      —— 常规 await
        //   => db.x(...)        —— 直接 return 给调用方
        //   return db.x(...)    —— 同上
        //   then(                —— 在 .then 回调里（外层必然已处理 Promise）
        //   db.x(…)  ,  或  )    —— 出现在数组/实参列表里
        const done = /\bawait\s+db\.|=>\s*db\.|return\s+db\.|then\(|\bdb\.\w+\s*[,)]/.test(before);
        // ⚠ Promise.all([ … ]) 里的 db.xxx 不需要逐个 await ——
        //   Promise.all 本身就等所有元素，漏 await 在这里**不是 bug**。
        //   判据：从本行**往上**找到最近的 `Promise.all(`，
        //   再从那里**往下**数括号是否已配平；未配平说明本行仍在该块内。
        //   （正向追踪而非固定行数窗口：驾驶舱那个 Promise.all 有 20 多行、40 行都不够用，
        //     固定窗口是脆弱的启发式。）
        const inPromiseAll = (() => {
          let start = -1;
          for (let k = 1; k <= 200; k++) {
            const j = i - k;
            if (j < 0) break;
            if (/Promise\.all\s*\(/.test(lines[j])) { start = j; break; }
          }
          if (start < 0) return false;
          // 从 start 开始做括号配平（只数 ( ) 与 [ ]，忽略字符串里的括号）
          let depth = 0, seen = false;
          for (let j = start; j < lines.length; j++) {
            const s = lines[j].replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
            for (let q = 0; q < s.length; q++) {
              const ch = s[q];
              if (ch === '(' || ch === '[') { depth++; seen = true; }
              else if (ch === ')' || ch === ']') { depth--; if (seen && depth <= 0 && j > start) return false; }
            }
            if (j === i) return true;   // 走到本行还没闭合 → 本行在块内
          }
          return true;
        })();
        if (!done && !inPromiseAll) problems.push({ rel, ln, type: 'db 调用缺 await', text: trimmed });
      }
    }

    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
  });
});

// ---- --fix：给缺 async 的函数头补关键字 ----
if (FIX && newlyAsync.length) {
  // 同文件同定义行只补一次（一个函数可能有多处 await）
  const seen = new Set();
  const targets = newlyAsync.filter(f => {
    const k = f.rel + '#' + f.line;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const byFile = {};
  targets.forEach(t => { (byFile[t.rel] = byFile[t.rel] || []).push(t); });

  Object.keys(byFile).forEach(rel => {
    const file = path.join(ROOT, rel);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let n = 0;
    byFile[rel].forEach(t => {
      const idx = t.line - 1;
      if (idx < 0 || idx >= lines.length) return;
      const line = lines[idx];
      if (/\basync\b/.test(line.split('//')[0])) return;   // 已 async

      let fixed = null;
      if (t.kind === 'function') {
        // 在 function 关键字前插入 "async "，保留原有空白（曾把 " function" 写成 "async function"，把空格吞了）
        const at = line.search(/(?:^|[^\w$.])(function\s*\*?\s*[A-Za-z_$][\w$]*)/);
        if (at >= 0) {
          const ins = line.slice(0, at).length - (line[at] === ' ' || line[at] === '\t' ? 1 : 0);
          fixed = line.slice(0, ins) + 'async ' + line.slice(ins);
        }
      } else if (t.kind === 'arrow') {
        // const f = (…) => {   /   const f = x => {
        const at = line.search(/=\s*(?!async\b)((?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>)/);
        if (at >= 0) {
          const eq = line.indexOf('=', at);
          fixed = line.slice(0, eq + 1) + ' async ' + line.slice(eq + 1).replace(/^\s+/, ' ');
        }
      } else if (t.kind === 'method') {
        const m2 = line.match(/^(\s*)((?:static\s+)?(?:get\s+|set\s+)?)([A-Za-z_$][\w$]*\s*\*?\s*\()/);
        if (m2) fixed = m2[1] + m2[2] + 'async ' + m2[3] + line.slice(m2[0].length);
      } else if (t.kind === 'arrowcb') {
        // 参数箭头：(req, res) => {  →  async (req, res) => {
        const idx = line.search(/\([^()]*\)\s*=>\s*\{\s*$/);
        if (idx >= 0 && !/async\s+$/.test(line.slice(Math.max(0, idx - 8), idx))) {
          fixed = line.slice(0, idx) + 'async ' + line.slice(idx);
        }
      }
      if (fixed && fixed !== line) { lines[idx] = fixed; n++; }
    });
    if (n) {
      fs.writeFileSync(file, lines.join('\n'), 'utf8');
      console.log('✔ ' + rel + '  给 ' + n + ' 个函数补了 async');
    }
  });

  console.log('\n--fix 后续必做：');
  console.log('  1) node --check <改过的文件>          确认无语法错');
  console.log('  2) node scripts/async_lint.js        复检剩余问题');
  console.log('  3) 按下面清单把「返回值被使用」的调用点补 await');
  console.log('  4) node scripts/selftest.js <port>   确认本地 167 项零回归\n');
}

if (newlyAsync.length) {
  const uniq = {};
  newlyAsync.forEach(f => {
    const k = f.rel + '::' + f.name;
    if (!uniq[k]) uniq[k] = f;
  });
  console.log('受影响函数（需确认调用点是否要补 await）：');
  Object.keys(uniq).sort().forEach(k => {
    const f = uniq[k];
    console.log('  ' + f.rel + '  ' + f.name + '  (定义 L' + f.line + ', ' + f.kind + ')');
  });
  console.log('');
}

if (!problems.length) {
  console.log('async_lint: 通过，未发现问题');
} else {
  console.log('async_lint: 发现 ' + problems.length + ' 处问题\n');
  const byFile = {};
  problems.forEach(p => { (byFile[p.rel] = byFile[p.rel] || []).push(p); });
  Object.keys(byFile).sort().forEach(rel => {
    console.log('== ' + rel);
    byFile[rel].forEach(p => console.log('  L' + p.ln + '  [' + p.type + ']  ' + p.text));
    console.log('');
  });
  if (!FIX) process.exitCode = 1;
}