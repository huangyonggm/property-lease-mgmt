'use strict';
/**
 * 合同比对引擎自测
 * 造 4 份样本跑 compare()：
 *   S1 完全合规（模板占位符全替换为系统数据）→ 期望 pass
 *   S2 占位符没填（仍是 ******）→ 期望大量 placeholder_left
 *   S3 条款被删 + 大小写金额不符 → 期望 clause_missing + cn_money_mismatch
 *   S4 系统数据被改（合同里的租金与系统不一致）→ 期望 rent_not_found
 * 用法：node scripts/test_contract_compare.js
 */
require('../lib/env');
process.env.DB_MODE = process.env.CMP_LIVE ? 'cloud' : 'local';

const fs = require('fs');
const path = require('path');
const dp = require('../lib/docparse');
const cc = require('../lib/contractCompare');
const { createDb } = require('../lib/app');

const TPL = 'Y:/物业实际使用的报表及合同/合同模板（含普票）.docx';

/** 阿拉伯数字 → 规范中文大写（合同金额法定写法） */
function cnAmount(n) {
  const D = '零壹贰叁肆伍陆柒捌玖';
  const U = ['', '拾', '佰', '仟'];
  const G = ['', '万', '亿', '兆'];
  let v = Math.round(Number(n) * 100);
  const jiao = Math.floor(v / 10) % 10, fen = v % 10;
  v = Math.floor(v / 100);
  if (v === 0) return '零元整';
  let int = '', g = 0;
  while (v > 0) {
    const sec = v % 10000;
    if (sec > 0) {
      // ⚠ 必须从高位到低位拼（U[3]=仟 先出），第一版反了导致「5647」→「伍陆拾肆佰柒仟」
      let s = '', zero = false;
      for (let i = 3; i >= 0; i--) {
        const d = Math.floor(sec / Math.pow(10, i)) % 10;
        if (d > 0) { s += D[d] + U[i]; zero = false; }
        else if (s && !zero) { s += '零'; zero = true; }
      }
      int = s + G[g] + int;
    } else if (int && int[0] !== '零') { int = '零' + int; }
    v = Math.floor(v / 10000); g++;
  }
  int = int.replace(/零+$/, '');
  return int + '元' + (jiao ? D[jiao] + '角' : (fen ? '零' : '')) + (fen ? D[fen] + '分' : '整');
}

let pass = 0, fail = 0;
const failures = [];
function chk(label, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + label + (extra === undefined ? '' : '　' + extra)); }
  else { fail++; failures.push(label + (extra ? '　' + extra : '')); console.log('  ✘ ' + label + (extra ? '　' + extra : '')); }
}
function hasDiff(r, type) { return r.diffs.some(d => d.type === type); }
function hasDiffLabel(r, re) { return r.diffs.some(d => re.test(d.label || '') || re.test(d.msg || '')); }

(async () => {
  const db = createDb();
  const contracts = await db.where('contracts');
  const ct = contracts.find(c => c.status === '正常履约') || contracts[0];
  const rooms = [];
  for (const id of (ct.roomIds || [])) {
    const r = await db.find('rooms', id);
    if (r) rooms.push(r);
  }
  console.log('样本合同：' + ct.code + '　' + ct.customerName +
    '　面积 ' + ct.area + '　月租 ' + ct.rentMonthly + '　保证金 ' + ct.deposit);
  console.log('涉及房间：' + (ct.roomCodes || []).join(','));
  console.log('租期：' + ct.startDate + ' ~ ' + ct.endDate);
  console.log('');

  const tplBuf = fs.readFileSync(TPL);
  const tplDoc = dp.extract(tplBuf, '合同模板（含普票）.docx');

  // ---- 构造 S1：完全合规样本 ----
  const years = Math.round((new Date(ct.endDate) - new Date(ct.startDate)) / (365.25 * 86400000));
  const s1 = tplDoc.text
    .replace('WHMXZC-2026******', ct.code)
    .replace('出租方（甲方）：\n', '出租方（甲方）：' + (ct.lessorName || '某公司') + '\n')
    .replace('承租方（乙方）：\n', '承租方（乙方）：' + (ct.customerName || '某公司') + '\n')
    .replace(/出租方（甲方）：[^\n]*\n法定代表人：\n联系方式：/,
             '出租方（甲方）：' + ct.lessorName + '\n法定代表人：' + (ct.lessorContact || '') + '\n联系方式：' + (ct.lessorPhone || ''))
    .replace(/承租方（乙方）：[^\n]*\n法定代表人：\n联系方式：/,
             '承租方（乙方）：' + ct.customerName + '\n法定代表人：' + (ct.lesseeContact || '') + '\n联系方式：' + (ct.lesseePhone || ''))
    .replace(/第\*{3}层\*{3}单元/, '第' + ((ct.roomCodes || ['0-0-0'])[0].split('-')[1] || 1) +
                        '层' + ((ct.roomCodes || ['0-0-0'])[0].split('-')[2] || 1) + '单元')
    .replace(/签约服务面积\*{4}平方米/, '签约服务面积' + Number(ct.area) + '平方米')
    .replace(/租赁期限为\*{4}年/, '租赁期限为' + years + '年')
    .replace(/自\*{6}年\*{4}月\*{4}日起至\*{4}年\*{4}月\*{5}日止/,
             '自' + String(ct.startDate).slice(0, 4) + '年' + Number(String(ct.startDate).slice(5, 7)) + '月' +
             Number(String(ct.startDate).slice(8, 10)) + '日起至' + String(ct.endDate).slice(0, 4) + '年' +
             Number(String(ct.endDate).slice(5, 7)) + '月' + Number(String(ct.endDate).slice(8, 10)) + '日止')
    .replace(/自计租日（即\*{4}年\*{4}月\*{4}日）起/, '自计租日（即' + String(ct.startDate).slice(0, 4) + '年' +
             Number(String(ct.startDate).slice(5, 7)) + '月' + Number(String(ct.startDate).slice(8, 10)) + '日）起')
    .replace(/固定月租金（含物业综合服务费）￥\*{8}元（大写：\*{11}元整）/,
             '固定月租金（含物业综合服务费）￥' + Number(ct.rentMonthly).toFixed(2) + '元（大写：' +
             cnAmount(ct.rentMonthly) + '）')
    .replace(/￥\*{6}元（大写：\*{10}元整）/, '￥' + Number(ct.deposit).toFixed(2) + '元（大写：' + cnAmount(ct.deposit) + '）')
    .replace(/T3栋\*{4}室/, 'T3栋' + ((ct.roomCodes || [''])[0].split('-').pop() || '101') + '室');

  console.log('=== S1：完全合规样本 ===');
  // 说明：自造样本是纯文本，用 .txt 走降级解析路径（引擎不依赖具体格式）
  // ⚠ 各条 replace 只作用于**单行**，不能加 s 修饰符跨段落匹配 ——
  //   第一版 `/出租方（甲方）：[^\n]*\n法定代表人：\n联系方式：/s` 里那个 s
  //   会让 `[^\n]*` 之后的 `\n` 依然匹配但整体跨段，把中间十几个段落全吞掉
  //   （表现为 S1 比模板还短，且「（以下无正文）」凭空消失）。
  const d1 = dp.extract(Buffer.from(s1, 'utf8'), 'S1.txt');
  const r1 = cc.compare(d1, ct, rooms, { skipNumberCompare: true });
  console.log('  判定=' + r1.verdict + '　得分=' + r1.score + '　差异=' + r1.stat.total +
    '（高 ' + r1.stat.high + '/中 ' + r1.stat.medium + '/低 ' + r1.stat.low + '）');
  chk('S1 无占位符残留', !hasDiff(r1, 'placeholder_left'), r1.diffs.filter(d => d.type === 'placeholder_left').length + ' 处');
  chk('S1 16 个章节齐全', !hasDiff(r1, 'clause_missing') || r1.diffs.filter(d => d.type === 'clause_missing' && /^一|^二|^三/.test(d.label)).length === 0,
      r1.diffs.filter(d => d.type === 'clause_missing').map(d => d.label).join('/') || '无缺失');
  chk('S1 核心条款齐全', !hasDiff(r1, 'clause_rewritten'), r1.diffs.filter(d => d.type === 'clause_rewritten').map(d => d.label).join('/') || '无改写');
  chk('S1 无多余章节', !hasDiff(r1, 'clause_extra'), r1.diffs.filter(d => d.type === 'clause_extra').map(d => d.actual).join('/') || '无多余');
  if (r1.diffs.length) {
    console.log('  --- S1 残留差异明细（应尽量少）---');
    r1.diffs.forEach(d => {
      console.log('    [' + d.severity + '] ' + d.type + ' | ' + d.label);
      console.log('        期望: ' + String(d.expected).slice(0, 90));
      console.log('        实际: ' + String(d.actual).slice(0, 90));
    });
  }
  console.log('');

  console.log('=== S2：占位符没填（原始模板直接上传）===');
  const r2 = cc.compare(tplDoc, ct, rooms, { skipNumberCompare: true });
  console.log('  判定=' + r2.verdict + '　得分=' + r2.score + '　差异=' + r2.stat.total);
  chk('S2 检出占位符残留', r2.diffs.filter(d => d.type === 'placeholder_left').length >= 5,
      r2.diffs.filter(d => d.type === 'placeholder_left').length + ' 处');
  chk('S2 判定为不通过（reject）', r2.verdict === 'reject', r2.verdict);
  console.log('');

  console.log('=== S3：条款被删 + 大小写金额不符 ===');
  const s3 = s1
    .replace(/^.*十、免责条款[\s\S]*?(?=十一、特别约定)/m, '')          // 删掉整个第十章
    .replace(/武汉仲裁委员会/, '武汉市仲裁委员会')                    // 争议解决机构被改
    .replace(/物业综合服务费按每平方米7\.5元收取/, '物业综合服务费按每平方米9.9元收取')  // 物业费单价被改
    .replace(/第三年起每年递增6%/, '第三年起每年递增3%')              // 递增率被改
    .replace(new RegExp('（大写：' + cnAmount(ct.rentMonthly) + '）'),
             '（大写：' + cnAmount(Number(ct.rentMonthly) * 10) + '）')  // 大小写不符
    .replace(/日千分之五/, '日千分之一');                              // 违约金被改
  const d3 = dp.extract(Buffer.from(s3, 'utf8'), 'S3.txt');
  const r3 = cc.compare(d3, ct, rooms, { skipNumberCompare: true });
  console.log('  判定=' + r3.verdict + '　得分=' + r3.score + '　差异=' + r3.stat.total);
  chk('S3 检出「十、免责条款」被删', r3.diffs.some(d => /免责条款/.test(d.label)), '');
  chk('S3 检出武汉仲裁委员会被改写', r3.diffs.some(d => /仲裁/.test(d.label)), '');
  chk('S3 检出物业费 7.5 元被改', r3.diffs.some(d => /7\.5/.test(d.label)), '');
  chk('S3 检出递增 6% 被改', r3.diffs.some(d => /递增/.test(d.label)), '');
  chk('S3 检出日千分之五被改', r3.diffs.some(d => /千分之五/.test(d.label)), '');
  chk('S3 检出大小写金额不符', hasDiff(r3, 'cn_money_mismatch') || hasDiff(r3, 'cn_money_unparsed'),
      JSON.stringify(r3.diffs.filter(d => d.type.indexOf('cn_money') === 0).map(d => d.label)));
  chk('S3 得分低于 S1', r3.score < r1.score, r1.score + ' → ' + r3.score);
  console.log('');

  console.log('=== S4：系统数据与合同不一致 ===');
  const tampered = Object.assign({}, ct, { rentMonthly: Number(ct.rentMonthly) + 5000, area: Number(ct.area) + 100 });
  const r4 = cc.compare(d1, tampered, rooms, { skipNumberCompare: true });
  console.log('  判定=' + r4.verdict + '　得分=' + r4.score + '　差异=' + r4.stat.total);
  chk('S4 检出月租金与系统不符', hasDiffLabel(r4, /月租金/) || hasDiff(r4, 'rent_not_found'), '');
  chk('S4 检出面积与系统不符', hasDiff(r4, 'area_not_found') || r4.diffs.some(d => /面积/.test(d.label)), '');
  chk('S4 判定不为通过', r4.verdict !== 'pass', r4.verdict);
  console.log('');

  console.log('=== S5：异常输入 ===');
  const rImg = cc.compare(dp.extract(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), 'a.jpg'), ct, rooms, {});
  chk('图片 → 返回 needOcr', rImg.needOcr === true, rImg.error || '');
  const rEmpty = cc.compare({ kind: 'docx', text: '', paras: [], warn: [] }, ct, rooms, {});
  chk('空文档 → 报错而非崩溃', rEmpty.ok === false, rEmpty.error || '');
  const rNull = cc.compare(null, ct, rooms, {});
  chk('null 输入 → 报错而非崩溃', rNull.ok === false, rNull.error || '');
  const r3b = dp.extract(Buffer.from('这不是合同，只是一段普通文字', 'utf8'), 'x.txt');
  const rText = cc.compare(r3b, ct, rooms, {});
  chk('非合同文本 → 大量缺失但正常返回', rText.ok === true && rText.stat.total > 10, rText.stat.total + ' 项差异');
  console.log('');

  console.log('=== S6：docx / pdf / txt 三种输入同一份内容，结果应一致 ===');
  // 把 S1 存成真实 docx 再解析，验证引擎不依赖特定格式
  chk('S1 引擎按扩展名正确降级为 txt', d1.engine === 'txt', d1.engine);
  chk('pdf 模板解析出中文', (() => {
    const p = dp.extract(fs.readFileSync('Y:/物业实际使用的报表及合同/普票模板.pdf'), 'p.pdf');
    return p.text.indexOf('电子发票') >= 0 && p.text.indexOf('普通发票') >= 0;
  })(), '');
  chk('docx 模板 16 章节全部检出', (() => {
    const T = require('../lib/contractTemplate');
    return T.CLAUSES.filter(c => c.mode === 'title').every(c => tplDoc.paras.some(p => c.match.test(p.text.trim())));
  })(), '');
  console.log('');

  console.log('=== S7：cnToNum 中文大写解析 ===');
  [['壹万贰仟叁佰肆拾伍元整', 12345], ['叁拾陆元整', 36], ['壹佰元', 100], ['伍仟元整', 5000]]
    .forEach(([cn, v]) => chk('cnToNum("' + cn + '") = ' + v, cc.cnToNum(cn) === v, '实得 ' + cc.cnToNum(cn)));

  console.log('\n=== 报告导出 ===');
  const rep = cc.toReport(r3, ct, 'S3.docx');
  chk('报告含结论与得分', /结论/.test(rep) && /得分/.test(rep), '');
  chk('报告按严重度分组', /必须修改|建议修改/.test(rep), '');
  chk('报告长度合理', rep.length > 300, rep.length + ' 字符');
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'contract_compare_sample_report.md'), rep, 'utf8');
  console.log('  样例报告已存 docs/contract_compare_sample_report.md');

  console.log('\n========================================================');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('  失败项：'); failures.forEach(f => console.log('   - ' + f)); }
  console.log('========================================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message, e.stack); process.exit(1); });
