'use strict';
// 重置演示数据：清空 data 目录并重新生成
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

if (fs.existsSync(DATA)) {
  fs.readdirSync(DATA).forEach(f => {
    if (f.indexOf('.json') > 0 && f.indexOf('.tmp') < 0) fs.unlinkSync(path.join(DATA, f));
  });
  console.log('[reseed] 已清空 ' + DATA);
}
const DB = require('../lib/db');
const { seed } = require('../lib/seed');
const db = new DB(DATA);
const ok = seed(db);
console.log(ok ? '[reseed] 演示数据已重新生成' : '[reseed] 已存在数据，未覆盖');
console.log('[reseed] 统计：' + JSON.stringify(db.stats()));
