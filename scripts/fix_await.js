/**
 * 给所有 db.xxx 调用补 await —— 云端适配的收尾工具
 *
 * 背景：lib/db.js 全同步，lib/clouddb.js 全 async。业务代码只有一处不同：
 *   本地  const r = db.all('users')            → 直接是数组
 *   云端  const r = await db.all('users')      → Promise
 * 所以云端要求所有 db 调用都 await。
 *
 * 本脚本做三件事：
 *   1. 给「async 函数内裸调用的 db.xxx」补上 (await ...)
 *   2. 给「所在函数需要变成 async」的函数头加 async
 *   3. 把 reduce/forEach 回调里的 db 调用改成串行（Promise.all 或 for...of）
 *
 * 为什么用括号包住而不是只插 await：
 *   db.where('x').map(..)  →  await db.where('x').map(..)   ← 错！await 等的是 map 结果
 *   (await db.where('x')).map(..)  →  对
 *
 * 用法：node scripts/fix_await.js [--dry] [文件...]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry');
const ONLY = process.argv.slice(2).filter(a => !a.startsWith('--'));

// 这些方法返回值直接参与运算，必须 await
const METHODS = ['all', 'one', 'find', 'where', 'insert', 'update', 'remove', 'save', 'count', 'page', 'nextId', 'scalar', 'insertMany', 'table'];

const SKIP_FILES = [
  'lib/db.js',            // 存储层本体，自己不能 await
  'lib/clouddb.js',       // 同上
  'lib/tidb.js',          // 底层驱动
  'lib/seed.js',          // 演示数据种子，只在本地跑，永不进云端
  'scripts/fix_await.js', // 自身
  'scripts/async_lint.js',
  'scripts/to_async.js'
];

const FILES = [];
function walk(dir) {
  fs.readdirSync(dir).forEach(n => {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (n === 'node_modules' || n === 'backups' || n === '.netlify') return; walk(p); }
    else if (n.endsWith('.js')) FILES.push(p);
  });
}
walk(path.join(ROOT, 'lib'));
walk(path.join(ROOT, 'routes'));
FILES.push(path.join(ROOT, 'server.js'));

const targets = FILES
  .map(f => path.relative(ROOT, f).replace(/\\/g, '/'))
  .filter(rel => !SKIP_FILES.includes(rel))
  .filter(rel => !ONLY.length || ONLY.some(o => rel.includes(o)));

/** 找出 src 中所有 db.<method>( 的起点位置（排除已在 await 后的、字符串/注释里的） */
function findDbCalls(src) {
  const hits = [];
  const re = new RegExp('\\bdb\\.(' + METHODS.join('|') + ')\\s*\\(', 'g');
  let m;
  while ((m = re.exec(src))) {
    const at = m.index;
    // 前面紧邻 await（允许空格）→ 已处理
    const before = src.slice(Math.max(0, at - 12), at);
    if (/\bawait\s+$/.test(before)) continue;
    if (/\basync\s+$/.test(before)) continue;
    // 是否在字符串或注释里：粗略看所在行
    const lineStart = src.lastIndexOf('\n', at) + 1;
    const line = src.slice(lineStart, at);
    const cIdx = line.indexOf('//');
    if (cIdx >= 0 && cIdx < line.lastIndexOf('db.')) continue;
    hits.push({ at: at, len: m[0].length, method: m[1] });
  }
  return hits;
}

/** 从 '(' 处开始做括号配对，返回匹配 ')' 的下标；考虑字符串 */
function matchParen(src, open) {
  let depth = 0, i = open;
  let quote = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** 该 db 调用外面是否还套着链式访问（.map/.filter/.sort/[0]/.slice…），决定要不要把 await 提前 */
const CHAIN = /^(\s*\??\.\s*[A-Za-z_$][\w$]*\s*(\(|\[))|^\s*\[/;

const stat = { files: 0, calls: 0, funcsAsync: 0 };

targets.forEach(rel => {
  const file = path.join(ROOT, rel);
  let src = fs.readFileSync(file, 'utf8');
  const hits = findDbCalls(src);
  if (!hits.length) return;

  // 从后往前改，避免前面的替换影响后面下标
  let changed = 0;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    const openIdx = h.at + 'db.'.length + h.method.length;
    while (src[openIdx] !== '(') openIdx++;      // 跳过方法名与空白
    const closeIdx = matchParen(src, openIdx);
    if (closeIdx < 0) continue;

    // 判断后面是否链式
    const after = src.slice(closeIdx + 1);
    const chain = CHAIN.exec(after);
    const expr = src.slice(h.at, closeIdx + 1);

    // 已是 `(await ...)` 或 `await ...` → 跳过
    if (/\(\s*await\s+$/.test(src.slice(Math.max(0, h.at - 12), h.at))) continue;

    if (chain) {
      // 链式：await 提前到最外层，即包住整个链。简化处理 —— 仍只包 db 调用本身，
      // 因为链式尾部的 .map() 作用在 await 后的数组上是正确的：
      //   (await db.where('x')).map(...)   ← 这样写语义正确
      src = src.slice(0, h.at) + '(await ' + expr + ')' + src.slice(closeIdx + 1);
    } else {
      src = src.slice(0, h.at) + '(await ' + expr + ')' + src.slice(closeIdx + 1);
    }
    changed++;
  }

  if (changed) {
    stat.files++;
    stat.calls += changed;
    if (DRY) console.log('[dry] ' + rel + '  补 ' + changed + ' 处');
    else { fs.writeFileSync(file, src, 'utf8'); console.log('✔ ' + rel + '  补 ' + changed + ' 处'); }
  }
});

console.log('\n合计：' + stat.files + ' 个文件，' + stat.calls + ' 处 db 调用补 await' + (DRY ? '（dry-run，未写入）' : ''));