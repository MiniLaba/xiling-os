[CmdletBinding(SupportsShouldProcess, ConfirmImpact = "Medium")]
param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][ValidatePattern("^[A-Za-z0-9_-]+$")][string]$ProjectId,
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA "XiLingOS")
)

$ErrorActionPreference = "Stop"
if ($SourcePath.StartsWith("\\")) { throw "UNC/SMB sources are not supported; copy the file to a local drive first" }
$item = Get-Item -LiteralPath $SourcePath
if ($item.PSIsContainer) { throw "Gate 2 import accepts one file at a time" }
if (($item.Attributes -band [IO.FileAttributes]::Offline) -ne 0) { throw "The OneDrive placeholder must be downloaded locally first" }
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse points and junctions are not accepted as import sources" }

if ($PSCmdlet.ShouldProcess($item.FullName, "Create a content-addressed snapshot inside Xi Ling OS native project storage")) {
    $digest = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $targetRoot = Join-Path $DataRoot "projects\$ProjectId\imports"
    New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
    $target = Join-Path $targetRoot $digest
    if (-not (Test-Path -LiteralPath $target)) {
        $temporary = Join-Path $targetRoot (".incoming-" + [guid]::NewGuid().ToString("N"))
        try { Copy-Item -LiteralPath $item.FullName -Destination $temporary; Move-Item -LiteralPath $temporary -Destination $target }
        finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
    Write-Output "artifact://$digest"
}
