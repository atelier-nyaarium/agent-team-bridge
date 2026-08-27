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

# bun is resolved HERE, never trusted from the ambient PATH. The bash twin carries the full reasoning:
# a login file that exports bun's PATH below a non-interactive guard leaves the daemon unable to find
# it, and it then fast-fails and stays down silently while its gateway keeps reporting healthy. The
# same exposure exists on Windows, where a shell profile may not have run for a Start-Process child.
function Resolve-Bun {
	$onPath = Get-Command bun -ErrorAction SilentlyContinue
	if ($onPath) { return $onPath.Source }
	$roots = @()
	if ($env:BUN_INSTALL) { $roots += $env:BUN_INSTALL }
	$roots += (Join-Path $HOME '.bun')
	foreach ($root in $roots) {
		$candidate = Join-Path $root 'bin\bun.exe'
		if (Test-Path $candidate) { return $candidate }
	}
	return $null
}

# Not the retry loop: five identical "not recognized" failures bury the cause. An absent runtime is
# hard-down on the first try, so name where it was searched and hold the window open, as MaxFastFails does.
$Bun = Resolve-Bun
if (-not $Bun) {
	Write-Host "[host-daemon] bun not found. Searched: PATH, `$env:BUN_INSTALL\bin, $HOME\.bun\bin."
	Write-Host "[host-daemon] Install bun (https://bun.sh) or set BUN_INSTALL, then: .\start-host-daemon.ps1"
	cmd /c pause
	exit 1
}
Write-Host "[host-daemon] bun: $Bun"

$HealthySecs  = 10
$MaxFastFails = 5
$delay = 2
$fails = 0

while ($true) {
	$start = Get-Date
	& $Bun run src/main-host-daemon.ts
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
