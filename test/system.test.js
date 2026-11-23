'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { bundle36, setup, api, weekdays } = require('./fixture');
const cfg = require('../server/config');
const E = require('../server/engine');
const S = require('../server/service');
const A = require('../server/admin');
const { validateBundle, previewDataset } = require('../server/dataset');
const { createApp } = require('../server/app');
const { openDb } = require('../server/db');

const accOf = (env, tok) => env.db.prepare('SELECT a.* FROM accounts a JOIN participants p ON p.id=a.participant_id WHERE p.token_hash=? ORDER BY attempt DESC LIMIT 1').get(S.sha(tok));
function dump(env, tok) {
  const acc = accOf(env, tok); const q = (sql) => env.db.prepare(sql).all(acc.id);
  return JSON.stringify({
    acc: [acc.sim_date, acc.cash, acc.deposits, acc.status],
    holdings: q('SELECT instrument_id,qty,cost FROM holdings WHERE account_id=? ORDER BY 1'),
    orders: q('SELECT instrument_id,side,qty,amount,status,placed_date,exec_date,settle_date,closed_date,price_milli,gross,fee,units,origin,reason FROM orders WHERE account_id=? ORDER BY id'),
    ledger: q('SELECT date,type,instrument_id,amount,qty FROM ledger WHERE account_id=? ORDER BY id'),
    recv: q('SELECT kind,instrument_id,amount,qty,due_date,status FROM receivables WHERE account_id=? ORDER BY id'),
    snaps: q('SELECT date,total,deposits FROM snapshots WHERE account_id=? ORDER BY date'),
  });
}
const CASH_TYPES = ['deposit', 'purchase_settlement', 'sale_settlement', 'dividend', 'split_fraction'];
function checkInvariants(env, tok) {
  const acc = accOf(env, tok); const v = E.valuation(env.db, acc, env.ds);
  const sum = env.db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM ledger WHERE account_id=? AND type IN (${CASH_TYPES.map((t) => `'${t}'`).join(',')})`).get(acc.id).s;
  assert.equal(acc.cash, sum, `現金=台帳の現金系合計 (${acc.sim_date})`);
  assert.ok(acc.cash >= 0 && v.available >= 0, `現金・買付可能額が負にならない (${acc.sim_date})`);
  assert.equal(v.available, acc.cash - v.reserved - v.payable_purchase);
  assert.equal(v.total, v.cash + v.holdings_value + v.receivable_sale + v.receivable_dividend - v.payable_purchase);
  for (const h of v.holdings) assert.ok(h.sellable_qty >= 0 && h.sellable_qty + h.unsettled_qty <= h.qty);
  const dup = env.db.prepare('SELECT COUNT(*) c FROM (SELECT key FROM ledger WHERE account_id=? GROUP BY key HAVING COUNT(*)>1)').get(acc.id).c; assert.equal(dup, 0);
}
const firstBdOfMonth = (ds, d) => ds.calendar.find((x) => x.slice(0, 7) === d.slice(0, 7)) === d;

// 早送りと1日ずつで同じ操作をするスクリプト。月初の営業日（どちらの進め方でも必ず止まる日）に売買する
function runScript(env, tok, a, mode) {
  a.plan(tok, { instrument_id: 'F1', amount: 10000, day_of_month: 5 });
  a.plan(tok, { instrument_id: 'F2', amount: 20000, day_of_month: 15 });
  for (const [id, q] of [['S1', 100], ['S2', 100], ['E1', 50], ['E2', 30]]) a.order(tok, { instrument_id: id, side: 'buy', qty: q });
  a.order(tok, { instrument_id: 'F1', side: 'buy', amount: 50000 });
  let guard = 0; let lastHook = null;
  const tryDo = (f) => { try { f(); } catch (e) { if (!e.status) throw e; } };
  while (accOf(env, tok).status === 'active') {
    const d = accOf(env, tok).sim_date;
    if (firstBdOfMonth(env.ds, d) && d !== lastHook) {
      lastHook = d; const mo = Number(d.slice(5, 7));
      if (mo % 6 === 0) { tryDo(() => a.order(tok, { instrument_id: 'E1', side: 'sell', qty: 20 })); tryDo(() => a.order(tok, { instrument_id: 'F1', side: 'sell', qty: 10000 })); }
      if (mo % 6 === 3) { tryDo(() => a.order(tok, { instrument_id: 'E1', side: 'buy', qty: 20 })); tryDo(() => a.order(tok, { instrument_id: 'S1', side: 'sell', sell_all: true })); }
    }
    a.advance(tok, mode); checkInvariants(env, tok);
    if (++guard > 3000) throw new Error('loop');
  }
}

test('早送り(月単位)と1日ずつの結果が完全一致し、全営業日で資産の恒等式・非負が成り立つ（36か月、売買・配当・分割を含む）', () => {
  const env = setup(bundle36(), { initial_cash: 3000000 }); const a = api(env);
  const t1 = a.join(), t2 = a.join();
  runScript(env, t1, a, 'day'); runScript(env, t2, a, 'month');
  const d1 = dump(env, t1), d2 = dump(env, t2);
  assert.equal(d1, d2);
  const j = JSON.parse(d1);
  assert.equal(j.acc[3], 'finished'); assert.ok(j.snaps.length > 700);
  for (const ty of ['dividend', 'purchase_settlement', 'sale_settlement']) assert.ok(j.ledger.some((l) => l.type === ty), ty);
  assert.ok(j.orders.some((o) => o.side === 'sell' && o.status === 'filled'));
  console.log(`  [情報] 営業日数 ${j.snaps.length}, 約定 ${j.orders.filter((o) => o.status === 'filled').length}件, 失効 ${j.orders.filter((o) => o.status === 'lapsed').length}件, 最終総資産 ${j.snaps[j.snaps.length - 1].total}`);
});

// 参加者APIの応答に、シミュレーション日付より先の日付が「許可された予定日」以外で含まれないことを検査
const FUTURE_OK = new Set(['exec_date', 'settle_date', 'due_date', 'next_deposit_date', 'final_date', 'end', 'cancel_deadline', 'retrieved_at']);
function scanFuture(obj, simDate, where, key = '') {
  if (Array.isArray(obj)) return obj.forEach((x, i) => scanFuture(x, simDate, `${where}[${i}]`, key));
  if (obj && typeof obj === 'object') return Object.entries(obj).forEach(([k, v]) => scanFuture(v, simDate, `${where}.${k}`, k));
  if (typeof obj === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj) && obj > simDate && obj !== '9999-12-31') assert.ok(FUTURE_OK.has(key), `未来の日付 ${obj} が ${where} に含まれています`);
}
test('未来情報を返さない: 全参加者APIを走査（価格・ニュース・権利情報）、日付・ID改変も無効', () => {
  const env = setup(bundle36(), { initial_cash: 3000000 }); const a = api(env); const tok = a.join(); const other = a.join();
  a.order(other, { instrument_id: 'E1', side: 'buy', qty: 10 }); for (let i = 0; i < 400; i++) a.advance(other, 'day'); // 他人は先に進んでいる
  for (const steps of [0, 60, 250]) {
    for (let i = 0; i < steps; i++) a.advance(tok, 'day');
    if (steps === 60) { a.order(tok, { instrument_id: 'S1', side: 'buy', qty: 100 }); a.plan(tok, { instrument_id: 'F2', amount: 20000, day_of_month: 15 }); }
    const d = accOf(env, tok).sim_date;
    const all = { me: a.me(tok), list: a.instruments(tok), hist: a.history(tok), cmp: a.compare(tok), pv: a.preview(tok, { instrument_id: 'F1', side: 'buy', amount: 1000 }) };
    for (const i of env.ds.instruments.keys()) all['d_' + i] = a.detail(tok, i);
    scanFuture(all, d, 'resp');
    for (const i of env.ds.instruments.keys()) assert.equal(all['d_' + i].series.at(-1)[0] <= d, true);
    assert.ok(all.me.news.every((n) => n.published_date <= d));
  }
  // 別人の request_id・試行番号を指定しても自分のデータしか返らない
  const oRid = 'other-secret-0001'; S.opPlaceOrder(env.db, { request_id: oRid, instrument_id: 'E1', side: 'buy', qty: 1 })(env.now, other);
  assert.equal(a.reqStatus(tok, oRid).found, false);
  assert.throws(() => a.history(tok, 99), /見つかりません/);
});

test('同一request_idの再送・同時送信、複数タブの二重進行を防止。通信結果不明は照会で確認できる', async () => {
  const env = setup(bundle36()); const a = api(env); const tok = a.join();
  const b = { request_id: 'dup-request-0001', instrument_id: 'E1', side: 'buy', qty: 10, expected_sim_date: accOf(env, tok).sim_date };
  const r1 = a.orderRaw(tok, b), r2 = a.orderRaw(tok, b);
  assert.equal(r1.order_id, r2.order_id); assert.equal(r2.replayed, true);
  assert.equal(env.db.prepare('SELECT COUNT(*) c FROM orders').get().c, 1);
  // 通信結果不明: 応答を受け取れなかった想定 → 照会で受付済みを確認
  const st = a.reqStatus(tok, 'dup-request-0001'); assert.equal(st.found, true); assert.equal(st.response.order_id, r1.order_id);
  assert.equal(a.reqStatus(tok, 'never-sent-00001').found, false);
  const d0 = accOf(env, tok).sim_date;
  a.advance(tok, 'day', { expected_sim_date: d0 });
  assert.throws(() => a.advance(tok, 'day', { expected_sim_date: d0 }), (e) => e.status === 409);
  assert.throws(() => a.order(tok, { instrument_id: 'E1', side: 'buy', qty: 1, expected_sim_date: d0 }), (e) => e.status === 409);
  // HTTP で同時送信: 同じ日付からの進行10本 → 1本だけ成功。同じ request_id の注文10本 → 注文は1件
  const app = createApp(env.db, { operatorToken: 'o'.repeat(32), verifierToken: 'v'.repeat(32), quiet: true, now: () => env.now });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); const port = app.server.address().port;
  try {
    const d1 = accOf(env, tok).sim_date;
    const advs = await Promise.all(Array.from({ length: 10 }, (_, i) => call(port, 'POST', '/api/advance', { token: tok, body: { request_id: `tab-${i}-advance`, mode: 'day', expected_sim_date: d1 } })));
    assert.equal(advs.filter((x) => x.status === 200).length, 1); assert.equal(advs.filter((x) => x.status === 409).length, 9);
    const before = env.db.prepare('SELECT COUNT(*) c FROM orders').get().c;
    const ords = await Promise.all(Array.from({ length: 10 }, () => call(port, 'POST', '/api/orders', { token: tok, body: { request_id: 'same-click-0001', instrument_id: 'E1', side: 'buy', qty: 1 } })));
    assert.ok(ords.every((x) => x.status === 200)); assert.equal(env.db.prepare('SELECT COUNT(*) c FROM orders').get().c, before + 1);
    const q = await call(port, 'GET', '/api/requests/same-click-0001', { token: tok }); assert.equal(q.body.found, true);
  } finally { app.server.close(); }
});

test('他参加者の口座・注文には触れられない / 認証なし・偽トークンは拒否', () => {
  const env = setup(bundle36()); const a = api(env); const t1 = a.join(), t2 = a.join();
  const o = a.order(t1, { instrument_id: 'E1', side: 'buy', qty: 10 });
  assert.throws(() => a.cancel(t2, o.order_id), /見つかりません/);
  assert.equal(env.db.prepare('SELECT status FROM orders WHERE id=?').get(o.order_id).status, 'accepted');
  assert.throws(() => a.me('x'.repeat(64)), (e) => e.status === 401);
  assert.throws(() => a.me(''), (e) => e.status === 401);
  assert.equal(a.me(t2).orders.length, 0); assert.equal(a.history(t2, 1).orders.length, 0);
  // 積立設定IDの横取り
  const p = a.plan(t1, { instrument_id: 'F1', amount: 1000, day_of_month: 10 });
  assert.throws(() => a.planUpd(t2, p.plan_id, { action: 'cancel' }), /見つかりません/);
});

test('利用期限: サーバー時刻で判定、終了時刻をまたぐ操作、一時停止・緊急停止・開始前・定員', () => {
  const env = setup(bundle36()); const a = api(env); const tok = a.join();
  A.setState(env.db, env.ev.id, 'pause', env.now, 'operator');
  assert.ok(a.me(tok)); assert.throws(() => a.order(tok, { instrument_id: 'E1', side: 'buy', qty: 1 }), (e) => e.status === 423);
  assert.throws(() => a.advance(tok, 'day'), (e) => e.status === 423); assert.throws(() => a.join(), (e) => e.status === 423);
  A.setState(env.db, env.ev.id, 'resume', env.now, 'operator');
  env.now = Date.parse(env.ev.ends_at) - 1; assert.ok(a.order(tok, { instrument_id: 'E1', side: 'buy', qty: 1 }).ok);
  const pending = { request_id: 'cross-end-0001', mode: 'month' };
  env.now = Date.parse(env.ev.ends_at); // 終了時刻ちょうど以降は既存セッションも全拒否（閲覧・照会も）
  assert.throws(() => S.opAdvance(env.db, pending)(env.now, tok), (e) => e.status === 410);
  for (const f of [() => a.me(tok), () => a.history(tok), () => a.compare(tok), () => a.reqStatus(tok, 'cross-end-0001'), () => a.detail(tok, 'E1')]) assert.throws(f, (e) => e.status === 410);
  assert.throws(() => a.join(), (e) => e.status === 423);
  const env2 = setup(bundle36()); const a2 = api(env2); const t2 = a2.join();
  A.setState(env2.db, env2.ev.id, 'emergency_stop', env2.now, 'operator'); assert.throws(() => a2.me(t2), (e) => e.status === 410);
  const env3 = setup(bundle36()); env3.now = Date.parse(env3.ev.starts_at) - 1000; assert.throws(() => api(env3).join(), (e) => e.status === 423);
  const env4 = setup(bundle36(), { max_participants: 2 }); const a4 = api(env4); a4.join(); a4.join(); assert.throws(() => a4.join(), (e) => e.status === 429);
});

test('再起動後の永続データ復元: ファイルDBを閉じて開き直しても状態・冪等記録・進行が継続', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nisa-sim-')); const file = path.join(dir, 'app.sqlite');
  try {
    let env = setup(bundle36(), {}, undefined, file); let a = api(env); const tok = a.join();
    a.order(tok, { instrument_id: 'E1', side: 'buy', qty: 10 }); S.opPlaceOrder(env.db, { request_id: 'before-restart-1', instrument_id: 'F1', side: 'buy', amount: 5000 })(env.now, tok);
    for (let i = 0; i < 30; i++) a.advance(tok, 'day');
    const before = dump(env, tok); env.db.close();
    const db2 = openDb(file); env = { ...env, db: db2 }; a = api(env);
    assert.equal(dump(env, tok), before);
    const rep = S.opPlaceOrder(env.db, { request_id: 'before-restart-1', instrument_id: 'F1', side: 'buy', amount: 5000 })(env.now, tok); assert.equal(rep.replayed, true);
    a.advance(tok, 'month'); checkInvariants(env, tok);
    db2.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('削除: 期限経過後に全消去、失敗は記録→再試行、停止中に期限を過ぎても再起動時・単独スクリプトで処理', () => {
  const env = setup(bundle36()); const a = api(env); const t1 = a.join(); const t2 = a.join();
  a.order(t1, { instrument_id: 'E1', side: 'buy', qty: 10 }); a.plan(t2, { instrument_id: 'F1', amount: 10000, day_of_month: 10 }); a.advance(t1, 'month'); a.restart(t1);
  const purgeAt = Date.parse(S.purgeAt(env.db.prepare('SELECT * FROM events WHERE id=?').get(env.ev.id)));
  assert.equal(purgeAt, Date.parse(env.ev.ends_at) + 24 * 3600000);
  assert.deepEqual(A.runPurgeJob(env.db, purgeAt - 1000), []);
  env.db.exec("CREATE TRIGGER block BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'注入した失敗'); END");
  let res = A.runPurgeJob(env.db, purgeAt); assert.equal(res[0].ok, false);
  assert.equal(env.db.prepare('SELECT COUNT(*) c FROM participants').get().c, 2, '失敗時は全体をロールバック');
  assert.deepEqual(A.purgeStatus(env.db).failing, [env.ev.id]);
  env.db.exec('DROP TRIGGER block');
  res = A.runPurgeJob(env.db, purgeAt + 60000); assert.equal(res[0].ok, true);
  for (const t of ['participants', 'accounts', 'holdings', 'orders', 'receivables', 'ledger', 'plans', 'plan_runs', 'snapshots', 'requests']) assert.equal(env.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c, 0, t);
  assert.throws(() => a.me(t1), (e) => e.status === 401 || e.status === 410);
  const log = A.purgeStatus(env.db).log; assert.deepEqual(log.map((l) => l.status), ['done', 'failed']); assert.equal(log[0].attempts, 2);
  assert.ok(!JSON.stringify(log).includes('p_') && !JSON.stringify(log).includes(t1));
  assert.deepEqual(A.runPurgeJob(env.db, purgeAt + 120000), []);
  assert.ok(env.db.prepare('SELECT COUNT(*) c FROM prices').get().c > 0, '市場データは残る');
  assert.throws(() => A.setRetention(env.db, env.ev.id, 72, true, purgeAt + 1, 'operator'), (e) => e.status === 409);

  // 停止中に期限を過ぎた: ファイルDBを閉じ、期限後に「起動」→ startJobs の初回実行で削除される
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nisa-sim-')); const file = path.join(dir, 'app.sqlite');
  try {
    let e2 = setup(bundle36(), {}, undefined, file); api(e2).join(); const pa = Date.parse(S.purgeAt(e2.db.prepare('SELECT * FROM events').get())); e2.db.close();
    const db = openDb(file); const app = createApp(db, { quiet: true, now: () => pa + 3600000, operatorToken: 'o'.repeat(32), verifierToken: 'v'.repeat(32) });
    app.startJobs(); app.stopJobs();
    assert.equal(db.prepare('SELECT COUNT(*) c FROM participants').get().c, 0); db.close();
    // 単独スクリプト（cron 用）: 実時刻で期限切れの開催回を処理し、終了コード0
    e2 = setup(bundle36(), {}, undefined, file + '2'); api(e2).join(); e2.db.close();
    const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'purge.js')], { env: { ...process.env, APP_ENV: 'dev', DB_PATH: file + '2' }, encoding: 'utf8' });
    assert.match(out, /purge ev_\w+ ok/);
    const db3 = openDb(file + '2'); assert.equal(db3.prepare('SELECT COUNT(*) c FROM participants').get().c, 0); db3.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('管理者による即時削除は開催名の再入力が必要、保持時間変更は影響確認が必要', () => {
  const env = setup(bundle36()); const a = api(env); a.join();
  assert.throws(() => A.purgeNow(env.db, env.ev.id, 'ちがう', env.now, 'operator'), (e) => e.status === 400);
  assert.throws(() => A.setRetention(env.db, env.ev.id, 48, false, env.now, 'operator'), (e) => e.status === 400);
  const pv = A.retentionPreview(env.db, env.ev.id, 48, env.now); assert.equal(pv.participants, 1);
  A.setRetention(env.db, env.ev.id, 48, true, env.now, 'operator');
  A.purgeNow(env.db, env.ev.id, 'テスト開催', env.now, 'operator');
  assert.equal(env.db.prepare('SELECT COUNT(*) c FROM participants').get().c, 0);
});

test('動作確認の解除: コード・設定・仮設定の変更で確認が外れ、公開できない。権限分離', () => {
  const env = setup(bundle36()); const now = env.now;
  const ev2 = A.createEvent(env.db, { name: 'B', starts_at: '2024-06-01T00:00:00Z', ends_at: '2024-06-01T06:00:00Z', max_participants: 10, initial_cash: 100000, monthly_deposit: 0, dataset_id: env.dsId, sim_start: '2021-01-01', sim_end: '2023-12-31' }, now, 'operator');
  assert.throws(() => A.setState(env.db, ev2.id, 'enable', now, 'operator'), (e) => e.status === 409);
  const row = () => env.db.prepare('SELECT * FROM events WHERE id=?').get(ev2.id);
  assert.throws(() => A.recordVerification(env.db, ev2.id, { verified_by: 'x', reference: 'r', fingerprint: 'wrong' }, now, 'verifier'), (e) => e.status === 409);
  A.recordVerification(env.db, ev2.id, { verified_by: '確認担当', reference: 'R-1', fingerprint: S.fingerprint(env.db, row()) }, now, 'verifier');
  A.setState(env.db, ev2.id, 'enable', now, 'operator');
  assert.equal(S.eventStatus(env.db, row(), now), 'open');
  // コード変更（実行コードのハッシュが変わる）→ 確認解除扱い
  const orig = cfg.CODE_HASH; cfg.CODE_HASH = 'changed'; try { assert.equal(S.eventStatus(env.db, row(), now), 'unverified'); } finally { cfg.CODE_HASH = orig; }
  assert.equal(S.eventStatus(env.db, row(), now), 'open');
  // 計算条件の変更 → 確認解除・下書きへ
  assert.equal(A.updateEvent(env.db, ev2.id, { initial_cash: 200000 }, now, 'operator').verification_cleared, true);
  assert.equal(A.listEvents(env.db, now).find((e) => e.id === ev2.id).admin_state, 'draft');
  assert.throws(() => A.setState(env.db, ev2.id, 'enable', now, 'operator'), (e) => e.status === 409);
  // 仮設定フラグの変更も確認解除
  A.recordVerification(env.db, ev2.id, { verified_by: '確認担当', reference: 'R-2', fingerprint: S.fingerprint(env.db, row()) }, now, 'verifier');
  assert.equal(A.updateEvent(env.db, ev2.id, { provisional: { initial_cash: false } }, now, 'operator').verification_cleared, true);
  // 参加者がいる開催回の計算条件・仮設定は変更不可
  api(env).join();
  assert.throws(() => A.updateEvent(env.db, env.ev.id, { initial_cash: 5 }, now, 'operator'), (e) => e.status === 409);
  assert.throws(() => A.updateEvent(env.db, env.ev.id, { provisional: { period: false } }, now, 'operator'), (e) => e.status === 409);
});

test('本番・確認用環境の規則: 開発データ不可、本番データは条件明示・許諾確認・仮設定解除まで公開不可', () => {
  const prod = bundle36('2021-01-01', '2023-12-31', 'production'); prod.meta.version = 'テスト版';
  const db = openDb(':memory:'); const now = Date.parse('2024-06-01T01:00:00Z');
  assert.equal(A.importDataset(db, bundle36(), 'staging', '2024').ok, false, '確認用環境に開発データは入らない');
  // 既定値に頼る商品条件は本番データでは取込エラー
  const loose = JSON.parse(JSON.stringify(prod)); delete loose.instruments[0].terms.settlement_days; delete loose.instruments[1].terms.buy_reserve_margin_bp;
  const lr = A.importDataset(db, loose, 'staging', '2024'); assert.equal(lr.ok, false);
  assert.ok(lr.errors.some((e) => /settlement_days が未設定/.test(e)) && lr.errors.some((e) => /確保ルール/.test(e)));
  const noRec = JSON.parse(JSON.stringify(prod)); delete noRec.actions[0].record_date; assert.ok(A.importDataset(db, noRec, 'staging', '2024').errors.some((e) => /record_date/.test(e)));
  const imp = A.importDataset(db, prod, 'staging', '2024'); assert.equal(imp.ok, true, JSON.stringify(imp.errors));
  const save = { STRICT: cfg.STRICT, ENV: cfg.ENV, REVIEW: cfg.REVIEW }; cfg.STRICT = true; cfg.ENV = 'prod'; cfg.REVIEW = false;
  try {
    assert.equal(A.lockDataset(db, imp.id, '2024', 'prod').ok, true);
    const ev = A.createEvent(db, { name: 'S', starts_at: '2024-06-01T00:00:00Z', ends_at: '2024-06-01T06:00:00Z', max_participants: 10, initial_cash: 100000, monthly_deposit: 0, dataset_id: imp.id, sim_start: '2021-01-01', sim_end: '2023-12-31' }, now, 'operator');
    const fp = () => S.fingerprint(db, db.prepare('SELECT * FROM events WHERE id=?').get(ev.id));
    A.recordVerification(db, ev.id, { verified_by: 'x', reference: 'r', fingerprint: fp() }, now, 'verifier');
    assert.throws(() => A.setState(db, ev.id, 'enable', now, 'operator'), /仮設定のままの項目/);
    A.updateEvent(db, ev.id, { provisional: { initial_cash: false, monthly_deposit: false, max_participants: false, period: false, schedule: false } }, now, 'operator');
    A.recordVerification(db, ev.id, { verified_by: 'x', reference: 'r2', fingerprint: fp() }, now, 'verifier');
    assert.equal(A.setState(db, ev.id, 'enable', now, 'operator').state, 'enabled');
  } finally { Object.assign(cfg, save); }
});

test('データ検証: 重複・不正日付・非正値・ID不整合・欠損・期間不足・調整済み・CSV・部分失敗なし・プレビュー', () => {
  const b = bundle36('2021-01-01', '2021-03-31');
  assert.equal(validateBundle(b, 'dev').errors.length, 0);
  const mut = (f) => { const x = JSON.parse(JSON.stringify(b)); f(x); return validateBundle(x, 'dev').errors.join('\n'); };
  assert.match(mut((x) => x.prices.push({ ...x.prices[0] })), /重複/);
  assert.match(mut((x) => { x.prices[0].date = '2021-02-30'; }), /日付が不正/);
  assert.match(mut((x) => { x.prices[1].close = '0'; }), /正の値/);
  assert.match(mut((x) => { x.prices[1].close = '-5'; }), /0以上/);
  assert.match(mut((x) => { x.prices[2].instrument_id = 'NOPE'; }), /商品IDが instruments にありません/);
  assert.match(mut((x) => { x.prices = x.prices.filter((p) => !(p.instrument_id === 'S1' && p.date === '2021-02-10')); }), /欠損/);
  assert.match(mut((x) => { x.prices = x.prices.filter((p) => p.date < '2021-03-01'); }), /必要期間不足/);
  assert.match(mut((x) => { x.sources[0].adjustment = 'adjusted'; }), /raw_unadjusted/);
  assert.match(mut((x) => { x.instruments[4].terms.distribution_mode = 'reinvest'; }), /再投資は未実装/);
  assert.match(mut((x) => x.actions.push({ instrument_id: 'S2', type: 'split', ex_date: '2021-02-01', num: 3, den: 2 })), /端数処分代金/);
  assert.match(mut((x) => x.actions.push({ instrument_id: 'S2', type: 'dividend', ex_date: '2021-02-01', record_date: '2021-01-29', per_unit: '1', pay_date: '2021-03-01' })), /権利落日 ≤ 権利確定日/);
  // CSV（行番号付きエラー）
  const csv = JSON.parse(JSON.stringify(b)); const s1 = csv.prices.filter((p) => p.instrument_id === 'S1'); csv.prices = csv.prices.filter((p) => p.instrument_id !== 'S1');
  csv.prices_csv = 'instrument_id,date,open,close,status\n' + s1.map((p) => [p.instrument_id, p.date, p.open ?? '', p.close, p.status].join(',')).join('\n');
  assert.equal(validateBundle(csv, 'dev').errors.length, 0, 'CSV と JSON の併用');
  csv.prices_csv += '\nS1,2021-13-01,1,1,normal';
  assert.match(validateBundle(csv, 'dev').errors.join(), /CSV \d+行目 S1 2021-13-01: 日付が不正/);
  // プレビューは書き込まない
  const db = openDb(':memory:'); const pv = previewDataset(b, 'dev');
  assert.equal(pv.ok, true); assert.equal(pv.summary.counts.instruments, 6); assert.match(pv.summary.checksum, /^[0-9a-f]{64}$/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM datasets').get().c, 0);
  // 書込み途中の失敗 → 何も残らない
  db.exec("CREATE TRIGGER nb BEFORE INSERT ON actions BEGIN SELECT RAISE(ABORT,'注入した失敗'); END");
  assert.throws(() => A.importDataset(db, b, 'dev', '2024'));
  for (const t of ['datasets', 'dataset_sources', 'instruments', 'prices', 'actions']) assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c, 0, t);
  db.exec('DROP TRIGGER nb');
  const ok = A.importDataset(db, b, 'dev', '2024'); assert.equal(ok.ok, true);
  const row = db.prepare('SELECT source_checksum,counts_json FROM datasets').get(); assert.equal(row.source_checksum, pv.summary.checksum);
  // 固定後は変更不可（許諾状態の変更も不可）
  A.lockDataset(db, ok.id, '2024', 'dev');
  assert.throws(() => A.setLicense(db, ok.id, 'src', 'unconfirmed', '', Date.now(), 'operator'), (e) => e.status === 409);
});

test('結果の保存と同条件での再試行: 初回と再試行を区別、過去の試行は閲覧専用、比較は順位なし', () => {
  const env = setup(bundle36()); const a = api(env); const tok = a.join();
  a.order(tok, { instrument_id: 'E1', side: 'buy', qty: 10 }); for (let i = 0; i < 40; i++) a.advance(tok, 'day');
  const r = a.restart(tok); assert.equal(r.attempt, 2);
  const h1 = a.history(tok, 1); assert.equal(h1.read_only, true);
  assert.equal(a.me(tok).account.attempt, 2); assert.equal(a.me(tok).assets.total, 1000000);
  for (let i = 0; i < 10; i++) a.advance(tok, 'day');
  const c = a.compare(tok); assert.equal(c.rows.length, 2); assert.ok(c.rows.every((x) => x.at_common.deposits === c.rows[0].at_common.deposits));
  assert.ok(!('rank' in c.rows[0])); assert.match(c.note, /順位は付けません/);
  assert.equal(env.db.prepare('SELECT status FROM accounts WHERE attempt=1').get().status, 'saved');
});

function call(port, method, p, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: s.startsWith('{') ? JSON.parse(s) : s }));
    }); req.on('error', reject); if (data) req.write(data); req.end();
  });
}
test('HTTP: 管理認証・権限分離・トークンをログ/画面に出さない・ヘッダー・ヘルスチェック・必須文言', async () => {
  const env = setup(bundle36()); const op = 'op-token-0123456789abcdef0123456789', vf = 'vf-token-0123456789abcdef0123456789';
  const logs = []; const orig = console.log; console.log = (...x) => logs.push(x.join(' '));
  const app = createApp(env.db, { operatorToken: op, verifierToken: vf, now: () => env.now });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); const port = app.server.address().port;
  try {
    assert.equal((await call(port, 'GET', '/healthz')).body.ok, true);
    assert.equal((await call(port, 'GET', '/admin-api/events')).status, 401);
    assert.equal((await call(port, 'GET', '/admin-api/events', { token: 'wrong' })).status, 401);
    assert.equal((await call(port, 'GET', `/admin-api/events?token=${op}`)).status, 401, 'URLのトークンは受け付けない');
    assert.equal((await call(port, 'GET', '/admin-api/events', { token: vf })).status, 200);
    assert.equal((await call(port, 'POST', '/admin-api/events', { token: vf, body: {} })).status, 403);
    assert.equal((await call(port, 'POST', `/admin-api/events/${env.ev.id}/verify`, { token: op, body: {} })).status, 403);
    assert.equal((await call(port, 'POST', `/admin-api/events/${env.ev.id}/emergency_stop`, { token: vf })).status, 403);
    const evs = (await call(port, 'GET', '/admin-api/events', { token: op })).body; assert.ok(!JSON.stringify(evs).includes('token_hash'));
    for (const f of ['/admin', '/admin.js', '/', '/app.js']) { const r = await call(port, 'GET', f); assert.ok(!r.body.includes(op) && !r.body.includes(vf)); assert.equal(r.headers['cache-control'], 'no-store'); }
    const html = (await call(port, 'GET', '/app.js')).body; for (const d of cfg.DISCLAIMERS) assert.ok(html.includes(d), '必須文言が改変されていない: ' + d.slice(0, 10));
    const ev = await call(port, 'GET', `/api/event?code=${env.ev.join_code}`); assert.equal(ev.body.status, 'open'); assert.match(ev.headers['content-security-policy'], /default-src 'self'/);
    const j = await call(port, 'POST', '/api/join', { body: { code: env.ev.join_code } }); assert.equal(j.status, 200);
    const me = await call(port, 'GET', '/api/me?sim_date=2023-12-31', { token: j.body.token, headers: { 'X-Sim-Date': '2023-12-31' } });
    assert.equal(me.body.account.sim_date, '2021-01-01', '日付の改変は無視');
    assert.equal((await call(port, 'GET', '/api/me')).status, 401);
    assert.equal((await call(port, 'GET', '/../server/config.js')).status, 404);
    assert.equal((await call(port, 'POST', '/api/orders', { token: j.body.token, body: [1] })).status, 400);
    assert.equal((await call(port, 'POST', '/api/orders', { token: j.body.token, body: { request_id: 'bad-req-0001', instrument_id: 'E1', side: 'buy', qty: -5 } })).status, 422);
    assert.equal((await call(port, 'POST', '/api/orders', { token: j.body.token, body: { request_id: 'sneaky-0001', instrument_id: 'E1', side: 'buy', qty: 100000000, cash: 1e12, available: 1e12 } })).status, 422);
    env.now = Date.parse(env.ev.ends_at) + 1000; assert.equal((await call(port, 'GET', '/api/me', { token: j.body.token })).status, 410);
    const all = logs.join('\n'); assert.ok(!all.includes(op) && !all.includes(vf) && !all.includes(j.body.token) && !all.includes(env.ev.join_code), 'ログに秘密情報・参加コードが出ない');
  } finally { console.log = orig; app.server.close(); }
});

test('管理画面のローカル限定: プロキシ・トンネル経由の要求には管理系の経路が存在しないように見える（経路の書き換えでも同じ）', async () => {
  const env = setup(bundle36()); const app = createApp(env.db, { now: () => env.now, operatorToken: 'o'.repeat(32), verifierToken: 'v'.repeat(32), quiet: true, adminLocalOnly: true });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); const port = app.server.address().port;
  const get = (p, headers = {}) => new Promise((resolve, reject) => { const rq = http.request({ host: '127.0.0.1', port, path: p, headers }, (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, body: s })); }); rq.on('error', reject); rq.end(); });
  try {
    const auth = { Authorization: 'Bearer ' + 'o'.repeat(32) }; const via = { 'Cf-Ray': 'x', 'X-Forwarded-For': '203.0.113.9' };
    for (const p of ['/admin', '/admin.html', '/admin.js', '/admin-api/events', '/admin-api/whoami', '/x/../admin', '/x/../admin-api/events', '/./admin', '/api/../admin.js', '/ADMIN', '/admin/']) {
      const r = await get(p, { ...auth, ...via }); assert.equal(r.status, 404, p); assert.equal(/管理|token|events/i.test(r.body), false, p);
    }
    assert.equal((await get('/admin')).status, 200, 'このホストからの直接接続では開ける');
    assert.equal((await get('/admin-api/events', auth)).status, 200);
    assert.equal((await get('/healthz', via)).status, 200, '参加者向けの経路はプロキシ経由で使える');
    assert.equal((await get('/api/event?code=' + env.ev.join_code, via)).status, 200);
  } finally { await new Promise((r) => app.server.close(r)); }
});
