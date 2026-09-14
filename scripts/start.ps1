$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$localNode = Get-ChildItem -Path (Join-Path $projectRoot '.tools') -Filter 'node.exe' -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($localNode) {
    $env:Path = $localNode.Directory.FullName + ';' + $env:Path
} elseif (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Chua co Node.js. Cai Node.js LTS tu https://nodejs.org/ roi chay lai.'
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
}
Write-Host 'ChiDi ERP: http://localhost:2000' -ForegroundColor Green
Write-Host 'Chua co Supabase? Ban chay thu van hoat dong. Xem docs/SUPABASE_SETUP.md.'
& npm.cmd run dev
