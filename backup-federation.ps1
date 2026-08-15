<# Back up Router state while stopped. #>

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# A missing container is a normal "not running" answer, not a failure.
$running = $(try { docker inspect -f '{{.State.Running}}' switchboard-federation 2>$null } catch { '' })
if ($running -eq 'true') { Write-Error 'Federation Router is running. Stop it before backing up.'; exit 1 }

$backupDir = Join-Path $PSScriptRoot 'volumes/federation-backups'
New-Item -Path $backupDir -ItemType Directory -Force | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$archive = Join-Path $backupDir "federation-$timestamp.tar.gz"

# The tokens live in .env, not the data volume, so a data-only archive restores an identity
# the gateway and console can no longer authenticate to. Stage them beside the data.
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -Path $staging -ItemType Directory -Force | Out-Null
try {
	Copy-Item -Path (Join-Path $PSScriptRoot 'volumes/federation-data') -Destination (Join-Path $staging 'federation-data') -Recurse
	$envFile = Join-Path $PSScriptRoot '.env'
	$tokens = if (Test-Path $envFile) {
		Get-Content $envFile | Where-Object { $_ -match '^(CONSOLE_BRIDGE_TOKEN|FEDERATION_WS_TOKEN)=' }
	} else { @() }
	Set-Content -Path (Join-Path $staging 'federation-tokens.env') -Value $tokens

	tar -czf $archive -C $staging federation-data federation-tokens.env
	# $ErrorActionPreference does not govern native exit codes on PS 5.1, and tar creates the
	# output file before failing, so an unchecked run leaves an empty archive reported as success.
	if ($LASTEXITCODE -ne 0) { Write-Error "tar failed with exit code $LASTEXITCODE"; exit 1 }
} finally {
	Remove-Item -Path $staging -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Created $archive (data volume + the two Router tokens from .env)"
Write-Host 'Restore: stop Router, restore, verify fingerprint matches pinned clients, start Router, verify gateway registration.'
Write-Host 'An OLD snapshot can resurrect revoked members and spent nonces. Reconcile the allowlist after restoring one.'
