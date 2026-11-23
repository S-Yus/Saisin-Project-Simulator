# 確認用環境（staging）のアプリを起動する。すでに動いていれば何もしない。
#   powershell -ExecutionPolicy Bypass -File ops\start-staging.ps1
$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $root 'data-staging\server.pid'
if (Test-Path $pidFile) { $old = Get-Content $pidFile; if (Get-Process -Id $old -ErrorAction SilentlyContinue) { "すでに起動しています (PID $old)"; exit 0 } }
Get-Content (Join-Path $root '.env.staging') | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object { $k, $v = $_ -split '=', 2; Set-Item -Path "Env:$($k.Trim())" -Value $v.Trim() }
New-Item -ItemType Directory -Force (Join-Path $root 'data-staging') | Out-Null
$p = Start-Process -FilePath node -ArgumentList 'server/index.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $root 'data-staging\server.log') -RedirectStandardError (Join-Path $root 'data-staging\server.err.log')
$p.Id | Set-Content $pidFile
"起動しました (PID $($p.Id))  http://127.0.0.1:$env:PORT"
