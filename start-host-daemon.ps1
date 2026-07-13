<#
Launch the headless host daemon (src/main-host-daemon.ts) in a background PowerShell window - the
Windows stand-in for the detached tmux session start-host-daemon.sh uses. The daemon owns the
gateway's reserved "host" WS slot: the devcontainer catalog + on-demand wake, and the console
terminal-view host ops. It runs no Claude session. Its PID is written to .host-daemon.pid so
down.ps1 can stop the whole tree.

tmux caveat: host-target terminal ops need tmux and will not work on Windows; devcontainer waking
and the gateway bridge do (see run-host-daemon.ps1).
#>

$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot

$pidFile = Join-Path $PSScriptRoot '.host-daemon.pid'

# Already running? A live PID in the pid file means yes.
if (Test-Path $pidFile) {
	$existing = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
	if ($existing -match '^\d+$' -and (Get-Process -Id ([int]$existing) -ErrorAction SilentlyContinue)) {
		Write-Host "Host daemon already running (PID $existing)."
		exit 0
	}
	Remove-Item $pidFile -ErrorAction SilentlyContinue
}

# Pass the host-daemon WS token start-gateway provisioned into .env so the daemon authenticates to
# the gateway's reserved "host" slot. Start-Process inherits this shell's environment.
$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path $envFile) {
	foreach ($line in Get-Content $envFile) {
		if ($line -match '^HOST_WS_TOKEN=(.*)$') { $env:HOST_WS_TOKEN = $Matches[1]; break }
	}
}

Write-Host "Starting host daemon..."
$runner = Join-Path $PSScriptRoot 'run-host-daemon.ps1'
$proc = Start-Process -FilePath 'powershell.exe' `
	-ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', $runner `
	-WorkingDirectory $PSScriptRoot -PassThru

Set-Content -Path $pidFile -Value $proc.Id
Write-Host "Host daemon running in background (PID $($proc.Id))."
Write-Host "  A new PowerShell window is running the supervisor (run-host-daemon.ps1)."
Write-Host "  Stop: .\down.ps1"
