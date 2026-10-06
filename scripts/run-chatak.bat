@echo off
title Chatak local server
REM Double-click to run Chatak locally. Leave this window open while testing.
REM
REM Location-agnostic: works whether this file sits in the repo root, in
REM scripts\, or one folder above the app. It searches for the app and serves
REM whichever folder holds it.

setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "PORT=5080"
set "ENTRY=index.html"

set "ROOT="
if exist "%ENTRY%"           set "ROOT=%CD%"
if not defined ROOT if exist "..\%ENTRY%"        pushd ".." & set "ROOT=!CD!" & popd
if not defined ROOT if exist "app\%ENTRY%"       pushd "app" & set "ROOT=!CD!" & popd
if not defined ROOT if exist "chatak\%ENTRY%"    pushd "chatak" & set "ROOT=!CD!" & popd

if not defined ROOT (
  echo.
  echo Could not find "%ENTRY%".
  echo.
  echo Looked in:
  echo   %CD%
  echo   %CD%\..
  echo   %CD%\app
  echo   %CD%\chatak
  echo.
  echo Put this .bat in the repo root or in its scripts\ folder.
  echo.
  pause & goto :eof
)

cd /d "%ROOT%"

if not exist "support.js" (
  echo.
  echo WARNING: support.js is missing from "%CD%".
  echo The page will load but the app will not render.
  echo.
)

REM --- Find a Python: PATH first, then common Anaconda/Miniconda locations ---
REM (double-clicking uses plain cmd, where conda's PATH is usually NOT active,
REM  so we look for python.exe directly.)
set "PY="
for %%P in (
  "python.exe"
  "%USERPROFILE%\anaconda3\python.exe"
  "%USERPROFILE%\miniconda3\python.exe"
  "%USERPROFILE%\AppData\Local\anaconda3\python.exe"
  "%USERPROFILE%\AppData\Local\miniconda3\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
  "C:\ProgramData\anaconda3\python.exe"
  "C:\ProgramData\miniconda3\python.exe"
) do (
  if not defined PY (
    "%%~P" -c "import sys" >nul 2>nul && set "PY=%%~P"
  )
)

if not defined PY (
  echo.
  echo Could not find Python automatically.
  echo Open "Anaconda Prompt", cd to this folder, and run:
  echo     python -m http.server %PORT%
  echo.
  pause & goto :eof
)

REM --- Warn if the port is already taken (a stale server from last time) ---
netstat -ano | findstr /r /c:"LISTENING.*:%PORT% " >nul 2>nul
if not errorlevel 1 (
  echo.
  echo Port %PORT% is already in use - another server may still be running.
  echo Close that window, or edit PORT at the top of this file.
  echo.
  pause & goto :eof
)

REM --- First run: create the config from the example. Never overwrites. ---
if not exist "js\chatak-config.js" if exist "js\chatak-config.example.js" (
  copy /y "js\chatak-config.example.js" "js\chatak-config.js" >nul
  echo Created js\chatak-config.js from the example - paste your Supabase URL and anon key into it.
)

REM --- Which data will the app show? ---
set "MODE=sample data - js\chatak-config.js is MISSING"
if exist "js\chatak-config.js" (
  set "MODE=sample data - no credentials in js\chatak-config.js yet"
  findstr /c:"url: ''" "js\chatak-config.js" >nul 2>nul
  if errorlevel 1 set "MODE=live Supabase data - credentials found"
)

set "OPENURL=http://localhost:%PORT%/"

echo.
echo   Chatak - local server
echo   Python:  %PY%
echo   Serving: %CD%
echo   Open:    %OPENURL%
echo   Data:    %MODE%
echo   (Close this window to stop.)
echo.

REM Open the browser a couple of seconds after the server binds, detached, so
REM the first request does not arrive before Python is listening.
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" "%OPENURL%""

REM Prefer the no-cache server: the stdlib one lets browsers serve a stale
REM index.html for hours, which looks exactly like "my changes did not land".
if exist "scripts\serve-nocache.py" (
  "%PY%" "scripts\serve-nocache.py" %PORT%
) else (
  "%PY%" -m http.server %PORT%
)

echo.
echo Server stopped.
pause
