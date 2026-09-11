Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js 22.19 or newer is required.'
    }
    $nodeVersion = [version]((& node --version).TrimStart('v'))
    if ($nodeVersion -lt [version]'22.19.0') {
        throw 'Node.js 22.19 or newer is required.'
    }

    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'npm is required.'
    }

    $firstStart = $true
    do {
        if ($firstStart) {
            & npm.cmd run start -- '--open-webui' @args
            $firstStart = $false
        }
        else {
            & npm.cmd run start -- @args
        }
        $appExitCode = $LASTEXITCODE
    } while ($appExitCode -eq 75)

    exit $appExitCode
}
finally {
    Pop-Location
}
