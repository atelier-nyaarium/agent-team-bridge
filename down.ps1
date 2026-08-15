<#
Stop the host daemon and take down the gateway (PowerShell port of down.sh).
#>

$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot

# Stop all components.

$pidFile = Join-Path $PSScriptRoot '.host-daemon.pid'

# Stop the background host-daemon window and its bun child (a whole tree, like tmux kill-session).
if (Test-Path $pidFile) {
	$daemonPid = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
	if ($daemonPid -match '^\d+$' -and (Get-Process -Id ([int]$daemonPid) -ErrorAction SilentlyContinue)) {
		Write-Host "Stopping host daemon (PID $daemonPid)..."
		# taskkill /T kills the process tree (the supervisor window plus its bun child); Stop-Process
		# alone would orphan the child.
		& taskkill /PID $daemonPid /T /F 2>$null | Out-Null
	} else {
		Write-Host "No running host daemon for PID $daemonPid."
	}
	Remove-Item $pidFile -ErrorAction SilentlyContinue
} else {
	Write-Host "No host daemon PID file; nothing to stop."
}

Write-Host "Taking down gateway..."
try { docker compose down --remove-orphans 2>$null } catch { }

Write-Host 'Taking down federation Router...'
try { docker compose -f docker-compose.federation.yml -p switchboard-federation down --remove-orphans 2>$null } catch { }

foreach ($network in @('switchboard', 'switchboard-federation')) {
	docker network inspect $network 2>$null 1>$null
	if ($LASTEXITCODE -eq 0) {
		Write-Host "Removing '$network' network..."
		docker network rm $network 2>$null 1>$null
		if ($LASTEXITCODE -ne 0) {
			Write-Host "WARNING: could not remove '$network' network (containers still attached?)."
		}
	}
}

Write-Host "Done."
