'use strict';
/**
 * 打包准备：把「云端真正需要的文件」收集到一个干净目录。
 *
 * 【为什么需要这个脚本 —— 修一个安全 + 性能双问题】
 * Netlify 的 nft 打包默认会把项目根下「被静态引用的一切」都收进函数包。
 * 实测打出来的 api.zip 解压后 **80.5MB / 617 个文件**：
 *    40.20 MB  uploads/                        （用户上传的巡更 xls）
 *    22.56 MB  data/                            （客户/工资/合同/考勤 全部本地数据）
 *    14.50 MB  exports/                         （含工资表_*.xls、员工名册_*.xls）
 *     0.98 MB  梦想之城物业管理系统/局部小工具/   ← 连 Y 盘别的项目都被卷进来了
 *
 * 后果一（性能）：Lambda 每次唤醒要解压 80MB → 冷启动 17~20 秒，
 *   30 秒函数上限下频繁 502/504。
 * 后果二（安全，更严重）：data/customers.json（客户信息）、data/payrolls.json（工资）、
 *   exports/工资表_2026-09.xls（真实工资表）全都被打进部署产物。
 *
 * 【为什么用「收集到干净目录」而不是 included_files 白名单】
 * 实测 `included_files` 在 nft 模式下不按预期生效（会连 nft 追踪出的 lib/、routes/
 * 一起排除掉，打出 274KB 但缺业务代码的包，线上靠 telemetry 兜底才没崩）——
 * 行为不可控。改成「物理上只把需要的文件放进构建目录」，
 * 不需要的数据压根不在那儿被打包，最可靠也最直观。
 *
 * 用法：
 *   node scripts/prepare_cloud_build.js          # 生成 .cloudbuild/
 *   然后 netlify deploy --dir=.cloudbuild/public --functions=.cloudbuild/netlify/functions
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.cloudbuild');

/** 需要收集的文件/目录（相对项目根） */
const INCLUDE_DIRS = ['lib', 'routes', 'netlify'];
const INCLUDE_FILES = ['package.json', 'netlify.toml'];

/**
 * 收集 netlify/ 时必须清掉的构建残留。
 *
 * 【踩过的坑 —— 部署的代码「改了没生效」就是这个原因】
 * 打包脚本第一次运行时，netlify/functions/ 里已经有上次 `netlify functions:build`
 * 生成的 `api.zip`（280KB）和 `manifest.json`。
 * 而 Netlify 打包时**优先使用已存在的 api.zip**（当它是预构建产物），
 * 于是 `netlify/functions/api.js` 明明改了（加了 /api/warmup 预热端点），
 * 线上跑的还是 zip 里的旧代码 —— 表现为「改了没反应，接口 404」。
 *
 * 所以每次收集前必须先删掉 *.zip 和 manifest.json，
 * 强迫 Netlify 重新从 api.js 构建。
 */
const STALE_IN_FUNCTIONS = ['api.zip', 'manifest.json', 'api.zip.json'];


/** node_modules 里真正需要的包（及传递依赖，按 nft 结果固化） */
const INCLUDE_MODULES = [
  '@tidbcloud', 'qiniu', 'iconv-lite', 'urllib', 'qs', 'mime', 'semver',
  'minimist', 'readable-stream', 'object-inspect', 'any-promise', 'utility'
];

/** exports 里只带 schema.json —— clouddb.js require 它，其余报表/探针一律不带 */
const INCLUDE_EXPORTS = ['schema.json'];

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { } }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function copyDir(src, dst) {
  mkdirp(dst);
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name), d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
function duKB(p) {
  let n = 0;
  const walk = d => {
    for (const name of fs.readdirSync(d)) {
      const f = path.join(d, name);
      const st = fs.statSync(f);
      if (st.isDirectory()) walk(f); else n += st.size;
    }
  };
  try { walk(p); } catch (e) { }
  return Math.round(n / 1024);
}

function main() {
  rmrf(OUT);
  mkdirp(OUT);

  // ---- 代码目录 ----
  for (const d of INCLUDE_DIRS) {
    const src = path.join(ROOT, d);
    if (!fs.existsSync(src)) { console.log('  跳过（不存在）', d); continue; }
    copyDir(src, path.join(OUT, d));
    console.log('  ✔ ' + d + '  ' + duKB(path.join(OUT, d)) + ' KB');
  }
  // ---- 清理函数目录里的陈旧构建产物（关键，见 STALE_IN_FUNCTIONS 注释）----
  const fnDir = path.join(OUT, 'netlify', 'functions');
  for (const f of STALE_IN_FUNCTIONS) {
    const p = path.join(fnDir, f);
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('  ✔ 已清理陈旧产物 netlify/functions/' + f); }
  }
  // ---- 单文件 ----
  for (const f of INCLUDE_FILES) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) { console.log('  跳过（不存在）', f); continue; }
    fs.copyFileSync(src, path.join(OUT, f));
    console.log('  ✔ ' + f);
  }
  // ---- exports：只要 schema.json（工资表/员工名册/探针绝不带）----
  mkdirp(path.join(OUT, 'exports'));
  for (const f of INCLUDE_EXPORTS) {
    const src = path.join(ROOT, 'exports', f);
    if (!fs.existsSync(src)) { console.log('  跳过（不存在）exports/' + f); continue; }
    fs.copyFileSync(src, path.join(OUT, 'exports', f));
    console.log('  ✔ exports/' + f + '  ' + duKB(path.join(OUT, 'exports')) + ' KB');
  }
  // ---- node_modules 白名单 ----
  const nmOut = path.join(OUT, 'node_modules');
  mkdirp(nmOut);
  for (const m of INCLUDE_MODULES) {
    const src = path.join(ROOT, 'node_modules', m);
    if (!fs.existsSync(src)) { console.log('  ⚠ 依赖缺失，跳过 ' + m); continue; }
    copyDir(src, path.join(nmOut, m));
    console.log('  ✔ node_modules/' + m + '  ' + duKB(path.join(nmOut, m)) + ' KB');
  }
  // ---- public（静态资源）----
  const pub = path.join(ROOT, 'public');
  if (fs.existsSync(pub)) {
    copyDir(pub, path.join(OUT, 'public'));
    console.log('  ✔ public  ' + duKB(path.join(OUT, 'public')) + ' KB');
  } else {
    console.log('  ⚠ public/ 不存在');
  }

  console.log('\n=== 收集完成 ===');
  console.log('构建根目录：' + OUT);
  console.log('总计：' + duKB(OUT) + ' KB');
  console.log('\n下一步（注意 --dir 与 --functions 都要指向 .cloudbuild）：');
  console.log('  netlify deploy --prod --dir=.cloudbuild/public --functions=.cloudbuild/netlify/functions --message="..."');
  console.log('\n⚠ .cloudbuild/ 里绝不能出现 data/ uploads/ exports/*.xls —— 已由白名单保证');
}

main();
