<#
Supervisor for the host daemon (PowerShell port of run-host-daemon.sh). Runs the daemon, and on
exit restarts with exponential backoff. A healthy run (>= HealthySecs) resets the backoff; after
repeated fast crashes it stops and keeps this window open for inspection instead of hot-looping.
HOST_WS_TOKEN is inherited from the environment start-host-daemon.ps1 sets before launching this.

tmux caveat: the host terminal-view ops (peek / tmux_send / host-target create_session) drive tmux,
which does not exist on Windows, so those host-side ops will fail. Waking devcontainers and the
gateway bridge work normally - they drive tmux INSIDE the Linux containers via docker exec.
#>

$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot

$HealthySecs  = 10
$MaxFastFails = 5
$delay = 2
$fails = 0

while ($true) {
	$start = Get-Date
	bun run src/main-host-daemon.ts
	$ran = [int]((Get-Date) - $start).TotalSeconds

	if ($ran -ge $HealthySecs) {
		$delay = 2
		$fails = 0
	} else {
		$fails++
	}

	if ($fails -ge $MaxFastFails) {
		Write-Host "[host-daemon] exited fast ${fails}x (< ${HealthySecs}s each); staying down for inspection."
		Write-Host "[host-daemon] fix the cause, then re-run: bun run src/main-host-daemon.ts"
		break
	}

	Write-Host "[host-daemon] exited after ${ran}s; restarting in ${delay}s (fast-fail ${fails}/${MaxFastFails})."
	Start-Sleep -Seconds $delay
	$delay = [Math]::Min($delay * 2, 60)
}
