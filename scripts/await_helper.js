/**
 * 给指定文件里的「已知 async helper 调用」补 await。
 *
 * 背景：把某个 helper 从同步改成 async（比如为了把 N+1 次查库合并成一次全量查）之后，
 * 所有调用点都必须补 await。这类改动有 10+ 处，逐个手改容易漏，
 * 用脚本统一处理后再 node --check + selftest 验证。
 *
 * 关键点：正则必须跳过「已经带 await 的」，否则会出现 await await。
 * bash 里内联 node -e 容易被转义吃掉（\s 变 s），所以写成脚本文件执行。
 *
 * 用法：node scripts/await_helper.js routes/hr.js dt pt
 */
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const names = process.argv.slice(3);

if (!file || !names.length) {
  console.error('用法：node scripts/await_helper.js <文件> <helper名...>');
  process.exit(1);
}

const abs = path.isAbsolute(file) ? file : path.join(__dirname, '..', file);
let src = fs.readFileSync(abs, 'utf8');
let n = 0;

names.forEach(name => {
  // 匹配 name(db, xxx) 形式；参数里不含嵌套括号（现有 helper 都是 id/row.deptId 这类）
  const re = new RegExp('(?<![A-Za-z0-9_.$])(' + name + '\\(db,[^()]*\\))', 'g');
  src = src.replace(re, (m, g, off, str) => {
    const before = str.slice(Math.max(0, off - 8), off);
    if (/await\s+$/.test(before)) return m;     // 已带 await
    if (/function\s+$/.test(before)) return m;  // 函数定义处
    n++;
    return 'await ' + g;
  });
});

fs.writeFileSync(abs, src, 'utf8');
console.log(file + '  补 await ' + n + ' 处');