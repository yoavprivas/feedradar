@echo off
pwsh -NoProfile -File "%~dp0Start-FeedRadar.ps1"
if errorlevel 1 pause
