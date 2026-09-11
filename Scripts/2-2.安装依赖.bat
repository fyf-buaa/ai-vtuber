@echo off
setlocal
pushd "%~dp0.."

where node >nul 2>nul || (
  echo Node.js 22.19 or newer is required. 1>&2
  popd
  exit /b 1
)
where npm >nul 2>nul || (
  echo npm is required. 1>&2
  popd
  exit /b 1
)
node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=19)?0:1)" || (
  echo Node.js 22.19 or newer is required. 1>&2
  popd
  exit /b 1
)
if not exist "pi\package.json" (
  echo Vendored pi\package.json is missing. Restore the repository checkout. 1>&2
  popd
  exit /b 1
)

call npm run install:pi || goto failure
call npm ci --ignore-scripts || goto failure

echo Dependencies installed successfully.
popd
exit /b 0

:failure
set "INSTALL_EXIT_CODE=%ERRORLEVEL%"
echo Dependency installation failed. 1>&2
popd
exit /b %INSTALL_EXIT_CODE%
