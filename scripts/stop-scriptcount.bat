@echo off
rem ===================================================================
rem  Script Count - stop the background app
rem
rem  Removes the app from pm2. Entries are already saved in
rem  data\scriptcount.db, so stopping never loses anything.
rem
rem  Anything else still holding the port (for example a "npm start"
rem  window left open) is stopped as well.
rem ===================================================================

setlocal EnableExtensions EnableDelayedExpansion

set "APPDIR=E:\My Documents\abhishek-2\scriptcount"
set "APPNAME=scriptcount"
set "PORT=3010"

if exist "%APPDIR%\.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%APPDIR%\.env") do (
    if /i "%%a"=="PORT" set "PORT=%%b"
  )
)
set "PORT=%PORT: =%"

rem --- pm2 copy ("call" is required: pm2 is a .cmd) -------------------
where pm2 >nul 2>&1
if not errorlevel 1 (
  call pm2 describe %APPNAME% >nul 2>&1
  if not errorlevel 1 (
    echo Stopping %APPNAME% ...
    call pm2 delete %APPNAME% >nul 2>&1
  ) else (
    echo %APPNAME% is not running under pm2.
  )
)

rem --- anything else still on the port --------------------------------
rem  netstat lists the IPv4 and IPv6 rows of one listener separately, so
rem  keep a list of the PIDs already dealt with.
set "KILLED= "
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  if not "%%p"=="0" (
    echo !KILLED! | findstr /c:" %%p " >nul
    if errorlevel 1 (
      set "KILLED=!KILLED!%%p "
      echo Also stopping process %%p still on port %PORT% ...
      taskkill /PID %%p /F >nul 2>&1
    )
  )
)

echo Stopped.
ping -n 2 127.0.0.1 >nul
exit /b 0
