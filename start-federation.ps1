<# Start the federation Router without touching the gateway. #>

$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot
$envFile = Join-Path $PSScriptRoot '.env'

function Get-EnvValue([string]$key) {
	if (-not (Test-Path $envFile)) { return $null }
	foreach ($line in Get-Content $envFile) {
		if ($line -match "^$([regex]::Escape($key))=(.*)$") { return $Matches[1] }
	}
	return $null
}

function New-Token {
	$bytes = New-Object 'System.Byte[]' 32
	[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
	return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

if (-not (Test-Path $envFile)) { New-Item -Path $envFile -ItemType File | Out-Null }
if (-not (Get-EnvValue 'CONSOLE_BRIDGE_TOKEN')) { Add-Content -Path $envFile -Value "CONSOLE_BRIDGE_TOKEN=$(New-Token)" }
if (-not (Get-EnvValue 'FEDERATION_WS_TOKEN')) { Add-Content -Path $envFile -Value "FEDERATION_WS_TOKEN=$(New-Token)" }

# The two reach settings are the owner's to fill, not ours to mint. Say so rather than start a
# Router no phone can find.
$bind = Get-EnvValue 'FEDERATION_BIND'
if (-not $bind -or $bind -eq '127.0.0.1') {
	Write-Warning 'FEDERATION_BIND is unset or loopback in .env - the Router will not be reachable from a phone. Set it to this machine''s LAN address and rerun.'
}
if (-not (Get-EnvValue 'FEDERATION_PUBLIC_HOST')) {
	Write-Warning 'FEDERATION_PUBLIC_HOST is unset in .env - a phone off this LAN cannot reach the Router. Set it to your domain or public IP once port 20001 is forwarded here.'
}

docker network inspect switchboard-federation 2>$null 1>$null
if ($LASTEXITCODE -ne 0) { docker network create switchboard-federation | Out-Null }

docker compose -f docker-compose.federation.yml -p switchboard-federation up --build -d
if ($LASTEXITCODE -ne 0) { Write-Error 'Federation Router compose up failed'; exit 1 }

# Probe whatever the compose file actually bound. A LAN FEDERATION_BIND unbinds loopback, so a
# hardcoded localhost probe reports a healthy Router as a 60s timeout.
$probeHost = Get-EnvValue 'FEDERATION_BIND'
if (-not $probeHost -or $probeHost -eq '0.0.0.0') { $probeHost = '127.0.0.1' }

Write-Host 'Waiting for the federation Router to be ready...'
foreach ($i in 1..30) {
	try {
		$resp = Invoke-WebRequest -Uri "https://${probeHost}:20001/health" -SkipCertificateCheck -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
		if ($resp.StatusCode -eq 200) {
			Write-Host 'Federation Router ready. TLS fingerprint:'
			docker logs switchboard-federation 2>&1 | Select-String -Pattern 'TLS fingerprint' | Select-Object -First 1
			exit 0
		}
	} catch { }
	Start-Sleep -Seconds 2
}

Write-Error 'Federation Router did not become healthy within 60s - run: docker logs switchboard-federation'
exit 1
