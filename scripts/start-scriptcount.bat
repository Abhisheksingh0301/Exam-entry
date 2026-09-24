@echo off
rem ===================================================================
rem  Script Count - start the app in the background with pm2
rem
rem  Double-click each morning. pm2 keeps the app running (and restarts
rem  it if it crashes) without a console window. Click it again later
rem  and it simply restarts the app, picking up any code changes.
rem
rem  NOTE: this deliberately does NOT run "pm2 startup" or "pm2 save",
rem  so nothing is registered to launch at Windows boot.
rem
rem  Optional argument:  nobrowser   - start without opening the browser
rem ===================================================================

setlocal EnableExtensions

set "APPDIR=E:\My Documents\abhishek-2\scriptcount"
set "APPNAME=scriptcount"
set "PORT=3010"

if not exist "%APPDIR%\bin\www" (
  echo.
  echo  Cannot find the app at:
  echo    %APPDIR%
  echo  Edit APPDIR at the top of this file.
  echo.
  pause
  exit /b 1
)

cd /d "%APPDIR%"

rem --- port comes from .env so this stays in step with the app --------
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="PORT" set "PORT=%%b"
  )
)
set "PORT=%PORT: =%"

rem --- pm2 must be on PATH (npm i -g pm2) -----------------------------
where pm2 >nul 2>&1
if errorlevel 1 (
  echo.
  echo  pm2 was not found. Install it once with:
  echo      npm install -g pm2
  echo.
  pause
  exit /b 1
)

rem --- known to pm2 already? restart it, else start it -----------------
rem  ("call" is required: pm2 is a .cmd, and without it this script ends
rem   right here instead of carrying on.)
call pm2 describe %APPNAME% >nul 2>&1
if errorlevel 1 (
  echo Starting %APPNAME% on port %PORT% ...
  call pm2 start ".\bin\www" --name %APPNAME% --cwd "%APPDIR%" --time
) else (
  echo Restarting %APPNAME% on port %PORT% ...
  call pm2 restart %APPNAME% --update-env
)

if errorlevel 1 (
  echo.
  echo  pm2 could not start the app. Check the log with:
  echo      pm2 logs %APPNAME%
  echo.
  pause
  exit /b 1
)

rem --- wait for it to answer (up to ~20s) ------------------------------
set /a tries=0
:wait
set /a tries+=1
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 goto ready
if %tries% GEQ 20 (
  echo.
  echo  The app is not listening on port %PORT%. Check:
  echo      pm2 logs %APPNAME% --err
  echo.
  pause
  exit /b 1
)
ping -n 2 127.0.0.1 >nul
goto wait

:ready
echo.
echo  Running: http://localhost:%PORT%/qp
echo  Logs   : pm2 logs %APPNAME%      Stop: stop-scriptcount.bat
echo.
if /i not "%~1"=="nobrowser" start "" "http://localhost:%PORT%/qp"
exit /b 0
