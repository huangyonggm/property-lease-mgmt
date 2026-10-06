'use strict';
/**
 * 迁移：invoices 表增加 `sellerName`（票面销售方）
 *
 * 【为什么需要这个字段】
 * 发票表单原先把「发票抬头」填成票面**购买方**，但票面**销售方**（谁开的这张票）
 * 完全没有落库位置。用户上传一张进项票（如国美电器开出的）时，看不到「开票方是谁」。
 * 现按用户要求「识别出来是什么就是什么」，把票面销售方原样存下来。
 *
 * 【加字段三步走】（漏一步的代价见 .workbuddy/memory/MEMORY.md）
 *   ① exports/schema.json 的 cols.invoices 加列名   ← 已做
 *   ② 线上 TiDB ALTER TABLE（本脚本）               ← 本脚本
 *   ③ exports/schema.sql 同步                        ← 已做
 *   漏 ② 会让该表所有写入报 Unknown column；漏 ① 会静默丢字段。
 *
 * 用法：node scripts/migrate_invoice_sellername.js
 * 幂等：列已存在则跳过。
 */
require('../lib/env.js');
const { run } = require('../lib/tidb');

(async () => {
  const t = 'invoices', col = 'sellerName';
  console.log('=== 检查 ' + t + '.' + col + ' ===');
  const cols = await run('SHOW COLUMNS FROM `' + t + '`', []);
  const has = cols.some(c => c.Field === col);
  console.log('  现有列数 = ' + cols.length + '，' + col + ' 存在 = ' + (has ? 'yes' : 'NO'));

  if (has) {
    const d = cols.find(c => c.Field === col);
    console.log('  类型 = ' + d.Type + '，无需 ALTER');
  } else {
    console.log('  执行 ALTER TABLE `' + t + '` ADD COLUMN `' + col + '` VARCHAR(64) ...');
    await run('ALTER TABLE `' + t + '` ADD COLUMN `' + col + '` VARCHAR(64) DEFAULT NULL', []);
    console.log('  ✅ ALTER 完成');
  }

  const after = await run('SHOW COLUMNS FROM `' + t + '`', []);
  console.log('=== 结果 ===');
  console.log('  列数 = ' + after.length);
  console.log('  ' + after.map(c => c.Field).join(', '));

  // 回读校验：确认写入该列不再报 Unknown column
  const cnt = await run('SELECT COUNT(*) AS c FROM `' + t + '` WHERE `' + col + '` IS NULL OR `' + col + "` = ''", []);
  console.log('  ' + col + ' 为空的行数 = ' + JSON.stringify(cnt));
  console.log('MIGRATE_DONE');
})().catch(e => { console.log('❌ ' + e.message); process.exit(1); });
