@echo off
setlocal
pushd "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.19 or newer is required. 1>&2
  popd
  exit /b 1
)
node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=19)?0:1)" || (
  echo Node.js 22.19 or newer is required. 1>&2
  popd
  exit /b 1
)


where npm >nul 2>nul
if errorlevel 1 (
  echo npm is required. 1>&2
  popd
  exit /b 1
)
set "FIRST_START_ARG=--open-webui"

:run
call npm run start -- %FIRST_START_ARG% %*
set "APP_EXIT_CODE=%ERRORLEVEL%"
set "FIRST_START_ARG="
if "%APP_EXIT_CODE%"=="75" goto run

popd
exit /b %APP_EXIT_CODE%
