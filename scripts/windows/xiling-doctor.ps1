[CmdletBinding()]
param(
    [switch]$Json,
    [switch]$AllowOccupiedPort,
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA "XiLingOS")
)

$ErrorActionPreference = "Stop"
$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check([string]$Name, [bool]$Ok, [string]$Detail) {
    $checks.Add([pscustomobject]@{ name = $Name; ok = $Ok; detail = $Detail })
}

$version = [Environment]::OSVersion.Version
Add-Check "windows-11" ($version.Build -ge 22000) ([Environment]::OSVersion.VersionString)

$memory = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
Add-Check "memory" ($memory -ge 8GB) ("{0:N1} GB installed" -f ($memory / 1GB))
try {
    $virtualization = (Get-CimInstance Win32_Processor | Select-Object -First 1).VirtualizationFirmwareEnabled
    Add-Check "virtualization" ([bool]$virtualization) $(if ($virtualization) { "enabled in firmware" } else { "enable CPU virtualization in firmware" })
} catch { Add-Check "virtualization" $false "could not inspect firmware virtualization" }

$node = Get-Command node.exe -ErrorAction SilentlyContinue
$nodeVersion = if ($node) { (& node.exe --version).TrimStart("v") } else { "missing" }
$nodeReady = $node -and ([version]$nodeVersion -ge [version]"22.19.0")
Add-Check "node" ([bool]$nodeReady) $(if ($nodeReady) { "Node.js $nodeVersion" } else { "Install Node.js 22.19 or newer" })

$pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
Add-Check "pnpm" ($null -ne $pnpm) $(if ($pnpm) { "pnpm available" } else { "Enable Corepack and install pnpm 11.19.0" })

$docker = Get-Command docker.exe -ErrorAction SilentlyContinue
Add-Check "docker" ($null -ne $docker) $(if ($docker) { "docker.exe available" } else { "Install Docker Desktop with Linux containers; no changes were made" })
if ($docker) {
    $dockerOs = (& docker.exe info --format '{{.OSType}}' 2>$null | Out-String).Trim()
    Add-Check "docker-linux" ($dockerOs -eq "linux") $(if ($dockerOs -eq "linux") { "Linux container sandbox ready" } else { "Switch Docker Desktop to Linux containers" })
}

$portFree = $null -eq (Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue)
Add-Check "port-4317" ($portFree -or $AllowOccupiedPort) $(if ($portFree) { "available" } else { "occupied; an existing Xi Ling OS instance may be running" })

$dataDriveName = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($DataRoot)).TrimEnd("\").TrimEnd(":")
$drive = Get-PSDrive -Name $dataDriveName
Add-Check "disk" ($drive.Free -ge 20GB) ("{0:N1} GB free" -f ($drive.Free / 1GB))
$dataParent = Split-Path -Parent $DataRoot
$dataRootReady = (Test-Path -LiteralPath $DataRoot -PathType Container) -or (Test-Path -LiteralPath $dataParent -PathType Container)
Add-Check "data-root" $dataRootReady $(if ($dataRootReady) { $DataRoot } else { "Parent directory is unavailable: $dataParent" })

$proxyConfigured = [bool]($env:HTTPS_PROXY -or $env:HTTP_PROXY)
$caConfigured = [bool]($env:REQUESTS_CA_BUNDLE -or $env:SSL_CERT_FILE)
Add-Check "network-config" $true ("proxy={0}; custom-ca={1}; values are not logged" -f $proxyConfigured, $caConfigured)

$result = [pscustomobject]@{ ok = -not ($checks.ok -contains $false); checks = $checks }
if ($Json) { $result | ConvertTo-Json -Depth 4 } else { $checks | Format-Table -AutoSize }
if (-not $result.ok) { exit 2 }
