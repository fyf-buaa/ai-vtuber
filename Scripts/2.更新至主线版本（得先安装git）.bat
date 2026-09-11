@echo off
setlocal
pushd "%~dp0.."
where git >nul 2>nul || (
  echo Git is required. 1>&2
  popd
  exit /b 1
)
git pull --ff-only
set "UPDATE_EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %UPDATE_EXIT_CODE%
