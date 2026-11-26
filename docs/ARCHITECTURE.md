# 設計図（技術者向け・アプリ 0.11.1）

資産形成シミュレーターの構成を、図でまとめたもの。文章での説明は [DESIGN.md](DESIGN.md)（基本設計）、[SPEC.md](SPEC.md)（計算の詳細）、[API.md](API.md)（API）にある。この文書は、それらを読む前の見取り図として使う。

図は Mermaid で書いてある（GitHub ではそのまま図として表示される）。

## 1. 全体の構成（確認用環境の実際の配置）

```mermaid
flowchart LR
  subgraph user["利用者"]
    P["参加者のスマートフォン<br/>ブラウザー"]
    A["管理者のパソコン<br/>ブラウザー"]
  end
  CF["Cloudflare<br/>HTTPS の終端・トンネル"]
  subgraph vps["さくらのVPS（Ubuntu 24.04・1台）"]
    T["cloudflared<br/>systemd --user"]
    subgraph app["Node.js 24.11.1（単一プロセス・systemd --user）"]
      H["HTTP サーバー<br/>127.0.0.1 で待受"]
      J["削除ジョブ<br/>60秒ごと"]
    end
    DB[("SQLite<br/>app.sqlite（WAL）")]
  end
  P -- "HTTPS" --> CF
  A -- "HTTPS" --> CF
  CF -- "トンネル（VPS から外向きに接続）" --> T
  T -- "HTTP（127.0.0.1）" --> H
  H --> DB
  J --> DB
```

- 外から VPS へ直接つながる入口は開けていない（パケットフィルターで許可しているのは SSH だけ）。アプリは 127.0.0.1 で待ち受け、cloudflared が VPS から Cloudflare へ外向きに接続して、そこを通って要求が届く。
- プロセスは1つ、データベースはファイル1つ。外部のサービス（認証基盤・解析・CDN など）は使っていない。npm の依存パッケージもない（QRコードの生成だけ、MIT ライセンスの `public/vendor/qrcode.js` を同梱）。
- 環境は `APP_ENV` で分かれる: `prod`（厳格。許諾・確認の記録がそろわないと公開できない）、`staging`（確認用。未確定の項目を画面に表示したうえで動く）、`dev`（開発・検算用。127.0.0.1 でしか起動しない）。

## 2. サーバーのモジュール構成

```mermaid
flowchart TB
  index["index.js<br/>起動の検査・終了処理"]
  app["app.js<br/>経路の振り分け・認証・制限・静的ファイル"]
  service["service.js<br/>参加者向けの処理（認証・冪等・読み出し）"]
  admin["admin.js<br/>管理の処理（開催回・データ・削除・監査）"]
  auth["auth.js<br/>管理者のログイン（scrypt・セッション）"]
  engine["engine.js<br/>計算（注文・約定・受渡・日次処理・評価）"]
  dataset["dataset.js<br/>市場データの検証・取込・読み込み"]
  money["money.js<br/>整数の丸め（円・1/1000円）"]
  db["db.js<br/>テーブル定義・移行・トランザクション"]
  config["config.js<br/>環境変数・版・コードのハッシュ"]

  index --> app
  app --> service
  app --> admin
  app --> auth
  service --> engine
  service --> dataset
  admin --> dataset
  admin --> service
  engine --> money
  dataset --> money
  service --> db
  admin --> db
  auth --> db
  engine --> db
  dataset --> db
  admin --> config
  service --> config
  app --> config
```

| ファイル | 役割 |
|---|---|
| `server/index.js` | Node の版・トークンの長さ・待受アドレスを検査して起動する。終了時は処理中の要求を待ってからデータベースを閉じる |
| `server/app.js` | `/api/*`（参加者）、`/admin-api/*`（管理者）、`/healthz`、静的ファイルを振り分ける。回数制限、応答ヘッダー（CSP など）、管理者の認証と権限の判定もここ |
| `server/service.js` | 参加者の認証、開催回の状態の判定、冪等キーによる再送の扱い、画面に返す内容の組み立て。更新はすべて `mutate()` を通る |
| `server/engine.js` | 計算の本体。注文の検証、1営業日ごとの処理、資産の評価、NISA と普通の口座の比較 |
| `server/admin.js` | 開催回の作成・変更・公開・停止・削除、市場データの取込と固定、保持時間、監査ログ |
| `server/auth.js` | 管理者アカウント（scrypt のハッシュ）と、ログインのセッション |
| `server/dataset.js` | 取込ファイルの検証（期間・重複・欠損・禁止語など）と、メモリ上の読み込み（キャッシュ） |
| `public/app.js` | 参加者の画面。計算はせず、サーバーの結果を表示するだけ |
| `public/admin.js` | 管理者の画面 |

## 3. 画面とAPIの対応

```mermaid
flowchart LR
  subgraph pub["参加者の画面（public/app.js）"]
    s1["開始・質問"]
    s2["ホーム"]
    s3["えらぶ（買う・売る）"]
    s4["商品・注文・積立"]
    s5["記録・比較"]
    s6["メニュー・やり直し"]
  end
  subgraph api["/api"]
    a1["GET /event<br/>POST /join"]
    a2["GET /me<br/>POST /advance"]
    a3["GET /instruments"]
    a4["GET /instruments/:id<br/>POST /orders/preview<br/>POST /orders<br/>POST /orders/:id/cancel<br/>POST /plans, /plans/:id"]
    a5["GET /history<br/>GET /compare"]
    a6["POST /monthly<br/>POST /restart"]
  end
  s1 --> a1
  s2 --> a2
  s3 --> a3
  s4 --> a4
  s5 --> a5
  s6 --> a6
```

- 参加者は、参加したときに発行されるトークン（`Authorization: Bearer`）で識別する。サーバーにはトークンの SHA-256 だけを保存する。氏名などは受け取らない。
- 画面から日付や残高は送らない。更新の要求に付けるのは、冪等キー（`request_id`）と、画面が見ている日付（`expected_sim_date`。食い違えば 409）だけ。
- 通信が切れて結果が分からないときは、`GET /api/requests/:id` で同じ `request_id` の結果を照会する。

## 4. 更新の要求の流れ（「1か月進める」の例）

```mermaid
sequenceDiagram
  participant B as 参加者の画面
  participant A as app.js
  participant S as service.js（mutate）
  participant E as engine.js
  participant D as SQLite
  B->>A: POST /api/advance {request_id, expected_sim_date, mode: month}
  A->>S: opAdvance
  S->>D: BEGIN IMMEDIATE
  S->>D: トークンから参加者・開催回・口座を読む
  Note over S: 開催回の状態をサーバー時刻で判定（終了・停止なら拒否）
  S->>D: 同じ request_id の記録を探す
  alt 記録がある（再送）
    S-->>A: 保存してある応答を返す
  else はじめての要求
    Note over S: expected_sim_date が違えば 409
    loop 月が変わるか、止まる理由が出るまで
      S->>E: processDay（1営業日）
      E->>D: 入金・権利処理・約定・積立・受渡・評価の記録
    end
    S->>D: request_id と応答を保存
    S->>D: COMMIT
    S-->>A: 進んだ日数・できごと・止まった理由
  end
  A-->>B: 200
  B->>A: GET /api/me
  A-->>B: その日付までの資産・推移・ニュース
```

- 1営業日の処理順: 月初の入金 → 分割・併合 → 配当・分配金の確定 → 株式・ETF の約定 → 投資信託の約定 → 積立の注文 → 受渡（現金の出入り）→ 資産の評価の記録・ニュース・最終日の判定。早送りも、この1日分のくり返し。
- 「1か月」は、注文の成立・失効、積立の見送り、ニュースの公表があった日で止まる。
- 読み出しでは、その口座の日付より後の価格・ニュースを返さない（サーバー側で切る）。

## 5. データの構造

```mermaid
erDiagram
  datasets ||--o{ dataset_sources : "出典"
  datasets ||--o{ instruments : "商品"
  datasets ||--o{ prices : "日次の価格"
  datasets ||--o{ actions : "配当・分割"
  datasets ||--o{ news : "ニュース"
  datasets ||--o{ events : "使う"
  events ||--o{ participants : "参加"
  participants ||--o{ accounts : "試行（1回目・2回目…）"
  accounts ||--o{ holdings : "保有"
  accounts ||--o{ orders : "注文"
  accounts ||--o{ receivables : "受渡待ち"
  accounts ||--o{ ledger : "台帳"
  accounts ||--o{ plans : "積立"
  accounts ||--o{ snapshots : "日ごとの総資産"
  accounts ||--o{ requests : "冪等キー"
  plans ||--o{ plan_runs : "月ごとの実行"
  admin_users ||--o{ admin_sessions : "ログイン"
  events ||--o{ purge_log : "削除の記録"

  datasets { text id PK
    text kind
    text status
    text content_hash }
  events { text id PK
    text join_code
    text starts_at
    text ends_at
    text sim_start
    text sim_end
    text admin_state }
  participants { text id PK
    text token_hash }
  accounts { int id PK
    int attempt
    text status
    text sim_date
    int cash
    int deposits }
  orders { int id PK
    text side
    text status
    text exec_date
    int reserve }
  ledger { int id PK
    text type
    int amount
    text key }
```

| まとまり | テーブル | 寿命 |
|---|---|---|
| 市場データ | `datasets`, `dataset_sources`, `instruments`, `prices`, `actions`, `news` | 取込後に固定（ロック）すると変更できない。開催回の削除では消えない |
| 開催回 | `events` | 管理者が削除するまで残る |
| 参加者のデータ | `participants`, `accounts`, `holdings`, `orders`, `receivables`, `ledger`, `plans`, `plan_runs`, `snapshots`, `requests` | 開催回の終了から保持時間（既定24時間）が過ぎると、削除ジョブがまとめて消す |
| 管理 | `admin_users`, `admin_sessions`, `admin_audit`, `purge_log` | 残る（監査ログと削除記録には、参加者の中身を書かない） |

- 金額は円の整数、価格は 1/1000 円の整数で持つ。浮動小数点で金額を計算しない。
- 台帳（`ledger`）は `(account_id, key)` が一意で、同じ入金や受渡を二重に記録できない。現金残高は、台帳の現金に関わる行の合計と常に一致する（自動テストで全営業日を検査）。
- 総資産 ＝ 現金 ＋ 保有の評価額 − 未受渡の買付代金 ＋ 未受渡の売却代金 ＋ 未収の配当等。

## 6. 状態の移り変わり

### 開催回

```mermaid
stateDiagram-v2
  [*] --> 未公開: 作成
  未公開 --> 開始前: 公開（開始時刻より前）
  未公開 --> 開催中: 公開
  開始前 --> 開催中: 開始時刻
  開催中 --> 一時停止中: 一時停止
  一時停止中 --> 開催中: 再開
  開催中 --> 終了: 終了時刻
  一時停止中 --> 終了: 終了時刻
  開催中 --> 緊急停止中: 終了する（緊急停止）
  終了 --> 削除済み: 保持時間の経過（削除ジョブ）
  緊急停止中 --> 削除済み: 保持時間の経過
  削除済み --> [*]: 管理者が削除
```

状態はデータベースに持つ値（`admin_state`）とサーバー時刻から、要求のたびに求める。データや計算に関わる設定が公開後に変わると、公開は取り消される（本番環境では、さらに動作確認の記録が現在の構成と一致していることが条件）。

### 注文

```mermaid
stateDiagram-v2
  [*] --> 受付済み: 注文（買付額・数量を確保）
  受付済み --> 取消済み: その日のうちに取消
  受付済み --> 成立済み: 成立日の価格で約定
  受付済み --> 失効: 価格なし・確保額の超過・期間の終わり・やり直し
  成立済み --> [*]: 受渡日に現金が動く
```

## 7. 市場データが画面に出るまで

```mermaid
flowchart LR
  raw["market-data/raw/<br/>運用会社の公開CSV（取得したまま）"]
  cat["market-data/catalog.json<br/>台帳（出典・ハッシュ・取引条件・ニュース）"]
  build["scripts/build-dataset.js<br/>照合・再検証"]
  bundle["market-data/build/dataset.json<br/>取込ファイル"]
  imp["POST /admin-api/datasets/import<br/>検証して保存（draft）"]
  lock["POST /admin-api/datasets/:id/lock<br/>固定（locked）"]
  ev["開催回<br/>データと期間を指定"]
  raw --> build
  cat --> build
  build --> bundle
  bundle --> imp
  imp --> lock
  lock --> ev
```

- 元のCSVと生成した取込ファイルは、利用許諾が未確認のためリポジトリに入れていない（`.gitignore`）。台帳に取得元とハッシュがあり、同じファイルかどうかを照合できる。
- 価格は元の値のまま使う（補完・調整・予測をしない）。空欄の分配金を0円に置き換えない。
- ニュースの解説と「考え方の例」は、取込のときに禁止語（売買のすすめや値動きの見通しにあたる表現）を検査する。

## 8. 認証と権限

```mermaid
flowchart TB
  subgraph part["参加者"]
    pt["参加トークン<br/>（QRコードで参加したときに発行）"]
  end
  subgraph adm["管理者"]
    lg["IDとパスワード<br/>→ Cookie（HttpOnly・SameSite=Strict・Secure・12時間）"]
    tk["管理トークン<br/>（確認担当・復旧・運用スクリプト用）"]
  end
  pt --> api["/api/*<br/>自分の口座だけ"]
  lg --> op["operator（実用）<br/>すべての管理操作"]
  lg --> te["tester（テスト用）<br/>自分が作った説明会だけ・50人・7日まで"]
  tk --> op
  tk --> ve["verifier（確認担当）<br/>動作確認の記録だけ"]
  op --> aapi["/admin-api/*"]
  te --> aapi
  ve --> aapi
```

- パスワードは scrypt のハッシュ（アカウントごとのソルト）で保存する。セッションとトークンは SHA-256 だけを保存する。
- ログインの失敗は、送信元ごとに1分10回まで。同じIDで5回続くと、そのIDは15分使えない。
- Cookie で認証した変更操作は、同じサイトの画面からの要求だけを受け付ける（Origin を照合）。
- 管理者の画面とAPIからは、参加者一人ひとりの口座・注文の中身を読めない（人数と件数だけ）。

## 9. 主な設計上の決めごと

| 決めたこと | 理由 |
|---|---|
| 単一プロセス＋SQLite | 説明会1回の規模（数十〜数百人）なら足り、運用する部品が少ない。300人・60秒の負荷を手元で確認済み（[TEST_REPORT.md](TEST_REPORT.md)） |
| 計算はすべてサーバー | 画面から残高や日付を受け取らないので、端末側の改変で結果を変えられない |
| 金額は整数 | 丸めの位置を仕様として決められる（[SPEC.md](SPEC.md) §0） |
| 更新はすべて冪等キーつき | 会場のWi-Fiで通信が切れても、二重の注文・二重の進行が起きない |
| 未来の情報はサーバーで切る | 画面のコードを読んでも、その日付より後の価格やニュースは手に入らない |
| 参加者のデータは終了後に自動で削除 | 匿名のデータでも残さない。削除の記録には件数だけを残す |
| 依存パッケージなし | 確認する対象を、このリポジトリのコードと Node.js 本体に限る |

## 10. 既知の制約

- `node:sqlite` は Node 24 の時点で実験的機能。検証した版（24.11.1）以外では、本番・確認用環境を起動しない。
- 1台・1プロセスなので、止まれば全体が止まる。冗長化はしていない。
- 市場データの利用許諾、取引条件、ニュースの文言は、さいしんの確認が済んでいない（[LIMITATIONS.md](LIMITATIONS.md)）。
