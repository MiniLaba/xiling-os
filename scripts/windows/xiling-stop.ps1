[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "High")]
param(
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA "XiLingOS"),
    [switch]$ForceRecovery
)

$ErrorActionPreference = "Stop"
try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4317/api/system/stop" -TimeoutSec 5 | Out-Null }
catch { Write-Warning "The graceful stop endpoint was unavailable." }
$pidPath = Join-Path $DataRoot "runtime\xiling-server.pid"
if ($ForceRecovery -and (Test-Path -LiteralPath $pidPath)) {
    $serverPid = [int](Get-Content -LiteralPath $pidPath -Raw)
    if ($PSCmdlet.ShouldProcess("PID $serverPid", "Force terminate Xi Ling OS after graceful stop failed")) {
        Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    }
}
