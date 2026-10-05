/**
 * 业务库跨模块调用点的 await 检查
 *
 * async_lint 查的是「db.xxx 缺 await」和「await 位置不对」，
 * 但查不出一类更隐蔽的问题：**业务库函数变成 async 后，调用点忘了加 await**。
 * 症状很隐蔽：登录接口返回 "操作失败"、汇总数字全是 0、列表整页空白，
 * 而且本地模式（db 同步）下函数体照常工作，只有切云端才炸。
 *
 * 本脚本的正向清单来自「各 lib 里实际是 async 的导出函数」，
 * 再去 routes/ server.js 里找调用点，看前面有没有 await。
 *
 * 用法：node scripts/check_lib_calls.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// lib 文件 → 在 routes 里通常用的别名
const LIBS = [
  { file: 'lib/billing.js', alias: ['B', 'billing'] },
  { file: 'lib/hr.js', alias: ['H', 'HR', 'hr'] },
  { file: 'lib/income.js', alias: ['I', 'INC', 'income'] },
  { file: 'lib/patrol.js', alias: ['P', 'PAT', 'patrol'] },
  { file: 'lib/dingtalk.js', alias: ['dt', 'DT', 'dingtalk'] },
  { file: 'lib/auth.js', alias: ['A', 'AUTH', 'auth'] },
  { file: 'lib/audit.js', alias: ['audit'] },
  { file: 'lib/crud.js', alias: ['register', 'crud'] }
];

/** 从 lib 文件里抽出 async 函数名（只认「本文件里确实是 async 定义」的） */
function asyncExports(file) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) return [];
  const src = fs.readFileSync(abs, 'utf8');
  const names = new Set();
  // 逐个函数定义判断是否 async，而不是只 grep async 那一行 ——
  // 否则「同名但同步」的函数（income.rentPriceOf / patrol.parseRecords）会被误报。
  const defRe = /^(async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s+)?(?:function|\()/gm;
  let m;
  while ((m = defRe.exec(src))) {
    const isAsync = !!m[1] || !!m[4];
    const name = m[2] || m[3];
    if (isAsync && name) names.add(name);
  }
  return Array.from(names);
}

const SCAN = [];
fs.readdirSync(path.join(ROOT, 'routes')).forEach(n => {
  if (n.endsWith('.js')) SCAN.push('routes/' + n);
});
SCAN.push('server.js');
SCAN.push('netlify/functions/api.js');

const problems = [];
let checked = 0;

LIBS.forEach(lib => {
  const names = asyncExports(lib.file);
  if (!names.length) return;
  SCAN.forEach(rel => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);

    // 确认这个文件真的 import 了这个 lib（拿别名），避免同名误判
    const src = lines.join('\n');
    const usedAliases = lib.alias.filter(a =>
      new RegExp('(?:const|let|var)\\s+' + a + '\\s*=\\s*require\\(').test(src) ||
      new RegExp('\\b' + a + '\\.').test(src)
    );
    if (!usedAliases.length) return;

    lines.forEach((line, i) => {
      usedAliases.forEach(a => {
        const re = new RegExp('(?<![A-Za-z0-9_.$])' + a + '\\.([A-Za-z_$][\\w$]*)\\s*\\(', 'g');
        let m;
        while ((m = re.exec(line))) {
          const fn = m[1];
          if (!names.includes(fn)) continue;
          checked++;
          const before = line.slice(Math.max(0, m.index - 8), m.index);
          const hasAwait = /\bawait\s+$/.test(before);
          // 已显式挂 .catch 的 fire-and-forget（如「推送钉钉失败不阻断审批」）是刻意写法，不算问题
          const tail = line.slice(m.index);
          const fireAndForget = /\.catch\s*\(/.test(tail) || /\.then\s*\(/.test(tail);
          // 审计日志本就旁路，不需要 await
          const discarded = /audit\.\w+\(/.test(line);
          if (!hasAwait && !fireAndForget && !discarded) {
            problems.push({ rel, ln: i + 1, call: a + '.' + fn, text: line.trim() });
          }
        }
      });
    });
  });
});

console.log('检查了 ' + checked + ' 处业务库调用');
if (!problems.length) {
  console.log('check_lib_calls: 通过，全部调用点都已正确 await');
} else {
  console.log('发现 ' + problems.length + ' 处可能缺 await：\n');
  problems.forEach(p => console.log('  ' + p.rel + ' L' + p.ln + '  ' + p.call + '\n      ' + p.text));
  process.exitCode = 1;
}