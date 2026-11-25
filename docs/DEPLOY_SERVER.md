# 借りたサーバーで確認用環境を公開する手順

このPCで動かしている確認用環境（アプリ＋Cloudflare Tunnel）を、借りたサーバー（Ubuntu 24.04 のVPS）へ移す手順。URL（`https://staging.nisa-simulator.app`）は変わらない。

> **実施済み（2026-11-25）**: さくらのVPS（石狩第1・1Gプラン・Ubuntu 24.04、お試し期間中）に設置し、公開URLから参加できることを確認した。ただし、**下の「実際に行った方法」で設置しており、1〜7章の手順（sudo と /opt を使う方法）そのものは通していない。**

決定事項（2026-11-25）: 実データをそのまま使う／開催回の期間は30日／サーバーの管理は開発担当が行う／さいしんの確認は公開のあと。利用許諾は3社とも未確認のままなので、環境は **staging（確認用）** とし、本番（prod）にはしない。

## 実際に行った方法（管理者権限を使わない設置）
管理ユーザー  の  にはパスワードが要るため、すべて  の権限の中で設置した。

| もの | 場所（サーバー） |
|---|---|
| Node.js 24.11.1（公式の配布物。SHA-256 を照合） |  |
| プログラム（GitHub から取得） |  |
| 設定・管理トークン（サーバーで新しく生成。権限600） |  |
| データベース |  |
| 取込ファイル（このPCから scp。SHA-256 の一致を確認） |  |
| cloudflared（公式の配布物） | 、設定と資格情報は  |
| 常駐の設定（ユーザー単位の systemd。 済み） | 、 |

操作（サーバーに SSH で入って実行。 は不要）:

| したいこと | コマンド |
|---|---|
| 状態を見る |  |
| アプリを再起動 |  |
| 外部公開だけ止める／戻す |  ／  |
| ログを見る |  |
| プログラムを更新 |  |
| 開催回を作り直す（30日） |  |
| 管理トークンを見る |  |

SSH の接続（このPCから。鍵は ）: 。管理画面は  を付けてつなぎ、ブラウザーで 。この鍵にはパスフレーズがない（作業の自動実行のため）。不要になったらサーバーの  から  の行を消す。

確認した結果:  200、 と  は外から 404、公開URLから参加して口座を取得できた（アプリ 0.8.0）。サーバー上の自動テストは失敗0（実データのテスト10件は元ファイルがないため見送り）。

**していないこと・未確認**: OSの更新（）、SSH のパスワードログインの停止、サーバー再起動後に自動で立ち上がることの確認、サーバー上での負荷試験、バックアップの設定。外から入れるのは、さくらのパケットフィルターにより SSH（22番）だけ。お試し期間中は回線の帯域が制限される。

以下の 0〜11 章は、管理者権限で  に設置する場合の手順（未検証）。

## 0. 用意するもの
| もの | 場所 |
|---|---|
| サーバー | Ubuntu 24.04、メモリ1GB以上。開けるポートは SSH（22）だけ。80/443 は開けない |
| 取込ファイル | このPCの `market-data/build/dataset.json`（GitHub には入っていない） |
| トンネルの資格情報 | このPCの `%USERPROFILE%\.cloudflared\<トンネルID>.json`（秘密情報。GitHub・チャットに貼らない） |
| トンネルID | このPCの `ops/cloudflared-staging.yml` の `tunnel:` の値 |

以下、`<IP>` はサーバーのIPアドレス、`<USER>` はSSHのユーザー名。

## 1. サーバーの初期設定（サーバーで）
```sh
sudo apt update && sudo apt -y upgrade
sudo apt -y install git curl xz-utils ufw
sudo ufw allow OpenSSH && sudo ufw --force enable     # 入ってくる通信は SSH だけ
sudo useradd --system --home /opt/nisa-sim --shell /usr/sbin/nologin nisa
```
SSH は鍵認証にし、パスワードでのログインは止めておく（VPS の管理画面の案内に従う）。

## 2. Node.js 24.11.1 を入れる（サーバーで）
バージョンは固定。違うと起動時に止まる。
```sh
cd /tmp
curl -fsSLO https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-x64.tar.xz
curl -fsSLO https://nodejs.org/dist/v24.11.1/SHASUMS256.txt
grep node-v24.11.1-linux-x64.tar.xz SHASUMS256.txt | sha256sum -c -      # 「OK」と出ること
sudo tar -xJf node-v24.11.1-linux-x64.tar.xz -C /usr/local --strip-components=1
node -v                                                                  # v24.11.1
```

## 3. プログラムを置く（サーバーで）
```sh
sudo git clone https://github.com/S-Yus/Saisin-Project-Simulator.git /opt/nisa-sim
cd /opt/nisa-sim && npm test        # 実データのテストは元ファイルがないので自動で省かれる。失敗0であること
sudo mkdir -p /opt/nisa-sim/market-data/build /opt/nisa-sim/data-staging /etc/nisa-sim
```

## 4. 設定ファイルを作る（サーバーで）
管理トークンは**サーバー用に新しく作る**（このPCのものを使い回さない）。
```sh
sudo sh -c 'umask 077; cat > /etc/nisa-sim/staging.env <<EOF
APP_ENV=staging
OPERATOR_TOKEN=$(openssl rand -hex 32)
VERIFIER_TOKEN=$(openssl rand -hex 32)
HOST=127.0.0.1
PORT=8081
TRUST_PROXY=1
JOIN_RATE_PER_MIN=600
PURGE_INTERVAL_MS=60000
ADMIN_LOCAL_ONLY=1
PUBLIC_URL=https://staging.nisa-simulator.app
EOF'
sudo ln -s /etc/nisa-sim/staging.env /opt/nisa-sim/.env.staging    # ops/ のスクリプトが読む場所
```
`OPERATOR_TOKEN` が管理画面に入れるトークン。見るときは `sudo grep OPERATOR /etc/nisa-sim/staging.env`。

## 5. データを送る（このPCの PowerShell で）
```powershell
scp market-data\build\dataset.json <USER>@<IP>:/tmp/dataset.json
```
サーバーで:
```sh
sudo mv /tmp/dataset.json /opt/nisa-sim/market-data/build/dataset.json
sha256sum /opt/nisa-sim/market-data/build/dataset.json     # このPCの `npm run build-data` が表示した sha256 と先頭が一致すること
```

## 6. アプリを常駐させる（サーバーで）
```sh
sudo cp /opt/nisa-sim/deploy/systemd/nisa-sim@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nisa-sim@staging
systemctl status nisa-sim@staging --no-pager
curl -s http://127.0.0.1:8081/healthz        # {"ok":true,...}
```
データベースは `/var/lib/nisa-sim/staging/app.sqlite` にできる。ログは `journalctl -u nisa-sim@staging`。

## 7. トンネルをサーバーへ移す
同じトンネルを2か所で同時に動かさない。**先にこのPCのトンネルを止める**（このPCで）:
```powershell
powershell -ExecutionPolicy Bypass -File ops\stop-tunnel.ps1
```
資格情報を送る（このPCで。`<トンネルID>` は実際の値に置き換える）:
```powershell
scp $env:USERPROFILE\.cloudflared\<トンネルID>.json <USER>@<IP>:/tmp/tunnel.json
```
サーバーで cloudflared を入れ、設定を置いて常駐させる:
```sh
curl -fsSLO https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb
sudo mkdir -p /etc/cloudflared && sudo mv /tmp/tunnel.json /etc/cloudflared/tunnel.json && sudo chmod 600 /etc/cloudflared/tunnel.json
sudo sh -c 'cat > /etc/cloudflared/config.yml <<EOF
tunnel: <トンネルID>
credentials-file: /etc/cloudflared/tunnel.json
ingress:
  - hostname: staging.nisa-simulator.app
    path: ^/(admin|admin\\.html|admin\\.js|admin-api)(/.*)?\$
    service: http_status:404
  - hostname: staging.nisa-simulator.app
    service: http://127.0.0.1:8081
  - service: http_status:404
EOF'
cat /etc/cloudflared/config.yml               # path の行が ops/cloudflared-staging.example.yml と同じであること
sudo cloudflared service install
systemctl status cloudflared --no-pager
```
DNS は変更不要（トンネルIDが同じため）。確認（どこからでも）:
```sh
curl -s -o /dev/null -w "%{http_code}\n" https://staging.nisa-simulator.app/healthz    # 200
curl -s -o /dev/null -w "%{http_code}\n" https://staging.nisa-simulator.app/admin      # 404（管理画面は外に出ない）
```

## 8. 開催回を作って公開する（サーバーで）
```sh
cd /opt/nisa-sim
sudo node ops/seed-staging.js 30        # データの取込・固定・開催回の作成・公開。数字は開催日数
sudo node ops/make-qr.js                # data-staging/join-qr.svg
sudo cat data-staging/join-code.txt
```
参加URLは `https://staging.nisa-simulator.app/?code=<参加コード>`。スマートフォンで開いて、参加・購入・時間の進行ができることを確かめる。QR画像を手元に取るには、このPCで `scp <USER>@<IP>:/opt/nisa-sim/data-staging/join-qr.svg .`。

## 9. 管理画面を開く（このPCから）
管理画面はサーバーの中からしか開けない。SSH のポート転送でつなぐ:
```powershell
ssh -L 8081:127.0.0.1:8081 <USER>@<IP>
```
つないだまま、このPCのブラウザーで `http://127.0.0.1:8081/admin` を開き、手順4の `OPERATOR_TOKEN` を入れる。このPCの確認用アプリが動いていると 8081 番が重なるので、先に `ops\stop-staging.ps1` で止める。

## 10. 日々の操作
| したいこと | 方法 |
|---|---|
| 一時停止・再開・終了 | 管理画面の開催回のボタン |
| QRを会場に映す | 管理画面の「会場用に大きく表示」 |
| プログラムを更新 | `cd /opt/nisa-sim && sudo git pull && npm test && sudo systemctl restart nisa-sim@staging` |
| 止める | `sudo systemctl stop nisa-sim@staging`（公開だけ止めるなら `sudo systemctl stop cloudflared`） |
| ログを見る | `journalctl -u nisa-sim@staging -n 100` |

- プログラムを更新すると構成の指紋が変わる。確認用環境では公開は続くが、確認記録は付け直しになる。
- 参加データは、開催回の終了の24時間後に自動で削除される。サーバーを解約するときは、ディスクの消去方法を事業者の案内で確認する（OPERATIONS.md §5）。

## 11. このPC側の後片付け
サーバーで動くことを確かめたら、このPCのアプリを止める（`ops\stop-staging.ps1`）。トンネルの資格情報（`%USERPROFILE%\.cloudflared\`）はサーバーに移したので、このPCから不要なら削除してよい（再びこのPCで公開する予定がなければ）。
