'use strict';
/**
 * 把业务库中依赖 db 的函数改造成 async 版本（云端适配）
 *
 * 背景：本地 lib/db.js 是全同步 API，lib/clouddb.js 是全 async。
 *       业务库（billing/hr/income）混用 db.* 调用，本地跑得通、云端拿到 Promise。
 *
 * 本脚本做两件事（可重复执行，幂等）：
 *   1. 把「函数体内含 db. 读调用」的顶层函数加 async
 *   2. 把全项目对该函数的调用处补 await
 *
 * 手工改容易漏调用点，所以用脚本统一处理并打印改动清单便于复核。
 *
 * 用法：node scripts/to_async.js [--dry]
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// 需要改造的业务库：文件 → 需改 async 的函数名
const TARGETS = {
  'lib/billing.js': ['prevReading', 'usageOf', 'buildBill', 'generateBills', 'generateVacantElectric',
    'allocateSharedElectric', 'pay', 'dailyCollection', 'monthlySummary', 'arrearsList', 'electricAnomaly'],
  'lib/hr.js': ['insurancePolicy', 'summarizeAttendance', 'yearPayrolls', 'buildPayroll',
    'payrollSummary', 'laborCost', 'attendanceOverview'],
  'lib/income.js': ['dailyIncome', 'incomeCodeOf']
};

// 从这些文件里找出调用点，补 await
const CALLER_DIRS = ['routes', 'lib', 'netlify'];
const CALLER_EXTRA_FILES = ['server.js'];

/** 这些文件不在改造范围 */
const SKIP_FILES = [
  'lib/seed.js',        // 演示数据种子，只在本地跑，不进云端
  'scripts/to_async.js' // 自身
];

const DRY = process.argv.indexOf('--dry') >= 0;

function readDirFiles() {
  const out = [];
  CALLER_DIRS.forEach(d => {
    const dir = path.join(ROOT, d);
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(f => {
      const fp = path.join(dir, f);
      if (fs.statSync(fp).isDirectory()) {
        fs.readdirSync(fp).forEach(g => {
          const gp = path.join(fp, g);
          if (fs.statSync(gp).isFile() && g.endsWith('.js')) out.push(gp);
        });
      } else if (f.endsWith('.js')) out.push(fp);
    });
  });
  CALLER_EXTRA_FILES.forEach(f => {
    const fp = path.join(ROOT, f);
    if (fs.existsSync(fp)) out.push(fp);
  });
  return out;
}

let changedFunctions = [];   // {file, fn}
let changedCalls = [];       // {file, line}

const FN_RE_CACHE = {};
function fnNames() {
  const all = new Set();
  Object.keys(TARGETS).forEach(f => TARGETS[f].forEach(n => all.add(n)));
  return Array.from(all).sort((a, b) => b.length - a.length);  // 长名优先，避免前缀误伤
}

const NAMES = fnNames();
/**
 * 匹配调用点。要覆盖三种写法：
 *   fn(db, ...)          —— 直接调用（lib 内部）
 *   B.fn(db, ...)        —— 模块别名调用（routes 里 B=billing / H=hr / I=income / P=patrol）
 *   const r = await fn()
 * 排除：对象方法（obj.fn）、函数声明、require。
 */
const ALT = '([A-Za-z_$][\\w$]*\\s*\\.\\s*)?';
const CALL_RE = new RegExp('(?<![\\w$.])' + ALT + '(' +
  NAMES.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\s*\\(', 'g');

/** 模块别名白名单：B=billing H=hr I=income P=patrol，否则不放行 */
const ALLOWED_ALIAS = ['B', 'H', 'I', 'P', 'billing', 'hr', 'income', 'patrol', 'BIL', 'HR'];

function main() {
  console.log(DRY ? '【试运行，不写文件】' : '开始改造…');

  // 第一步：函数声明加 async
  Object.keys(TARGETS).forEach(rel => {
    const fp = path.join(ROOT, rel);
    let src = fs.readFileSync(fp, 'utf8');
    const fns = TARGETS[rel];
    fns.forEach(fn => {
      const re = new RegExp('(^\\s*)function\\s+' + fn + '\\s*\\(', 'm');
      if (re.test(src)) {
        src = src.replace(re, '$1async function ' + fn + ' (');
        changedFunctions.push({ file: rel, fn });
      }
    });
    if (!DRY) fs.writeFileSync(fp, src, 'utf8');
  });
  console.log('函数声明加 async：' + changedFunctions.length + ' 个');
  changedFunctions.forEach(c => console.log('  ' + c.file + ' → ' + c.fn));

  // 第二步：调用点补 await
  const files = readDirFiles();
  for (const fp of files) {
    const rel = path.relative(ROOT, fp).replace(/\\/g, '/');
    if (SKIP_FILES.indexOf(rel) >= 0) continue;

    /**
     * 只给「本文件确实能拿到定义」的函数加 await。
     * 同名函数跨文件冲突是这类脚本最大的坑 ——
     * patrol.js 里也有个同步的 monthlySummary()，若不校验会被误加 await 直接语法报错。
     *
     * 「能拿到定义」有两种来源：
     *   a) 本文件用 function 声明了该函数
     *   b) 本文件 require 了对应模块，且用的是已知别名（B/H/I/P）
     *      routes/*.js 全是这种形式：const B = require('../lib/billing')
     */
    const src0 = fs.readFileSync(fp, 'utf8');
    const definedHere = new Set();
    for (const n of NAMES) {
      const re = new RegExp('^\\s*(?:async\\s+)?function\\s+' + n + '\\s*\\(', 'm');
      if (re.test(src0)) definedHere.add(n);
    }
    // 找出本文件 require 的业务模块及其别名
    const aliasMap = {};      // 别名 → 模块文件
    const REQ_RE = /const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(['"]([^'"]+)['"]\)/g;
    let rm;
    while ((rm = REQ_RE.exec(src0)) !== null) {
      const alias = rm[1], rel = rm[2].replace(/\\/g, '/');
      const norm = rel.replace(/^\.\.\//, '').replace(/^\.\//, '');
      for (const t of Object.keys(TARGETS)) {
        if (norm === t || norm === t.replace(/^lib\//, 'lib/')) aliasMap[alias] = t;
      }
    }
    const targetsOf = {};    // 模块文件 → 本文件可用的函数名集合
    Object.keys(TARGETS).forEach(t => {
      const names = new Set(definedHere);
      for (const a of Object.keys(aliasMap)) {
        if (aliasMap[a] === t) TARGETS[t].forEach(n => names.add(n));
      }
      targetsOf[t] = names;
    });
    // 本文件到底能用哪些函数：本文件声明的 + 通过别名可达的
    const reachable = new Set(definedHere);
    Object.keys(aliasMap).forEach(a => { TARGETS[aliasMap[a]].forEach(n => reachable.add(n)); });
    let src = src0;
    const orig = src;
    const lines = src.split('\n');

    // 本文件未定义、别名也不可达的函数一律不处理（跨文件同名冲突防护）
    const localNames = NAMES.filter(n => reachable.has(n));
    if (!localNames.length) continue;
    const LOCAL_RE = new RegExp('(?<![\\w$.])' + ALT + '(' +
      localNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\s*\\(', 'g');

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;                 // 注释行跳过
      // 已经是 await 的、async 函数声明的、require 的，跳过
      LOCAL_RE.lastIndex = 0;
      line = line.replace(LOCAL_RE, (m, alias, name, off, str) => {
        const before = str.slice(Math.max(0, off - 14), off);
        if (/await\s+$/.test(before)) return m;                       // 已有 await
        if (/function\s+$/.test(before)) return m;                    // 函数声明
        if (/require\s*\(\s*$/.test(before)) return m;
        // 带模块别名的必须确认别名合法，避免把 obj.method 误加 await
        if (alias) {
          const a = alias.replace(/\s*\.\s*$/, '').trim();
          if (ALLOWED_ALIAS.indexOf(a) < 0) return m;
          return 'await ' + m;
        }
        return 'await ' + m;
      });
      if (line !== lines[i]) {
        changedCalls.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 70) });
      }
      lines[i] = line;
    }
    src = lines.join('\n');
    if (src !== orig && !DRY) fs.writeFileSync(fp, src, 'utf8');
  }
  console.log('调用点补 await：' + changedCalls.length + ' 处');
  const byFile = {};
  changedCalls.forEach(c => { byFile[c.file] = (byFile[c.file] || 0) + 1; });
  Object.keys(byFile).sort().forEach(f => console.log('  ' + f + '  ' + byFile[f] + ' 处'));

  console.log(DRY ? '试运行结束（未写文件）' : '完成。下一步必须跑 require 校验 + 完整自检。');
}

main();