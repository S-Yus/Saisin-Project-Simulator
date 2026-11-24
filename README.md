# 資産形成シミュレーター（説明会限定）0.7.0

埼玉縣信用金庫の大学生向け資産形成説明会で使う投資シミュレーター。出典を確認した**過去の実データ**の上で、投資信託（データがそろえば株式・ETFも）の購入・売却・積立を試す。将来の価格や成果の予測・生成は行わない。

**Node.js 24.11.1（固定）＋単一プロセス＋SQLite（`node:sqlite`）**。外部依存パッケージなし（QR生成のみ MIT の `public/vendor/qrcode.js` を同梱）。

> **現在の状態**: 実装と開発環境での検証は完了。実データ（投資信託7商品・2023-11〜2026-10）は検証済みで取込ファイルを生成できるが、**利用許諾は未確認、取引条件は仮設定、さいしんの動作確認は未実施**のため、本番では公開できない（システムが拒否する）。確認用環境（`APP_ENV=staging`）は、さいしんの動作確認のために未確定のままでも動かせる（画面に未確定事項を表示）。詳細は [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

## ローカルで動かす（開発・検算環境。127.0.0.1 限定・赤帯表示）
```bash
export APP_ENV=dev OPERATOR_TOKEN=dev-operator-token-000000000 VERIFIER_TOKEN=dev-verifier-token-000000000 PORT=8099
node scripts/dev-seed.js real   # 実データ（許諾未確認・検算専用）。引数なしなら架空データ（株式・ETF・配当・分割あり）
node server/index.js
```
- 参加者: `dev-seed` が表示する `http://localhost:8099/?code=…`（本番ではQRコード）
- 管理画面: `http://localhost:8099/admin`（上記のトークンを入力。運用担当＝OPERATOR、確認担当＝VERIFIER）
- ヘルスチェック: `/healthz`

## 確認用環境・本番
```bash
cp .env.example .env.staging    # 値を記入（トークンは互いに異なる32文字以上の乱数）
docker compose -f deploy/docker-compose.yml up -d staging     # Docker（ビルド未検証）
# または: APP_ENV=staging OPERATOR_TOKEN=… VERIFIER_TOKEN=… DB_PATH=/var/lib/nisa-sim/staging/app.sqlite node server/index.js
```
HTTPS リバースプロキシ・管理画面のIP制限・削除ジョブの設定例は `deploy/`、手順は [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 実データ
```bash
npm run check-data   # market-data/raw の元CSVを台帳（catalog.json）と照合・再検証
npm run build-data   # 検証して取込ファイル market-data/build/dataset.json を生成
```
出典・ハッシュ・検証結果・許諾状態は [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md)。

## 検証
```bash
npm test                                   # 43件
node scripts/loadtest.js 300 60 session    # ファイルDB・別プロセスで負荷確認（fullrun で最悪ケース）
```

## 文書
| 文書 | 内容 |
|---|---|
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | 要件定義（目的・利用者・確定/未確定事項・対象外・受入条件・完成の段階） |
| [docs/DESIGN.md](docs/DESIGN.md) | 基本設計（構成・画面・遷移・権限・開始から削除までの流れ）とデータ設計（テーブル・制約・保存期間） |
| [docs/SPEC.md](docs/SPEC.md) | 詳細設計（注文の状態遷移・日次処理の順序・資産評価・積立・配当/分割・日付・端数・冪等。計算仕様版 1.2） |
| [docs/API.md](docs/API.md) | API仕様（認証・リクエスト・レスポンス・エラー・冪等キー・期限/権限/未来情報の制約） |
| [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) | データ出典台帳（取得元・取得日時・期間・項目・単位・許諾状態・ハッシュ・検証結果・取引条件の根拠） |
| [docs/DATA_INPUT.md](docs/DATA_INPUT.md) | 取込ファイルの入力仕様と取込手順 |
| [docs/TEST_REPORT.md](docs/TEST_REPORT.md) | テスト・検算仕様と結果（手計算例・負荷・画面・未実施の確認） |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | 運用手順（取込・固定・確認・公開・停止・障害対応・削除・更新/ロールバック・ログ/バックアップ） |
| [docs/CHECKLIST.md](docs/CHECKLIST.md) | さいしんの動作確認チェックリスト（開催回ごと） |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | 制約・未確定事項（本番を妨げる事項と将来の改善の区別） |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 人の判断が必要な事項の記入シート |
