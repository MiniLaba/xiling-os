[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "Medium")]
param([string]$DataRoot = (Join-Path $env:LOCALAPPDATA "XiLingOS"))

$ErrorActionPreference = "Stop"
& "$PSScriptRoot\xiling-doctor.ps1" -DataRoot $DataRoot
if ($LASTEXITCODE -ne 0) { throw "Doctor checks failed" }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ($PSCmdlet.ShouldProcess($repoRoot, "Install locked Xi Ling OS dependencies and create native data directories")) {
    foreach ($name in @("projects", "artifacts", "cache", "database", "logs", "runtime")) {
        New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot $name) | Out-Null
    }
    Push-Location $repoRoot
    try { & pnpm.cmd install --frozen-lockfile; if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" } }
    finally { Pop-Location }
    Write-Host "Xi Ling OS native Windows workspace is ready at $DataRoot"
}
