/**
 * 把「数组方法的回调里含 await」的同步回调改写成串行 / Promise.all
 *
 * 为什么需要：云端 db 全 async，凡是要读库的地方都得 await。
 * 但 forEach/map/filter/some 的回调是同步函数，await 在里面不生效，
 * 运行时表现为「拿到的全是 undefined / Promise，页面空白」。
 * 这类错 node --check 抓得到（await 在非 async 函数里是语法错），
 * 所以可以在静态阶段一次性改干净。
 *
 * 改写规则：
 *   arr.forEach(x => { ...await... })      →  for (const x of arr) { ... }          （return → continue）
 *   arr.map(x => { ...await... })          →  await Promise.all(arr.map(async x => { ... }))
 *   arr.filter(x => { ...await... })       →  人工处理（本脚本不碰，语义要重排）
 *   arr.some/reduce 同理→ 人工处理
 *
 * 只处理「回调体里确有 await」且「回调以 )}); 或 }) 结尾」的简单形态，
 * 复杂的（多语句拼接在单行、嵌套 forEach）留人工，避免瞎改。
 *
 * 用法：node scripts/fix_async_cb.js [--dry]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');

const FILES = [];
(function walk(dir) {
  fs.readdirSync(dir).forEach(n => {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (n === 'node_modules' || n === 'backups' || n === '.netlify') return; walk(p); }
    else if (n.endsWith('.js')) FILES.push(p);
  });
})(path.join(ROOT, 'lib'));
fs.readdirSync(path.join(ROOT, 'routes')).forEach(n => { if (n.endsWith('.js')) FILES.push(path.join(ROOT, 'routes', n)); });
FILES.push(path.join(ROOT, 'server.js'));

let totalChanged = 0;

FILES.forEach(file => {
  let src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const orig = src;
  let changedHere = 0;

  // ---- 规则 1：X.forEach(param => { ... })  →  for (const param of X) { ... } ----
  // 逐个找 `.forEach(` 开头的回调，从回调的 `{` 做括号配对找到闭合 `}`，
  // 若期间含 await 且不是 async 回调，则改写。
  let idx = 0;
  while (true) {
    const fe = src.indexOf('.forEach(', idx);
    if (fe < 0) break;
    const cbStart = fe + '.forEach('.length;
    // 参数：简单标识符
    const pm = /^\s*([A-Za-z_$][\w$]*)\s*=>\s*\{/.exec(src.slice(cbStart));
    if (!pm) { idx = cbStart; continue; }
    const param = pm[1];
    const braceAt = src.indexOf('{', cbStart + pm[0].length - 1);
    if (braceAt < 0) { idx = cbStart; continue; }
    // 找匹配的 }，并确认紧随其后是 )
    const close = matchBrace(src, braceAt);
    if (close < 0) { idx = cbStart; continue; }
    let after = close + 1;
    while (src[after] === ' ' || src[after] === '\t') after++;
    if (src[after] !== ')') { idx = cbStart; continue; }
    const body = src.slice(braceAt, close + 1);
    // 只有含 await 的才改
    if (!/\bawait\b/.test(body)) { idx = after; continue; }
    // 嵌套了 forEach/map 的（body 内再出现同步回调）暂不自动处理，避免误伤
    if (/\.(forEach|map|filter|reduce|some|every|find)\s*\(\s*[A-Za-z_$][\w$]*\s*=>/.test(body)) {
      idx = after; continue;
    }

    // 数组表达式：从 .forEach 往前找到匹配的起始表达式（标识符 / 括号 / 属性链）
    const arrStart = findArrExprStart(src, fe);
    if (arrStart < 0) { idx = after; continue; }
    const arrExpr = src.slice(arrStart, fe);   // 例如 "c.roomIds" 或 "(await db.where(...))"

    // 回调体：return X; → continue;   （forEach 里 return 只是跳过，语义等价）
    let newBody = body;
    // 只把顶层的 return 改成 continue（粗略：行首缩进的 return）
    newBody = newBody.replace(/(\n\s*)return\b/g, '$1continue');

    const replacement = 'for (const ' + param + ' of ' + arrExpr + ') ' + newBody;
    src = src.slice(0, arrStart) + replacement + src.slice(after + 1);
    changedHere++;
    idx = arrStart + replacement.length;
  }

  // ---- 规则 2：X.map(param => { ...await... })  →  await Promise.all(X.map(async param => { ... })) ----
  idx = 0;
  while (true) {
    const me = src.indexOf('.map(', idx);
    if (me < 0) break;
    const cbStart = me + '.map('.length;
    const pm = /^\s*([A-Za-z_$][\w$]*)\s*=>\s*\{/.exec(src.slice(cbStart));
    if (!pm) { idx = cbStart; continue; }
    const param = pm[1];
    const braceAt = src.indexOf('{', cbStart + pm[0].length - 1);
    if (braceAt < 0) { idx = cbStart; continue; }
    const close = matchBrace(src, braceAt);
    if (close < 0) { idx = cbStart; continue; }
    let after = close + 1;
    while (src[after] === ' ' || src[after] === '\t') after++;
    if (src[after] !== ')') { idx = cbStart; continue; }
    const body = src.slice(braceAt, close + 1);
    if (!/\bawait\b/.test(body)) { idx = after; continue; }
    if (/\.(forEach|map|filter|reduce|some|every|find)\s*\(\s*[A-Za-z_$][\w$]*\s*=>/.test(body)) {
      idx = after; continue;
    }

    const arrStart = findArrExprStart(src, me);
    if (arrStart < 0) { idx = after; continue; }
    const arrExpr = src.slice(arrStart, me);

    // 已有 await 前缀？ 避免重复包
    const beforeExpr = src.slice(Math.max(0, arrStart - 8), arrStart);
    const alreadyAwaited = /\bawait\s+$/.test(beforeExpr);

    let newBody = body.replace(/^\{/, '{');   // 保持原样
    // 在回调参数箭头前加 async
    const inner = 'async ' + param + ' => ' + newBody;
    const replacement = (alreadyAwaited ? '' : 'await Promise.all(') + arrExpr + '.map(' + inner + ')' + (alreadyAwaited ? '' : ')');
    src = src.slice(0, arrStart) + replacement + src.slice(after + 1);
    changedHere++;
    idx = arrStart + replacement.length;
  }

  if (src !== orig) {
    totalChanged += changedHere;
    if (DRY) console.log('[dry] ' + rel + '  改写 ' + changedHere + ' 处回调');
    else { fs.writeFileSync(file, src, 'utf8'); console.log('✔ ' + rel + '  改写 ' + changedHere + ' 处回调'); }
  }
});

console.log('\n合计改写 ' + totalChanged + ' 处' + (DRY ? '（dry-run）' : ''));

function matchBrace(src, open) {
  let depth = 0, i = open, quote = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// 从 .forEach 往前找数组表达式的起点
function findArrExprStart(src, dotAt) {
  // 向前跳过空白
  let i = dotAt - 1;
  while (i >= 0 && /\s/.test(src[i])) i--;
  if (i < 0) return -1;
  // 若前面是 )，向前配对找到 (
  if (src[i] === ')') {
    let depth = 0;
    for (let j = i; j >= 0; j--) {
      if (src[j] === ')') depth++;
      else if (src[j] === '(') { depth--; if (depth === 0) { i = j - 1; break; } }
      if (depth === 0 && j < i) { i = j - 1; break; }
    }
    while (i >= 0 && /\s/.test(src[i])) i--;
  }
  // 若前面是标识符/属性链（.foo 或 标识符），向前吃到表达式起点
  while (i >= 0 && /[A-Za-z_$0-9.\]]/.test(src[i])) i--;
  return i + 1;
}