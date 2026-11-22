@echo off
setlocal
set "READER_URL=http://127.0.0.1:8788/"
set "READER_EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%READER_EDGE%" set "READER_EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%READER_EDGE%" (
    start "" "%READER_EDGE%" --app=%READER_URL% --window-size=420,820
) else (
    start "" "%READER_URL%"
)
