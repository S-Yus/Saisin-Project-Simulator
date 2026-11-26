'use strict';
process.env.APP_ENV = 'dev'; // 検算は必ず dev 環境で実行する
// ★開発・検算専用の架空データ。本番DBには取り込めない（kind: dev_test は prod で拒否される）。
const { openDb } = require('../server/db');
const A = require('../server/admin');
const S = require('../server/service');
const { loadDataset } = require('../server/dataset');

function weekdays(startISO, endISO) {
  const out = []; for (let t = Date.parse(startISO + 'T00:00:00Z'); t <= Date.parse(endISO + 'T00:00:00Z'); t += 86400000) { const d = new Date(t); const w = d.getUTCDay(); if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10)); }
  return out;
}
const SRC = [{ id: 'src', name: '開発用ダミー出典', retrieved_at: '2024-01-01', license_status: 'confirmed', adjustment: 'raw_unadjusted' }];
const stockTerms = (lot, fee) => ({ terms_status: 'confirmed', lot_size: lot, settlement_days: 2, buy_reserve_margin_bp: 3000, fee: fee || { rate_ppm: 0 } });
const fundTerms = (fee) => ({ terms_status: 'confirmed', min_amount: 100, amount_step: 1, nav_offset: 1, settlement_days: 4, buy_settlement_days: 1, holdback_ppm: 3000, savings_ok: true, distribution_mode: 'cash', fee: fee || { rate_ppm: 0 } });
const INSTR = [
  { id: 'S1', type: 'stock', name: 'テスト株A', category: '国内株式', description: 'ダミー', source_id: 'src', terms: stockTerms(100, { rate_ppm: 1000, min: 50 }) },
  { id: 'S2', type: 'stock', name: 'テスト株B（分割あり）', category: '国内株式', description: 'ダミー', source_id: 'src', terms: stockTerms(100) },
  { id: 'E1', type: 'etf', name: 'テストETF', category: '国内ETF', description: 'ダミー', source_id: 'src', terms: stockTerms(1) },
  { id: 'E2', type: 'etf', name: 'テストETF（停止日あり）', category: '国内ETF', description: 'ダミー', source_id: 'src', terms: stockTerms(10) },
  { id: 'F1', type: 'fund', name: 'テスト投信A', category: '投資信託', description: 'ダミー', source_id: 'src', terms: fundTerms({ rate_ppm: 11000 }) },
  { id: 'F2', type: 'fund', name: 'テスト投信B（分配金あり）', category: '投資信託', description: 'ダミー', source_id: 'src', terms: fundTerms() },
];
const lcg = (seed) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

// 36か月の決定的な疑似データ（検算・負荷確認用）
function bundle36(start = '2021-01-01', end = '2023-12-31', kind = 'dev_test') {
  const cal = weekdays(start, end); const r = lcg(7); const prices = []; const actions = [];
  const base = { S1: 2500, S2: 4000, E1: 1800, E2: 3000, F1: 12000, F2: 15000 };
  const cur = { ...base };
  for (const [di, d] of cal.entries()) {
    for (const i of INSTR) {
      const prev = cur[i.id]; const open = Math.max(100, Math.round(prev * (1 + (r() - 0.5) * 0.02))); const close = Math.max(100, Math.round(open * (1 + (r() - 0.5) * 0.02)));
      cur[i.id] = close;
      if (i.type === 'fund') prices.push({ instrument_id: i.id, date: d, close: String(close) });
      else {
        let status = 'normal'; if (i.id === 'E2' && di % 200 === 150) status = 'halt'; if (i.id === 'S1' && di % 300 === 299) status = 'limit';
        prices.push({ instrument_id: i.id, date: d, open: status === 'halt' ? undefined : String(open), close: status === 'halt' ? '' : String(close), status });
        if (status === 'halt') cur[i.id] = prev;
      }
    }
  }
  const m = (n) => cal.find((d) => d >= n);
  const add = (x) => { if (x.ex_date) actions.push(x); };
  add({ instrument_id: 'S1', type: 'dividend', ex_date: m('2021-03-30'), record_date: m('2021-03-31'), per_unit: '50', pay_date: '2021-06-25' });
  add({ instrument_id: 'S2', type: 'split', ex_date: m('2022-04-01'), num: 3, den: 2, fraction_price: '2700', fraction_pay_date: '2022-06-30' });
  add({ instrument_id: 'F2', type: 'dividend', ex_date: m('2022-06-15'), record_date: m('2022-06-15'), per_unit: '120', pay_date: '2022-06-22' });
  const news = [
    ['n1', '2021-06-15'], ['n2', '2021-12-10'], ['n3', '2022-03-14'], ['n4', '2022-09-30'], ['n5', '2023-05-12'],
  ].filter(([, d]) => d >= start && d <= end).map(([id, d]) => ({ id, published_date: d, summary: '【開発用ダミー】' + id, source_name: 'ダミー', url: 'https://example.invalid/' + id }));
  return { meta: { name: '開発用テストデータ（架空）', kind, period_start: start, period_end: end }, sources: SRC, instruments: INSTR, prices, actions, news, broker_basis: { name: 'dev', status: 'confirmed' } };
}

// 手計算検証用の小さなデータ。prices: {id: {date: [open, close, status]}}
function tiny(spec) {
  const cal = spec.days; const prices = []; const instruments = spec.instruments;
  for (const i of instruments) for (const d of cal) {
    const p = spec.prices[i.id][d]; if (!p) continue;
    prices.push({ instrument_id: i.id, date: d, open: p[0] == null ? (i.type === 'fund' || p[2] === 'halt' ? undefined : String(p[1])) : String(p[0]), close: String(p[1]), status: p[2] || 'normal' });
  }
  return { meta: { name: 'tiny', kind: 'dev_test', period_start: cal[0], period_end: spec.period_end || cal[cal.length - 1] }, sources: SRC, instruments, prices, actions: spec.actions || [], news: spec.news || [], broker_basis: { name: 'dev', status: 'confirmed' } };
}

function setup(bundle, evOver = {}, nowMs = Date.parse('2024-06-01T01:00:00Z'), file = ':memory:') {
  const db = openDb(file);
  const imp = A.importDataset(db, bundle, 'dev', new Date(nowMs).toISOString());
  if (!imp.ok) throw new Error('import: ' + imp.errors.join(' / '));
  const lk = A.lockDataset(db, imp.id, new Date(nowMs).toISOString(), 'dev'); if (!lk.ok) throw new Error(lk.errors.join());
  const ds0 = loadDataset(db, imp.id);
  const ev = A.createEvent(db, { name: 'テスト開催', starts_at: '2024-06-01T00:00:00Z', ends_at: '2024-06-01T06:00:00Z', max_participants: 500, initial_cash: 1000000, monthly_deposit: 30000, sim_start: ds0.calendar[0], sim_end: ds0.calendar[ds0.calendar.length - 1], dataset_id: imp.id, ...evOver }, nowMs, 'operator');
  const row = db.prepare('SELECT * FROM events WHERE id=?').get(ev.id);
  A.recordVerification(db, ev.id, { verified_by: 'tester', reference: 'T-1', fingerprint: S.fingerprint(db, row) }, nowMs, 'verifier');
  A.setState(db, ev.id, 'enable', nowMs, 'operator');
  return { db, file, ev: { ...ev, ...db.prepare('SELECT * FROM events WHERE id=?').get(ev.id) }, dsId: imp.id, ds: ds0, now: nowMs };
}
let ridn = 0; const rid = () => 'req-' + (++ridn).toString().padStart(8, '0');
const api = (env) => {
  const t = () => env.now;
  return {
    join: () => S.join(env.db, env.ev.join_code, t()).token,
    me: (tok) => S.me(env.db, S.auth(env.db, tok, t(), { write: false }), t()),
    order: (tok, b) => S.opPlaceOrder(env.db, { request_id: rid(), ...b })(t(), tok),
    orderRaw: (tok, b) => S.opPlaceOrder(env.db, b)(t(), tok),
    cancel: (tok, id, b = {}) => S.opCancel(env.db, { request_id: rid(), ...b }, id)(t(), tok),
    advance: (tok, mode, b = {}) => S.opAdvance(env.db, { request_id: rid(), mode, ...b })(t(), tok),
    plan: (tok, b) => S.opPlanCreate(env.db, { request_id: rid(), ...b })(t(), tok),
    planUpd: (tok, id, b) => S.opPlanUpdate(env.db, { request_id: rid(), ...b }, id)(t(), tok),
    monthly: (tok, v) => S.opMonthly(env.db, { request_id: rid(), monthly_deposit: v })(t(), tok),
    restart: (tok) => S.opRestart(env.db, { request_id: rid() })(t(), tok),
    history: (tok, a) => S.history(env.db, S.auth(env.db, tok, t(), { write: false }), a),
    compare: (tok) => S.compare(env.db, S.auth(env.db, tok, t(), { write: false })),
    detail: (tok, id) => S.instrumentDetail(env.db, S.auth(env.db, tok, t(), { write: false }), id),
    instruments: (tok) => S.instruments(env.db, S.auth(env.db, tok, t(), { write: false })),
    preview: (tok, b) => S.orderPreview(env.db, S.auth(env.db, tok, t(), { write: false }), b),
    reqStatus: (tok, r) => S.requestStatus(env.db, S.auth(env.db, tok, t(), { write: false }), r),
  };
};
module.exports = { weekdays, bundle36, tiny, setup, api, INSTR, stockTerms, fundTerms, SRC, rid };
