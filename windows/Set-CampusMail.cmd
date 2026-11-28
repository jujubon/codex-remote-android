@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Set-CampusMail.ps1" %*
pause
