@echo off
setlocal
title 豆包分镜工作台 · 隔离开发版

rem ── 始终以脚本所在目录为根：双击、挪位置、从别处调用都成立 ──
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

rem ── 用通配查找运行时：不硬编码中文文件名，任何代码页下都能找到 ──
set "EXE="
for %%F in ("%ROOT%\runtime\dev\*.exe") do set "EXE=%%~fF"

set "ISO=%ROOT%\runtime\isolation\stable"
set "CHROMIUM=%ISO%\chromium"
set "APPDATA_DIR=%ISO%\DoubaoAccountManager"

if not defined EXE (
  echo [错误] 没有找到运行时：%ROOT%\runtime\dev\*.exe
  echo         这是开发副本，请先在项目里执行一次打包：
  echo         tools\pack-app.cjs --entry-file tools\supervised-entry.cjs
  echo.
  pause
  exit /b 1
)

rem ── 已在运行就不重复启动：多开会抢同一份隔离数据，导致页面/会话异常 ──
rem    判定用「可执行文件路径」而不是命令行文本：否则检测脚本的 powershell 进程
rem    会因为自己的命令行里含 isolation\stable\chromium 而误判成「已运行」。
rem    退出码：0=没在运行  10=隔离版在运行  11=开发版在运行但没带隔离参数
powershell -NoProfile -Command "$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -like '*\runtime\dev\*.exe' }; if (-not $all) { exit 0 }; if ($all | Where-Object { $_.CommandLine -like '*isolation\stable\chromium*' }) { exit 10 } else { exit 11 }"
if errorlevel 11 (
  echo [提示] 检测到开发版正在运行，但它不是本脚本启动的（可能没带隔离参数）。
  echo         为避免两套数据混在一起，请先关闭那个窗口，再运行本脚本。
  echo.
  pause
  exit /b 0
)
if errorlevel 10 (
  echo [提示] 隔离开发版已经在运行了，直接用已打开的窗口即可。
  echo         如果窗口找不到了，可在任务栏找「豆包管理器」；或先关掉它再运行本脚本。
  echo.
  pause
  exit /b 0
)

rem ── 隔离目录只在本脚本里存在，退出即失效，不会写进系统环境 ──
if not exist "%CHROMIUM%" mkdir "%CHROMIUM%" >nul 2>nul

echo 正在启动隔离开发版...
echo   程序     : %EXE%
echo   隔离根   : %ISO%
echo   应用数据 : %APPDATA_DIR%
echo   Chromium : %CHROMIUM%
echo.
echo 提示：进入应用后点顶栏「分镜工作台」。
echo       本脚本只影响隔离目录，不会读写正式版的数据。
echo.

set "DBM_ISOLATED_ROOT=%ISO%"
set "DBM_CHROMIUM_DIR=%CHROMIUM%"
start "" "%EXE%" "--user-data-dir=%CHROMIUM%"

echo 已启动。关闭应用窗口后，可用 tools\run-isolated.cjs --verify 复查隔离是否零改动。
timeout /t 6 >nul
endlocal