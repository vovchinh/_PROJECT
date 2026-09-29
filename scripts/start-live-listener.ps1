$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$bundledNode = Join-Path $projectRoot '.tools\node-v24.21.0-win-x64\node.exe'
if (Test-Path -LiteralPath $bundledNode) {
    $env:Path = (Split-Path -Parent $bundledNode) + ';' + $env:Path
} elseif (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is required. Open docs/runbooks/TIKTOK_LIVE_TROUBLESHOOTING.md.'
}
$serviceRoot = Join-Path $projectRoot 'services\live-bridge'
$configuration = Join-Path $serviceRoot '.env'
if (-not (Test-Path -LiteralPath $configuration)) {
    Copy-Item -LiteralPath (Join-Path $serviceRoot '.env.example') -Destination $configuration
    Write-Host 'Created services/live-bridge/.env from the template. No credentials were copied.' -ForegroundColor Yellow
    Write-Host 'Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and LIVE_WORKSPACE_ID for the test workspace.'
    Write-Host 'Then open START_LIVE_LISTENER.cmd again. Guide: docs/runbooks/TIKTOK_LIVE_TROUBLESHOOTING.md'
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $serviceRoot 'node_modules\tiktok-live-connector\package.json'))) {
    Write-Host 'Installing the locked listener dependencies.'
    & npm.cmd --prefix services/live-bridge ci --ignore-scripts --include=optional
    if ($LASTEXITCODE -ne 0) { throw 'Listener dependency installation failed.' }
}
Write-Host 'ChiDi LIVE listener - sign in with your ERP owner/manager account.' -ForegroundColor Green
Write-Host 'This process handles pending CONNECT requests in the configured workspace.'
Write-Host 'Use a test workspace first. Keep this terminal open; Ctrl+C stops the listener safely.'
Write-Host 'This is separate from START_CHIDI.cmd and is not TikTok OAuth.'
& npm.cmd --prefix services/live-bridge run worker:channels:login
exit $LASTEXITCODE
