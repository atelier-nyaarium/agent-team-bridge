<#
Thin launcher for the admin Domain setup (PowerShell port of setup.sh). All logic lives in
scripts/setup.ts (run with bun); this stays an entry point for muscle memory and docs. No args opens
the setup menu; see scripts/setup.ts for the flags (--qr, --verify, --help).
#>

$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot
bun run scripts/setup.ts @args
exit $LASTEXITCODE
