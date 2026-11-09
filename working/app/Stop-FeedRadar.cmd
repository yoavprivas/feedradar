@echo off
pwsh -NoProfile -File "%~dp0Stop-FeedRadar.ps1" -StopDatabase
if errorlevel 1 pause
