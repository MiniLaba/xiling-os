[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA "XiLingOS")
)

$ErrorActionPreference = "Stop"
& "$PSScriptRoot\xiling-doctor.ps1" -DataRoot $DataRoot
if ($LASTEXITCODE -ne 0) { throw "Doctor checks failed" }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$env:XILING_DATA_ROOT = $DataRoot
Push-Location $repoRoot
try {
    if ($NoBrowser) { & pnpm.cmd start:no-browser } else { & pnpm.cmd start }
    if ($LASTEXITCODE -ne 0) { throw "Xi Ling OS exited with code $LASTEXITCODE" }
} finally { Pop-Location }
