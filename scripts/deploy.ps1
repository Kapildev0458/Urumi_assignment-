# Installs or upgrades the whole platform with Helm.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1 [-Environment local|prod]
param(
    [ValidateSet('local', 'prod')][string]$Environment = 'local',
    [string]$Namespace = 'urumi',
    [string]$Release = 'urumi'
)
. "$PSScriptRoot\lib.ps1"

$chart  = Join-Path $RepoRoot 'charts\platform'
$values = Join-Path $chart "values-$Environment.yaml"

Write-Step 'Resolving chart dependencies'
Invoke-Native helm @('dependency', 'update', $chart)

# The first install pulls the WordPress/MariaDB images and downloads WooCommerce inside the setup
# job; on a slow connection that alone took >15 minutes, so allow a generous timeout. Re-running
# after a timeout is safe: it continues the same release.
$valueArgs = @('-f', $values)
# Image tags from the last scripts\build-images.ps1 run (local only).
$imageValues = Join-Path $chart 'values-images.yaml'
if ($Environment -eq 'local' -and (Test-Path $imageValues)) { $valueArgs += @('-f', $imageValues) }

if ($Environment -eq 'local') {
    # Pulls from inside the k3d node are much slower than Docker Desktop's own pulls (a WordPress
    # image took >10 min, past the Deployment progress deadline). Pull third-party images on the
    # host and import them; images from our registry (localhost:5000) are already fast.
    $rendered = & helm template $Release $chart --namespace $Namespace @valueArgs
    $images = $rendered | Select-String -Pattern '^\s*image:\s*"?([^"\s]+)"?' |
        ForEach-Object { $_.Matches[0].Groups[1].Value } |
        Where-Object { $_ -notlike 'localhost:5000/*' } | Sort-Object -Unique
    # Not `k3d image import`: with Docker Desktop's containerd image store it exports a
    # multi-platform index whose other-arch blobs are missing ("content digest not found") and
    # still reports success, and it mangles Windows tarball paths. Save amd64 only and load it
    # into the node's containerd directly.
    $node = "k3d-$ClusterName-server-0"
    $tar = Join-Path $env:TEMP 'urumi-image.tar'
    foreach ($image in $images) {
        Write-Step "Pre-pulling $image"
        Invoke-Native docker @('pull', '-q', $image)
        Invoke-Native docker @('save', '--platform', 'linux/amd64', '-o', $tar, $image)
        Invoke-Native docker @('cp', $tar, "${node}:/tmp/image.tar")
        Invoke-Native docker @('exec', $node, 'ctr', '-n', 'k8s.io', 'images', 'import', '/tmp/image.tar')
        Invoke-Native docker @('exec', $node, 'rm', '-f', '/tmp/image.tar')
    }
    Remove-Item $tar -ErrorAction SilentlyContinue
}

Write-Step "helm upgrade --install $Release ($Environment) into namespace $Namespace"
Invoke-Native helm (@('upgrade', '--install', $Release, $chart,
    '--namespace', $Namespace, '--create-namespace') + $valueArgs + @('--wait', '--timeout', '30m'))

Write-Step 'Workloads'
Invoke-Native kubectl @('-n', $Namespace, 'get', 'pods,pvc,ingress')

$secret = "$Release-store-credentials"
$encoded = & kubectl -n $Namespace get secret $secret -o 'jsonpath={.data.wp-admin-password}'
if ($LASTEXITCODE -eq 0 -and $encoded) {
    $password = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
    $hostName = & kubectl -n $Namespace get ingress "$Release-store" -o 'jsonpath={.spec.rules[0].host}'
    Write-Host ''
    Write-Host "Storefront: http://$hostName" -ForegroundColor Green
    Write-Host "WP admin:   http://$hostName/wp-admin  (user: admin, password: $password)" -ForegroundColor Green
}
