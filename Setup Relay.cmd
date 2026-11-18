@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-relay.ps1" -SourceRoot "%~dp0." -Apply -InstallHerdr
if errorlevel 1 (
  echo.
  echo Setup stopped. Read the message above; existing data was kept.
  pause
  exit /b 1
)
echo.
echo Relay is ready. Open Start Relay.cmd in your Relay folder.
pause
