# 確認用環境のアプリを停止する（このスクリプトが記録したPIDだけを止める）
$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $root 'data-staging\server.pid'
if (-not (Test-Path $pidFile)) { '起動記録がありません'; exit 0 }
$id = Get-Content $pidFile
if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Stop-Process -Id $id; "停止しました (PID $id)" } else { 'すでに停止しています' }
Remove-Item $pidFile
