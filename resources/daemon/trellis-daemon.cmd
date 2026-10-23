@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\Trellis Panel.exe" "%~dp0..\app.asar.unpacked\out\main\daemon-cli.js" %*
exit /b %errorlevel%
