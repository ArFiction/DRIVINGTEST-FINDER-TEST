@echo off
REM One-command local setup for Windows.
REM Double-click this file, or run it from a terminal in the repo folder.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node is not installed. Get it from https://nodejs.org ^(v20+^), then re-run this.
  pause
  exit /b 1
)
echo ==^> Node found.

echo ==^> Installing dependencies ^(npm install^)...
call npm install || goto :err

echo ==^> Installing Google Chrome for Playwright...
call npx playwright install chrome || goto :err

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo ==^> Created .env from the template.
  echo.
  echo NEXT: open the .env file and fill in your details:
  echo   DVSA_LICENCE_NUMBER, DVSA_THEORY_NUMBER, DVSA_TEST_CENTRE, NTFY_TOPIC
  echo.
  echo Then test it with:   npm run local:now
) else (
  echo ==^> .env already exists; leaving it as-is.
  echo Test the checker with:   npm run local:now
)
pause
exit /b 0

:err
echo Something went wrong during setup. Scroll up to see the error.
pause
exit /b 1
