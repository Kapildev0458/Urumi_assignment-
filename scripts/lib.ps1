# Shared helpers for the PowerShell scripts. Dot-source it: . "$PSScriptRoot\lib.ps1"
$ErrorActionPreference = 'Stop'

$ClusterName  = 'urumi'
$RegistryName = 'urumi-registry'
$RepoRoot     = Split-Path -Parent $PSScriptRoot

# winget installs update PATH in the registry; pick that up without restarting the shell.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User')

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

# Runs a native command and throws if it exits non-zero (PowerShell 5.1 does not do this itself).
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$Arguments = @()
    )
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "'$Exe $($Arguments -join ' ')' failed with exit code $LASTEXITCODE"
    }
}

# Runs a native command whose failure is expected (probes, "already deleted"), hiding stderr.
# With $ErrorActionPreference = 'Stop', PowerShell 5.1 turns redirected native stderr into a
# terminating error, so relax it for the call. Returns stdout; check $LASTEXITCODE after.
function Invoke-Probe {
    param(
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$Arguments = @()
    )
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Exe @Arguments 2>$null } finally { $ErrorActionPreference = $saved }
}

function Test-ClusterExists {
    $names = & k3d cluster list -o json | ConvertFrom-Json | ForEach-Object { $_.name }
    return $names -contains $ClusterName
}
