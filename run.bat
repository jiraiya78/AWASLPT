@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set PORT=8765

echo.
echo  AWAS Alert — local test server
echo  ==================================
echo.
echo  This PC (browser):
echo    http://127.0.0.1:%PORT%/
echo.
echo  Phone / car Android player (same Wi-Fi):
call :print_lan_urls
echo.
echo  Note: some Android browsers need HTTPS for GPS.
echo  If GPS fails on LAN IP, use Demo from the menu, or the
echo  GitHub Pages URL: https://jiraiya78.github.io/AWASLPT/
echo.
echo  Press Ctrl+C in this window to stop the server.
echo  ==================================
echo.

start "" "http://127.0.0.1:%PORT%/"

where py >nul 2>&1
if %ERRORLEVEL%==0 (
  py -m http.server %PORT% --bind 0.0.0.0
  goto :eof
)

where python >nul 2>&1
if %ERRORLEVEL%==0 (
  python -m http.server %PORT% --bind 0.0.0.0
  goto :eof
)

where npx >nul 2>&1
if %ERRORLEVEL%==0 (
  npx --yes serve -l tcp://0.0.0.0:%PORT% .
  goto :eof
)

echo ERROR: Need Python or Node.js installed.
echo Install Python: https://www.python.org/downloads/
pause
goto :eof

:print_lan_urls
set FOUND=0
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /R /C:"IPv4 Address"') do (
  for /f "tokens=*" %%B in ("%%A") do (
    echo    http://%%B:%PORT%/
    set FOUND=1
  )
)
if "%FOUND%"=="0" (
  echo    ^(No LAN IPv4 found — check Wi-Fi^)
)
goto :eof
