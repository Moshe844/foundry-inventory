# Restart the local StockChief server and the ngrok tunnel, taking port 4000 back
# from whatever holds it.
#
# Why this exists: on 2026-09-15 a Codex session on this machine launched
# StockChief five separate times inside its own sandbox. That sandbox has no
# outbound network, so every model call from those copies failed with
# "This StockChief server process is not allowed to connect to the model
# provider" - and each copy took port 4000, so the next thing tried landed on
# it. This script kills every StockChief server regardless of which tool started
# it, launches one with normal network access, points ngrok at it, and prints
# who owns the port so you can see it worked.
#
# Run from PowerShell:   .\scripts\restart-local.ps1
# Or right-click -> Run with PowerShell.

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host ""
Write-Host "StockChief restart" -ForegroundColor Cyan

# 1. Who has the port right now - so a Codex copy is named, not guessed at.
$held = Get-NetTCPConnection -LocalPort 4000 -State Listen | Select-Object -First 1
if ($held) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($held.OwningProcess)"
  $who = if ($p.ExecutablePath -like '*codex*') { 'Codex' } elseif ($p.ExecutablePath -like '*nvm4w*') { 'a normal launch' } else { 'unknown' }
  Write-Host ("  port 4000 held by PID {0} ({1}), started {2}" -f $p.ProcessId, $who, $p.CreationDate.ToString('HH:mm:ss'))
} else {
  Write-Host "  port 4000 is free"
}

# 2. Every StockChief server, whoever started it. Match on server.js alone:
#    Codex's command line uses a backslash (src\server.js) and a narrower
#    pattern misses it.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*server.js*' } |
  ForEach-Object {
    Write-Host ("  stopping PID {0}" -f $_.ProcessId)
    Stop-Process -Id $_.ProcessId -Force
  }
Get-Process ngrok | Stop-Process -Force
Start-Sleep -Seconds 2

# 3. Start the application's supported local launcher. It keeps HTTP work and
# background inventory work in separate processes so a large database cannot
# block the browser server.
$env:PORT = '4000'
$stdout = Join-Path $root '.tmp-stockchief-dev.stdout.log'
$stderr = Join-Path $root '.tmp-stockchief-dev.stderr.log'
Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','dev' -WorkingDirectory $root `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden
# Startup on a multi-gigabyte database runs the migrations and the provenance
# backfill before it listens - twenty seconds is normal, and a lock left by a
# copy that was just killed can add more. Sixty was too short on 2026-09-15.
$deadline = (Get-Date).AddSeconds(180)
do {
  Start-Sleep -Milliseconds 500
  $up = Get-NetTCPConnection -LocalPort 4000 -State Listen | Select-Object -First 1
} until ($up -or (Get-Date) -gt $deadline)

if (-not $up) {
  Write-Host "  server did not come up within 180s - run 'node src/server.js' by hand to see why" -ForegroundColor Red
  exit 1
}
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$($up.OwningProcess)"
Write-Host ("  server up: PID {0}  {1}" -f $p.ProcessId, $p.ExecutablePath) -ForegroundColor Green

# 4. The tunnel, on the reserved domain.
Start-Process -FilePath 'ngrok' -ArgumentList 'http','--domain=streak-velvet-plod.ngrok-free.dev','4000' -WindowStyle Hidden
Start-Sleep -Seconds 5
try {
  $tunnels = (Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels').tunnels
  foreach ($t in $tunnels) { Write-Host ("  tunnel: {0} -> {1}" -f $t.public_url, $t.config.addr) -ForegroundColor Green }
} catch {
  Write-Host "  ngrok started but its API did not answer yet; give it a few seconds" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. If Ask StockChief says it cannot reach the model provider, run this again" -ForegroundColor Cyan
Write-Host "and check whether the line above says the port was held by Codex."
