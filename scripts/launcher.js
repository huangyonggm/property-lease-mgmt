#!/usr/bin/env node
/* =====================================================================
 * 物业不动产租赁管理系统 —— 一键启动器
 *
 * 为什么要有这个文件：Windows 的 .bat 装不下中文提示。
 * cmd.exe 是按字节偏移读 bat 文件的，`chcp 65001` 之后文件里是 3 字节
 * UTF-8 序列，读指针会落在字符中间，导致后面半行被当成命令执行
 * （典型报错：'xxx' 不是内部或外部命令）。所以 bat 保持纯 ASCII，
 * 所有中文都交给 Node 输出 —— Node 处理 UTF-8 是可靠的。
 *
 * 职责：
 *   1. 检查端口占用（提前拦下并给出可执行建议）
 *   2. 在独立窗口启动服务（关窗口即停）
 *   3. 轮询 /api/health 等待真正就绪
 *   4. 就绪后才打开浏览器（避免"无法访问此页面"）
 *
 * 用法：node scripts/launcher.js [端口]   默认 8080
 * 退出码：0 正常（服务已在后台运行）  1 失败  2 用户取消
 * ===================================================================== */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
let PORT = Number(process.argv[2] || process.env.PORT || 8080);
const BASE_PORT = PORT;      // bat 里指定的「首选端口」
const MAX_PORT_TRY = 20;     // 最多顺延 20 个端口

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m'
};
const say = (...a) => console.log(...a);
const line = (ch = '=') => console.log(ch.repeat(62));

/* ---------- 端口占用检测 ----------
 * 【重要】本机所有 child_process spawn 方式（execSync / execFileSync /
 * spawnSync+shell / 直接跑 netstat.exe / 包 cmd /c）全部抛 EBUSY，
 * 是环境级的子进程拦截，不是代码问题。因此**不能**用 netstat 查端口。
 *
 * 改用 net.createServer().listen() 试探：能 bind 就是空闲，EADDRINUSE
 * 就是被占。零依赖、零 spawn、跨平台。
 *
 * 【坑】必须 listen(port, '::') 而不是 '0.0.0.0'。
 * server.js 监听 '::'（IPv6 双栈，为了让浏览器能访问 localhost ——
 * Windows 上 localhost 优先解析成 ::1）。用 0.0.0.0 试 bind 时
 * 双栈监听不冲突，会误报「空闲」，于是占着端口也检测不出来。
 *
 * 【设计】拿不到占用进程 PID（spawn 被拦），所以不提供「一键结束」
 * 按钮，改为告知用户去关掉那个窗口 —— 反正关窗口才是他们要做的动作。 */
const net = require('net');

function isPortBusy(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '::');
  });
}

/* ---------- 自动顺延找空闲端口 ----------
 * 从 fromPort 起最多试 maxTry 个（8080 → 8081 → 8082 ...）。
 * 用户不该为「8080 被上一个实例占着」这种事做决策 —— 自动换一个继续跑。
 * 返回 null 表示这一段范围全被占（极端情况，通常意味着有程序在批量扫端口）。 */
async function findFreePort(fromPort, maxTry = 20) {
  for (let i = 0; i < maxTry; i++) {
    const p = fromPort + i;
    if (!(await isPortBusy(p))) return p;
  }
  return null;
}

/* ---------- 检测「本系统是否已在运行」 ----------
 * data/.instance.lock 里记了 pid / host / port / startedAt，
 * 由 server.js 定期刷新心跳（mtime）。
 *
 * 【为什么不靠端口判断】本系统是单进程独占式 JSON 存储 ——
 * 两个实例同时写同一份 data 会互相覆盖数据。所以真正要问的不是
 * 「8080 忙不忙」，而是「数据目录是不是已经有人在用了」。
 * 端口空闲但锁活着（服务跑在 8081）时，照样不能开第二个。
 *
 * 返回 null 表示没在跑；否则返回 {pid, port} —— port 可能是 0/NaN
 * （旧版本锁文件没记端口），调用方要能兜住。 */
function readRunningInstance() {
  const file = path.join(ROOT, 'data', '.instance.lock');
  if (!fs.existsSync(file)) return null;
  let cur;
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  if (!cur || !cur.pid) return null;

  // 心跳超过 30 分钟视为失效（server.js 会定期刷新 mtime）
  const STALE_MS = 30 * 60 * 1000;
  let alive;
  if (cur.host === os.hostname()) {
    // 同机：直接问系统这个 PID 还在不在（不 spawn，纯原生）
    alive = pidAlive(cur.pid);
  } else {
    alive = (Date.now() - fs.statSync(file).mtimeMs) < STALE_MS;
  }
  if (!alive) return null;
  return { pid: cur.pid, port: Number(cur.port) || 0, startedAt: cur.startedAt };
}

/* 查 PID 是否存活：process.kill(pid, 0) 抛 ESRCH 才算死。
 * 【坑】不能 spawn tasklist —— 本机所有 spawn 都 EBUSY。 */
function pidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // EPERM = 存在但无权限（SYSTEM 进程）
}

/* ---------- 健康探测 ----------
 * 必须用 /api/health（永远 200）。/api/auth/me 未登录返回 401，
 * 会被误判成「服务没起来」。127.0.0.1 而非 localhost，避开 IPv6 解析。 */
function probe() {
  return new Promise(resolve => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 2000 },
      res => { res.resume(); resolve(res.statusCode === 200); }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 打开浏览器 ----------
 * 异步 spawn 拉浏览器在本机不稳定（EBUSY / SIGTERM，见上）。
 * 失败不阻塞流程 —— 反正地址已经打印出来了，用户自己点/复制即可。 */
function openBrowser(url) {
  return new Promise(resolve => {
    let p;
    try {
      p = spawn(process.env.COMSPEC || 'cmd.exe',
        ['/c', 'start', '""', url],
        { detached: true, stdio: 'ignore', windowsHide: true });
      p.on('error', () => resolve(false));
      p.unref();
    } catch (e) {
      resolve(false);
      return;
    }
    setTimeout(() => resolve(true), 800);
  });
}

/* ---------- 主流程 ---------- */
(async function main() {
  say('');
  line();
  say(`  ${C.bold}物业不动产租赁管理系统${C.reset}`);
  line();

  // 1) 本系统是否已在运行？
  //    独占式 JSON 存储不允许两个实例，所以「已在跑」时不该报错 ——
  //    直接把已有实例的页面打开就够了，用户想看的就是系统。
  const running = readRunningInstance();
  if (running) {
    const knownPort = running.port && running.port > 0 ? running.port : null;
    let target = null;
    if (knownPort && !(await isPortBusy(knownPort))) {
      target = `http://localhost:${knownPort}/`;
    } else {
      // 锁里没记端口 / 端口对不上（服务刚起、锁还没刷新等）——
      // 扫一段范围找那个真正活着且响应 /api/health 的端口。
      for (let p = BASE_PORT; p < BASE_PORT + MAX_PORT_TRY; p++) {
        if (await isPortBusy(p)) { target = `http://localhost:${p}/`; break; }
      }
    }
    say('');
    say(`  ${C.yellow}[提示]${C.reset} 本系统已经在运行了${knownPort ? `（端口 ${knownPort}，PID ${running.pid}）` : ''}。`);
    if (target) {
      say(`  ${C.dim}正在为你打开已有实例 ...${C.reset}`);
      await openBrowser(target);
    } else {
      say(`  ${C.dim}（未找到它的监听端口，可能正在启动，请稍等几秒再双击本文件）${C.reset}`);
    }
    say('');
    say(`  ${C.dim}提示：无需重复启动。关掉那个 [PLM Launcher] 窗口才会停止服务。${C.reset}`);
    say('');
    return 0;
  }

  // 2) 端口检查 —— 被别的程序占用就自动顺延，不打断用户
  if (await isPortBusy(PORT)) {
    say('');
    say(`  ${C.yellow}端口 ${PORT} 被其他程序占用，正在自动换端口 ...${C.reset}`);
    const free = await findFreePort(PORT + 1, MAX_PORT_TRY);
    if (free === null) {
      say('');
      say(`  ${C.red}[错误]${C.reset} 端口 ${C.bold}${PORT}~${PORT + MAX_PORT_TRY - 1}${C.reset} 全被占用，找不到可用端口。`);
      say(`  ${C.dim}请关掉占用端口的程序后重试，或编辑 启动系统.bat 顶部的 set "PORT=..." 换一个区间。${C.reset}`);
      say('');
      return 1;
    }
    say(`  ${C.green}已自动改用端口 ${free}${C.reset}`);
    PORT = free;
    await sleep(600);   // 停一下让用户看清实际用的哪个地址
  }

  // 3) 就在当前进程里启动服务（不 spawn 子进程）
  //
  // 【为什么不用 spawn 拉独立窗口】本机（用户 Windows + 安全软件）对
  // child_process 拦截很严：spawnSync/execFileSync 跑任何 exe 都 EBUSY；
  // 异步 spawn detached 拉 GUI 窗口则整个父进程被 SIGTERM。
  // 与其跟环境对抗，不如让 launcher 自己把服务跑起来 ——
  // bat 窗口本来就是服务窗口，关掉它服务自然停，语义完全正确。
  say('');
  say(`  ${C.dim}正在启动服务 ...${C.reset}`);
  process.argv[2] = String(PORT);          // server.js 从 argv[2] 读端口
  process.chdir(ROOT);
  require(path.join(ROOT, 'server.js'));  // 同步执行，server.js 内部 listen 后继续跑事件循环

  // 4) 轮询等待就绪（最多 40 秒）
  let ready = false;
  process.stdout.write(`  ${C.dim}等待服务就绪`);
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (await probe()) { ready = true; break; }
    if (i % 3 === 2) process.stdout.write('.');
  }
  process.stdout.write('\r\x1b[K');

  if (!ready) {
    say('');
    say(`  ${C.red}[错误]${C.reset} 服务在 40 秒内没有就绪，请看上方日志排查。`);
    say('');
    return 1;
  }

  // 5) 就绪后才开浏览器
  const url = `http://localhost:${PORT}/`;
  say(`  ${C.green}[就绪]${C.reset} 服务已启动，正在打开浏览器 ...`);
  await openBrowser(url);

  say('');
  line('-');
  say(`  ${C.bold}PC 端${C.reset}  : ${C.cyan}${url}${C.reset}`);
  say(`  ${C.cyan}http://localhost:${PORT}/m.html${C.reset}${C.dim}   <- 移动端${C.reset}`);
  say(`  ${C.dim}账号  : admin / 123456  （其他角色见 README.md）${C.reset}`);
  if (PORT !== BASE_PORT) {
    say('');
    say(`  ${C.yellow}注意：${C.reset}首选端口 ${BASE_PORT} 被占用，本次自动改用 ${C.bold}${PORT}${C.reset}。`);
    say(`  ${C.dim}      浏览器会自动打开正确地址；书签建议存上面这个。${C.reset}`);
  }
  say('');
  say(`  ${C.yellow}关闭本窗口即停止服务。${C.reset}`);
  line('-');
  say('');
  // 不 process.exit —— 服务还在这个进程里跑着
  return null;
})().then(rc => {
  if (rc !== null) process.exit(rc);
  // rc === null：服务已在本进程运行，让事件循环继续
}).catch(err => {
  console.error(`\n  [FATAL] 启动器异常：${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
