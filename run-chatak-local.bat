@echo off
title Chatak local server
REM Double-click to run Chatak locally. Leave this window open while testing.
REM Port 5080 is Chatak's own: Akatsuki uses 8092. Supabase's Redirect URLs list
REM http://localhost:5080/** - change the port and sign-in will bounce.
REM Same-origin trap: this port does NOT share localStorage with the other apps.
REM Supabase, signed in as the same user, is the only cross-app path.
cd /d "%~dp0"

set "PORT=5080"
set "ROOT=."
if not exist "%ROOT%\index.html" if exist "..\index.html" set "ROOT=.."
if not exist "%ROOT%\index.html" (
  echo Could not find index.html in this folder.
  echo Put this .bat in the same folder as index.html ^(your Chatak folder^).
  echo Current folder: %CD%
  pause & goto :eof
)
cd /d "%ROOT%"

if not exist "js\chatak-config.js" if exist "js\chatak-config.example.js" (
  copy /y "js\chatak-config.example.js" "js\chatak-config.js" >nul
  echo Created js\chatak-config.js from the example - paste your Supabase URL and anon key into it.
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
  echo     python -m http.server %PORT% --bind 127.0.0.1
  echo.
  pause & goto :eof
)

netstat -ano | findstr /r /c:"LISTENING.*:%PORT% " >nul 2>nul
if not errorlevel 1 (
  echo.
  echo Port %PORT% is already in use - an old Chatak window may still be open.
  echo Close it and double-click this file again.
  echo.
  pause & goto :eof
)

echo.
echo   Chatak - price tracker - local server
echo   Python:  %PY%
echo   Serving: %CD%    Open: http://localhost:%PORT%/
echo   (Close this window to stop.)
echo.

start "" "http://localhost:%PORT%/"
REM No-cache server if present, so a reload always gets the latest index.html.
if exist "scripts\serve-nocache.py" (
  "%PY%" "scripts\serve-nocache.py" %PORT%
) else (
  "%PY%" -m http.server %PORT% --bind 127.0.0.1
)

echo.
echo Server stopped.
pause
