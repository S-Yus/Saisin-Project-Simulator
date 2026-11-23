# トンネルを停止する（外部から開けなくなる。アプリ自体は止まらない）
$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $root 'data-staging\tunnel.pid'
if (-not (Test-Path $pidFile)) { '起動記録がありません'; exit 0 }
$id = Get-Content $pidFile
if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Stop-Process -Id $id; "停止しました (PID $id)" } else { 'すでに停止しています' }
Remove-Item $pidFile
