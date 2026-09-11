@echo off
setlocal
pushd "%~dp0.."
call npm run backup
set "BACKUP_EXIT_CODE=%ERRORLEVEL%"
popd
pause
exit /b %BACKUP_EXIT_CODE%
