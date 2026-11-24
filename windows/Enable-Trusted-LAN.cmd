@echo off
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Start-CodexMobile.ps1" -EnableTrustedLan
pause
