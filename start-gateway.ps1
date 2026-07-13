<#
Pull and start this machine's gateway. One gateway per machine, configured by .env.
Setup lives in .\setup.ps1. PowerShell port of start-gateway.sh (that script is the canonical
reference; keep the two in sync).

Run from PowerShell:            .\start-gateway.ps1
If script execution is blocked: powershell -ExecutionPolicy Bypass -File .\start-gateway.ps1
#>

$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot

$envFile = Join-Path $PSScriptRoot '.env'

# Read a KEY= value from .env (first match), or $null.
function Get-EnvValue([string]$key) {
	if (-not (Test-Path $envFile)) { return $null }
	foreach ($line in Get-Content $envFile) {
		if ($line -match "^$([regex]::Escape($key))=(.*)$") { return $Matches[1] }
	}
	return $null
}

# Pull latest (best-effort, same as the .sh).
try { git fetch --prune 2>$null } catch { }
try { git pull 2>$null } catch { }

# Default GATEWAY_ID to this machine's hostname when .env sets none, so two machines never both
# silently fall back to "switchboard". docker compose reads .env on its own; this only fills the gap.
if (-not (Get-EnvValue 'GATEWAY_ID')) {
	$env:GATEWAY_ID = [System.Net.Dns]::GetHostName()
}
$effId = Get-EnvValue 'GATEWAY_ID'
if (-not $effId) {
	if ($env:GATEWAY_ID) { $effId = $env:GATEWAY_ID } else { $effId = [System.Net.Dns]::GetHostName() }
}

# Auto-provision the host-daemon WS token into .env so the reserved "host" slot (which the console
# drives agent terminals through) is authenticated by default. The host daemon reads the same value.
if (-not (Get-EnvValue 'HOST_WS_TOKEN')) {
	$bytes = New-Object 'System.Byte[]' 32
	[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
	$token = (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
	Add-Content -Path $envFile -Value "HOST_WS_TOKEN=$token"
}

try { docker compose down --remove-orphans 2>$null } catch { }
docker compose up --build -d
if ($LASTEXITCODE -ne 0) {
	Write-Error "docker compose up failed"
	exit 1
}

Write-Host "Waiting for the gateway to be ready..."
foreach ($i in 1..30) {
	try {
		$resp = Invoke-WebRequest -Uri 'http://localhost:20000/health' -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
		if ($resp.StatusCode -eq 200) {
			Write-Host "Gateway ready (Host: $effId). Waiting 10s for evie-bot..."
			Start-Sleep -Seconds 10
			exit 0
		}
	} catch { }
	Start-Sleep -Seconds 2
}

Write-Error "Gateway did not become healthy within 60s - run: docker logs switchboard"
exit 1
