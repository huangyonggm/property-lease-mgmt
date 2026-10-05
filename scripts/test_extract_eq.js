// extractEq 下推优化的正确性测试
// 核心红线：提取出来的 SQL WHERE 命中集必须是「原函数命中集的超集」，
// 否则会漏数据。宁可提取不出来（慢），也不能提取错（错）。
const path = require('path');
const ROOT = path.join(__dirname, '..');
require(path.join(ROOT, 'lib', 'env'));

// 从 clouddb 里把 extractEq 抠出来测（同模块内不方便直接导出，先尝试直接取）
const mod = require(path.join(ROOT, 'lib', 'clouddb'));
let extractEq = mod.__extractEq;
if (typeof extractEq !== 'function') {
  console.log('提示：clouddb 未导出 __extractEq，改用源码加载方式');
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'clouddb.js'), 'utf8');
  const start = src.indexOf('function extractEq');
  const end = src.indexOf('\nclass CloudDB');
  const code = src.slice(start, end);
  // 依赖的 COLS / JSONS
  const META = require(path.join(ROOT, 'exports', 'schema.json'));
  const f = new Function('COLS', 'JSONS', 'require', 'path', '__dirname',
    code + '\nreturn extractEq;');
  extractEq = f(META.cols, new Set(META.json), require, path, ROOT);
}

let pass = 0, fail = 0;
function chk(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + '\n      实际 ' + JSON.stringify(got) + '\n      期望 ' + JSON.stringify(want)); }
}
function chkNull(name, got) {
  const ok = got === null;
  if (ok) { pass++; console.log('  ✔ ' + name + '（正确放弃提取）'); }
  else { fail++; console.log('  ✘ ' + name + ' 应放弃提取，实际 ' + JSON.stringify(got)); }
}

console.log('=== ① 必须能提取的简单等值 ===');
chk('b => b.contractId === row.id 的字面量形式',
  extractEq('bills', b => b.contractId === 'ct_001'),
  { sql: '`contractId` = ?', params: ['ct_001'] });
chk('双引号字符串',
  extractEq('bills', b => b.status === '正常'),
  { sql: '`status` = ?', params: ['正常'] });
chk('数字比较',
  extractEq('bills', b => b.crossMonth === 1),
  { sql: '`crossMonth` = ?', params: [1] });
chk('不等',
  extractEq('bills', b => b.status !== '作废'),
  { sql: '`status` <> ?', params: ['作废'] });
chk('函数声明形式',
  extractEq('bills', function (b) { return b.contractId === 'ct_9'; }),
  { sql: '`contractId` = ?', params: ['ct_9'] });
chk('带括号的形参',
  extractEq('bills', (b) => b.period === '2026-09'),
  { sql: '`period` = ?', params: ['2026-09'] });

console.log('\n=== ② 多条件：全部提取 ===');
chk('两个 && 条件',
  extractEq('bills', b => b.contractId === 'c1' && b.status === '正常'),
  { sql: '`contractId` = ? AND `status` = ?', params: ['c1', '正常'] });
chk('一个可提取一个不可提取（只提可提取的）',
  extractEq('bills', b => b.contractId === 'c1' && b.items.length > 0),
  { sql: '`contractId` = ?', params: ['c1'] });

console.log('\n=== ③ 必须拒绝提取的复杂条件 ===');
chkNull('数组 includes', extractEq('bills', b => ['a', 'b'].includes(b.status)));
chkNull('函数调用', extractEq('bills', b => calc(b) === 1));
chkNull('复杂比较表达式', extractEq('bills', b => b.totalAmount - b.paidAmount > 0));
chkNull('多行复杂逻辑', extractEq('bills', b => {
  if (b.status === 'x') return true;
  return b.a === 1;
}));
chkNull('含插值的模板字符串', extractEq('bills', b => b.code === `x${y}`));
chkNull('undefined 比较', extractEq('bills', b => b.status === undefined));
chkNull('变量比较（非字面量）', extractEq('bills', b => b.status === someVar));
chkNull('未知字段', extractEq('bills', b => b.notAColumn === 'x'));
chkNull('嵌套在 || 内部', extractEq('bills', b => b.a === 1 || b.b === 2));

console.log('\n=== ④ 安全性 ===');
// 注意：字面量里的反引号不是注入点 —— 值一律走 ? 参数化，数据库驱动会转义。
// 这里验证的是「列名不可注入」（列名只从 schema 白名单里取，且强制合法标识符）。
const inj = extractEq('bills', b => b.id === "x` OR 1=1--");
const injOk = inj && inj.sql === '`id` = ?' && inj.params[0] === "x` OR 1=1--";
if (injOk) { pass++; console.log('  ✔ 反引号字面量被参数化（值不进 SQL 文本），无注入'); }
else { fail++; console.log('  ✘ 反引号字面量处理异常：' + JSON.stringify(inj)); }
chkNull('列名带空格', extractEq('bills', b => b['id'] === 'x'));

console.log('\n=== ⑤ 关键：超集性质验证（SQL 命中 ⊇ 函数命中）===');
// 用真实数据抽样验证：对一批 cond，比较「内存 filter 结果」与「SQL 下推+再 filter 结果」
const rows = [
  { id: '1', contractId: 'c1', status: '正常', totalAmount: 100, paidAmount: 50 },
  { id: '2', contractId: 'c1', status: '作废', totalAmount: 200, paidAmount: 200 },
  { id: '3', contractId: 'c2', status: '正常', totalAmount: 300, paidAmount: 0 },
  { id: '4', contractId: 'c2', status: '逾期', totalAmount: 400, paidAmount: 100 }
];
const conds = [
  b => b.contractId === 'c1',
  b => b.status !== '作废',
  b => b.contractId === 'c1' && b.status === '正常',
  b => b.contractId === 'c2' && b.status !== '正常',
  b => b.totalAmount > 150 && b.status === '正常',
  b => b.contractId === 'c1' && b.totalAmount - b.paidAmount > 0
];
const names = ['contractId=c1', 'status!=作废', 'c1&正常', 'c2&非正常', 'amount>150&正常', 'c1&有欠款'];
for (let i = 0; i < conds.length; i++) {
  const cond = conds[i];
  const memAns = rows.filter(cond).map(r => r.id);
  const eq = extractEq('bills', cond);
  let sqlAns;
  if (eq && eq.sql) {
    // 内存模拟 SQL：只应用提取出的等值/不等值子句
    const cols = eq.sql.split(' AND ').map(s => s.split(' ')[0].replace(/`/g, ''));
    const ops = eq.sql.split(' AND ').map(s => s.split(' ')[1]);
    const vals = eq.params;
    sqlAns = rows.filter(r => cols.every((c, j) =>
      ops[j] === '=' ? String(r[c]) === String(vals[j]) : String(r[c]) !== String(vals[j])
    )).map(r => r.id);
  } else {
    sqlAns = memAns;
  }
  // 超集校验：SQL 命中集必须包含全部函数命中集（不漏数据）
  const subsetOk = memAns.every(id => sqlAns.includes(id));
  // 最终结果校验：SQL 命中集再过一遍原 cond，必须与内存结果完全一致（不多不少）
  const finalIds = sqlAns.filter(id => cond(rows.find(r => r.id === id))).map(id => id);
  const finalOk = JSON.stringify(finalIds) === JSON.stringify(memAns);
  if (subsetOk && finalOk) { pass++; console.log('  ✔ ' + names[i] + ' → 提取 ' + (eq ? '有' : '无') + '，超集+复检均正确'); }
  else {
    fail++;
    console.log('  ✘ ' + names[i] + ' 超集=' + subsetOk + ' 复检一致=' + finalOk +
      '\n      内存 ' + JSON.stringify(memAns) + ' vs SQL ' + JSON.stringify(sqlAns) +
      ' vs 复检 ' + JSON.stringify(finalIds));
  }
}

console.log('\n=== 结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项 ===');
process.exit(fail ? 1 : 0);
