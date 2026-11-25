# API仕様（アプリ 0.5.0）

すべて JSON。応答には `Cache-Control: no-store` と CSP 等のヘッダーが付く。日付は `YYYY-MM-DD`（シミュレーション上の日付）、日時は ISO 8601（実際の時刻・UTC）。金額は円の整数、価格は 1/1000 円の整数（`*_milli`）。

## 1. 共通
### 認証
| 対象 | 方法 |
|---|---|
| 参加者 | `POST /api/join` が返す `token` を `Authorization: Bearer <token>` で送る。サーバーはハッシュのみ保存 |
| 管理 | `Authorization: Bearer <OPERATOR_TOKEN または VERIFIER_TOKEN>`。URL・クエリ・Cookie では受け付けない |

### 制約（すべてサーバー側で判定）
- **期限**: 開催回の状態が 終了・緊急停止・削除済み・未公開・確認未了・開始前 のとき、参加者APIは閲覧を含めすべて `410`。一時停止中は閲覧のみ可で、更新は `423`。判定はサーバー時刻（端末の時計は無関係）。更新はトランザクション内で再判定するため、終了時刻をまたぐ操作は成立しない。
- **権限**: 参加者APIはトークンの本人の口座だけを対象にする。参加者ID・口座ID・日付を指定する引数はない。
- **未来情報**: 価格・ニュース・権利情報は、その参加者のシミュレーション日付以前のものだけを返す。応答に含まれる未来の日付は、約定予定日・受渡予定日・入金予定日・次回入金日・最終日だけ。データの最終日より後の価格は存在せず、返す経路もない。

### 冪等キー（更新系の POST）
| 項目 | 内容 |
|---|---|
| `request_id` | 必須。8〜80文字。クライアントが操作ごとに生成（UUID） |
| 再送 | 同じ `request_id` は保存済みの応答に `replayed: true` を付けて返す（二重に実行しない。同じ参加者の全試行で照合） |
| `expected_sim_date` | 任意。現在のシミュレーション日付と違えば `409`（複数タブ・古い画面）。応答に `sim_date` |
| 結果不明時 | `GET /api/requests/{request_id}` で受付状況を照会。未受付なら同じIDで再送できる |

### エラー
応答は `{ "error": "日本語の説明", ... }`。
| 状態 | 意味 |
|---|---|
| 400 | 形式不正（JSON、`request_id` なし、引数の型） |
| 401 | 認証なし・トークン無効（削除済みを含む） |
| 403 | 権限なし（管理の役割違い） |
| 404 | 対象なし |
| 409 | 状態の競合（古い日付、構成の不一致、参加者がいる回の計算条件変更など） |
| 410 | この説明会は利用できない（`status` に理由） |
| 413 | 送信データが大きすぎる（参加者 32KB、管理 12MB） |
| 422 | 業務エラー（資金不足、単位違い、取消期限切れ、最終日到達など。`errors` に一覧） |
| 423 | 一時停止中・参加不可 |
| 429 | 定員超過、参加操作の集中、管理認証の失敗超過 |
| 500 | 内部エラー（状態は変更されない。内容はログのみ） |

## 2. 参加者API
| メソッド・経路 | 内容 |
|---|---|
| `GET /api/event?code=` | 開催回の公開情報: `name, status, status_ja, starts_at, ends_at, server_now, joinable, funds{defaults{initial_cash, monthly_deposit}, limits{initial_max, monthly_max, step}}, data_ready, data{kind, period{start,end}, pending[]（未確定のまま動いている項目）, license_confirmed, sources[]}, retention_hours, disclaimers[], env`。認証不要 |
| `POST /api/join` `{code, initial_cash?, monthly_deposit?}` | 参加。開催中のみ。`{token}` を返す。定員超過は 429。金額は参加者が選んだ資金条件（円・整数、最初 0〜1,000万・毎月 0〜30万・1,000円単位・両方0は不可。範囲外は 422）。省略時は開催回の既定値。**質問への回答（学年・収入・支出）は送らない** |
| `GET /api/me` | 口座の全体像（下記） |
| `GET /api/instruments?q=&category=` | 一覧: `items[{id,type,name,category,description,price_milli,price_date,stale,prev_close_milli,spark[]（直近30営業日の価格。その参加者の日付まで）,qty,value}], categories[]` |
| `GET /api/instruments/{id}` | 詳細: 上記＋`series[[date, close_milli]]`（日付以前のみ）, `terms`, `source`, `holding`, `sellable`, `plan`, `available`, `open_orders[]` |
| `GET /api/history?attempt=` | `orders[], ledger[], plans[]`。`attempt` は本人の過去の試行（閲覧専用） |
| `GET /api/compare` | 本人の試行の比較（共通の日付時点。順位なし）。各試行の `conditions{initial_cash, monthly_deposit}` と `same_conditions` を返す |
| `GET /api/requests/{request_id}` | `{found: true, response}` または `{found: false, message}` |
| `POST /api/orders/preview` | 注文の事前検証（保存しない）: `{ok, errors[], info}` |
| `POST /api/orders` | 注文。`{request_id, expected_sim_date?, instrument_id, side: buy/sell, amount?（投信の買い・円）, qty?（売り・株式の買い）, sell_all?}` → `{ok, order_id, info, message}` |
| `POST /api/orders/{id}/cancel` | 取消（注文した日のうちのみ） |
| `POST /api/advance` | 時間進行。`{request_id, expected_sim_date?, mode: day/month}` → `{ok, days, events[{date,type,text}], stop{reason,message,next}}` |
| `POST /api/plans` | 積立の設定。`{request_id, instrument_id, amount, day_of_month(1〜28)}` |
| `POST /api/plans/{id}` | 積立の変更。`{request_id, action: amount/pause/resume/cancel, amount?}` |
| `POST /api/restart` `{request_id, initial_cash?, monthly_deposit?}` | 結果を保存してやり直す（10回まで）。金額を省略すれば同じ条件、指定すれば条件を変える |

### 管理APIの認証（0.10.0）
- `POST /admin-api/login` `{id, password}` → Cookie `nisa_admin`（HttpOnly）を発行し、`{ok, role, user}` を返す。誤りは 401（IDの有無によらず同じ文言）、制限中は 429。
- `POST /admin-api/logout`、`POST /admin-api/password` `{current, new}`（ログイン中のみ。規則に合わなければ 422）。
- `GET /admin-api/whoami` → `{role: operator|tester|verifier, user, via: session|token, role_ja, ...}`。
- `DELETE /admin-api/events/:id` … 説明会を削除（参加者データを消してから説明会を消す。operator、または自分が作った説明会の tester）。
- 認証は Cookie（ログイン）か `Authorization: Bearer <管理トークン>`。tester は `GET /events`（自分の分だけ）・`GET /datasets`・`POST /events`（上限つき）・自分の説明会の `enable|pause|resume|emergency_stop` だけが許され、ほかは 403。

### `GET /api/me` の主な項目
- `nisa{gain, tax, after_tax, rate_text, annual_limit, over_limit_years[{year, bought}]}`: NISA口座と普通の口座の比較（概算。SPEC §6b）。`tax` は普通の口座だった場合の税額、`after_tax` は手元に残る利益。
- `news[]` の各件に `explain`（解説。なければ null）と `views[{label, text}]`（考え方の例2つ。なければ null）。
| 項目 | 内容 |
|---|---|
| `server_now` | サーバーの実時刻 |
| `event` | `name, status, ends_at, retention_hours, env, data{kind, period, license_confirmed, sources[]}, provisional, initial_cash, monthly_deposit（この口座の資金条件）, funds_limits{initial_max, monthly_max, step}, period{start,end}, app_version, calc_spec_version` |
| `account` | `attempt, status(active/finished/saved), sim_date, final_date, version` |
| `assets` | `cash, reserved, payable_purchase, available, holdings_value, receivable_sale, receivable_dividend, total, deposits, pnl, holdings[{instrument_id,name,type,category,spark[],qty,unsettled_qty,sellable_qty,cost,price_milli,price_date,stale,value,pnl}]` |
| `allocation` | 分類別の評価額と現金等: `[{label, value, pct_bp}]`（合計＝総資産） |
| `series` | 日次の `{date,total,deposits}` |
| `news` | 日付以前に公表されたもの（新しい順・最大20件） |
| `orders, plans, receivables` | 受付済み注文、積立、受渡・入金の予定 |
| `next_deposit_date` | 次の追加資金の入金日 |
| `disclaimers` | 必須3文言 |

注文の `info`: `instrument_id, side, kind, order_date, cancel_deadline, exec_date, settle_date, available, ref_price_milli, ref_price_date, amount / qty, reserve, fee_estimate`（株式の買いは `reserve_price_milli, reserve_gross, reference_amount`、売りは `held, unsettled, sellable`）。

時間進行の `stop.reason`: `order_filled`（手動注文・売りの成立）/ `order_lapsed`（失効）/ `plan_skipped`（積立の見送り）/ `news` / `end`（最終日）。

## 3. 管理API（`/admin-api`）
| メソッド・経路 | 役割 | 内容 |
|---|---|---|
| `GET /whoami` | 両方 | 役割、環境、アプリ版、計算仕様版、実行コードのハッシュ、Node版 |
| `GET /events` | 両方 | 開催回の一覧（状態、人数、削除予定、仮設定、構成指紋、確認記録） |
| `GET /datasets` | 両方 | データの一覧（版、チェックサム、件数、出典と許諾状態、検証の警告） |
| `GET /purge` | 両方 | 削除記録と失敗中の開催回 |
| `POST /events/{id}/verify` | **確認担当のみ** | `{verified_by, reference, note?, fingerprint}`。`fingerprint` が現在の構成と違えば 409 |
| `POST /events` | 運用担当 | 開催回の作成（全項目が仮設定で始まる） |
| `PATCH /events/{id}` | 運用担当 | 変更。計算条件・仮設定の変更は確認を解除（参加者がいる回は 409） |
| `POST /events/{id}/enable` `pause` `resume` `emergency_stop` | 運用担当 | 公開の条件: 本番は「データ固定・未確定事項なし・仮設定なし・確認が有効・期間設定済み」。確認用環境は「データ固定・期間設定済み」のみ |
| `POST /events/{id}/retention-preview` | 運用担当 | 保持時間変更の影響（新しい削除予定・対象人数） |
| `POST /events/{id}/retention` | 運用担当 | `{hours, confirm: true}` |
| `POST /events/{id}/purge` | 運用担当 | 即時削除。`{confirm_name}` に開催名の再入力が必要 |
| `POST /datasets/preview` | 運用担当 | 取込ファイルの検証のみ（保存しない） |
| `POST /datasets/import` | 運用担当 | 下書きとして取込（1トランザクション） |
| `POST /datasets/{id}/license` | 運用担当 | `{source_id, status: confirmed/unconfirmed, note}`。下書きの間のみ |
| `POST /datasets/{id}/lock` | 運用担当 | 固定。本番では「全出典の許諾確認済み・全商品条件が確定・基準が確定」が条件。確認用環境は未確定でも固定でき、応答の `pending` に未確定事項を返す |

## 4. その他
| 経路 | 内容 |
|---|---|
| `GET /healthz` | `{ok: true}`（DB読み出しまで確認。内部情報は返さない） |
| `GET /` `/admin` と静的ファイル | 画面。トークン等は埋め込まれていない |
