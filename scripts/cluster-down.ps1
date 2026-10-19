# Stops or deletes the local cluster.
#   -Stop   : stop containers, keep all data (PVCs, registry images)   <- normal end of day
#   default : delete cluster AND registry (all store data is lost)
param([switch]$Stop)
. "$PSScriptRoot\lib.ps1"

if (-not (Test-ClusterExists)) {
    Write-Host "Cluster '$ClusterName' does not exist; nothing to do."
    exit 0
}

if ($Stop) {
    Write-Step "Stopping cluster '$ClusterName' (data is kept)"
    Invoke-Native k3d @('cluster', 'stop', $ClusterName)
} else {
    Write-Step "Deleting cluster '$ClusterName' and registry '$RegistryName'"
    Invoke-Native k3d @('cluster', 'delete', $ClusterName)
    # Registries created from the cluster config may outlive the cluster; ignore "not found".
    $null = Invoke-Probe k3d @('registry', 'delete', $RegistryName)
}
