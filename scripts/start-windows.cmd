@echo off
setlocal
set "APP_EXE=%~dp0..\release\win-unpacked\guanaitong-hub.exe"
if not exist "%APP_EXE%" (
  echo Windows build not found. Run npm run package first.
  pause
  exit /b 1
)
start "" "%APP_EXE%"
