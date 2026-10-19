# Verifies everything needed to run the local cluster. Exits 1 if anything is missing.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\check-prereqs.ps1
. "$PSScriptRoot\lib.ps1"
$ErrorActionPreference = 'Continue'

$failed = $false
function Report([string]$Name, [bool]$Ok, [string]$Detail, [string]$Fix) {
    if ($Ok) {
        Write-Host ("  [ OK ] {0,-22} {1}" -f $Name, $Detail) -ForegroundColor Green
    } else {
        Write-Host ("  [FAIL] {0,-22} {1}" -f $Name, $Detail) -ForegroundColor Red
        if ($Fix) { Write-Host "         fix: $Fix" -ForegroundColor Yellow }
        $script:failed = $true
    }
}

Write-Step 'Command-line tools'
$tools = [ordered]@{
    docker  = 'Install Docker Desktop: winget install -e --id Docker.DockerDesktop (needs WSL2 + reboot)'
    kubectl = 'winget install -e --id Kubernetes.kubectl'
    helm    = 'winget install -e --id Helm.Helm'
    k3d     = 'winget install -e --id k3d.k3d'
    node    = 'winget install -e --id OpenJS.NodeJS.LTS'
}
foreach ($t in $tools.Keys) {
    $cmd = Get-Command $t -ErrorAction SilentlyContinue
    $detail = 'not found'
    if ($cmd) { $detail = $cmd.Source }
    Report $t ([bool]$cmd) $detail $tools[$t]
}

Write-Step 'WSL2 and Docker engine'
$null = & wsl.exe --status 2>$null
Report 'WSL' ($LASTEXITCODE -eq 0) 'wsl --status' 'Run "wsl --install" in an admin terminal, then reboot'

$dockerOk = $false
if (Get-Command docker -ErrorAction SilentlyContinue) {
    $serverVersion = & docker info --format '{{.ServerVersion}}' 2>$null
    $dockerOk = ($LASTEXITCODE -eq 0) -and $serverVersion
    Report 'Docker engine' $dockerOk "server $serverVersion" 'Start Docker Desktop and wait until it says "Engine running"'
} else {
    Report 'Docker engine' $false 'docker CLI missing' 'Install Docker Desktop first'
}

Write-Step 'Host ports (80, 443, 5000)'
$clusterExists = $false
if ($dockerOk -and (Get-Command k3d -ErrorAction SilentlyContinue)) { $clusterExists = Test-ClusterExists }
if ($clusterExists) {
    Report 'Ports' $true "cluster '$ClusterName' already exists and owns them" ''
} else {
    foreach ($port in 80, 443, 5000) {
        $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        $detail = 'free'
        if ($listener) { $detail = "in use by $((Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue).ProcessName)" }
        Report "Port $port" (-not $listener) $detail 'Stop the program using this port (IIS, Skype, another web server, ...)'
    }
}

Write-Step 'Local domain resolution (*.127.0.0.1.nip.io)'
$ip = $null
try { $ip = (Resolve-DnsName 'store.127.0.0.1.nip.io' -Type A -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress } catch { }
Report 'nip.io DNS' ($ip -eq '127.0.0.1') "resolves to '$ip'" 'Your DNS/router blocks it: add hosts-file entries instead (see README "Local domains")'

Write-Host ''
if ($failed) {
    Write-Host 'Some prerequisites are missing (see fixes above).' -ForegroundColor Red
    exit 1
}
Write-Host 'All prerequisites satisfied.' -ForegroundColor Green
exit 0
