# Creates (or starts) the local k3d cluster and proves registry + ingress work end to end.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\cluster-up.ps1 [-SkipSmokeTest]
param([switch]$SkipSmokeTest)
. "$PSScriptRoot\lib.ps1"

Write-Step 'Checking prerequisites'
& "$PSScriptRoot\check-prereqs.ps1"
if ($LASTEXITCODE -ne 0) { throw 'Prerequisites missing; fix them and re-run.' }

if (Test-ClusterExists) {
    Write-Step "Cluster '$ClusterName' exists; starting it"
    Invoke-Native k3d @('cluster', 'start', $ClusterName)
    Invoke-Native kubectl @('config', 'use-context', "k3d-$ClusterName")
} else {
    Write-Step "Creating cluster '$ClusterName' (first run pulls images, takes a few minutes)"
    Invoke-Native k3d @('cluster', 'create', '--config', (Join-Path $RepoRoot 'k3d\cluster-local.yaml'))
}

Write-Step 'Waiting for the node to be Ready'
Invoke-Native kubectl @('wait', '--for=condition=Ready', 'node', '--all', '--timeout=180s')

Write-Step 'Waiting for Traefik ingress controller'
# k3s installs Traefik through a HelmChart job, so the Deployment appears a little after startup
# (several minutes on a first run over a slow connection, while system images are pulled).
$deadline = (Get-Date).AddMinutes(10)
while ($true) {
    $null = Invoke-Probe kubectl @('-n', 'kube-system', 'get', 'deployment', 'traefik')
    if ($LASTEXITCODE -eq 0) { break }
    if ((Get-Date) -gt $deadline) { throw 'Traefik did not appear within 10 minutes (kubectl -n kube-system get pods)' }
    Start-Sleep -Seconds 5
}
Invoke-Native kubectl @('-n', 'kube-system', 'rollout', 'status', 'deployment/traefik', '--timeout=180s')

if (-not $SkipSmokeTest) {
    Write-Step 'Smoke test: push an image to the local registry'
    Invoke-Native docker @('pull', 'traefik/whoami:v1.10')
    Invoke-Native docker @('tag', 'traefik/whoami:v1.10', 'localhost:5000/whoami:smoke')
    Invoke-Native docker @('push', 'localhost:5000/whoami:smoke')

    Write-Step 'Smoke test: deploy it behind an Ingress'
    $manifest = Join-Path $RepoRoot 'k3d\smoke-test.yaml'
    Invoke-Native kubectl @('apply', '-f', $manifest)
    Invoke-Native kubectl @('-n', 'smoke', 'rollout', 'status', 'deployment/whoami', '--timeout=120s')

    Write-Step 'Smoke test: GET http://hello.127.0.0.1.nip.io'
    $body = $null
    for ($i = 0; $i -lt 20 -and -not $body; $i++) {
        try { $body = (Invoke-WebRequest 'http://hello.127.0.0.1.nip.io' -UseBasicParsing -TimeoutSec 5).Content }
        catch { Start-Sleep -Seconds 3 }
    }
    Invoke-Native kubectl @('delete', '-f', $manifest, '--wait=false')
    if (-not $body) { throw 'Ingress did not answer. Check nip.io DNS (scripts\check-prereqs.ps1) and kubectl -n smoke get ingress,pods' }
    Write-Host ($body -split "`n" | Select-Object -First 3 | Out-String)
    Write-Host 'Smoke test passed: registry, pod, Service, Ingress and local DNS all work.' -ForegroundColor Green
}

Write-Host ''
Write-Host "Cluster '$ClusterName' is ready. kubectl context: k3d-$ClusterName" -ForegroundColor Green
Invoke-Native kubectl @('get', 'nodes', '-o', 'wide')
