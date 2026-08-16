<# Start the federation Router without touching the gateway. Thin launcher for
   scripts/start-federation.ts, which owns every .env key the Router reads. #>

Set-Location -Path $PSScriptRoot
bun run scripts/start-federation.ts @args
exit $LASTEXITCODE
