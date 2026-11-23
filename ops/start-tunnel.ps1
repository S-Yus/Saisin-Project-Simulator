# 確認用環境のトンネル（staging.nisa-simulator.app → このPCの 127.0.0.1:8081）を起動する。すでに動いていれば何もしない。
#   powershell -ExecutionPolicy Bypass -File ops\start-tunnel.ps1
$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $root 'data-staging\tunnel.pid'
if (Test-Path $pidFile) { $old = Get-Content $pidFile; if (Get-Process -Id $old -ErrorAction SilentlyContinue) { "すでに起動しています (PID $old)"; exit 0 } }
$p = Start-Process -FilePath (Join-Path $PSScriptRoot 'bin\cloudflared.exe') -ArgumentList 'tunnel', '--config', (Join-Path $PSScriptRoot 'cloudflared-staging.yml'), '--no-autoupdate', 'run' -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root 'data-staging\tunnel.log') -RedirectStandardError (Join-Path $root 'data-staging\tunnel.err.log')
$p.Id | Set-Content $pidFile
"トンネルを起動しました (PID $($p.Id))  https://staging.nisa-simulator.app"
