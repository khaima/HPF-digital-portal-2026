@echo off
REM Human Practice Foundation - Digital Portal launcher (Windows)
cd /d "%~dp0"
where py >nul 2>nul && ( py server.py %* & goto :eof )
where python >nul 2>nul && ( python server.py %* & goto :eof )
echo Python was not found. Install Python 3 from https://www.python.org/downloads/
pause
