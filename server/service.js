'use strict';
// 参加者向けサービス層。時刻・残高・日付はすべてサーバーが正。クライアント値は expected_sim_date 以外信用しない。
const crypto = require('node:crypto');
const cfg = require('./config');
const { tx } = require('./db');
const { loadDataset } = require('./dataset');
const E = require('./engine');

class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra || {}; } }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

function fingerprint(db, ev) {
  const ds = ev.dataset_id ? db.prepare('SELECT content_hash,status FROM datasets WHERE id=?').get(ev.dataset_id) : null;
  if (!ds || ds.status !== 'locked') return null;
  // 動作確認の単位: アプリ版・計算仕様版・実行コードのハッシュ・データ（商品条件を含む）・計算に関わる設定・仮設定フラグ
  return sha([cfg.APP_VERSION, cfg.CALC_SPEC_VERSION, cfg.CODE_HASH, ds.content_hash, ev.initial_cash, ev.monthly_deposit, ev.sim_start, ev.sim_end, ev.provisional_json].join('|'));
}
function purgeAt(ev) { return iso(Date.parse(ev.ends_at) + ev.retention_hours * 3600000); }

// 開催回の実効状態。サーバー時刻で毎回判定する（クライアントの時計は無関係）
function eventStatus(db, ev, nowMs) {
  if (ev.purged_at) return 'purged';
  if (ev.admin_state === 'stopped') return 'stopped';
  if (nowMs >= Date.parse(ev.ends_at)) return 'ended';
  if (ev.admin_state === 'paused') return 'paused';
  if (ev.admin_state !== 'enabled') return 'not_enabled';
  // 有効化後にデータ・設定が変わっていたら（確認状態の解除）開けない。
  // 確認用環境は動作確認そのものを行う場所なので、確認の記録を公開の条件にしない（データが固定済みであることだけ求める）
  const fp = fingerprint(db, ev);
  if (cfg.REVIEW ? !fp : (!ev.verified_fingerprint || ev.verified_fingerprint !== fp)) return 'unverified';
  if (nowMs < Date.parse(ev.starts_at)) return 'not_started';
  return 'open';
}
const STATUS_JA = { purged: '削除済み', stopped: '緊急停止中', ended: '終了', paused: '一時停止中', not_enabled: '未公開', unverified: '動作確認が未了または解除', not_started: '開始前', open: '開催中' };

// データの種類・対象期間・許諾状態（表示用）。価格やニュースの中身は含まない
function dataInfo(db, ev) {
  if (!ev.dataset_id) return { kind: null, period: null, license_confirmed: false, sources: [] };
  const d = db.prepare('SELECT kind FROM datasets WHERE id=?').get(ev.dataset_id); const ds = loadDataset(db, ev.dataset_id);
  const period = ev.sim_start && ev.sim_end && ds ? { start: E.startDate(ds, ev), end: E.finalDate(ds, ev) } : null;
  // 未確定のまま動いている項目（確認用環境・開発環境で画面に表示する）
  const pending = [];
  if (ds) {
    if (d?.kind === 'production' && !ds.sources.every((s) => s.license_status === 'confirmed')) pending.push('データの利用許諾が未確認');
    if ([...ds.instruments.values()].some((i) => i.terms.terms_status !== 'confirmed')) pending.push('取引条件が仮設定');
    if (Object.values(JSON.parse(ev.provisional_json)).some(Boolean)) pending.push('開催回の設定が仮設定');
    if (!ev.verified_fingerprint || ev.verified_fingerprint !== fingerprint(db, ev)) pending.push('動作確認が未記録');
  }
  return { kind: d?.kind || null, period, pending, license_confirmed: !!ds && ds.sources.every((s) => s.license_status === 'confirmed'), sources: ds ? ds.sources.map((s) => ({ name: s.name, retrieved_at: s.retrieved_at })) : [] };
}
function publicEvent(db, code, nowMs) {
  const ev = db.prepare('SELECT * FROM events WHERE join_code=?').get(code);
  if (!ev) throw new HttpError(404, '開催回が見つかりません');
  const st = eventStatus(db, ev, nowMs);
  return { name: ev.name, status: st, status_ja: STATUS_JA[st], starts_at: ev.starts_at, ends_at: ev.ends_at, server_now: iso(nowMs), joinable: st === 'open', funds: { defaults: { initial_cash: ev.initial_cash, monthly_deposit: ev.monthly_deposit }, limits: cfg.FUNDS }, data_ready: !!ev.dataset_id, data: dataInfo(db, ev), retention_hours: ev.retention_hours, disclaimers: cfg.DISCLAIMERS, env: cfg.ENV };
}

// 参加者が選ぶ資金条件の検証。値はサーバーが範囲・単位を確認し、口座には2つの金額だけを保存する（質問への回答そのものは受け取らない）
function parseFunds(ev, b) {
  if (!b || (b.initial_cash === undefined && b.monthly_deposit === undefined)) return null; // 既定値を使う
  const L = cfg.FUNDS; const ic = b.initial_cash ?? ev.initial_cash, md = b.monthly_deposit ?? ev.monthly_deposit;
  const ok = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max && v % L.step === 0;
  if (!ok(ic, L.initial_max)) throw new HttpError(422, `最初に用意する金額は 0〜${L.initial_max.toLocaleString('ja-JP')}円、${L.step.toLocaleString('ja-JP')}円単位で指定してください`);
  if (!ok(md, L.monthly_max)) throw new HttpError(422, `毎月の金額は 0〜${L.monthly_max.toLocaleString('ja-JP')}円、${L.step.toLocaleString('ja-JP')}円単位で指定してください`);
  if (ic === 0 && md === 0) throw new HttpError(422, '最初の金額と毎月の金額のどちらかは1,000円以上にしてください');
  return { initial_cash: ic, monthly_deposit: md };
}
const fundsOf = (ev, acc) => ({ initial_cash: acc.initial_cash ?? ev.initial_cash, monthly_deposit: acc.monthly_deposit ?? ev.monthly_deposit });
const condOf = (ev, acc) => ({ ...fundsOf(ev, acc), monthly_changed: acc.monthly_changed || 0 });

function join(db, code, nowMs, body) {
  const ev = db.prepare('SELECT * FROM events WHERE join_code=?').get(code);
  if (!ev) throw new HttpError(404, '開催回が見つかりません');
  return tx(db, () => {
    const st = eventStatus(db, ev, nowMs);
    if (st !== 'open') throw new HttpError(423, `現在は参加できません（${STATUS_JA[st]}）`, { status: st });
    const n = db.prepare('SELECT COUNT(*) c FROM participants WHERE event_id=?').get(ev.id).c;
    if (n >= ev.max_participants) throw new HttpError(429, '定員に達したため参加できません');
    const ds = loadDataset(db, ev.dataset_id);
    const token = crypto.randomBytes(32).toString('hex'); const pid = 'p_' + crypto.randomBytes(8).toString('hex');
    db.prepare('INSERT INTO participants VALUES(?,?,?,?)').run(pid, ev.id, sha(token), iso(nowMs));
    E.createAccount(db, pid, ev, ds, 1, iso(nowMs), parseFunds(ev, body));
    return { token };
  });
}

// 認証: 参加者トークン → participant + event。終了後・停止後・削除後はここで全拒否
function auth(db, token, nowMs, { write }) {
  if (!token) throw new HttpError(401, '認証が必要です');
  const p = db.prepare('SELECT * FROM participants WHERE token_hash=?').get(sha(token));
  if (!p) throw new HttpError(401, 'セッションが無効です（削除済みの可能性があります）');
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(p.event_id);
  const st = eventStatus(db, ev, nowMs);
  if (['ended', 'stopped', 'purged', 'not_enabled', 'unverified', 'not_started'].includes(st)) throw new HttpError(410, `この説明会は利用できません（${STATUS_JA[st]}）`, { status: st });
  if (st === 'paused' && write) throw new HttpError(423, '管理者により一時停止中です。再開までお待ちください', { status: st });
  const acc = db.prepare('SELECT * FROM accounts WHERE participant_id=? ORDER BY attempt DESC LIMIT 1').get(p.id);
  return { p, ev, acc, st, ds: loadDataset(db, ev.dataset_id) };
}

function mutate(db, ctx0, body, fn) {
  // トランザクション内で再認証・最新口座を読み直す（終了時刻をまたぐ注文を弾く）。冪等キーで再送を安全に。
  return (nowMs, token) => tx(db, () => {
    const ctx = auth(db, token, nowMs, { write: true });
    const rid = body.request_id;
    if (typeof rid !== 'string' || rid.length < 8 || rid.length > 80) throw new HttpError(400, 'request_id が必要です');
    // 同じ参加者の全試行を対象に照合（やり直し後に古い操作が再送されても二重に実行しない）
    const prior = db.prepare('SELECT r.response_json FROM requests r JOIN accounts a ON a.id=r.account_id WHERE a.participant_id=? AND r.request_id=?').get(ctx.p.id, rid);
    if (prior) return { ...JSON.parse(prior.response_json), replayed: true };
    if (body.expected_sim_date && body.expected_sim_date !== ctx.acc.sim_date) throw new HttpError(409, '画面の日付が古くなっています（別のタブや端末で進行した可能性）。画面を更新してやり直してください', { sim_date: ctx.acc.sim_date });
    ctx.nowMs = nowMs;
    const r = fn(ctx);
    db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(ctx.acc.id, rid, JSON.stringify(r), iso(nowMs));
    return r;
  });
}

// ---------- 読み出し ----------
function nextMonthStart(ds, d) { return ds.calendar.find((x) => x > d && x.slice(0, 7) !== d.slice(0, 7)) || null; }

// 直近の値動き（小グラフ用）。その参加者の日付以前の実在する価格だけを返す
function sparkOf(ds, instId, simDate, n = 30) {
  const mp = ds.prices.get(instId); const out = []; if (!mp) return out;
  for (let i = ds.calIdx.get(simDate); i >= 0 && out.length < n; i--) { const r = mp.get(ds.calendar[i]); if (r && r.close > 0) out.push(r.close); }
  return out.reverse();
}
function instBrief(ds, db, acc, inst, holdMap) {
  const p = E.lastPrice(ds, inst.id, acc.sim_date);
  const idx = ds.calIdx.get(acc.sim_date); let prevClose = null;
  for (let i = idx - 1; i >= 0 && prevClose == null; i--) prevClose = ds.prices.get(inst.id)?.get(ds.calendar[i])?.close || null;
  const h = holdMap.get(inst.id);
  return { id: inst.id, type: inst.type, name: inst.name, category: inst.category, description: inst.description, price_milli: p?.close ?? null, price_date: p?.date ?? null, stale: !!p?.stale, prev_close_milli: prevClose, spark: sparkOf(ds, inst.id, acc.sim_date), qty: h?.qty || 0, value: h ? E.lineValue(inst, h.qty, p?.close || 0) : 0 };
}

function me(db, ctx, nowMs) {
  const { ev, acc, ds, st } = ctx;
  const v = E.valuation(db, acc, ds);
  const nm = (id) => ds.instruments.get(id)?.name || id;
  const series = db.prepare('SELECT date,total,deposits FROM snapshots WHERE account_id=? ORDER BY date').all(acc.id);
  const news = ds.news.filter((n) => n.published_date <= acc.sim_date).reverse();
  const orders = db.prepare("SELECT * FROM orders WHERE account_id=? AND status='accepted' ORDER BY id").all(acc.id).map((o) => ({ ...o, name: nm(o.instrument_id) }));
  const plans = db.prepare("SELECT * FROM plans WHERE account_id=? AND status!='cancelled' ORDER BY id").all(acc.id).map((p) => ({ ...p, name: nm(p.instrument_id) }));
  const recv = db.prepare("SELECT * FROM receivables WHERE account_id=? AND status='pending' ORDER BY due_date").all(acc.id).map((r) => ({ ...r, name: nm(r.instrument_id) }));
  const fin = E.finalDate(ds, ev);
  // 資産配分（分類別の評価額と現金等）。計算はサーバー、画面は表示のみ
  const byCat = new Map();
  for (const h of v.holdings) { const c = ds.instruments.get(h.instrument_id).category; byCat.set(c, (byCat.get(c) || 0) + h.value); }
  const cashLike = v.total - v.holdings_value; // 現金残高 − 未受渡の買付代金 + 未受渡の売却代金 + 未収配当等
  const allocation = [...[...byCat].map(([label, value]) => ({ label, value })), { label: '現金等（受渡待ちを含む）', value: cashLike }]
    .map((x) => ({ ...x, pct_bp: v.total > 0 ? Math.round((x.value * 10000) / v.total) : 0 }));
  return {
    server_now: iso(nowMs),
    event: { name: ev.name, status: st, status_ja: STATUS_JA[st], ends_at: ev.ends_at, retention_hours: ev.retention_hours, env: cfg.ENV, data: dataInfo(db, ev), provisional: JSON.parse(ev.provisional_json), ...fundsOf(ev, acc), funds_limits: cfg.FUNDS, period: { start: E.startDate(ds, ev), end: fin }, app_version: cfg.APP_VERSION, calc_spec_version: cfg.CALC_SPEC_VERSION },
    account: { attempt: acc.attempt, monthly_changed: acc.monthly_changed || 0, status: acc.status, sim_date: acc.sim_date, final_date: fin, version: acc.version },
    assets: { ...v, holdings: v.holdings.map((h) => ({ ...h, name: nm(h.instrument_id), type: ds.instruments.get(h.instrument_id).type, category: ds.instruments.get(h.instrument_id).category, spark: sparkOf(ds, h.instrument_id, acc.sim_date) })) },
    nisa: E.nisaCompare(db, acc, v),
    allocation, series, news: news.slice(0, 20).map((n) => ({ id: n.id, published_date: n.published_date, summary: n.summary, source_name: n.source_name, url: n.url, explain: n.explain || null, views: n.views_json ? JSON.parse(n.views_json) : null })), orders, plans, receivables: recv,
    next_deposit_date: fundsOf(ev, acc).monthly_deposit > 0 && acc.sim_date < fin ? nextMonthStart(ds, acc.sim_date) : null,
    disclaimers: cfg.DISCLAIMERS,
  };
}

function instruments(db, ctx, q, cat) {
  const { acc, ds } = ctx;
  const hold = new Map(db.prepare('SELECT * FROM holdings WHERE account_id=? AND qty>0').all(acc.id).map((h) => [h.instrument_id, h]));
  let list = [...ds.instruments.values()].map((i) => instBrief(ds, db, acc, i, hold));
  if (q) list = list.filter((i) => (i.name + i.description + i.category).toLowerCase().includes(q.toLowerCase()));
  if (cat) list = list.filter((i) => i.category === cat);
  return { items: list, categories: [...new Set([...ds.instruments.values()].map((i) => i.category))] };
}

function instrumentDetail(db, ctx, id) {
  const { acc, ds } = ctx; const inst = ds.instruments.get(id);
  if (!inst) throw new HttpError(404, '投資対象が見つかりません');
  const hold = new Map(db.prepare('SELECT * FROM holdings WHERE account_id=? AND qty>0').all(acc.id).map((h) => [h.instrument_id, h]));
  const brief = instBrief(ds, db, acc, inst, hold);
  const mp = ds.prices.get(id); const series = [];
  for (const d of ds.calendar) { if (d > acc.sim_date) break; const r = mp.get(d); if (r && r.close > 0) series.push([d, r.close]); } // 未来の価格は返さない
  const src = ds.sources.find((s) => s.source_id === inst.source_id);
  return {
    ...brief, series, terms: inst.terms, source: src ? { name: src.name, retrieved_at: src.retrieved_at } : null,
    holding: hold.get(id) ? { qty: hold.get(id).qty, cost: hold.get(id).cost, unsettled_qty: hold.get(id).qty - E.sellableQty(db, acc.id, id) - db.prepare("SELECT COALESCE(SUM(qty),0) s FROM orders WHERE account_id=? AND instrument_id=? AND side='sell' AND status='accepted'").get(acc.id, id).s } : null,
    sellable: hold.has(id) ? Math.max(0, E.sellableQty(db, acc.id, id)) : 0,
    plan: db.prepare("SELECT * FROM plans WHERE account_id=? AND instrument_id=? AND status!='cancelled'").get(acc.id, id) || null,
    available: E.availableCash(db, acc), open_orders: db.prepare("SELECT * FROM orders WHERE account_id=? AND instrument_id=? AND status='accepted'").all(acc.id, id),
  };
}

function history(db, ctx, attemptNo) {
  const { p, ds } = ctx;
  const acc = attemptNo ? db.prepare('SELECT * FROM accounts WHERE participant_id=? AND attempt=?').get(p.id, attemptNo) : ctx.acc;
  if (!acc) throw new HttpError(404, '試行が見つかりません');
  const nm = (id) => (id ? ds.instruments.get(id)?.name || id : null);
  return {
    attempt: acc.attempt, read_only: acc.status !== 'active',
    orders: db.prepare('SELECT * FROM orders WHERE account_id=? ORDER BY id DESC').all(acc.id).map((o) => ({ ...o, name: nm(o.instrument_id) })),
    ledger: db.prepare('SELECT * FROM ledger WHERE account_id=? ORDER BY id DESC').all(acc.id).map((l) => ({ ...l, name: nm(l.instrument_id) })),
    plans: db.prepare('SELECT * FROM plans WHERE account_id=? ORDER BY id').all(acc.id).map((x) => ({ ...x, name: nm(x.instrument_id) })),
  };
}

function compare(db, ctx) {
  const { p, ds, ev } = ctx;
  const accs = db.prepare('SELECT * FROM accounts WHERE participant_id=? ORDER BY attempt').all(p.id);
  const common = accs.map((a) => a.sim_date).sort()[0];
  const rows = accs.map((a) => {
    const s = db.prepare('SELECT total,deposits FROM snapshots WHERE account_id=? AND date=?').get(a.id, common);
    const own = E.valuation(db, a, ds);
    const fees = db.prepare("SELECT COALESCE(-SUM(amount),0) s FROM ledger WHERE account_id=? AND type='fee'").get(a.id).s;
    const trades = db.prepare("SELECT COUNT(*) c FROM orders WHERE account_id=? AND status='filled'").get(a.id).c;
    return { attempt: a.attempt, status: a.status, sim_date: a.sim_date, conditions: condOf(ev, a), at_common: s, own: { total: own.total, deposits: own.deposits, pnl: own.pnl }, fees, trades, holdings: own.holdings.map((h) => ({ name: ds.instruments.get(h.instrument_id).name, value: h.value })), series: db.prepare('SELECT date,total FROM snapshots WHERE account_id=? AND date<=? ORDER BY date').all(a.id, common) };
  });
  const same = rows.every((r) => r.conditions.initial_cash === rows[0].conditions.initial_cash && r.conditions.monthly_deposit === rows[0].conditions.monthly_deposit && !r.conditions.monthly_changed);
  return { common_date: common, rows, same_conditions: same, conditions: rows[rows.length - 1].conditions, note: same ? '同じ資金条件での比較です。結果に優劣の順位は付けません。' : '資金条件が異なる試行が含まれます（各試行の条件を表示しています）。結果に優劣の順位は付けません。' };
}

// 通信結果が不明な操作の照会: 同じ request_id が受け付けられていれば、その結果を返す（本人の全試行が対象）
function requestStatus(db, ctx, rid) {
  if (typeof rid !== 'string' || rid.length < 8 || rid.length > 80) throw new HttpError(400, 'request_id が不正です');
  const row = db.prepare('SELECT r.response_json FROM requests r JOIN accounts a ON a.id=r.account_id WHERE a.participant_id=? AND r.request_id=?').get(ctx.p.id, rid);
  return row ? { found: true, response: JSON.parse(row.response_json) } : { found: false, message: 'この操作は受け付けられていません。同じ内容でもう一度送信できます（二重には受け付けません）' };
}

// ---------- 更新系（すべて mutate() 経由） ----------
function orderPreview(db, ctx, b) { const r = E.evaluateOrder(db, ctx.acc, ctx.ds, ctx.ev, { instrument_id: b.instrument_id, side: b.side, qty: b.qty, amount: b.amount, sell_all: b.sell_all === true }); return { ok: !r.errors.length, errors: r.errors, info: r.info || null }; }

function opPlaceOrder(db, b) {
  return mutate(db, null, b, (ctx) => {
    const r = E.placeOrder(db, ctx.acc, ctx.ds, ctx.ev, { instrument_id: b.instrument_id, side: b.side, qty: b.qty, amount: b.amount, sell_all: b.sell_all === true });
    if (!r.ok) throw new HttpError(422, r.errors[0], { errors: r.errors });
    return { ok: true, order_id: r.order_id, info: r.info, message: '注文を受け付けました' };
  });
}
function opCancel(db, b, orderId) {
  return mutate(db, null, b, (ctx) => { const r = E.cancelOrder(db, ctx.acc, orderId); if (!r.ok) throw new HttpError(422, r.error); return { ok: true, message: '注文を取り消しました' }; });
}
function opAdvance(db, b) {
  return mutate(db, null, b, (ctx) => {
    if (!['day', 'month'].includes(b.mode)) throw new HttpError(400, 'mode は day か month');
    if (ctx.acc.status !== 'active') throw new HttpError(422, 'この口座は進行できません（最終日に到達済み、または保存済み）');
    const r = E.advance(db, ctx.acc.id, ctx.ds, ctx.ev, b.mode);
    return { ok: true, ...r };
  });
}
function opPlanCreate(db, b) { return mutate(db, null, b, (ctx) => { const r = E.createPlan(db, ctx.acc, ctx.ds, b); if (!r.ok) throw new HttpError(422, r.errors[0], { errors: r.errors }); return { ok: true, ...r, message: '積立を設定しました' }; }); }
function opPlanUpdate(db, b, id) { return mutate(db, null, b, (ctx) => { const r = E.updatePlan(db, ctx.acc, ctx.ds, id, b); if (!r.ok) throw new HttpError(422, r.errors[0], { errors: r.errors }); return { ok: true, message: '積立設定を更新しました' }; }); }
// 毎月入ってくる金額を途中で変える（次の月初の入金から）
function opMonthly(db, b) {
  return mutate(db, null, b, (ctx) => {
    const L = cfg.FUNDS; const v = b.monthly_deposit;
    if (!(Number.isSafeInteger(v) && v >= 0 && v <= L.monthly_max && v % L.step === 0)) throw new HttpError(422, `毎月の金額は 0〜${L.monthly_max.toLocaleString('ja-JP')}円、${L.step.toLocaleString('ja-JP')}円単位で指定してください`);
    const cur = fundsOf(ctx.ev, ctx.acc).monthly_deposit;
    if (v === cur) throw new HttpError(422, 'いまと同じ金額です');
    const r = E.setMonthly(db, ctx.acc, v); if (!r.ok) throw new HttpError(422, r.error);
    return { ok: true, monthly_deposit: v, message: `毎月の金額を ${v.toLocaleString('ja-JP')}円 に変えました（次の月の入金から）` };
  });
}
function opRestart(db, b) {
  return mutate(db, null, b, (ctx) => {
    const n = db.prepare('SELECT COUNT(*) c FROM accounts WHERE participant_id=?').get(ctx.p.id).c;
    if (n >= 10) throw new HttpError(422, '試行は10回までです');
    db.prepare("UPDATE accounts SET status='saved', version=version+1 WHERE id=?").run(ctx.acc.id); // 過去の結果は閲覧専用
    db.prepare("UPDATE orders SET status='lapsed', closed_date=?, reason='やり直しのため保存', reserve=0 WHERE account_id=? AND status='accepted'").run(ctx.acc.sim_date, ctx.acc.id);
    // 既定は前回と同じ資金条件。金額を指定した場合だけ条件を変える（比較画面には各試行の条件が出る）
    const changed = parseFunds(ctx.ev, b); const funds = changed || fundsOf(ctx.ev, ctx.acc);
    const a = E.createAccount(db, ctx.p.id, ctx.ev, ctx.ds, ctx.acc.attempt + 1, iso(ctx.nowMs), funds);
    return { ok: true, attempt: a.attempt, message: `${changed ? '資金条件を変えて' : '同じ資金条件で'} ${a.attempt} 回目を開始しました（前回の結果は閲覧専用で残ります）` };
  });
}

module.exports = { requestStatus, HttpError, sha, iso, fingerprint, purgeAt, eventStatus, STATUS_JA, publicEvent, join, auth, me, instruments, instrumentDetail, history, compare, orderPreview, opPlaceOrder, opCancel, opAdvance, opPlanCreate, opPlanUpdate, opRestart, opMonthly };
