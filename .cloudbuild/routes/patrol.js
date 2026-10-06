'use strict';
/**
 * 巡更检查：点位卡 / 人员卡 / 巡查记录导入 / 夜班白班分析 / 日报月报 / 导出
 * 由 J:\梦想之城物业管理系统\局部小工具\巡更检查小工具 完整整合而来
 * 表格读取走 lib/xls.js（零第三方依赖，支持 .xls BIFF8 / .xlsx / .csv）
 */
const fs = require('fs');
const path = require('path');
const { ok, fail } = require('../lib/http');
const { register, can, needLogin } = require('../lib/crud');
const X = require('../lib/xls');
const P = require('../lib/patrol');
const XE = require('../lib/exportx');
const audit = require('../lib/audit');
const { uid, now, today, monthOf, addDays, addMonths, num } = require('../lib/util');

function sendDownload(res, filename, content, mime) {
  const buf = Buffer.from(content, 'utf8');
  res.writeHead(200, {
    'Content-Type': (mime || 'text/csv') + '; charset=utf-8',
    'Content-Length': buf.length,
    'Content-Disposition': 'attachment; filename="' + encodeURIComponent(filename) + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename)
  });
  res.end(buf);
}

module.exports = function (db, router, opt) {
  const ctx = opt || {};
  const uploadDir = ctx.uploadDir || path.join(ctx.rootDir || __dirname + '/..', 'uploads');

  /* 遗漏明细表：逐条「班次日 + 时段 + 漏检点 + 卡号 + 该时段巡检人 + 当班人员」
     对齐巡更小工具 patrol_core 的「漏巡明细」表。
     【为什么要时段列】夜班是5 轮（18:30-21:00 / 21:00-01:00 / 01:00-03:00 /
     03:00-06:30 / 06:30-08:30），每轮都要巡满全部点位才算完成。
     只记「班次日+点位」会把 5 轮的漏巡压成1 条，看不出是哪一轮没巡 ——
     这正是旧实现算出 96.5% 虚高率的根源。现在按「时段 × 点位」逐条列出。 */
  const M_MISS_HEADERS = [
    { title: '班次日', key: 'date' },
    { title: '时段', key: 'segment' },
    { title: '漏检点位', key: 'name' },
    { title: '卡号', key: 'code' },
    { title: '该时段巡检人', key: 'segPerson' },
    { title: '当班人员', key: 'person' }
  ];
  function missedDetailRows(daily) {
    const rows = [];
    (daily || []).forEach(d => {
      // 时段口径：逐时段列出漏检点（同一夜可能有多行）
      if (d.bySegment && (d.rounds || []).length) {
        (d.rounds || []).forEach(x => {
          (x.missingPoints || []).forEach((nm, i) => {
            rows.push({
              date: d.shiftDate,
              segment: x.round,
              name: nm,
              code: (x.missingCodes || [])[i] || '',
              segPerson: x.personText || '整时段无记录',
              person: d.allPersonText || '未知'
            });
          });
        });
        return;
      }
      // 非时段口径（兼容）
      (d.missed || []).forEach((c, i) => {
        rows.push({
          date: d.shiftDate, segment: '整夜',
          name: (d.missedPoints || [])[i] || c, code: c,
          segPerson: d.personText || '整时段无记录',
          person: d.allPersonText || '未知'
        });
      });
    });
    return rows;
  }

  /**
   * 从请求里取夜班时段（可配）。
   * 前端传 windowStart / windowEnd（'HH:MM' 字符串），
   * 不传则用默认 18:30 ~ 次日 06:30（与原独立小工具默认值一致）。
   * 集中在这一个函数里解析，避免每个接口各写一遍导致口径漂移。
   */
  function windowOf(src) {
    const q = src || {};
    return P.resolveWindow({
      start: q.windowStart || q.nightStart || '',
      end: q.windowEnd || q.nightEnd || ''
    });
  }

  /* ===================== 1. 巡检点位（地点卡） ===================== */
  // 【点位带月份归属 month】
  //
  // 【为什么必须有这个字段】设备中途换过 / 重新发卡后，点位卡号会整套换掉：
  //   2026-03 设备导出：00190466 → "T1 11南侧"、"T1 负一"（带塔号前缀，100 个）
  //   2026-07 整理表  ：0004854438 → "18F东面步梯间"（楼层体系，35 个）
  // 两套卡号交集为 0。若把它们合并进同一张点位表，135 个点会被同时当成两个月的应巡分母：
  //   3 月：应巡 = 135 × 31 = 4185，实巡 2992 → 覆盖率被摊薄到 71.5%
  //   7 月：应巡 = 135 × 31 = 4185，实巡 1085 → 覆盖率被摊薄到 26%
  // **两个月的数字会同时算错**，比「只导一套点位」错得还隐蔽。
  //
  // 所以点位必须带 month 归属：month 为空表示「通用点位」（任何月份都参与分母，
  // 兼容用户只有一套点位表、要覆盖全部月份的老用法）；month = '2026-03' 表示
  // 只属于 3 月那一套卡号体系。分析某个月时优先用该月专属点位，没有才回退到通用点位。
  register(router, '/api/patrol/points', 'patrolPoints', {
    db, view: 'patrol:view', manage: 'patrol:manage', sort: 'sortKey',
    where(q) {
      return r => {
        if (q.route && r.route !== q.route) return false;
        if (q.status && r.status !== q.status) return false;
        // month=all 看全部；month=common 只看通用点位；month=scoped 只看按月归档的；
        // month=YYYY-MM 看该月专属 + 通用；不传则不按月份过滤
        if (q.month === 'all') return true;
        if (q.month === 'common') return !r.month;
        if (q.month === 'scoped') return !!r.month;
        if (q.month && /^\d{4}-\d{2}$/.test(q.month)) {
          if (r.month && r.month !== q.month) return false;
        }
        return true;
      };
    },
    async search(kw, where) {
      kw = String(kw).toLowerCase();
      return (await db.where('patrolPoints', where)).filter(p =>
        (p.name || '').toLowerCase().indexOf(kw) >= 0 ||
        (p.code || '').indexOf(kw) >= 0 ||
        (p.remark || '').toLowerCase().indexOf(kw) >= 0
      );
    },
    async validate(b) {
      if (!b.code) return '请填写卡号';
      const exist = (await db.one('patrolPoints', p => String(p.code) === String(b.code) && String(p.id) !== String(b.id || '')));
      if (exist) return '卡号已存在：' + b.code;
      return null;
    },
    beforeInsert(b) {
      if (!b.name) b.name = b.code;
      if (!b.status) b.status = '启用';
      b.sortKey = P.pointSortKey(b.name);
    },
    beforeUpdate(patch, before) {
      if (patch.name) patch.sortKey = P.pointSortKey(patch.name);
    },
    after(row, action, req) {
      const map = { insert: '新增巡更点位', update: '修改巡更点位', remove: '删除巡更点位' };
      audit.routeLog(db, req, '巡更检查', map[action] || '点位变更', { bizId: row.id, bizCode: row.code, detail: row.name });
    }
  });

  /* ===================== 2. 巡更人员（人员卡） ===================== */
  register(router, '/api/patrol/persons', 'patrolPersons', {
    db, view: 'patrol:view', manage: 'patrol:manage', sort: 'name',
    where(q) {
      return r => {
        if (q.shift && r.shift !== q.shift) return false;
        return true;
      };
    },
    async search(kw, where) {
      kw = String(kw).toLowerCase();
      return (await db.where('patrolPersons', where)).filter(p =>
        (p.name || '').toLowerCase().indexOf(kw) >= 0 || (p.code || '').indexOf(kw) >= 0
      );
    },
    async validate(b) {
      if (!b.code) return '请填写卡号';
      if (!b.name) return '请填写人员名称';
      const exist = (await db.one('patrolPersons', p => String(p.code) === String(b.code) && String(p.id) !== String(b.id || '')));
      if (exist) return '卡号已存在：' + b.code;
      return null;
    },
    beforeInsert(b) {
      if (!b.shift) b.shift = (b.name || '').indexOf('夜班') >= 0 ? '夜班' : ((b.name || '').indexOf('白班') >= 0 ? '白班' : '');
      if (!b.status) b.status = '在职';
    },
    after(row, action, req) {
      const map = { insert: '新增巡更人员', update: '修改巡更人员', remove: '删除巡更人员' };
      audit.routeLog(db, req, '巡更检查', map[action] || '人员变更', { bizId: row.id, bizCode: row.code, detail: row.name });
    }
  });

  /* ===================== 3. 巡查记录（查询 / 清空） ===================== */
  router.get('/api/patrol/records', async (req, res) => {
    if (!can(req, res, 'patrol:view')) return;
    const q = req.query;
    const win = windowOf(q);
    let rows = (await db.where('patrolRecords', r => {
      if (q.start && String(r.time) < q.start + ' 00:00:00') return false;
      if (q.end && String(r.time) > q.end + ' 23:59:59') return false;
      if (q.person && r.person !== q.person) return false;
      if (q.pointCode && r.pointCode !== q.pointCode) return false;
      if (q.shift) {
        const isNight = P.assignShiftDate(r, win) !== null;
        if (q.shift === '夜班' && !isNight) return false;
        if (q.shift === '白班' && isNight) return false;
      }
      if (q.keyword) {
        const k = String(q.keyword);
        if ((r.person || '').indexOf(k) < 0 && (r.pointName || '').indexOf(k) < 0 && (r.pointCode || '').indexOf(k) < 0) return false;
      }
      return true;
    }));
    rows.sort((a, b) => (b.timeAt || 0) - (a.timeAt || 0));
    const total = rows.length;
    const p = Math.max(1, Number(q.page) || 1), sz = Math.max(1, Math.min(2000, Number(q.size) || 20));
    const list = rows.slice((p - 1) * sz, p * sz).map(r => Object.assign({}, r, {
      shift: P.assignShiftDate(r, win) ? '夜班' : '白班',
      shiftDate: P.assignShiftDate(r, win) || String(r.time || '').slice(0, 10)
    }));
    ok(res, { list: list, total: total, page: p, size: sz });
  });

  router.post('/api/patrol/records/clear', async (req, res) => {
    if (!can(req, res, 'patrol:manage')) return;
    const n = (await db.count('patrolRecords'));
    db.clear('patrolRecords');
    audit.routeLog(db, req, '巡更检查', '清空巡查记录', { detail: '共清除 ' + n + ' 条' });
    ok(res, { cleared: n });
  });

  /* ===================== 4. 表格导入 ===================== */
  /**
   * 推断一批记录归属的月份（YYYY-MM）。
   *
   * 点位表要按月归档，但用户不会告诉我们「这批点位属于几月」——
   * 只能从数据本身推。两级推断：
   *   ① 记录本身的时间戳（最可靠，用户在同一个月里打卡）
   *   ② 文件名里的「3月」「2026-03」等字样（记录表缺失时的兜底）
   *
   * 【为什么取众数而不是第一条】一个文件里常混进相邻月的零星记录
   * （夜班跨日、月底补录），取众数才能代表主体月份。
   */
  function guessMonth(records, fileName) {
    const cnt = {};
    (records || []).forEach(r => {
      const m = String(r.time || '').slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(m)) cnt[m] = (cnt[m] || 0) + 1;
    });
    const keys = Object.keys(cnt);
    if (keys.length) {
      keys.sort((a, b) => cnt[b] - cnt[a]);
      // 主体月份至少要占 5 成，否则说明这个文件跨月太散，不可信
      if (cnt[keys[0]] >= (records.length || 1) * 0.5) return keys[0];
    }
    // 兜底：文件名。覆盖「3月巡更记录(3).xls」「2026-03巡查记录」这类命名
    const fn = String(fileName || '');
    let mm = fn.match(/(20\d{2})[-_年\/\.]?(\d{1,2})/);
    if (mm) return mm[1] + '-' + String(mm[2]).padStart(2, '0');
    mm = fn.match(/(\d{1,2})\s*月/);
    if (mm) {
      // 没有年份就用数据里出现过的年份；再退到当前年份
      let year = keys.length ? keys.sort()[0].slice(0, 4) : String(new Date().getFullYear());
      return year + '-' + String(mm[1]).padStart(2, '0');
    }
    return '';
  }

  // 通用：base64 -> Buffer -> readTable
  function readUploaded(body) {
    const b = body || {};
    if (!b.dataBase64) return { err: '缺少文件内容' };
    const m = String(b.dataBase64).match(/^data:([^;]+);base64,(.*)$/);
    const data = m ? m[2] : b.dataBase64;
    const buf = Buffer.from(data, 'base64');
    if (!buf.length) return { err: '文件内容为空' };
    let table;
    try { table = X.readTable(buf, b.fileName || ''); }
    catch (e) { return { err: e.message }; }
    if (!table.rows || !table.rows.length) return { err: '表格为空或无法识别' };
    return { table: table, buf: buf, fileName: b.fileName || 'import.xls' };
  }

  /**
   * 多 Sheet 工作簿里挑出最适合某种用途的那张表。
   *
   * 维序设备导出的 xls 把点位卡（Rpt_cardinfo）和巡更流水（Rpt_downdata）
   * 塞在同一个文件里，各 1 张表。只看「行数最多」对记录表是对的选择，
   * 但若用户把这个文件当**点位表**导入，行数最多的那张是流水表，解析不出点位。
   * 所以这里按用途逐张试解析，取成果最大的一张。
   */
  function pickSheet(table, kind) {
    const list = (table.sheets && table.sheets.length) ? table.sheets : [{ name: table.name, rows: table.rows }];
    if (list.length === 1) return { sheet: list[0], tried: 1 };
    let best = null;
    list.forEach(s => {
      // 【性能】先用「前 120 行」试解析打分，而不是全表。
      // 一张设备导出的流水表有 13000+ 行，全量 parseRecords 要跑好几秒，
      // 三张表逐个全量试一遍会让导入按钮看起来像卡死。
      // 120 行足够看出「这张表是不是那种表」，选表只需要相对比较，不需要精确条数。
      const probe = s.rows.length > 120
        ? s.rows.slice(0, 120)
        : s.rows;
      let score;
      if (kind === 'points') {
        const p = P.parsePoints(probe);
        // 点位表打分：识别出多少个卡就算多少（无论 probe 还是全量，同一列的表头一致）
        score = p.points.length + p.persons.length;
        // parsePoints 对记录表会直接判 is-record-table 返回 0，这里再兜一层
        if (p.mode === 'is-record-table') score = 0;
      } else {
        const r = P.parseRecords(probe);
        // 记录表打分：能解析出的行数（按 120 行等比放大，让长表胜出）
        score = r.records.length * (s.rows.length > 120 ? Math.ceil(s.rows.length / 120) : 1);
      }
      if (!best || score > best.score) best = { sheet: s, score: score };
    });
    return { sheet: best.sheet, tried: list.length, score: best.score };
  }

  /** 按用途取表：返回 { rows, sheetName, picked, total } */
  function rowsFor(table, kind) {
    const r = pickSheet(table, kind);
    return { rows: r.sheet.rows, sheetName: r.sheet.name, picked: r.tried > 1, total: r.tried };
  }

  // 保存原始文件到存储层（本地磁盘或七牛云），便于追溯
  let _att = null;
  async function keepFile(buf, prefix, fileName) {
    try {
      if (!_att) {
        const { AttStore } = require('../lib/attstore');
        _att = new AttStore(uploadDir);
      }
      const ext = path.extname(fileName || '') || '.xls';
      const name = prefix + '_' + uid('') + ext;
      const r = await _att.put(name, buf);
      return r.url;
    } catch (e) { return ''; }
  }

  /**
   * 把解析出的点位/人员卡写库（点位表导入与记录表顺带导入共用）。
   *
   * 【抽出来是因为必须复用】一体化导入后，导入「3月巡更记录」这一个动作会
   * 同时写记录和点位（点位藏在同一个 xls 的另一个 sheet 里）。
   * 如果这里各写一份，日后必然出现「导入按钮那条路径没带 month、
   * 另一个路径带了」的差异，表现为 3 月点位存成了通用点位、
   * 7 月覆盖率突然掉到 26%，极难排查。
   *
   * @param {{points:Array, persons:Array}} parsed parsePoints 的返回值
   * @param {string} month 点位归属月份；'' = 通用点位（任何月份都参与分母）
   * @returns {{addP:number,updP:number,addPer:number,updPer:number}}
   */
  async function savePoints(parsed, month) {
    const existCodes = {};
    (await db.where('patrolPoints')).forEach(p => { existCodes[p.code] = p; });
    const existP = {};
    (await db.where('patrolPersons')).forEach(p => { existP[p.code] = p; });

    let addP = 0, updP = 0, addPer = 0, updPer = 0;
    // for...of：循环体要 await 查重后的更新/新增
    for (const p of parsed.points) {
      const old = existCodes[p.code];
      if (old) {
        // month 一起更新：同一个卡号若被重新归档到别的月份，要跟着改。
        // 否则会出现「3 月点位 month=2026-03，但 7 月分析时它仍作为通用点位参与分母」。
        const patch = { name: p.name, remark: p.remark, route: p.route, routeOrder: p.routeOrder, sortKey: p.sortKey };
        if (month) patch.month = month;
        await db.update('patrolPoints', old.id, patch);
        updP++;
      } else {
        await db.insert('patrolPoints', {
          code: p.code, name: p.name, remark: p.remark, route: p.route,
          routeOrder: p.routeOrder, sortKey: p.sortKey,
          status: '启用', month: month || ''
        });
        addP++;
      }
    }
    for (const p of parsed.persons) {
      const old = existP[p.code];
      if (old) { await db.update('patrolPersons', old.id, { name: p.name, shift: p.shift }); updPer++; }
      else { await db.insert('patrolPersons', { code: p.code, name: p.name, shift: p.shift, status: '在职' }); addPer++; }
    }
    return { addP, updP, addPer, updPer };
  }

  // 导入点位表（同时抽出人员卡）
  router.post('/api/patrol/import/points', async (req, res) => {
    if (!can(req, res, 'patrol:import')) return;
    const r = readUploaded(req.body);
    if (r.err) return fail(res, r.err);
    const selP = rowsFor(r.table, 'points');
    const parsed = P.parsePoints(selP.rows);
    if (!parsed.points.length && !parsed.persons.length) {
      const asRecords = P.parseRecords(selP.rows);
      const sheetHint = selP.picked
        ? ('该文件有 ' + selP.total + ' 个工作表（' + r.table.sheetNames.join(' / ') + '），已自动选用「' + selP.sheetName + '」')
        : '';
      if (asRecords.records.length) {
        return fail(res, '这张表是巡查记录表，请改用「导入巡查记录表」。' + sheetHint);
      }
      return fail(res, '未能从表格中识别到点位/人员卡，请确认包含「卡号」「类型」「名称」列。' + sheetHint);
    }

    const mode = (req.body && req.body.mode) || 'replace';
    // 【覆盖模式只清同月份的点位】不能 db.clear 全表 —— 那会把其他月份的
    // 点位体系一起清掉。用户 3 月、7 月各导一次，第二个月就把第一个月的数据抹了。
    // 只导入了一个月（month 为空）时才允许全清，保持「只有一套点位」的清库语义。
    const month = (req.body && req.body.month) || '';
    if (mode === 'replace') {
      if (month) {
        const olds = await db.where('patrolPoints', p => p.month === month);
        for (const p of olds) await db.remove('patrolPoints', p.id);
      } else {
        db.clear('patrolPoints'); db.clear('patrolPersons');
      }
    }
    const cnt = await savePoints(parsed, month);

    const file = await keepFile(r.buf, 'patrol_points', r.fileName);
    (await db.insert('patrolBatches', {
      id: uid('pbt'), type: '点位表', fileName: r.fileName, fileUrl: file,
      time: now(), points: parsed.points.length, persons: parsed.persons.length,
      records: 0, month: month || '', mode: mode, operator: req.u ? req.u.name : ''
    }));
    audit.routeLog(db, req, '巡更检查', '导入巡更点位表', {
      detail: r.fileName + '：地点卡 ' + parsed.points.length + ' 个、人员卡 ' + parsed.persons.length + ' 个' +
        (month ? '（归属 ' + month + '）' : '（通用点位）')
    });
    ok(res, {
      fileName: r.fileName, sheet: selP.sheetName,
      points: parsed.points.length, persons: parsed.persons.length,
      added: cnt.addP, updated: cnt.updP,
      personAdded: cnt.addPer, personUpdated: cnt.updPer,
      month: month,          // '' = 通用点位（任何月份都参与覆盖率分母）
      mode: mode
    });
  });

  // 导入巡查记录
  router.post('/api/patrol/import/records', async (req, res) => {
    if (!can(req, res, 'patrol:import')) return;
    const r = readUploaded(req.body);
    if (r.err) return fail(res, r.err);
    const sel = rowsFor(r.table, 'records');
    const parsed = P.parseRecords(sel.rows);
    if (!parsed.records.length) {
      // 【诊断提示】同一家物业的两种导出格式差异极大，容易传错表。
      // 这里先判断「这张表其实是不是点位表」，直接告诉用户传错了，
      // 而不是只丢一句「未识别到记录」。
      const asPoints = P.parsePoints(sel.rows);
      const sheetHint = sel.picked
        ? ('该文件有 ' + sel.total + ' 个工作表（' + r.table.sheetNames.join(' / ') + '），已自动选用「' + sel.sheetName + '」')
        : '';
      if (asPoints.points.length || asPoints.persons.length) {
        return fail(res, '这张表是点位/人员卡表，请改用「导入巡更点位表」。' + sheetHint);
      }
      return fail(res, '未能从表格中识别到巡查记录。' + sheetHint +
        ' 巡查记录表需含「巡检时间」列，以及「巡点编码/地点编码」或「巡更点/地点名称」列（维序设备原始导出用「地点编码/地点名称/巡检员」，系统同样识别）。');
    }

    const mode = (req.body && req.body.mode) || 'append';
    if (mode === 'replace') db.clear('patrolRecords');

    // 【幂等去重】追加模式下按业务主键「巡检时间 + 点位卡号 + 人员」去重。
    //
    // 【为什么必须去重】原来是无条件 push，用户手滑把同一份文件追加导两次，
    // 就会凭空多出 13669 条一模一样的记录 —— 实巡点次翻倍、覆盖率虚高、
    // 人员统计翻倍，整份月报彻底失真，而界面只显示「导入成功 13669 条」，
    // 用户完全察觉不到。（实测就是这么攒出 34102 条的，真实唯一记录只有 20433 条。）
    //
    // 选这个主键的理由：
    //   · 巡检时间精确到秒，同一个人在同一秒、在同一个点位打两次卡在业务上不存在
    //   · 点位卡号唯一确定打卡位置，排除「同一时刻不同点位」的正常并发打卡
    //   · 人员区分不同保安，排除交接班同一时刻在同一点位的两次打卡
    // 若点位卡号为空（部分表没有编码列），退化为「时间 + 点位名称 + 人员」，
    // 仍能拦住重复导入。
    const dupKey = (x) => [
      x.time, (x.pointCode || x.pointName || ''), x.person || ''
    ].join('');
    const existed = {};
    // 【双引擎兼容】原来写的是 db.load('patrolRecords')，
    // 但那只在本地 JSON 引擎（lib/db.js）里有；云端引擎（lib/clouddb.js，DB_MODE=cloud）
    // 的 37 个方法里**根本没有 load** —— 于是云端一导入就抛
    //   TypeError: db.load is not a function
    // 前端 bindImport 的 catch 捕获后弹「导入异常：db.load is not a function」，
    // 用户看到的就是「网络异常 / 导入异常」，而真正的错误只留在服务端。
    // where() 两个引擎都支持且语义一致（返回该集合全部行），是唯一正确写法。
    (await db.where('patrolRecords')).forEach(x => { existed[dupKey(x)] = true; });
    let dupInBatch = 0;
    const fresh = [];
    parsed.records.forEach(x => {
      const k = dupKey(x);
      // 【这一行不能少】已入库过 → 跳过。
      // 少了它，同一份文件重复导出会逐条 push 进库：
      // 实测云端第1 次导 13669 条、第 2 次 dup=0 又导 13669、第 3 次再 13669，
      // total 一路涨到 41007，而接口每次都回「导入成功 13669 条」——
      // 实巡点次翻倍、完成率虚高，且 dup 字段永远是 0，用户完全看不出来。
      if (existed[k]) { dupInBatch++; return; }
      existed[k] = true;                          // 同时拦掉本次文件内部的自我重复
      fresh.push(x);
    });

    const rows = fresh.map(x => Object.assign({ id: uid('pr') }, x));
    // 【写入方式必须用 insertMany，不能用 load()+push()+persist()】
    //   · 本地引擎：insertMany 内部会落盘，等价于原来的 push
    //   · 云端引擎：persist() 是**空操作**（"云端每次写库即落"），
    //     所以原来的 push 全部丢在内存里，最后那次 persist 什么也没做，
    //     13669 条记录一条都没进 TiDB —— 接口却返回「导入成功」。
    // insertMany 在云端是真正分批 INSERT（每批 200 条），
    // 既避开了 TiDB Serverless 单请求体大小限制，又真的落库。
    const CHUNK = 2000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db.insertMany('patrolRecords', rows.slice(i, i + CHUNK));
    }
    const all = (await db.where('patrolRecords'));
    const times = all.map(x => String(x.time)).sort();

    /* ================= 一体化导入：同文件里的点位表一起吃进来 =================
     * 【为什么必须做】维序设备导出的 xls 把点位卡（Rpt_cardinfo）和巡更流水
     * （Rpt_downdata）放在**同一个文件**的不同 sheet 里。用户拿到的就是
     * 「3月巡更记录(3).xls」这一个文件，点位就在里面。
     * 如果只导记录，用户会发现覆盖率是 0%，然后不得不**再拿同一个文件导一次点位**
     * —— 而这两次导入必须都成功、系统还得记住「这批点位属于 3 月」，
     * 否则 3 月点位会污染 7 月的分母。操作繁琐且极易出错。
     *
     * 【归属月份怎么定】从这批记录的时间戳推断（guessMonth），点位存成该月专属。
     * 这样 3 月点位 month=2026-03、7 月点位 month=2026-07，两个月各自用自己的分母，
     * 覆盖率分别是 96.5% 和 100%，互不干扰。
     *
     * 【什么时候不导点位】
     *   · 文件里只有一张 sheet（就是整理好的单表导出）→ 没有额外点位可导
     *   · 用户显式带了 alsoPoints=false → 只要记录
     *   · 找不到能解析出点位的 sheet → 静默跳过，不影响记录导入
     */
    const month = guessMonth(parsed.records, r.fileName);
    let ptImport = null;
    if (req.body.alsoPoints !== false && r.table.sheets && r.table.sheets.length > 1) {
      const selPt = rowsFor(r.table, 'points');
      const pp = P.parsePoints(selPt.rows);
      // parsePoints 遇到记录表会判 is-record-table 返回 0，这里天然就排除了流水表
      if (pp.points.length || pp.persons.length) {
        const cntP = await savePoints(pp, month);
        ptImport = {
          sheet: selPt.sheetName, month: month,
          points: pp.points.length, persons: pp.persons.length,
          added: cntP.addP, updated: cntP.updP, personAdded: cntP.addPer, personUpdated: cntP.updPer
        };
      }
    } else if (req.body.alsoPoints !== false && month) {
      // 单 sheet 文件：也可能是「只含 Rpt_cardinfo 的点位导出」，此时 points 端点自己会处理。
      // 记录端点不做点位导入，避免把流水表当点位表。
    }

    const file = await keepFile(r.buf, 'patrol_records', r.fileName);
    (await db.insert('patrolBatches', {
      id: uid('pbt'), type: '记录表', fileName: r.fileName, fileUrl: file,
      time: now(),
      points: ptImport ? ptImport.points : 0,
      persons: ptImport ? ptImport.persons : 0,
      records: rows.length,
      month: month || '',       // 批次归属月份，点位也按它归档
      mode: mode, operator: req.u ? req.u.name : '',
      range: times.length ? (times[0].slice(0, 10) + ' ~ ' + times[times.length - 1].slice(0, 10)) : ''
    }));
    audit.routeLog(db, req, '巡更检查', '导入巡查记录', {
      detail: r.fileName + '：' + rows.length + ' 条' + (dupInBatch ? '（跳过重复 ' + dupInBatch + ' 条）' : '') +
        (ptImport ? '，同时导入点位卡 ' + ptImport.points + ' 个（归属 ' + month + '）' : '')
    });
    ok(res, {
      fileName: r.fileName, sheet: sel.sheetName,
      sheets: r.table.sheetNames || [],
      imported: rows.length, skipped: parsed.skipped, mode: mode,
      // dup=本次识别到多少条已存在的记录（同一份文件重复导入时会大于 0）
      dup: dupInBatch,
      detect: parsed.mode,          // header=读到表头 / inferred=按内容推断 / default=默认列位
      month: month,                 // 从记录时间戳推断出的批次归属月份
      // points=同文件里顺带导入的点位（设备导出把点位藏在另一个 sheet 的情况）
      points: ptImport,
      total: (await db.count('patrolRecords')),
      range: times.length ? (times[0] + ' ~ ' + times[times.length - 1]) : ''
    });
  });

  // 导入批次历史
  router.get('/api/patrol/batches', async (req, res) => {
    if (!can(req, res, 'patrol:view')) return;
    ok(res, (await db.where('patrolBatches')).sort((a, b) => String(b.time) < String(a.time) ? -1 : 1));
  });

/* ===================== 5. 分析 ===================== */
  /**
   * 取参与分母的点位。
   *
   * 【按月选点位】设备换过 / 重新发卡后，同一物业不同月份是两套卡号体系
   * （3 月 100 个塔号体系卡 vs 7 月 35 个楼层体系卡，交集为 0）。
   * 全并进来会让两个月的应巡分母都变成 135，两边覆盖率同时算错。
   *
   * 规则：
   *   · 该月有专属点位（month === 'YYYY-MM'）→ **只用这一套**，不叠加通用点位
   *   · 该月没有专属点位 → 用通用点位（month 为空），保证只有一套点位表的老数据照常工作
   *
   * @param {string} [month] 'YYYY-MM'；不传则返回全部点位（供点位管理页使用）
   * @returns {Promise<{list:Array, scoped:boolean, month:string|null, total:number}>}
   */
  async function loadPoints(month) {
    const all = (await db.where('patrolPoints', p => p.status !== '停用'))
      .sort((a, b) => (a.sortKey || 0) - (b.sortKey || 0) || (a.name < b.name ? -1 : 1));
    const m = /^\d{4}-\d{2}$/.test(String(month || '')) ? String(month) : '';
    if (!m) return { list: all, scoped: false, month: null, total: all.length };
    const scoped = all.filter(p => p.month === m);
    const common = all.filter(p => !p.month);
    // 【关键】该月有专属点位时，就**只用**这一套，不再叠加通用点位。
    //
    // 【踩过的坑】一开始写成「专属 + 通用」叠加，结果 3 月分母变成
    // 100（3月专属） + 35（7月留下的通用点位） = 135，
    // 应巡从 3100 涨到 4185、覆盖率从 96.5% 被摊薄到 71.5%。
    // 而那 35 个通用点位是**另一套卡号体系**（楼层体系），
    // 3 月的员工压根没在这些点位打过卡，计进分母就是凭空造出 1085 次假漏检。
    //
    // 语义澄清：通用点位的意思是「没有归属月份的、我自己维护的那批」，
    // 只有在**用户没有为该月单独导过点位**时才是分母。
    // 一旦用户为该月导了专属点位，就说明他知道这个月用的是哪套卡，
    // 此时专属点位就是该月分母的全部，不该再混入别的卡号体系。
    if (!scoped.length) return { list: common, scoped: false, month: null, total: all.length };
    return { list: scoped, scoped: true, month: m, total: all.length };
  }
  /** 只要点位数组的便捷包装（各分析端点统一调用） */
  async function pointsOf(month) {
    return (await loadPoints(month)).list;
  }
  async function loadRecords(start, end) {
    return (await db.where('patrolRecords', r => {
      const d = String(r.time || '').slice(0, 10);
      if (!d) return false;
      if (start && d < addDays(start, -1)) return false;   // 夜班跨日，往前多看一天
      if (end && d > addDays(end, 1)) return false;
      return true;
    }));
  }

  // 总览：夜班 / 白班 双口径
  router.post('/api/patrol/analyze', async (req, res) => {
    if (!can(req, res, 'patrol:analyze')) return;
    const b = req.body || {};
    const points = await pointsOf(b.month || String(b.start || '').slice(0, 7));
    if (!points.length) return fail(res, '尚未导入巡更点位，请先导入点位表');
    const records = await loadRecords(b.start, b.end);
    if (!records.length) return fail(res, '所选范围内没有巡查记录');
    const persons = (await db.where('patrolPersons'));
    const mode = b.mode === 'day' ? 'day' : 'night';
    const crew = mode === 'day'
      ? P.personNamesOf(persons, records, '白班')
      : P.personNamesOf(persons, records, '夜班');
    const r = P.analyze({
      points: points, records: records, start: b.start, end: b.end,
      mode: mode, nightPersons: crew, dayPersons: crew,
      window: windowOf(b)
    });
    ok(res, {
      mode: mode,
      start: b.start || '', end: b.end || '',
      window: r.window, windowText: r.windowText,
      // 夜班 5 时段口径（bySegment=false 时退回整夜去重，供对照）
      bySegment: r.bySegment, segments: r.segments, segmentText: r.segmentText,
      excludedNights: r.excludedNights,
      dataStart: r.dataStart, dataEnd: r.dataEnd,
      pointCount: points.length,
      recordCount: records.length,
      daily: r.daily.map(d => {
        const c = Object.assign({}, d); delete c.records; return c;
      }),
      monthly: r.monthly
    });
  });

  // 单日详情（含漏检点位与打卡明细）
  router.get('/api/patrol/daily', async (req, res) => {
    if (!can(req, res, 'patrol:view')) return;
    const q = req.query;
    const date = q.date || today();
    const mode = q.mode === 'day' ? 'day' : 'night';
    const points = await pointsOf(String(date).slice(0, 7));
    const records = await loadRecords(date, date);
    const persons = (await db.where('patrolPersons'));
    const crew = P.personNamesOf(persons, records, mode === 'day' ? '白班' : '夜班');
    const win = windowOf(q);
    const r = P.analyze({ points: points, records: records, start: date, end: date, mode: mode, nightPersons: crew, dayPersons: crew, window: win });
    const d = r.daily[0];
    if (!d) return ok(res, { date: date, mode: mode, empty: true, windowText: r.windowText, points: points, records: [] });
    ok(res, {
      date: date, mode: mode, empty: false, windowText: r.windowText,
      report: Object.assign({}, d, { records: undefined }),
      records: d.records.map(x => Object.assign({}, x, {
        shift: P.assignShiftDate(x, win) ? '夜班' : '白班',
        shiftDate: P.assignShiftDate(x, win) || String(x.time).slice(0, 10),
        pointName: x.pointName || (points.filter(p => p.code === x.pointCode)[0] || {}).name || ''
      }))
    });
  });

  // 月度汇总
  router.get('/api/patrol/monthly', async (req, res) => {
    if (!can(req, res, 'patrol:view')) return;
    const q = req.query;
    const m = q.month || monthOf();
    const start = m + '-01';
    const end = addMonths(start, 1);
    const mode = q.mode === 'day' ? 'day' : 'night';
    const ptSel = await loadPoints(m);          // 按月选点位：换过卡的月份用自己那套
    const points = ptSel.list;
    const records = await loadRecords(start, addDays(end, -1));
    const persons = (await db.where('patrolPersons'));
    const crew = P.personNamesOf(persons, records, mode === 'day' ? '白班' : '夜班');
    const r = P.analyze({
      points: points, records: records,
      start: mode === 'night' ? start : start, end: mode === 'night' ? addDays(end, -1) : addDays(end, -1),
      mode: mode, nightPersons: crew, dayPersons: crew,
      window: windowOf(q)
    });
    // 【卡号体系一致性诊断】同 overview：命中率过低时覆盖率不可解读，
    // 需提示「请导入该月对应的点位表」，否则用户只会看到 0% 却不知原因。
    let codeHitRate = null;
    if (points.length && records.length) {
      const known = {};
      points.forEach(p => { known[p.code] = true; });
      const hit = records.filter(r => r.pointCode && known[r.pointCode]).length;
      codeHitRate = Math.round(hit / records.length * 1000) / 10;
    }
    ok(res, {
      month: m, mode: mode, windowText: r.windowText,
      bySegment: r.bySegment, segments: r.segments, segmentText: r.segmentText,
      excludedNights: r.excludedNights, dataStart: r.dataStart, dataEnd: r.dataEnd,
      recordCount: records.length, codeHitRate: codeHitRate,
      // 本次分析用的是哪一套点位：scoped=true 表示命中了该月专属点位（pointMonth）
      pointCount: points.length, pointScope: ptSel.scoped ? 'month' : 'common',
      pointMonth: ptSel.scoped ? m : null,
      daily: r.daily.map(d => { const c = Object.assign({}, d); delete c.records; return c; }),
      monthly: r.monthly
    });
  });

  // 驾驶舱概览
  router.get('/api/patrol/overview', async (req, res) => {
    if (!can(req, res, 'patrol:view')) return;
    const pointsAll = await loadPoints();      // 计数用全量点位（管理视角）
    const persons = (await db.where('patrolPersons'));
    const all = (await db.where('patrolRecords'));
    const times = all.map(r => String(r.time || '')).filter(Boolean).sort();
    const nightCrew = P.personNamesOf(persons, all, '夜班');
    const lastDate = times.length ? times[times.length - 1].slice(0, 10) : '';
    // 统计月份：优先当月；当月无数据则取记录最多的月份（避免演示数据停留在历史月份时看板空白）
    const byMonth = {};
    all.forEach(r => {
      const m = String(r.time || '').slice(0, 7);
      if (m) byMonth[m] = (byMonth[m] || 0) + 1;
    });
    const curM = monthOf();
    const dataMonth = byMonth[curM] ? curM : (Object.keys(byMonth).sort((a, b) => byMonth[b] - byMonth[a])[0] || curM);
    const monthStart = dataMonth + '-01';
    const monthEnd = addMonths(monthStart, 1);
    // 最后一个「有夜班记录的班次日」：最后一条打卡常落在清晨，其自然日未必有夜班
    const shifts = P.buildNightShifts(all);
    const lastShiftDate = shifts.length ? shifts[shifts.length - 1].shiftDate : lastDate;
    const mRec = all.filter(r => { const d = String(r.time).slice(0, 10); return d >= monthStart && d < monthEnd; });
    // 【按月选点位】概览的统计月份是推断出来的，所以到这里才知道该用哪套卡号。
    // 换过设备的月份（3 月塔号体系 / 7 月楼层体系）用自己那套点位，
    // 否则 135 个点会同时当两个月的分母，两个月覆盖率一起算错。
    const ptSel = await loadPoints(dataMonth);
    const points = ptSel.list;
    const mr = points.length ? P.analyze({
      points: points, records: mRec,
      start: monthStart, end: addDays(monthEnd, -1), mode: 'night', nightPersons: nightCrew,
      window: windowOf(req.query)
    }) : null;

    // 最近 7 个夜班
    const recent = mr ? mr.daily.slice(-7).map(d => ({
      date: d.shiftDate, actual: d.totalActual, expected: d.totalExpected,
      missed: d.totalMissed, rate: d.coverageRate, persons: d.allPersonText
    })) : [];

    // 【卡号体系一致性诊断】
    // 覆盖率 = 打卡记录里的点位卡号，在点位表卡号里的命中比例。
    // 若点位表与记录来自两套不同体系（设备换过 / 重新发卡，点位名称也可能整套不同），
    // 命中率就是 0 → 覆盖率恒 0%、漏检数 = 全部点数，用户完全看不懂为什么。
    // 这里把命中率算出来，前端据此提示「请导入该月对应的点位表」，而不是让人对着 0% 猜。
    let codeHitRate = null;
    if (points.length && mRec.length) {
      const known = {};
      points.forEach(p => { known[p.code] = true; });
      const hit = mRec.filter(r => r.pointCode && known[r.pointCode]).length;
      codeHitRate = Math.round(hit / mRec.length * 1000) / 10;   // 保留一位小数
    }

    ok(res, {
      // pointCount 保持「全量点位总数」，是管理视角的存量
      pointCount: pointsAll.list.length,
      // monthPointCount 是本月实际参与分母的点数 —— 覆盖率的分母是这个，不是 pointCount
      monthPointCount: points.length,
      pointScope: ptSel.scoped ? 'month' : 'common',
      pointMonth: ptSel.scoped ? dataMonth : null,
      personCount: persons.length,
      nightCrew: nightCrew,
      recordCount: all.length,
      lastRecord: times.length ? times[times.length - 1] : '',
      lastShiftDate: lastShiftDate,
      month: dataMonth,
      dataMonth: dataMonth,
      windowText: mr ? mr.windowText : P.windowText(P.defaultWindow ? P.defaultWindow() : windowOf(null)),
      bySegment: mr ? mr.bySegment : false,
      segments: mr ? mr.segments : [],
      segmentText: mr ? mr.segmentText : '',
      excludedNights: mr ? (mr.excludedNights || []) : [],
      monthNights: mr ? mr.monthly.totalNights : 0,
      monthCoverage: mr ? mr.monthly.coverageRate : 0,
      monthMissed: mr ? mr.monthly.totalMissed : 0,
      monthPerfect: mr ? mr.monthly.perfectNights : 0,
      monthExpected: mr ? mr.monthly.totalExpected : 0,
      monthActual: mr ? mr.monthly.totalActual : 0,
      monthSegments: mr ? (mr.monthly.segments || []) : [],
      totalRounds: mr ? (mr.monthly.totalRounds || 0) : 0,
      totalCompleteRounds: mr ? (mr.monthly.totalCompleteRounds || 0) : 0,
      topMissed: mr ? mr.monthly.topMissed.slice(0, 5) : [],
      recent: recent,
      monthRecordCount: mRec.length,
      codeHitRate: codeHitRate,     // 点位卡号命中率 %，null = 无记录无法判断
      batches: (await db.where('patrolBatches')).sort((a, b) => String(b.time) < String(a.time) ? -1 : 1).slice(0, 5)
    });
  });

  /* ===================== 6. 导出 ===================== */
  router.get('/api/patrol/export', async (req, res) => {
    if (!can(req, res, 'patrol:export')) return;
    const q = req.query;
    const type = q.type || 'daily';
    const mode = q.mode === 'day' ? 'day' : 'night';
    // 导出也要按月选点位，否则换过卡的月份导出的「遗漏明细」分母是错的
    const expMonth = q.month || String(q.start || '').slice(0, 7) || '';
    const points = await pointsOf(expMonth);
    const persons = (await db.where('patrolPersons'));
    const crew = P.personNamesOf(persons, (await db.where('patrolRecords')), mode === 'day' ? '白班' : '夜班');
    const fmt = q.format === 'xls' ? 'xls' : 'csv';

    if (type === 'records') {
      const win = windowOf(q);
      const rows = (await db.where('patrolRecords', r => {
        if (q.start && String(r.time) < q.start + ' 00:00:00') return false;
        if (q.end && String(r.time) > q.end + ' 23:59:59') return false;
        return true;
      })).sort((a, b) => (a.timeAt || 0) - (b.timeAt || 0));
      const headers = [
        { title: '序号', key: 'seq' }, { title: '巡检时间', key: 'time' },
        { title: '班次', value: r => (P.assignShiftDate(r, win) ? '夜班' : '白班') },
        { title: '班次日', value: r => (P.assignShiftDate(r, win) || String(r.time).slice(0, 10)) },
        { title: '巡检器', key: 'device' }, { title: '巡点编码', key: 'pointCode' },
        { title: '巡更点', key: 'pointName' }, { title: '人员', key: 'person' }
      ];
      const name = '巡查记录_' + (q.start || '') + '_' + (q.end || '') + '.' + fmt;
      return sendDownload(res, name,
        fmt === 'xls' ? XE.toXls([{ name: '巡查记录', headers: headers, rows: rows }]) : XE.toCSV(headers, rows),
        fmt === 'xls' ? 'application/vnd.ms-excel' : 'text/csv');
    }

    // single：单日导出时范围收敛到当天（夜班跨日由 loadRecords 自动前后各放宽一天）
    const isDaily = type === 'daily';
    const single = isDaily ? (q.date || today()) : '';
    const start = isDaily ? single : (q.start || (q.month ? q.month + '-01' : monthOf() + '-01'));
    const end = isDaily ? single : (q.end || addDays(addMonths(start, 1), -1));
    const r = P.analyze({
      points: points, records: await loadRecords(start, end), start: start, end: end,
      mode: mode, nightPersons: crew, dayPersons: crew, window: windowOf(q)
    });

    if (type === 'monthly') {
      const useSeg = r.bySegment;
      const headers = [
        { title: '班次日', key: 'shiftDate' },
        { title: '当班人员', key: 'allPersonText' }
      ];
      // 时段口径：每段「实巡/应巡」两列，直观暴露哪一轮没巡满
      if (useSeg) {
        (r.segments || []).forEach(s => {
          headers.push({ title: s.segment + ' 实/应', value: d => {
            const x = (d.rounds || []).filter(y => y.round === s.segment)[0];
            return x ? (x.covered + '/' + x.should) : '0/0';
          } });
        });
      }
      headers.push(
        { title: '应巡点次', key: 'totalExpected', type: 'number' },
        { title: '实巡点次', key: 'totalActual', type: 'number' },
        { title: '漏巡点次', key: 'totalMissed', type: 'number' },
        { title: '完成率(%)', key: 'coverageRate', type: 'number' },
        { title: '打卡条数', key: 'recordCount', type: 'number' },
        { title: '首次打卡', key: 'firstTime' },
        { title: '末次打卡', key: 'lastTime' }
      );
      const sheets = [{
        name: mode === 'day' ? '白班日报' : '夜班日报',
        headers: headers, rows: r.daily
      }];

      // 第二张：各时段完成率汇总（时段口径才有）
      if (useSeg && (r.monthly.segments || []).length) {
        sheets.push({
          name: '时段完成率',
          headers: [
            { title: '时段', key: 'segment' },
            { title: '应巡点次', key: 'expected', type: 'number' },
            { title: '实巡点次', key: 'covered', type: 'number' },
            { title: '漏巡点次', key: 'missed', type: 'number' },
            { title: '完成率(%)', key: 'rate', type: 'number' },
            { title: '零打卡夜数', key: 'zeroNights', type: 'number' }
          ],
          rows: r.monthly.segments
        });
      }

      // 第三张：漏巡明细（班次日 × 时段 × 点位）
      sheets.push({
        name: '漏巡明细',
        headers: M_MISS_HEADERS, rows: missedDetailRows(r.daily)
      });

      // 第四张：人员统计
      sheets.push({
        name: '人员统计',
        headers: [
          { title: '人员', key: 'person' }, { title: '班次', key: 'shift' },
          { title: '当班次数', key: 'nights', type: 'number' },
          { title: '打卡条数', key: 'records', type: 'number' },
          { title: '覆盖点次', key: 'checked', type: 'number' },
          { title: '漏巡点次', key: 'missed', type: 'number' },
          { title: '完成率(%)', key: 'rate', type: 'number' }
        ],
        rows: r.monthly.personStats
      });

      // 第五张：口径说明（必须随报表走，避免下一个看到数字的人不知道怎么算的）
      const notes = [
        ['统计口径', ''],
        ['数据范围', (r.dataStart ? r.dataStart + ' ~ ' + r.dataEnd : '')],
        ['夜班窗口', '当日 18:30 ~ 次日 08:30'],
        ['时段划分', useSeg ? (r.segmentText || P.segmentDescriptions()) : '整夜去重（旧口径，仅供对照）'],
        ['时段归属', '次日 00:00-08:29 的打卡归属前一日夜班'],
        ['去重规则', '同一时段同一巡点打 2 次、3 次只记1 次有效（不跨时段去重）'],
        ['时段外记录', '白天 08:30-18:29 的打卡不计入夜班清查'],
        ['应巡基数', points.length + ' 个点位 × ' + ((r.monthly.totalRounds / Math.max(1, r.monthly.totalNights)) || 1) + ' 个时段 × ' + r.monthly.totalNights + ' 夜'],
        ['未纳入夜班', (r.excludedNights || []).length ? (r.excludedNights || []).join('、') : '无'],
        ['未纳入原因', '窗口（当日18:30~次日08:30）未完整落在数据范围内，纳入会产生假漏巡'],
        ['漏巡判定', '某夜某时段中，应巡点位没有有效打卡记录'],
        ['巡满天数', r.monthly.perfectNights + ' / ' + r.monthly.totalNights + ' 夜'],
        ['时段全巡满天数', r.monthly.totalCompleteRounds + ' / ' + r.monthly.totalRounds + ' 段']
      ];
      sheets.push({
        name: '口径说明',
        headers: [{ title: '项目', key: 'k' }, { title: '说明', key: 'v' }],
        rows: notes.map(x => ({ k: x[0], v: x[1] }))
      });

      const name = '巡更' + (mode === 'day' ? '白班' : '夜班') + '月报_' + start + '_' + end + '.' + fmt;
      return sendDownload(res, name,
        fmt === 'xls' ? XE.toXls(sheets) : XE.toCSV(headers, r.daily),
        fmt === 'xls' ? 'application/vnd.ms-excel' : 'text/csv');
    }

    // missed：只导出遗漏明细（对齐原小工具「导出遗漏明细到Excel」按钮）
    if (type === 'missed') {
      const rows = missedDetailRows(r.daily);
      const name = '巡更遗漏明细_' + start + '_' + end + '.' + fmt;
      return sendDownload(res, name,
        fmt === 'xls' ? XE.toXls([{ name: '遗漏明细', headers: M_MISS_HEADERS, rows: rows }]) : XE.toCSV(M_MISS_HEADERS, rows),
        fmt === 'xls' ? 'application/vnd.ms-excel' : 'text/csv');
    }

    // 单日明细（巡检明细 + 遗漏汇总，对齐原 Python 工具 export_daily_to_excel）
    const date = q.date || today();
    const dr = r.daily.filter(d => d.shiftDate === date)[0];
    if (!dr) return fail(res, '该日期没有' + (mode === 'day' ? '白班' : '夜班') + '记录：' + date);
    const detailHeaders = [
      { title: '序号', key: 'seq' }, { title: '巡检时间', key: 'time' },
      { title: '巡检器', key: 'device' }, { title: '巡点编码', key: 'pointCode' },
      { title: '巡更点', key: 'pointName' }, { title: '人员', key: 'person' }
    ];
    const missRows = missedDetailRows([dr]);
    const sheets = [
      { name: '巡检明细', headers: detailHeaders, rows: dr.records },
      { name: '遗漏汇总', headers: M_MISS_HEADERS, rows: missRows }
    ];
    const name = '巡更日报_' + date + '.' + fmt;
    sendDownload(res, name,
      fmt === 'xls' ? XE.toXls(sheets) : XE.toCSV(detailHeaders, dr.records),
      fmt === 'xls' ? 'application/vnd.ms-excel' : 'text/csv');
  });

  /* ===================== 7. 移动端：我的巡更 ===================== */
  router.get('/api/patrol/mine', async (req, res) => {
    if (!needLogin(req, res)) return;
    const name = req.u ? req.u.name : '';
    const win = windowOf(req.query);
    const all = (await db.where('patrolRecords'));
    const mine = all.filter(r => r.person === name || (name && r.person && r.person.indexOf(name) >= 0));
    const days = {};
    mine.forEach(r => {
      const d = P.assignShiftDate(r, win) || String(r.time).slice(0, 10);
      (days[d] || (days[d] = [])).push(r);
    });
    const list = Object.keys(days).sort().reverse().slice(0, 30).map(d => ({
      date: d, count: days[d].length,
      first: days[d][0].time, last: days[d][days[d].length - 1].time,
      points: Array.from(new Set(days[d].map(x => x.pointName || x.pointCode))).length
    }));
    ok(res, { name: name, total: mine.length, days: list });
  });
};
