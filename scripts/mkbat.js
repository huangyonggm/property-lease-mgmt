'use strict';
// 生成 Windows 启动脚本（强制 CRLF，避免 cmd.exe 解析失败）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const lines = [
  '@echo off',
  'chcp 65001 >nul',
  'title 物业不动产租赁管理系统',
  'cd /d "%~dp0"',
  '',
  'set "NODE_EXE="',
  'where node >nul 2>nul',
  'if %errorlevel%==0 set "NODE_EXE=node"',
  '',
  'if not defined NODE_EXE (',
  '  for %%F in ("%USERPROFILE%\\.workbuddy\\binaries\\node\\versions\\*\\node.exe") do set "NODE_EXE=%%~fF"',
  ')',
  '',
  'if not defined NODE_EXE if exist "J:\\Program Files\\nodejs\\node.exe" set "NODE_EXE=J:\\Program Files\\nodejs\\node.exe"',
  'if not defined NODE_EXE if exist "C:\\Program Files\\nodejs\\node.exe" set "NODE_EXE=C:\\Program Files\\nodejs\\node.exe"',
  '',
  'if not defined NODE_EXE (',
  '  echo [错误] 未找到 Node.js，请先安装 Node.js 18 及以上版本。',
  '  echo        或编辑本脚本，手动指定 NODE_EXE 路径。',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'echo ============================================================',
  'echo   物业不动产租赁管理系统',
  'echo ============================================================',
  'echo   Node  : %NODE_EXE%',
  'echo   PC 端 : http://localhost:8080/',
  'echo   移动端: http://localhost:8080/m.html',
  'echo   账号  : admin / 123456  （详见 README.md）',
  'echo ============================================================',
  'echo   关闭本窗口即停止服务。',
  'echo ============================================================',
  'echo.',
  '',
  'start "" http://localhost:8080/',
  '"%NODE_EXE%" server.js 8080',
  '',
  'echo.',
  'echo 服务已停止。按任意键关闭窗口。',
  'pause >nul'
];

const txt = lines.join('\r\n') + '\r\n';
fs.writeFileSync(path.join(ROOT, '启动系统.bat'), txt, { encoding: 'utf8' });
console.log('已生成 启动系统.bat（CRLF，' + Buffer.byteLength(txt) + ' 字节）');
