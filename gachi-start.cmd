@echo off
setlocal EnableExtensions

title Gachi CLI Swarm

set "RUNTIME_PORT=4010"
set "WEB_PORT=5180"

echo.
echo ==========================================
echo        Gachi CLI Swarm
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  goto :fail
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pnpm was not found in PATH.
  goto :fail
)

if not exist node_modules (
  echo [SETUP] Installing dependencies...
  call pnpm install
  if errorlevel 1 goto :fail
)

echo [CLEAN] Releasing required ports...
call :kill_port %RUNTIME_PORT%
call :kill_port %WEB_PORT%

echo.
echo [START] Runtime: http://127.0.0.1:%RUNTIME_PORT%
start "" /B cmd /C "call pnpm dev:runtime"

echo [WAIT] Waiting for runtime...
call :wait_port %RUNTIME_PORT% 30
if errorlevel 1 (
  echo [ERROR] Runtime did not start on port %RUNTIME_PORT%.
  goto :fail
)

echo [READY] Runtime is online.
echo [START] Web UI:  http://127.0.0.1:%WEB_PORT%
echo.

call pnpm dev:web
if errorlevel 1 goto :fail

exit /b 0


:kill_port
set "PORT=%~1"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$pids = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($pids) { foreach ($pidValue in $pids) { Write-Host ('[KILL] Port %PORT% -> PID ' + $pidValue); Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue } } else { Write-Host '[OK] Port %PORT% is free.' }"

timeout /t 1 /nobreak >nul
exit /b 0


:wait_port
set "PORT=%~1"
set "MAX_TRIES=%~2"
set /a TRY=0

:wait_port_loop
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$client = New-Object System.Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1', %PORT%); $client.Close(); exit 0 } catch { $client.Close(); exit 1 }"

if not errorlevel 1 exit /b 0

set /a TRY+=1
if %TRY% GEQ %MAX_TRIES% exit /b 1

timeout /t 1 /nobreak >nul
goto :wait_port_loop


:fail
echo.
echo [ERROR] Gachi CLI Swarm failed to start.
pause
exit /b 1
