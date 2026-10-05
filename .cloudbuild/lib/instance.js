'use strict';
/**
 * 单实例锁 —— 防止同一个数据目录被多个服务进程同时打开
 *
 * 背景：本系统的持久化是「内存 Map + 全量原子写 JSON」。单个进程内写操作是串行的，
 *   但如果两台电脑（同一个网络共享盘 / 同一个 Y 盘）各跑一套服务、指向同一个 data 目录，
 *   两边的内存缓存会互相覆盖：甲新增的租约会被乙的 persist() 全量重写抹掉。
 *   单进程无法解决跨机器的并发，必须用「数据目录级别的独占锁」挡住第二个实例。
 *
 * 锁文件：<dataDir>/.instance.lock
 *   内容：{ pid, host, port, startedAt, heartbeat }
 *   心跳：持有者每 10 秒更新一次文件修改时间
 *
 * 判定规则：
 *   1. 锁文件不存在            → 直接获得
 *   2. host 相同 + pid 存活     → 拒绝启动（同一台机器重复启动）
 *   3. host 不同 + 心跳新鲜      → 拒绝启动（另一台机器正在用这个数据目录）
 *   4. 心跳超过 45 秒未更新      → 判定为崩溃残留，自动接管
 *   5. 设置了 PLM_FORCE=1       → 强制接管（会打印醒目告警）
 *
 * 退出时（正常退出 / Ctrl+C / SIGTERM）自动释放锁。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HEARTBEAT_MS = 10000;   // 持有者心跳间隔
const STALE_MS = 45000;       // 心跳多久不更新算「进程已死」

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM = 进程存在但无权限探测
}

function readLock(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8').trim();
    if (!txt) return null;
    return JSON.parse(txt);
  } catch (e) { return null; }
}

function where() {
  let t = '';
  try {
    const os_ = require('os');
    const ni = os_.networkInterfaces();
    for (const k of Object.keys(ni)) {
      for (const it of ni[k] || []) {
        if (it.family === 'IPv4' && !it.internal) t = it.address;
      }
    }
  } catch (e) { }
  return t || '127.0.0.1';
}

/**
 * 申请数据目录独占锁
 * @param {string} dataDir 数据目录
 * @param {number} port    端口（仅记录，便于排查）
 * @param {boolean} quiet  true 时不打印横幅（自检脚本用）
 * @returns {{file:string, release:Function, beat:Function}}
 * @throws {Error} 已有活跃实例时抛错
 */
function acquire(dataDir, port, quiet) {
  const file = path.join(dataDir, '.instance.lock');
  const force = process.env.PLM_FORCE === '1';
  const cur = readLock(file);

  if (cur && !force) {
    const hbAge = Date.now() - (fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0);
    const sameHost = cur.host === os.hostname();
    const alive = sameHost ? pidAlive(cur.pid) : hbAge < STALE_MS;

    if (alive) {
      const who = sameHost
        ? '本机进程 PID ' + cur.pid + '（启动于 ' + cur.startedAt + '，端口 ' + (cur.port || '?') + '）'
        : '另一台机器 ' + cur.host + ' 的 PID ' + cur.pid + '（启动于 ' + cur.startedAt + '，端口 ' + (cur.port || '?') + '）';
      throw new Error(
        '数据目录已被占用，拒绝启动。\n' +
        '  数据目录：' + dataDir + '\n' +
        '  占用者  ：' + who + '\n' +
        '  说明    ：本系统为单进程独占式 JSON 存储，两套服务同时写同一目录会互相覆盖数据。\n' +
        '  解决办法：① 关掉占用者后重试；② 给本实例换一个数据目录（set DATA_DIR=D:\\...）；' +
        '③ 确认是残留锁时删除 ' + path.join(dataDir, '.instance.lock') + ' 或设置 PLM_FORCE=1 强制接管。'
      );
    }
    if (!quiet) {
      console.log('[LOCK] 检测到失效的残留锁（' + (cur.host || '?') + ' PID ' + cur.pid + '），已自动接管');
    }
  } else if (cur && force && !quiet) {
    console.log('[LOCK] PLM_FORCE=1 —— 强制接管已被 ' + (cur.host || '?') + ' PID ' + cur.pid + ' 占用的数据目录！');
  }

  const payload = {
    pid: process.pid,
    host: os.hostname(),
    ip: where(),
    port: port || 0,
    startedAt: new Date().toISOString(),
    root: dataDir
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');

  let released = false;
  function release() {
    if (released) return;
    released = true;
    const now = readLock(file);
    if (now && now.pid === process.pid && now.host === os.hostname()) {
      try { fs.unlinkSync(file); } catch (e) { }
    }
  }
  function beat() {
    if (released) return;
    const now = readLock(file);
    if (!now || now.pid !== process.pid) { released = true; return; }
    const t = new Date().toISOString();
    try { fs.writeFileSync(file, JSON.stringify(Object.assign({}, now, { heartbeat: t }), null, 2), 'utf8'); }
    catch (e) { }
  }

  const timer = setInterval(beat, HEARTBEAT_MS);
  if (timer.unref) timer.unref();
  process.on('exit', release);
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => {
    process.on(sig, () => { release(); process.exit(sig === 'SIGINT' ? 130 : 0); });
  });

  return { file: file, release: release, beat: beat };
}

module.exports = { acquire, pidAlive, where, HEARTBEAT_MS, STALE_MS };
