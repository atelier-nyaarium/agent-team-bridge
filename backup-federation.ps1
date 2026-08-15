<# Back up Router state while stopped. #>

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$running = docker inspect -f '{{.State.Running}}' switchboard-federation 2>$null
if ($running -eq 'true') { Write-Error 'Federation Router is running. Stop it before backing up.'; exit 1 }

$backupDir = Join-Path $PSScriptRoot 'volumes/federation-backups'
New-Item -Path $backupDir -ItemType Directory -Force | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$archive = Join-Path $backupDir "federation-$timestamp.tar.gz"
tar -czf $archive -C (Join-Path $PSScriptRoot 'volumes') federation-data
Write-Host "Created $archive"
Write-Host 'Restore: stop Router, restore, verify fingerprint matches pinned clients, start Router, verify gateway registration.'
