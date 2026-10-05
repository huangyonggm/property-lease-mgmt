/* 巡更检查小工具「完整复制」回归测试
 * 覆盖 2026-10-04 用户反馈的三个缺口：
 *   ① 夜班时段可配（原 ui.py:79-95 有输入框，我方初版硬编码 18:30/06:30）
 *   ② 时段口径贯穿所有接口（records/daily/monthly/overview/export/mine）
 *   ③ 「导出遗漏明细」独立能力（原 analysis.get_missed_detail + 独立按钮）
 * 以及权限/导入相关的前后端一致性。
 *
 * 运行：DB_MODE=local node scripts/test_patrol_window.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; fails.push(name + (extra ? ' → ' + extra : '')); console.log('  ✘ ' + name + (extra ? ' → ' + extra : '')); }
}
function eq(name, a, b) { ok(name, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function section(t) { console.log('\n' + t); }

/* ============ 1. lib/patrol.js 时段参数化 ============ */
section('[1] lib/patrol.js · 夜班时段参数化');
const P = require('../lib/patrol');

eq('默认时段 18:30 起', P.NIGHT_START_MIN, 18 * 60 + 30);
eq('默认时段 06:30 止', P.NIGHT_END_MIN, 6 * 60 + 30);

const w1 = P.resolveWindow(null);
ok('resolveWindow(null) 不抛异常', !!w1);
ok('resolveWindow(null) 回退默认', w1.startMin === P.NIGHT_START_MIN && w1.endMin === P.NIGHT_END_MIN);
ok('回退对象字段齐全（startH/startM/endH/endM）',
  typeof w1.startH === 'number' && typeof w1.startM === 'number' &&
  typeof w1.endH === 'number' && typeof w1.endM === 'number');
ok('typeof null 不穿透到对象分支（回归 #9）', P.resolveWindow(undefined).startMin === P.NIGHT_START_MIN);
ok('resolveWindow("") 回退默认', P.resolveWindow('').startMin === P.NIGHT_START_MIN);

const w2 = P.resolveWindow({ start: '20:00', end: '08:00' });
eq('自定义时段 20:00 起', w2.startMin, 20 * 60);
eq('自定义时段 08:00 止', w2.endMin, 8 * 60);
eq('windowText 展示', P.windowText(w2), '20:00 ~ 次日 08:00');

const w3 = P.resolveWindow({ startH: 19, startM: 0, endH: 7, endM: 0 });
eq('兼容 {startH,startM,endH,endM} 传法', w3.startMin, 19 * 60);

ok('非法值回退默认（越界小时）', P.resolveWindow({ start: '99:99', end: '' }).startMin === P.NIGHT_START_MIN);
ok('起止相同回退默认', P.resolveWindow({ start: '18:30', end: '18:30' }).endMin === P.NIGHT_END_MIN);

/* 班次归属：同一批记录在不同时段下结果不同 */
function rec(t) { return { timeAt: new Date(t).getTime(), time: t }; }
const R1 = rec('2026-07-10 19:00:00');   // 默认 18:30 起 → 7-10 夜班
const R2 = rec('2026-07-11 05:00:00');   // 默认 06:30 止内 → 7-10 夜班
const R3 = rec('2026-07-11 07:00:00');   // 默认口径是白班；改 08:00 止后变成 7-10 夜班
eq('默认时段 19:00 归 7-10 夜班', P.assignShiftDate(R1), '2026-07-10');
eq('默认时段次日 05:00 归 7-10 夜班', P.assignShiftDate(R2), '2026-07-10');
eq('默认时段 07:00 判白班', P.assignShiftDate(R3), null);
eq('时段改 08:00 后 07:00 归 7-10 夜班', P.assignShiftDate(R3, P.resolveWindow({ start: '18:30', end: '08:00' })), '2026-07-10');
ok('isNight 随参数变化', P.isNight(R3) === false && P.isNight(R3, P.resolveWindow({ start: '18:30', end: '08:00' })) === true);

eq('defaultWindowText 常量', P.defaultWindowText, '18:30 ~ 次日 06:30');

/* analyze 全链路：时段确实影响漏检结果 */
const PTS = [
  { code: 'P1', name: '东门', sortKey: '1' },
  { code: 'P2', name: '西门', sortKey: '2' }
];
const RECS = [
  Object.assign(rec('2026-07-10 19:00:00'), { pointCode: 'P1', pointName: '东门', person: '夜班-甲' }),
  Object.assign(rec('2026-07-11 05:00:00'), { pointCode: 'P1', pointName: '东门', person: '夜班-甲' }),
  Object.assign(rec('2026-07-11 07:00:00'), { pointCode: 'P2', pointName: '西门', person: '夜班-甲' })
];
const aDef = P.analyze({ points: PTS, records: RECS, start: '2026-07-10', end: '2026-07-11', mode: 'night', window: P.resolveWindow(null) });
const aExt = P.analyze({ points: PTS, records: RECS, start: '2026-07-10', end: '2026-07-11', mode: 'night', window: P.resolveWindow({ start: '18:30', end: '08:00' }) });
eq('默认口径 7-10 夜班实巡 1 个点', aDef.daily[0].totalActual, 1);
eq('默认口径 7-10 夜班漏检 1 个点', aDef.daily[0].totalMissed, 1);
eq('时段延长后 7-10 夜班实巡 2 个点', aExt.daily[0].totalActual, 2);
eq('时段延长后 7-10 夜班漏检 0 个点', aExt.daily[0].totalMissed, 0);
eq('analyze 回传 windowText', aExt.windowText, '18:30 ~ 次日 08:00');
ok('不带 window 时不回归默认口径', P.analyze({ points: PTS, records: RECS, start: '2026-07-10', end: '2026-07-11', mode: 'night' }).daily[0].totalMissed === 1);

/* ============ 2. 路由层：windowOf 解析与各端点透传 ============ */
section('[2] routes/patrol.js · 时段解析与端点透传');
const fs = require('fs');
const rsrc = fs.readFileSync(path.join(ROOT, 'routes', 'patrol.js'), 'utf8');

ok('存在 windowOf 集中解析函数', /function windowOf\s*\(src\)/.test(rsrc));
ok('windowOf 兼容 windowStart/nightStart 两种命名', /windowStart \|\| q\.nightStart/.test(rsrc) && /windowEnd \|\| q\.nightEnd/.test(rsrc));

// 所有 P.analyze 调用点都要带 window
const analyzeCalls = rsrc.match(/P\.analyze\(\{[\s\S]*?\}\)/g) || [];
ok('P.analyze 调用点数量 = 5（analyze/daily/monthly/overview/export）', analyzeCalls.length === 5, 'got=' + analyzeCalls.length);
ok('全部 P.analyze 调用均透传 window', analyzeCalls.every(c => /window:\s*windowOf\(|window:\s*win\b/.test(c)),
  analyzeCalls.filter(c => !/window:/.test(c)).length + ' 个缺 window');

// 所有 assignShiftDate 调用点都要传 win
const shiftCalls = rsrc.match(/P\.assignShiftDate\([^)]*\)/g) || [];
ok('assignShiftDate 调用均传时段参数', shiftCalls.every(c => /,\s*win\s*\)/.test(c)),
  shiftCalls.filter(c => !/,\s*win\s*\)/.test(c)).join(' | '));

ok('/api/patrol/records 端点用 windowOf', /api\/patrol\/records[\s\S]{0,400}windowOf\(q\)/.test(rsrc));
ok('/api/patrol/mine 端点用 windowOf', /api\/patrol\/mine[\s\S]{0,400}windowOf\(req\.query\)/.test(rsrc));

/* ============ 3. 遗漏明细导出能力 ============ */
section('[3] 遗漏明细导出（对齐 get_missed_detail）');
ok('定义遗漏明细公共表头 M_MISS_HEADERS', /M_MISS_HEADERS\s*=\s*\[/.test(rsrc));
ok('定义 missedDetailRows 行构造函数', /function missedDetailRows\s*\(daily\)/.test(rsrc));
ok('存在 type=missed 独立导出分支', /type === 'missed'/.test(rsrc));
ok('月报导出附带「遗漏明细」表', /name:\s*'遗漏明细'/.test(rsrc));
ok('单日导出「遗漏汇总」复用公共表头', /name:\s*'遗漏汇总',\s*headers:\s*M_MISS_HEADERS/.test(rsrc));

const vsrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views5.js'), 'utf8');
ok('月报页有「导出遗漏明细 Excel」按钮', /data-expm/.test(vsrc));
ok('月报页展示遗漏明细卡片', /遗漏明细（'/.test(vsrc));

/* ============ 4. 前端时段配置 UI ============ */
section('[4] 前端 · 夜班时段可配');
ok('winHTML 生成时段输入控件', /function winHTML\(\)/.test(vsrc));
ok('winQS 生成 windowStart/windowEnd query', /windowStart=/.test(vsrc) && /windowEnd=/.test(vsrc));
ok('winQS 支持首参场景补 ?（回归：曾拼成 overview&windowStart=… 导致返回解析失败）',
  /return prefix \? '\?' \+ s : '&' \+ s;/.test(vsrc));
ok('overview 用 winQS(true) 传首参', /GET\('\/api\/patrol\/overview' \+ winQS\(true\)\)/.test(vsrc));
// 凡是「路径后直接拼 winQS() 且前面已有 ?」的调用，必须用 winQS()（& 前缀）；
// 若路径后没有 ? 则必须 winQS(true)。这里做一次粗筛防拼错。
const concatCalls = vsrc.match(/GET\('([^']+)'\s*\+\s*winQS\(([^)]*)\)/g) || [];
ok('GET+winQS 调用共 2 处（overview 概览 + patrolDefaults）', concatCalls.length === 2, 'got=' + concatCalls.length);
ok('GET+winQS 调用参数自洽（前导?与 prefix 匹配）', concatCalls.every(c => {
  const m = c.match(/GET\('([^']+)'\s*\+\s*winQS\(([^)]*)\)/);
  const path = m[1], arg = m[2].trim();
  const hasQ = path.indexOf('?') >= 0;
  return hasQ ? arg === '' : arg === 'true';
}), concatCalls.join(' | '));
// 其余带 ? 的请求（daily/monthly/records）在 URL 里手写 windowStart/End 或拼在末尾
// winQS 调用形式统计：无参 = & 前缀（用于路径已带 ? 的场景），带 true = ? 前缀（首个参数）
const allCalls = vsrc.match(/winQS\((true)?\)/g) || [];
const bare = allCalls.filter(c => c === 'winQS()').length;
const withTrue = allCalls.filter(c => c === 'winQS(true)').length;
ok('winQS 无参调用 8 处（daily/monthly/records + 6 个导出链接）', bare === 8, 'got=' + bare);
ok('winQS(true) 调用 2 处（overview 的两处请求）', withTrue === 2, 'got=' + withTrue);
ok('winQS 调用总数自洽', allCalls.length === bare + withTrue);
ok('winQS 定义处支持 prefix 形参', /function winQS\(prefix\)/.test(vsrc));
ok('setWin 写入 localStorage', /localStorage\.setItem\(WIN_KEY/.test(vsrc));
ok('bindWin 绑定「应用」按钮', /function bindWin\(scope, after\)/.test(vsrc));
ok('时段改动后清空概览缓存（口径变了默认日期要重取）', /function setWin[\s\S]{0,400}bustDefaults\(\)/.test(vsrc));

const winUsages = (vsrc.match(/winQS\(\)/g) || []).length;
ok('winQS 在多处请求透传（≥6 处）', winUsages >= 6, 'got=' + winUsages);
ok('巡更点位页也保留导入入口', /导入点位表（含人员卡）/.test(vsrc));

/* 导入区必须置顶（用户 2026-10-04 要求） */
const ovStart = vsrc.indexOf('async function renderOverview(box)');
const ovEnd = vsrc.indexOf('/* ==================== 2. 巡更点位');
const ov = vsrc.slice(ovStart, ovEnd);
const ovImp = ov.indexOf('data-imp="points"');
ok('概览页存在导入区', ovImp >= 0);
ok('导入区在概览页最顶端（早于时段条与巡更概况指标卡）',
  ovImp >= 0 && ovImp < ov.indexOf('winHTML()') && ovImp < ov.indexOf('巡更概况'));
ok('导入区只出现一次（移动后底部不再重复渲染）',
  (ov.match(/data-imp="points"/g) || []).length === 1);
ok('导入区带 card-head 说明支持格式', /数据导入（支持 \.xls \/ \.xlsx \/ \.csv/.test(ov));
ok('点位页导入条用 insertBefore 置顶', /box\.insertBefore\(bar, box\.firstChild\)/.test(vsrc));
ok('巡查记录页带时段', vsrc.indexOf("'shift=' + encodeURIComponent(st.shift)") >= 0 &&
  vsrc.indexOf("'windowStart=' + encodeURIComponent(win().start)") >= 0);

/* ============ 5. 权限固化回归（IIFE 顶层求值） ============ */
section('[5] 权限固化 bug 回归防护');
ok('CAN 改为 getter 惰性求值', /get import\(\)\s*\{\s*return zapPerm\('patrol:import'\)/.test(vsrc));
ok('CAN 顶部有中文注释说明原因', /必须惰性求值/.test(vsrc));
// 只看非注释行，避免误伤解释「为什么不能这么写」的注释示例
const codeLines = vsrc.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
ok('非注释代码里不再出现顶层固化写法',
  !codeLines.some(l => /const CAN\s*=\s*\{\s*import:\s*zapPerm/.test(l)));

const seed = fs.readFileSync(path.join(ROOT, 'lib', 'seed.js'), 'utf8');
ok('总经理角色显式补 patrol:import', /patrol:import/.test(seed));
ok('总经理角色显式补 patrol:analyze', /patrol:analyze/.test(seed));
ok('总经理角色显式补 patrol:export', /patrol:export/.test(seed));

/* ============ 6. 原工具 5 项功能逐项核对 ============ */
section('[6] 原小工具 5 项功能移植核对');
const pj = P;
ok('① 导入巡更点位表（parsePoints）', typeof pj.parsePoints === 'function');
ok('② 导入巡查记录表（parseRecords）', typeof pj.parseRecords === 'function');
ok('③ 设置月份（analyze 起止）', typeof pj.analyze === 'function' && /monthlySummary/.test(Object.keys(pj).join(',')));
ok('④ 分析漏检（missedPoints/totalMissed）',
  /totalMissed/.test(JSON.stringify(pj.analyze({ points: [], records: [], start: '2026-01-01', end: '2026-01-02', mode: 'night' }))) ||
  typeof pj.dailyReport === 'function');
const typeBranches = rsrc.match(/type === '[a-z]+'/g) || [];
['records', 'daily', 'monthly', 'missed'].forEach(t => {
  ok('⑤ 导出 Excel 支持 type=' + t, typeBranches.indexOf("type === '" + t + "'") >= 0);
});

/* ============ 7. 双格式兼容（3月设备原始表 / 7月标准表） ============ */
section('[7] 两种月份表格格式自动识别（2026-10-04 用户反馈「3月巡更记录导入不能识别」）');
const XLS = require('../lib/xls');
const fMar = 'Y:/物业实际使用的报表及合同/3月巡更记录(3).xls';
const fJul = 'Y:/物业实际使用的报表及合同/维序巡查记录7月.xls';
const haveReal = fs.existsSync(fMar) && fs.existsSync(fJul);

/* --- 7.1 根因 1：RK 浮点字节序 --- */
eq('rkValue 整数路径：1 编码为 (1<<2)|2', XLS.rkValue((1 << 2) | 0x02), 1);
eq('rkValue 整数路径：123 编码为 (123<<2)|2', XLS.rkValue((123 << 2) | 0x02), 123);
// BIFF 的 RK 浮点分支（fInt=0）：剩下 30 位是 IEEE754 double 的「高 32 位」，
// 必须写进 double 的 offset 4。修复前写到了 offset 0，日期序列号 46128.587
// 被读成 5.379e-315，序号列整列变垃圾 → parseRecords 判定「序号非法」→ 0 条入库。
//
// 【挑选样本的坑】不能随便拿一个高 32 位来测：
//   double 46128.5625 的高 32 位是 0x40E68612，而 0x12 的 bit1=1 ——
//   这个编码在 RK 语义里其实是**整数**（1088849426/4），走的是整数分支。
//   必须把低 2 位标志位掩掉（& 0xFFFFFFFC）才是合法的浮点 RK 编码。
//   另外十六进制字面量 > 0x7FFFFFFF 时要 `| 0` 转有符号 32 位再传进去。
// 【精度说明】RK 浮点只存 double 的高 32 位，低 32 位在格式里就是 0，
// 所以还原值必然是「按 32 位截断」后的结果：46128.5625 → 46128.5。
// 这是 BIFF 格式的固有限制，不是解码 bug。断言按截断后的值写。
function floatRk(doubleVal) {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(doubleVal, 0);
  return ((b.readUInt32LE(4) & 0xFFFFFFFC) | 0);
}
eq('rkValue 浮点路径：46128.5625 还原为 32 位精度值 46128.5',
  XLS.rkValue(floatRk(46128.5625)), 46128.5);
eq('rkValue 浮点路径：3月表真实日期 46128.4785 → 46128.375',
  XLS.rkValue(floatRk(46128.47850110502)), 46128.375);
ok('RK 浮点写在 double 高 4 字节（曾整体读成 5.29e-315）',
  Math.abs(XLS.rkValue(floatRk(46128.5625)) - 46128.5) < 0.01);
ok('RK 垃圾值已消除：不再出现 1e-315 量级', XLS.rkValue(floatRk(46128.5625)) > 1);
eq('RK cent 标志 = 结果除以 100（存 1.00 还原成 100）', XLS.rkValue((100 << 2) | 0x02 | 0x01), 1);
eq('RK cent 标志：存 0.01 还原成 1', Math.round(XLS.rkValue((1 << 2) | 0x02 | 0x01) * 100), 1);

/* --- 7.2 根因 2：多 Sheet 取最大表 --- */
const xsrc = fs.readFileSync(path.join(ROOT, 'lib', 'xls.js'), 'utf8');
const pw = xsrc.slice(xsrc.indexOf('function parseWorkbook'), xsrc.indexOf('function unzip'));
ok('parseWorkbook 取行数最多的表作主表（与 parseXlsx 一致）',
  /s\.rows\.length > main\.rows\.length/.test(pw));
ok('parseWorkbook 暴露 sheetNames（前端可提示「本文件有 N 个工作表」）',
  /sheetNames:\s*out\.map/.test(pw));
ok('parseWorkbook 暴露完整 sheets 数组', /sheets:\s*out/.test(pw));

/* --- 7.3 根因 3：表头别名 + 无表头推断 --- */
ok('记录表支持「地点名称」别名', P.REC_ALIASES.name.indexOf('地点名称') >= 0);
ok('记录表支持「地点编码」别名', P.REC_ALIASES.code.indexOf('地点编码') >= 0);
ok('记录表支持「巡检员」别名', P.REC_ALIASES.person.indexOf('巡检员') >= 0);
ok('记录表支持「巡检时间」别名', P.REC_ALIASES.time.indexOf('巡检时间') >= 0);
ok('matchHeader 完全相等优先（「巡检时间」不会被「时间」抢走）', P.matchHeader('巡检时间') === 'time');
ok('matchHeader 支持带括号后缀', P.matchHeader('巡检时间(必填)') === 'time');
ok('matchHeader 认地点名称', P.matchHeader('地点名称') === 'name');
ok('matchHeader 认巡检员', P.matchHeader('巡检员') === 'person');
ok('inferRecordColumns 已导出（无表头兜底）', typeof P.inferRecordColumns === 'function');

/* 无表头场景：把表头行删掉，仍要能推出时间/编码/名称/人员列 */
const noHeader = [
  ['1', '008D9066', '31楼茶水间', '2026-03-01 05:11:32', '余明辉'],
  ['2', '008C65D6', '30楼茶水间', '2026-03-01 05:11:59', '余明辉'],
  ['3', '008CACF0', '30楼卫生间', '2026-03-01 05:12:20', '余明辉'],
  ['4', '008CB328', '30楼南侧', '2026-03-01 05:13:02', '余明辉'],
  ['5', '008C8F9D', '29楼茶水间', '2026-03-01 05:14:11', '余明辉']
];
const inf = P.parseRecords(noHeader);
ok('无表头也能推断出 5 条记录', inf.records.length === 5, 'got=' + inf.records.length);
ok('无表头走 inferred 模式', inf.mode === 'inferred', 'got=' + inf.mode);
ok('无表头时时间列推断正确', inf.records[0] && inf.records[0].time === '2026-03-01 05:11:32',
  JSON.stringify(inf.records[0]));
ok('无表头时编码列推断正确', inf.records[0] && inf.records[0].pointCode === '008D9066');
ok('无表头时名称列推断正确', inf.records[0] && inf.records[0].pointName === '31楼茶水间');
ok('无表头时人员列推断正确', inf.records[0] && inf.records[0].person === '余明辉');

/* 一列不能兼两职（3月无「巡检器」列，device 曾被写成序号） */
const devLess = P.parseRecords([
  ['序号', '地点名称', '地点编码', '巡检时间', '巡检员'],
  ['1', '31楼茶水间', '008D9066', '2026-03-01 05:11:32', '余明辉'],
  ['2', '30楼茶水间', '008C65D6', '2026-03-01 05:11:59', '余明辉']
]);
eq('缺「巡检器」列时 device 置空而非串到序号列', devLess.records[0].device, '');
eq('缺「巡检器」列时序号仍正确', devLess.records[0].seq, 1);
eq('缺「巡检器」列时编码仍正确', devLess.records[0].pointCode, '008D9066');

/* 点位表：两种格式 */
const ptStd = P.parsePoints([
  ['序号', '卡号', '类型', '名称', '备注', '路线编号', '路线内顺序'],
  ['1', '0006599946', '地点卡', '19设备房', '', '', ''],
  ['2', '0004854438', '地点卡', '18F东面步梯间', '', '', ''],
  ['3', '0008539572', '人员卡', '夜班-何南', '', '', '']
]);
eq('标准点位表：2 个地点卡', ptStd.points.length, 2);
eq('标准点位表：1 张人员卡', ptStd.persons.length, 1);
eq('人员卡班次识别', ptStd.persons[0].shift, '夜班');
const ptDev = P.parsePoints([
  ['序号', '地点名称', '地点编码', '空闲/否', '备注'],
  ['1', '31楼茶水间', '008D9066', '已用', ''],
  ['2', '30楼茶水间', '008C65D6', '已用', '']
]);
eq('设备原始点位表（无「类型」列）：2 个点', ptDev.points.length, 2);
eq('设备原始点位表编码正确', ptDev.points[0].code, '008D9066');
eq('设备原始点位表名称正确', ptDev.points[0].name, '31楼茶水间');

/* 点位表误判防护：idx.code 若落到序号列，「1」「2」「3」会被当卡号灌进点位表。
   正确行为是：编码列认不出来时宁可留空，靠点位名称成行，编码为空由后续补录。 */
const ptBad = P.parsePoints([
  ['序号', '地点名称'],
  ['1', '31楼茶水间'],
  ['2', '30楼茶水间'],
  ['3', '30楼卫生间']
]);
ok('只有序号+名称两列时不产出任何编码（序号不会被当卡号）',
  ptBad.points.every(x => x.code === ''),
  JSON.stringify(ptBad.points.map(x => x.code)));
ok('只有序号+名称两列时点位仍按名称成行（3 个）', ptBad.points.length === 3,
  'got=' + ptBad.points.length);
ok('序号不会被当卡号（无 6~10 位十六进制串泄漏）',
  ptBad.points.every(x => !/^[0-9A-Fa-f]{6,10}$/.test(x.code)));

/* --- 7.4 路由：多 sheet 选表 + 互斥诊断 --- */
ok('路由有 pickSheet（按用途在多 sheet 中择优）', /function pickSheet/.test(rsrc));
ok('路由有 rowsFor（统一取表入口）', /function rowsFor/.test(rsrc));
ok('点位端点能识别「其实是记录表」并提示改用记录导入',
  /这张表是巡查记录表，请改用/.test(rsrc));
ok('记录端点能识别「其实是点位表」并提示改用点位导入',
  /这张表是点位\/人员卡表，请改用/.test(rsrc));
ok('多 sheet 时提示已自动选用哪张表', /已自动选用/.test(rsrc));
ok('导入响应回传 detect 识别模式', /detect:\s*parsed\.mode/.test(rsrc));
ok('导入响应回传 sheets 列表', /sheets:\s*r\.table\.sheetNames/.test(rsrc));
ok('不再把「行数最多的表」写死进报错文案（已改为按用途择优）',
  !/已自动选用行数最多的/.test(rsrc));

/* --- 7.5 真实文件端到端（文件在才算） --- */
if (haveReal) {
  const rMar = XLS.readTable(fs.readFileSync(fMar), '3月巡更记录(3).xls');
  ok('3月文件是 3 个工作表', rMar.sheets.length === 3, 'got=' + rMar.sheets.length);
  ok('3月文件主表自动选中 Rpt_downdata（记录表，13682 行）', rMar.name === 'Rpt_downdata', rMar.name);
  ok('3月文件主表行数 > 10000', rMar.rows.length > 10000, 'got=' + rMar.rows.length);
  const pMar = P.parseRecords(rMar.rows);
  ok('3月文件解析出 13000+ 条记录', pMar.records.length > 13000, 'got=' + pMar.records.length);
  ok('3月文件 skipped = 0', pMar.skipped === 0, 'got=' + pMar.skipped);
  ok('3月文件走表头识别模式', pMar.mode === 'header', 'got=' + pMar.mode);
  ok('3月文件时间范围在 2026-03', /^2026-03-/.test(pMar.records[0].time), pMar.records[0].time);
  ok('3月文件末条在 2026-03-31', /^2026-03-31/.test(pMar.records[pMar.records.length - 1].time));
  ok('3月文件编码列无空值', pMar.records.every(x => x.pointCode), '有空编码');
  ok('3月文件人员列有值（巡检员）', pMar.records.filter(x => x.person).length > 13000);
  ok('3月文件记录里无 RK 垃圾值（5.xxe-315）',
    pMar.records.every(x => !/e-31[0-9]/.test(String(x.seq)) && !/e-31[0-9]/.test(String(x.device))));
  ok('3月文件序号是连续整数 1..N', pMar.records.every((x, i) => x.seq === i + 1));

  const pMarPt = P.parsePoints(rMar.sheets[0].rows);
  ok('3月文件第 1 张是点位表（100 个点）', pMarPt.points.length >= 95, 'got=' + pMarPt.points.length);

  const rJul = XLS.readTable(fs.readFileSync(fJul), '维序巡查记录7月.xls');
  const pJul = P.parseRecords(rJul.rows);
  ok('7月文件解析出 6700+ 条记录（回归无退化）', pJul.records.length > 6700, 'got=' + pJul.records.length);
  ok('7月文件 skipped = 0', pJul.skipped === 0);
  ok('7月文件仍是标准列位（time 在 c2）', pJul.idx.time === 2, JSON.stringify(pJul.idx));
  ok('7月文件人员列仍带班次前缀（夜班-何南）',
    pJul.records.some(x => /^夜班-|^白班-/.test(x.person)));
} else {
  console.log('  · 跳过真实文件断言（未找到 Y:////物业实际使用的报表及合同 下的样本）');
}

/* --- 7.6 卡号体系不一致的诊断与提示 --- */
// 设备中途换过 / 重新发卡时，点位表与旧月份记录是两套卡号（实测 3 月 100 个塔号体系卡
// 与 7 月 35 个楼层体系卡交集为 0），覆盖率会恒为 0%、漏检数 = 全部点数。
// 数字本身没错，但完全没法解读 —— 必须在接口与前端都给出真实原因。
// 复用上文已声明的 vsrc（第 113 行读入的 views5.js 全文），不要重复声明
const rsrc2 = fs.readFileSync(path.join(ROOT, 'routes', 'patrol.js'), 'utf8');
ok('概览接口回传 codeHitRate', /codeHitRate:\s*codeHitRate/.test(rsrc2));
eq('前端共用一个 codeHitWarn（避免概览/月报两处文案走样）',
  (vsrc.match(/function codeHitWarn/g) || []).length, 1);
eq('概览与月报两处都调用 codeHitWarn',
  (vsrc.match(/h \+= codeHitWarn/g) || []).length, 2);
ok('警示卡文案包含可执行的下一步（重导记录文件即会带入点位）',
  /重新用「导入巡查记录表」导一次/.test(
    vsrc.slice(vsrc.indexOf('function codeHitWarn'), vsrc.indexOf('/* ==================== 主视图'))));

/* --- 7.7 幂等去重（重复导入不得让实巡点次翻倍） --- */
// 起因：追加模式原先无条件 push，同一份 3 月文件被导两次就攒出 13669 条完全重复记录，
// 实巡点次翻倍、覆盖率虚高，而界面只显示「导入成功」，用户完全察觉不到。
ok('记录导入有幂等去重（dupKey 主键）', /dupKey/.test(rsrc2));
ok('去重主键为「时间 + 卡号 + 人员」',
  /x\.time,\s*\(x\.pointCode \|\| x\.pointName \|\| ''\),\s*x\.person/.test(rsrc2.replace(/\s+/g, ' ')) ||
  /\[\s*x\.time,\s*\(x\.pointCode/.test(rsrc2));
ok('同时拦本次文件内部的自我重复（existed 在循环外建、在循环内写）',
  /existed\[k\] = true/.test(rsrc2));
ok('覆盖模式先 clear 再建去重索引（否则 replace 会被整份判为重复）',
  rsrc2.indexOf("db.clear('patrolRecords')") > 0 &&
  rsrc2.indexOf("db.clear('patrolRecords')") < rsrc2.indexOf('const existed = {}'));
ok('导入响应回传 dup 计数', /dup:\s*dupInBatch/.test(rsrc2));
ok('前端对 dup > 0 用警示色提示「跳过重复 N 条」',
  /d\.dup/.test(vsrc) && /跳过/.test(vsrc) && /'warn'/.test(vsrc));

/* --- 7.8 一体化导入：点位就在记录文件的另一个 sheet 里 ---
   *
   * 设备（维序）导出的 xls 把点位卡（Rpt_cardinfo）和巡更流水（Rpt_downdata）
   * 放在同一个文件的不同工作表。用户拿到的就是「3月巡更记录(3).xls」一个文件，
   * 点位在里面。以前必须导两次（先记录、再拿同一文件导点位），体验极差。
   *
   * 【真正难的不是「顺带导入」，而是「导入后两个月的分母不能互相污染」】
   * 3 月是 100 个塔号体系卡，7 月是 35 个楼层体系卡，交集为 0。
   * 若全并进一张表：3 月应巡 = 135×31 = 4185（实 2992）→ 覆盖率被摊薄到 71.5%，
   * 凭空多出 1085 次假漏检。所以点位必须带 month 归属，分析时按月取。
   */
ok('导入端点有 guessMonth（从记录时间戳推断点位归属月份）',
  /function guessMonth\(records, fileName\)/.test(rsrc2));
ok('guessMonth 优先看记录时间戳（用户不会告诉你点位属于几月）',
  /String\(r\.time \|\| ''\)\.slice\(0, 7\)/.test(rsrc2.slice(rsrc2.indexOf('function guessMonth'), rsrc2.indexOf('// 通用：base64'))));
// 兜底文件名里「N月」字样。写成字面串比对，避免双重转义把正则打坏
ok('guessMonth 兜底解析文件名月份（覆盖「3月巡更记录(3).xls」这类命名）',
  rsrc2.indexOf("fn.match(/(\\d{1,2})") > 0);
ok('记录导入会顺带把同文件里的点位表一起导进来（多 sheet 才做）',
  /r\.table\.sheets\.length > 1/.test(rsrc2) && /rowsFor\(r\.table, 'points'\)/.test(rsrc2));
ok('顺带导入的点位带 month 归档（savePoints 共用写入逻辑）',
  /function savePoints\(parsed, month\)/.test(rsrc2) && /savePoints\(pp, month\)/.test(rsrc2));
ok('导入响应回传顺带点位的详情与推断月份', /points: ptImport/.test(rsrc2) && /month: month,/.test(rsrc2));
ok('点位有 month 归属字段（覆盖率的分母按月取）',
  /month: month \|\| ''/.test(rsrc2));
ok('loadPoints 支持按月取点位', /async function loadPoints\(month\)/.test(rsrc2));
ok('有 pointsOf 便捷包装供各分析端点统一调用',
  /async function pointsOf\(month\)/.test(rsrc2) && /pointsOf\(/.test(rsrc2));

/* --- 7.9 按月归档的关键语义（曾致 3 月分母变 135、覆盖率 96.5%→71.5%） --- */
const lpStart = rsrc2.indexOf('async function loadPoints(month)');
const lp = rsrc2.slice(lpStart, rsrc2.indexOf('async function pointsOf'));
ok('有该月专属点位时只用专属，不叠加通用点位（否则 100+35=135 分母污染）',
  /if \(!scoped\.length\) return \{ list: common[\s\S]*?return \{ list: scoped, scoped: true/.test(lp));
ok('该月无专属点位时回退通用点位（老数据只有一套点位表仍能工作）',
  /if \(!scoped\.length\) return \{ list: common, scoped: false/.test(lp));
ok('注释写明「叠加通用会造出假漏检」这段踩坑记录',
  /造出 1085 次假漏检|假漏检/.test(lp));

ok('各分析端点都按月取点位（不能有裸 loadPoints() 参与分母）',
  // analyze / daily / monthly / export 都改成 pointsOf(...) 或 loadPoints(月)
  (rsrc2.match(/await pointsOf\(/g) || []).length >= 3);
ok('monthly 端点用 loadPoints(所选月份) 并回报 pointScope',
  /loadPoints\(m\)/.test(rsrc2) && /pointScope: ptSel\.scoped/.test(rsrc2));
ok('overview 端点在推断出统计月份后才取点位（dataMonth 决定用哪套）',
  /const ptSel = await loadPoints\(dataMonth\)/.test(rsrc2));
ok('概览区分「点位总数」与「本月分母点数」（避免混为一谈）',
  /monthPointCount: points\.length/.test(rsrc2));
ok('导出端点也按月取点位（遗漏明细的分母同样不能错）',
  /const expMonth = q\.month \|\|/.test(rsrc2));
ok('点位覆盖模式只清同月份，不清全表（否则后一个月导入会抹掉前一个月）',
  /db\.where\('patrolPoints', p => p\.month === month\)/.test(rsrc2));

/* --- 7.10 前端配套 --- */
ok('点位页有「归属月份」列并区分通用/按月', /title: '归属月份'/.test(vsrc) && /通用/.test(vsrc));
ok('点位表单可填归属月份（独立点位表文件需要手动指定）',
  /key: 'month', label: '归属月份'/.test(vsrc));
ok('点位筛选支持 全部/通用/按月归档',
  /value: 'common'/.test(vsrc) && /value: 'scoped'/.test(vsrc));
ok('导入提示告知「点位已一并导入并归档到某月」',
  /同时导入点位卡/.test(vsrc) && /归档到/.test(vsrc));
ok('警示卡指引改为「重导记录文件即可」，不再让用户单独导点位',
  /重新用「导入巡查记录表」导一次/.test(vsrc));
ok('概览指标区分「点位总数」与「该月分母点数」',
  /monthPointCount/.test(vsrc) && /分母点数/.test(vsrc));
ok('CrudView 字段支持 hint（解释「留空=通用点位」这种反直觉含义）',
  /if \(f\.hint\)/.test(fs.readFileSync(path.join(ROOT, 'public', 'js', 'components.js'), 'utf8')));

/* ============ 汇总 ============ */
console.log('\n' + '='.repeat(60));
console.log('巡更小工具复制完整性测试：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) { console.log('\n失败项：'); fails.forEach(f => console.log('  - ' + f)); }
console.log('='.repeat(60));
process.exit(fail ? 1 : 0);
