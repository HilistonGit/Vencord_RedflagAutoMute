@echo off
setlocal
cd /d "%~dp0"
rem Prevent PowerShell 7 module paths from hiding Windows PowerShell 5 modules.
set "PSModulePath="
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
 echo Installation failed. See the message above.
 pause
)
