@echo off
REM Double-click this file to start the SEO Tag Analyzer.
cd /d "%~dp0"
title SEO Tag Analyzer

where python >nul 2>nul && (python server.py & goto :end)
where py >nul 2>nul && (py server.py & goto :end)
if exist "%USERPROFILE%\anaconda3\python.exe" ("%USERPROFILE%\anaconda3\python.exe" server.py & goto :end)

echo Could not find Python. Open "Anaconda Prompt", cd to this folder and run:  python server.py
:end
pause
