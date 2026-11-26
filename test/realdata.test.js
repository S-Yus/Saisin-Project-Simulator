'use strict';
// 実データ（market-data/）の再検証と、実データ上での検算・期間終了の確認。
// 利用許諾は未確認のため、ここでの固定は dev 環境の一時DB（メモリ）だけで行う（許諾を確認済みにする操作は行わない）。
const baseTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setup, api } = require('./fixture');
const { build } = require('../scripts/build-dataset');
const A = require('../server/admin');
const S = require('../server/service');
const E = require('../server/engine');
const { openDb } = require('../server/db');

const MD = path.join(__dirname, '..', 'market-data');
// 元データ（market-data/raw/）は利用許諾が未確認のためリポジトリに含めていない。無い環境ではこのファイルのテストを見送る
const HAVE_RAW = fs.existsSync(path.join(MD, 'raw', '358347.csv'));
const test = HAVE_RAW ? baseTest : (name) => baseTest(name, { skip: 'market-data/raw がありません（docs/DATA_SOURCES.md の取得元から取得してください）' }, () => {});
const built = HAVE_RAW ? build() : null;
const cat = JSON.parse(fs.readFileSync(path.join(MD, 'catalog.json'), 'utf8'));

// テスト側の独立した読み取り（生成スクリプトのパーサーを使わない）: 日付 → 基準価額（円/1万口）
function rawNav(id) {
  const f = cat.funds.find((x) => x.id === id); const file = f.files.find((x) => x.role === 'nav').file;
  const m = new Map();
  for (const l of fs.readFileSync(path.join(MD, file), 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const a = l.match(/^(\d{4})[-/](\d{2})[-/](\d{2}),(?:"([\d,]+)"|(\d+)),/); if (a) m.set(`${a[1]}-${a[2]}-${a[3]}`, Number((a[4] || a[5]).replace(/,/g, '')));
  }
  return m;
}
const accOf = (env, tok) => env.db.prepare('SELECT a.* FROM accounts a JOIN participants p ON p.id=a.participant_id WHERE p.token_hash=? ORDER BY attempt DESC LIMIT 1').get(S.sha(tok));
const lastOrder = (env, tok) => env.db.prepare('SELECT * FROM orders WHERE account_id=? ORDER BY id DESC LIMIT 1').get(accOf(env, tok).id);

test('実データ: 元ファイルのハッシュ・形式・単位・期間・重複・欠損を再検証し、採用候補と未採用を分ける', () => {
  assert.deepEqual(built.errors, []);
  const r = built.report;
  assert.equal(r.expected_business_days, 730, '対象期間の国内営業日（平日−祝日−年末年始）');
  assert.deepEqual(r.adopted, ['358347', '313567', '645013', '313528', '140882', '140873', '643718']);
  for (const f of r.funds) {
    assert.ok(f.files.every((x) => x.hash_ok), `${f.id}: 元ファイルのハッシュ`);
    assert.equal(f.selected_rows, 730, f.id); assert.deepEqual(f.selected_range, ['2023-11-01', '2026-10-30']);
    assert.equal(f.duplicates, 0); assert.equal(f.invalid, 0);
    assert.deepEqual(f.missing_business_days, []); assert.deepEqual(f.extra_days, []);
    assert.equal(f.distributions_reported.length, 3, `${f.id}: 期間内の決算日3回が出典に明記`);
  }
  // 採用候補は、期間内の分配金がすべて「0円」と明記されている（空欄を0と読み替えたのではない）
  for (const id of r.adopted) assert.ok(r.funds.find((f) => f.id === id).distributions_reported.every((d) => Number(d.value) === 0));
  assert.equal(built.bundle.actions.length, 0);
  // 分配金があるのに支払日データがない商品は採用できない（支払日を作らない）
  const nk = r.funds.find((f) => f.id === '140875');
  assert.equal(nk.ok, false); assert.ok(nk.errors.every((e) => /支払日データがありません/.test(e))); assert.equal(nk.errors.length, 3);
  // 取込ファイル: 価格は元CSVの値と1件ずつ一致（丸め・補完・期間外の行なし）
  const rows = built.bundle.prices_csv.trim().split('\n').slice(1).map((l) => l.split(','));
  assert.equal(rows.length, 7 * 730);
  const navs = new Map(r.adopted.map((id) => [id, rawNav(id)]));
  for (const [id, d, open, close, st] of rows) { assert.equal(open, ''); assert.equal(st, 'normal'); assert.equal(Number(close), navs.get(id).get(d), `${id} ${d}`); assert.ok(d >= '2023-11-01' && d <= '2026-10-31'); }
  assert.equal(built.bundle.news.length, 10);
  assert.ok(built.bundle.sources.every((s) => s.license_status === 'unconfirmed'), '許諾は未確認のまま出力される');
});

test('実データ: 本番では、許諾未確認・条件仮設定・基準未確定のままでは固定できない', () => {
  const db = openDb(':memory:');
  const pv = A.previewDataset(built.bundle, 'staging'); assert.equal(pv.ok, true, JSON.stringify(pv.errors));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM datasets').get().c, 0, 'プレビューは保存しない');
  const imp = A.importDataset(db, built.bundle, 'staging', '2026-11-23T00:00:00Z'); assert.equal(imp.ok, true);
  const lk = A.lockDataset(db, imp.id, '2026-11-23T00:00:00Z', 'prod');
  assert.equal(lk.ok, false);
  assert.ok(lk.errors.some((e) => /利用許諾が未確認/.test(e)) && lk.errors.some((e) => /仮設定/.test(e)) && lk.errors.some((e) => /未確定/.test(e)), lk.errors.join(' / '));
  assert.equal(db.prepare('SELECT status FROM datasets WHERE id=?').get(imp.id).status, 'draft');
});

test('確認用環境: さいしんの確認の前に、未確定のまま固定・公開して動かせる。同じDBを本番として動かしても公開できない', () => {
  const cfg = require('../server/config'); const save = { STRICT: cfg.STRICT, ENV: cfg.ENV, REVIEW: cfg.REVIEW };
  const db = openDb(':memory:'); const now = Date.parse('2026-12-01T01:00:00Z'); const iso = new Date(now).toISOString();
  try {
    cfg.STRICT = true; cfg.ENV = 'staging'; cfg.REVIEW = true;
    const imp = A.importDataset(db, built.bundle, 'staging', iso); assert.equal(imp.ok, true);
    const lk = A.lockDataset(db, imp.id, iso, 'staging');
    assert.equal(lk.ok, true); assert.equal(lk.pending.length, 3, '未確定事項は固定の結果として返る（消えない）');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM dataset_sources WHERE license_status=?').get('confirmed').c, 0, '固定しても許諾は確認済みにならない');
    const ev = A.createEvent(db, { name: '確認用', starts_at: '2026-12-01T00:00:00Z', ends_at: '2026-12-01T06:00:00Z', max_participants: 10, initial_cash: 1000000, monthly_deposit: 30000, dataset_id: imp.id, sim_start: '2023-11-01', sim_end: '2026-10-31' }, now, 'operator');
    assert.equal(A.setState(db, ev.id, 'enable', now, 'operator').state, 'enabled', '確認の記録・仮設定の解除なしで公開できる');
    const pub = S.publicEvent(db, ev.join_code, now);
    assert.equal(pub.status, 'open'); assert.equal(pub.env, 'staging');
    assert.deepEqual(pub.data.pending, ['データの利用許諾が未確認', '取引条件が仮設定', '開催回の設定が仮設定', '動作確認が未記録']);
    const tok = S.join(db, ev.join_code, now).token;
    const me = S.me(db, S.auth(db, tok, now, { write: false }), now); assert.equal(me.account.sim_date, '2023-11-01'); assert.equal(me.event.data.pending.length, 4);
    // 終了時刻・緊急停止は確認用環境でも同じ
    assert.throws(() => S.auth(db, tok, Date.parse('2026-12-01T06:00:00Z'), { write: false }), /終了/);
    // 同じDBを本番として動かした場合: 確認の記録がないので開かず、公開操作も拒否される
    cfg.ENV = 'prod'; cfg.REVIEW = false;
    assert.equal(S.publicEvent(db, ev.join_code, now).status, 'unverified');
    assert.throws(() => S.auth(db, tok, now, { write: false }), /動作確認が未了/);
    const row = db.prepare('SELECT * FROM events WHERE id=?').get(ev.id);
    A.recordVerification(db, ev.id, { verified_by: 'x', reference: 'r', fingerprint: S.fingerprint(db, row) }, now, 'verifier');
    db.prepare("UPDATE events SET admin_state='draft' WHERE id=?").run(ev.id);
    assert.throws(() => A.setState(db, ev.id, 'enable', now, 'operator'), /未確定事項があるため本番では公開できません/);
  } finally { Object.assign(cfg, save); }
});

test('実データ検算: 投信の購入（手数料込み・口数）と売却（留保額・受渡）を元CSVの基準価額から手計算', () => {
  const env = setup(built.bundle); const a = api(env); const tok = a.join(); const cal = env.ds.calendar;
  assert.equal(accOf(env, tok).sim_date, '2023-11-01');
  // ① ハッピークローバー1年（313528）: 手数料2.2%（内枠）、注文日の2営業日後の基準価額
  //    10万円 → 手数料 floor(100000×22000/1022000)=2152、正味 97,848。2023-11-06 の基準価額 14,310 円/万口
  //    口数 floor(97848×10000/14310)=68,377口、約定代金 ceil(68377×14310/10000)=97,848、支払 100,000
  const nav1 = rawNav('313528'); assert.equal(nav1.get('2023-11-06'), 14310); assert.equal(cal[2], '2023-11-06');
  const o1 = a.order(tok, { instrument_id: '313528', side: 'buy', amount: 100000 });
  assert.equal(o1.info.exec_date, '2023-11-06'); assert.equal(o1.info.fee_estimate, 2152);
  // ② Jリート1年（140873）: 手数料2.2%、翌営業日の基準価額、留保額0.3%
  const nav2 = rawNav('140873'); const n2 = nav2.get(cal[1]);
  a.order(tok, { instrument_id: '140873', side: 'buy', amount: 50000 });
  const fee2 = Math.floor((50000 * 22000) / 1022000); const units2 = Math.floor(((50000 - fee2) * 10000) / n2); const inv2 = Math.ceil((units2 * n2) / 10000);
  a.advance(tok, 'day'); // 2023-11-02: ②が約定（①はまだ）
  let me = a.me(tok); let h2 = me.assets.holdings.find((h) => h.instrument_id === '140873');
  assert.equal(h2.qty, units2); assert.equal(h2.cost, inv2 + fee2);
  assert.equal(me.assets.cash, 1000000 - (inv2 + fee2)); assert.equal(me.assets.reserved, 100000);
  assert.equal(me.assets.total, 1000000 - (inv2 + fee2) + Math.floor((units2 * n2) / 10000));
  a.advance(tok, 'day'); // 2023-11-06: ①が約定
  const f1 = env.db.prepare("SELECT * FROM orders WHERE instrument_id='313528'").get();
  assert.deepEqual([f1.status, f1.closed_date, f1.price_milli, f1.units, f1.gross, f1.fee], ['filled', '2023-11-06', 14310000, 68377, 97848, 2152]);
  me = a.me(tok);
  assert.equal(me.assets.cash, 1000000 - (inv2 + fee2) - 100000);
  const v2 = Math.floor((units2 * nav2.get('2023-11-06')) / 10000);
  assert.equal(me.assets.total, me.assets.cash + Math.floor((68377 * 14310) / 10000) + v2, '総資産 = 現金 + 元CSVの基準価額による評価額');
  // ③ ②を全売却: 翌営業日の基準価額、留保額 floor(代金×0.3%)、受渡は約定日の3営業日後
  const so = a.order(tok, { instrument_id: '140873', side: 'sell', sell_all: true });
  assert.equal(so.info.qty, units2); assert.equal(so.info.exec_date, cal[3]); assert.equal(so.info.settle_date, cal[6]);
  a.advance(tok, 'day');
  const gross = Math.floor((units2 * nav2.get(cal[3])) / 10000); const hb = Math.floor((gross * 3000) / 1000000);
  const s = lastOrder(env, tok); assert.deepEqual([s.status, s.gross, s.fee, s.price_milli], ['filled', gross, hb, nav2.get(cal[3]) * 1000]);
  me = a.me(tok); assert.equal(me.assets.receivable_sale, gross - hb); const cashBefore = me.assets.cash; const totalAtFill = me.assets.total;
  assert.equal(totalAtFill, cashBefore + (gross - hb) + Math.floor((68377 * nav1.get(cal[3])) / 10000));
  for (let i = 0; i < 3; i++) a.advance(tok, 'day');
  me = a.me(tok); assert.equal(me.account.sim_date, cal[6]); assert.equal(me.assets.cash, cashBefore + gross - hb); assert.equal(me.assets.receivable_sale, 0);
});

test('実データ: 積立用の単位・一括購入の可否は商品条件に従う（クライアントからの偽装は無効）', () => {
  const b = JSON.parse(JSON.stringify(built.bundle)); b.instruments.find((i) => i.id === '358347').terms.spot_buy_ok = false;
  const env = setup(b); const a = api(env); const tok = a.join();
  assert.throws(() => a.order(tok, { instrument_id: '358347', side: 'buy', amount: 10000 }), /積立（定時定額）でのみ/);
  assert.throws(() => a.orderRaw(tok, { request_id: 'fake-plan-0001', instrument_id: '358347', side: 'buy', amount: 10000, _plan: true }), /積立（定時定額）でのみ/);
  assert.throws(() => a.order(tok, { instrument_id: '313528', side: 'buy', amount: 1000 }), /最低購入金額は 10,000円/);
  assert.throws(() => a.plan(tok, { instrument_id: '313528', amount: 1500, day_of_month: 5 }), /1,000円以上、1,000円単位/);
  assert.throws(() => a.plan(tok, { instrument_id: '645013', amount: 1000, day_of_month: 5 }), /積立に対応していません/);
  a.plan(tok, { instrument_id: '313528', amount: 1000, day_of_month: 5 }); a.plan(tok, { instrument_id: '358347', amount: 3000, day_of_month: 5 });
  a.advance(tok, 'month'); a.advance(tok, 'month');
  const filled = env.db.prepare("SELECT instrument_id,amount FROM orders WHERE status='filled' AND origin='plan' ORDER BY instrument_id").all();
  assert.ok(filled.some((o) => o.instrument_id === '358347' && o.amount === 3000) && filled.some((o) => o.instrument_id === '313528' && o.amount === 1000), JSON.stringify(filled));
});

test('期間終了: データの最終日で進行が終わり、その先の価格・資産額は生成されない。成立価格・表示価格はすべて元CSVの値', () => {
  const env = setup(built.bundle); const a = api(env); const tok = a.join(); const day = a.join();
  for (const t of [tok, day]) { a.order(t, { instrument_id: '643718', side: 'buy', amount: 200000 }); a.plan(t, { instrument_id: '358347', amount: 10000, day_of_month: 10 }); a.plan(t, { instrument_id: '140882', amount: 5000, day_of_month: 20 }); }
  let guard = 0; while (accOf(env, tok).status === 'active' && guard++ < 100) a.advance(tok, 'month');
  guard = 0; while (accOf(env, day).status === 'active' && guard++ < 1000) a.advance(day, 'day');
  const acc = accOf(env, tok);
  assert.equal(acc.status, 'finished'); assert.equal(acc.sim_date, '2026-10-30', '元データの対象期間の最終営業日');
  assert.equal(accOf(env, day).sim_date, '2026-10-30');
  // 1日ずつと月単位の早送りで、最終の現金・保有・評価履歴が一致
  const dump = (t) => { const x = accOf(env, t); return JSON.stringify([x.cash, x.deposits, env.db.prepare('SELECT instrument_id,qty,cost FROM holdings WHERE account_id=? ORDER BY 1').all(x.id), env.db.prepare('SELECT date,total FROM snapshots WHERE account_id=? ORDER BY date').all(x.id)]); };
  assert.equal(dump(tok), dump(day));
  // これ以上は進めない・注文できない（サーバーが拒否）
  assert.throws(() => a.advance(tok, 'day'), /進行できません/); assert.throws(() => a.advance(tok, 'month'), /進行できません/);
  assert.throws(() => a.order(tok, { instrument_id: '643718', side: 'buy', amount: 10000 }), /注文はできません/);
  assert.equal(accOf(env, tok).sim_date, '2026-10-30');
  // 評価の記録は元データの営業日だけ（730日）で、最終日より後の日付は1件もない
  const snaps = env.db.prepare('SELECT date FROM snapshots WHERE account_id=? ORDER BY date').all(acc.id).map((r) => r.date);
  assert.deepEqual(snaps, [...rawNav('358347').keys()].filter((d) => d >= '2023-11-01' && d <= '2026-10-31'));
  assert.equal(env.db.prepare("SELECT COUNT(*) c FROM prices WHERE date>'2026-10-31'").get().c, 0);
  assert.equal(env.db.prepare("SELECT COUNT(*) c FROM ledger WHERE date>'2026-10-30'").get().c, 0);
  // すべての成立価格が、その日の元CSVの基準価額と一致（生成・補間された価格がない）
  const fills = env.db.prepare("SELECT instrument_id,closed_date,price_milli FROM orders WHERE account_id=? AND status='filled'").all(acc.id);
  assert.ok(fills.length >= 60);
  const navs = new Map(); const nav = (id) => navs.get(id) || navs.set(id, rawNav(id)).get(id);
  for (const f of fills) assert.equal(f.price_milli, nav(f.instrument_id).get(f.closed_date) * 1000, `${f.instrument_id} ${f.closed_date}`);
  // 画面に返す価格推移も元CSVと全点一致し、最終日で終わる
  for (const id of env.ds.instruments.keys()) {
    const d = a.detail(tok, id); assert.equal(d.series.length, 730); assert.equal(d.series.at(-1)[0], '2026-10-30');
    for (const [dt, m] of d.series) assert.equal(m, nav(id).get(dt) * 1000);
  }
  const me = a.me(tok); assert.equal(me.account.final_date, '2026-10-30'); assert.equal(me.next_deposit_date, null);
  assert.deepEqual(me.event.data.period, { start: '2023-11-01', end: '2026-10-30' }); assert.equal(me.event.data.kind, 'production'); assert.equal(me.event.data.license_confirmed, false);
  assert.equal(me.allocation.reduce((s, x) => s + x.value, 0), me.assets.total, '資産配分の合計＝総資産');
  // 期間終了時に未成立の注文は残らない
  assert.equal(env.db.prepare("SELECT COUNT(*) c FROM orders WHERE account_id=? AND status='accepted'").get(acc.id).c, 0);
});

test('期間終了の境界: 最終日より後に成立する注文は受け付けない（開催回の期間をデータより短くした場合も同じ）', () => {
  const env = setup(built.bundle, { sim_end: '2024-01-31', monthly_deposit: 0 }); const a = api(env); const tok = a.join(); const cal = env.ds.calendar;
  const fin = E.finalDate(env.ds, env.ev); assert.equal(fin, '2024-01-31');
  while (accOf(env, tok).sim_date < cal[cal.indexOf(fin) - 1]) a.advance(tok, 'day'); // 最終日の前営業日
  assert.equal(a.order(tok, { instrument_id: '358347', side: 'buy', amount: 10000 }).info.exec_date, fin); // 翌営業日約定 → 可
  assert.throws(() => a.order(tok, { instrument_id: '313567', side: 'buy', amount: 10000 }), /成立する日がありません/); // 2営業日後 → 期間外
  const r = a.advance(tok, 'day'); assert.equal(r.stop.reason, 'end');
  assert.equal(accOf(env, tok).status, 'finished'); assert.equal(accOf(env, tok).sim_date, fin);
  assert.throws(() => a.advance(tok, 'day'), /進行できません/);
  assert.ok(a.detail(tok, '358347').series.every(([d]) => d <= fin), '期間終了後もデータ上の「その先」は返さない');
});

test('将来の値動きを作る要素がない: サーバーに乱数・補間による価格生成がなく、画面に推奨・予測の表示がない', () => {
  const dir = path.join(__dirname, '..');
  for (const f of ['server/engine.js', 'server/dataset.js', 'server/service.js', 'server/money.js', 'scripts/build-dataset.js']) {
    const t = fs.readFileSync(path.join(dir, f), 'utf8'); assert.equal(/Math\.random|interpolat|extrapolat/i.test(t), false, f);
  }
  // 価格テーブルに書き込むのは取込処理だけ
  for (const f of fs.readdirSync(path.join(dir, 'server'))) { const t = fs.readFileSync(path.join(dir, 'server', f), 'utf8'); if (f !== 'dataset.js') assert.equal(/INSERT INTO prices|UPDATE prices/.test(t), false, f); }
  const ui = fs.readFileSync(path.join(dir, 'public', 'app.js'), 'utf8').replace(/推奨し、勧誘するものではありません/g, '').replace(/すすめるものではありません/g, '').replace(/予測し保証するものではありません/g, '').replace(/予測[^。]{0,24}(ありません|行いません|わけではありません)/g, '').replace(/予測による価格は使っていません/g, '');
  for (const w of ['おすすめ', '初心者向け', '買い時', '上がりそう', '期待リターン', '人気', 'ランキング', '予測']) assert.equal(ui.includes(w), false, `画面に「${w}」が含まれています`);
  assert.ok(fs.readFileSync(path.join(dir, 'public', 'app.js'), 'utf8').includes('過去の実データに基づく取引体験'));
});

test('開発・検算環境は外部から到達できる待受では起動しない', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env: { ...process.env, APP_ENV: 'dev', HOST: '0.0.0.0', PORT: '18999', DB_PATH: ':memory:', OPERATOR_TOKEN: 'a'.repeat(32), VERIFIER_TOKEN: 'b'.repeat(32) }, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 1); assert.match(r.stderr, /ループバック/);
});

test('実データのニュース: 5件すべてに解説と、立場の異なる2つの考え方の例がある（取込検証を通る）', { skip: !fs.existsSync(path.join(__dirname, '..', 'market-data', 'raw')) }, () => {
  const { build } = require('../scripts/build-dataset');
  const news = build().bundle.news;
  assert.equal(news.length, 10);
  for (const n of news) { assert.ok(n.explain && n.explain.length <= 300, n.id); assert.equal(n.views.length, 2, n.id); assert.notEqual(n.views[0].label, n.views[1].label); }
});
