@echo off
setlocal
title 澜川Dola管理器 · 隔离开发版

rem 以脚本自身所在目录为根：双击即可用，无需改动任何绝对路径
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

rem 运行时目录：优先 dev2（在用、含最新构建），其次 dev
set "RUNTIME="
if exist "%ROOT%\runtime\dev2\*.exe" set "RUNTIME=%ROOT%\runtime\dev2"
if not defined RUNTIME if exist "%ROOT%\runtime\dev\*.exe" set "RUNTIME=%ROOT%\runtime\dev"

rem 可执行文件名：澜川Dola管理器.exe（同时兼容旧名 豆包管理器.exe）
set "EXE="
if defined RUNTIME for %%F in ("%RUNTIME%\*.exe") do set "EXE=%%~fF"

set "ISO=%ROOT%\runtime\isolation\stable"
set "CHROMIUM=%ISO%\chromium"
set "APPDATA_DIR=%ISO%\DoubaoAccountManager"

if not defined EXE (
  echo [错误] 没有找到运行时：%ROOT%\runtime\dev2\*.exe 或 %ROOT%\runtime\dev\*.exe
  echo        请先打包一次，例如在项目根目录执行：
  echo        tools\pack-app.cjs --entry-file tools\supervised-entry.cjs
  echo.
  pause
  exit /b 1
)

rem 防重复启动：同一份隔离数据只允许一个实例（多实例会抢占 webview/会话）
rem   判断用「可执行文件路径」而不是进程名，避免把自身子进程算进来；用 powershell 检测。
rem   命令行里含 isolation\stable\chromium 视为「本脚本启动」。
rem   退出码：0=没有运行  10=本脚本启动的实例在运行  11=其它副本在运行但没有隔离数据
powershell -NoProfile -Command "$all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -like '*\runtime\dev*\*.exe' }; if (-not $all) { exit 0 }; if ($all | Where-Object { $_.CommandLine -like '*isolation\stable\chromium*' }) { exit 10 } else { exit 11 }"
if errorlevel 11 (
  echo [提示] 检测到其它副本正在运行（不是本脚本启动的，也没有使用隔离数据目录）。
  echo        为避免污染隔离数据或抢占会话，请先关闭那个窗口，再运行本脚本。
  echo.
  pause
  exit /b 0
)
if errorlevel 10 (
  echo [提示] 隔离开发版已经在运行了：直接用它已打开的窗口即可。
  echo        如果需要换代码重新打包：请先关闭那个窗口，再运行本脚本。
  echo.
  pause
  exit /b 0
)

rem 隔离目录只在本脚本里出现，退出即失效，不会写入系统级配置
if not exist "%CHROMIUM%" mkdir "%CHROMIUM%" >nul 2>nul

echo 正在启动隔离开发版...
echo   程序     : %EXE%
echo   隔离数据 : %ISO%
echo   应用数据 : %APPDATA_DIR%
echo   Chromium : %CHROMIUM%
echo.
echo 提示：进入应用后点顶部「分镜工作台」按钮。
echo       本脚本只影响本目录，不会改动正式版与系统数据。
echo.

set "DBM_ISOLATED_ROOT=%ISO%"
set "DBM_CHROMIUM_DIR=%CHROMIUM%"
start "" "%EXE%" "--user-data-dir=%CHROMIUM%"

echo 若窗口意外关闭后，可用 tools\run-isolated.cjs --verify 检查是否读的是隔离目录。
timeout /t 6 >nul
endlocal