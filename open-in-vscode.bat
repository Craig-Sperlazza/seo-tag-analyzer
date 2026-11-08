@echo off
cd /d "%~dp0"
where code >nul 2>nul && (start "" code .) || (start "" "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" .)
