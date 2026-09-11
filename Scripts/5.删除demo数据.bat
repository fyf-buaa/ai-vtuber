@echo off
setlocal
pushd "%~dp0.."
call npm run cleanup:demo -- --confirm-demo-cleanup
set "CLEANUP_EXIT_CODE=%ERRORLEVEL%"
popd
pause
exit /b %CLEANUP_EXIT_CODE%
