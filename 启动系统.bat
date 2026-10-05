@echo off
chcp 65001 >nul
title PLM Launcher
cd /d "%~dp0"
setlocal enabledelayedexpansion

rem ============================================================
rem  Property Lease Management System - one-click launcher
rem
rem  This .bat is intentionally 100% ASCII. All Chinese text lives
rem  in scripts/launcher.js, which Node prints reliably.
rem
rem  WHY ASCII-ONLY (learned the hard way):
rem  cmd.exe reads .bat files byte-by-byte using seek offsets that
rem  were computed for the ORIGINAL code page. After "chcp 65001"
rem  the already-open file holds 3-byte UTF-8 sequences, so the
rem  reader lands mid-character and the rest of the line is parsed
rem  as a command. Symptom: a Chinese echo line becomes
rem  "'xxx' is not recognized as an internal or external command",
rem  usually on the line right after another Chinese echo.
rem  ASCII-only sidesteps the entire class of bugs.
rem
rem  OTHER RULES:
rem  - File must be CRLF (editors write LF by default, breaks blocks).
rem  - Sleep with "ping -n N 127.0.0.1", NOT "timeout /t N":
rem    Git Bash ships GNU coreutils "timeout" that shadows
rem    System32\timeout.exe on PATH -> "invalid time interval".
rem  - Use "set /p", NOT "choice": choice reads the console directly
rem    and returns nothing when stdin is piped or redirected.
rem ============================================================

set "PORT=8080"
set "NODE_EXE="

rem ---------- 1. locate node ----------
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE for %%F in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*\node.exe") do set "NODE_EXE=%%~fF"
if not defined NODE_EXE if exist "J:\Program Files\nodejs\node.exe" set "NODE_EXE=J:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"

if not defined NODE_EXE goto NO_NODE

rem ---------- 2. hand off to the Node launcher ----------
rem The Node launcher runs the server IN THIS PROCESS (it requires
rem server.js directly). So this window IS the server window:
rem closing it stops the service. Do NOT add "pause" here - the
rem launcher never returns while the server is running.
"%NODE_EXE%" "%~dp0scripts\launcher.js" %PORT%
set "RC=%errorlevel%"
if not "%RC%"=="0" pause
exit /b %RC%

rem ---------- fallbacks (ASCII only) ----------

:NO_NODE
echo.
echo [ERROR] Node.js not found.
echo         Install Node.js 18+ or edit this file to set NODE_EXE.
echo.
pause
exit /b 1
