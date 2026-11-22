@echo off
setlocal
set "READER_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
start "" "%READER_PS%" -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "%~dp0Phone-Reading-Window.ps1"
