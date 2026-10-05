'use strict';
/**
 * 为 TiDB 建索引 —— 列表页排序字段的优化。
 *
 * 背景（实测数据）：
 *   一次合同列表请求在共享缓存冷时发 68 条 SQL、耗时 4583ms；
 *   缓存热时只发 1 条、166ms。差 27 倍。
 *   其中 page() 的 ORDER BY 因为没有索引，要全表扫描+排序。
 *   实测加索引前 bills ORDER BY period 213ms、无排序仅 94ms。
 *
 * 用法：node scripts/tidb_add_indexes.js
 */
const tidb = require('../lib/tidb');

// 表 -> 需要索引的列
const INDEXES = {
  contracts: ['startDate', 'status', 'customerId'],
  workorders: ['createTime', 'status', 'roomId'],
  bills: ['period', 'status', 'contractId', 'payDate'],
  rooms: ['roomNo', 'status', 'buildingId'],
  attendance: ['month', 'employeeId'],
  payrolls: ['month', 'employeeId'],
  invoices: ['createTime', 'status'],
  payments: ['payDate', 'billId'],
  patrolRecords: ['time', 'pointCode', 'person'],
  readings: ['period', 'meterId'],
  expenses: ['period', 'expDate'],
  customers: ['name'],
  employees: ['no', 'name'],
  reminders: ['createTime'],
  logs: ['createTime'],
  deposits: ['createTime'],
  recharges: ['createTime']
};

(async () => {
  require('../lib/env');
  console.log('=== 为高频排序/过滤字段建索引 ===\n');
  let created = 0, exists = 0, fail = 0;
  for (const tb of Object.keys(INDEXES)) {
    for (const col of INDEXES[tb]) {
      const idxName = 'idx_' + tb + '_' + col;
      const sql = 'CREATE INDEX `' + idxName + '` ON `' + tb + '` (`' + col + '`)';
      try {
        await tidb.run(sql, []);
        console.log('  ✔ 新建  ' + tb + '.' + col);
        created++;
      } catch (e) {
        const msg = e && e.message || '';
        if (/Duplicate|already exists|1061/i.test(msg)) {
          console.log('  – 已存在 ' + tb + '.' + col);
          exists++;
        } else if (/column does not exist|1054/i.test(msg)) {
          // 列名写错：跳过并明确提示，避免「整批失败」掩盖其他已成功的索引
          console.log('  ✘ 列不存在 ' + tb + '.' + col + '（请核对 schema.json 的 cols）');
          fail++;
        } else {
          console.log('  ✘ 失败  ' + tb + '.' + col + ' → ' + msg.slice(0, 70));
          fail++;
        }
      }
    }
  }
  console.log('\n新建 ' + created + ' 个，已存在 ' + exists + ' 个，失败 ' + fail + ' 个');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('异常：', e && e.message); process.exit(1); });
