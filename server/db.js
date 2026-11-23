'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
-- ===== 市場データ・商品条件（参加者データと分離。開催後も残す） =====
CREATE TABLE IF NOT EXISTS datasets(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('production','dev_test')),
  status TEXT NOT NULL CHECK(status IN('draft','locked')), period_start TEXT, period_end TEXT,
  content_hash TEXT, created_at TEXT NOT NULL, locked_at TEXT, broker_basis_json TEXT NOT NULL DEFAULT '{}',
  validation_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS dataset_sources(
  dataset_id TEXT NOT NULL, source_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT, retrieved_at TEXT,
  license_status TEXT NOT NULL, license_note TEXT, adjustment TEXT NOT NULL,
  PRIMARY KEY(dataset_id, source_id));
CREATE TABLE IF NOT EXISTS instruments(
  dataset_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN('stock','etf','fund')),
  name TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL, source_id TEXT NOT NULL,
  terms_json TEXT NOT NULL, PRIMARY KEY(dataset_id, id));
CREATE TABLE IF NOT EXISTS prices(
  dataset_id TEXT NOT NULL, instrument_id TEXT NOT NULL, date TEXT NOT NULL,
  open_milli INTEGER, close_milli INTEGER NOT NULL, status TEXT NOT NULL,
  PRIMARY KEY(dataset_id, instrument_id, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS actions(
  dataset_id TEXT NOT NULL, seq INTEGER NOT NULL, instrument_id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN('split','dividend')),
  ex_date TEXT NOT NULL, num INTEGER, den INTEGER, per_unit_milli INTEGER, pay_date TEXT,
  PRIMARY KEY(dataset_id, seq));
CREATE TABLE IF NOT EXISTS news(
  dataset_id TEXT NOT NULL, id TEXT NOT NULL, published_date TEXT NOT NULL, summary TEXT NOT NULL,
  source_name TEXT NOT NULL, url TEXT NOT NULL, PRIMARY KEY(dataset_id, id));

-- ===== 開催回 =====
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, join_code TEXT NOT NULL UNIQUE,
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, retention_hours INTEGER NOT NULL DEFAULT 24,
  max_participants INTEGER NOT NULL, dataset_id TEXT, sim_start TEXT, sim_end TEXT,
  initial_cash INTEGER NOT NULL, monthly_deposit INTEGER NOT NULL,
  provisional_json TEXT NOT NULL DEFAULT '{}',
  admin_state TEXT NOT NULL DEFAULT 'draft' CHECK(admin_state IN('draft','enabled','paused','stopped')),
  verified_fingerprint TEXT, verified_by TEXT, verified_at TEXT, verification_ref TEXT, verification_note TEXT,
  purged_at TEXT, created_at TEXT NOT NULL);
-- 削除完了記録（参加者情報を含まない）
CREATE TABLE IF NOT EXISTS purge_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, rows_deleted INTEGER, at TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS admin_audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL, event_id TEXT, detail TEXT);
`;

// 参加者データ。DELETE 対象はこのグループのみ（purge.js が PARTICIPANT_TABLES を使う）
const PARTICIPANT_SCHEMA = `
CREATE TABLE IF NOT EXISTS participants(
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_part_event ON participants(event_id);
CREATE TABLE IF NOT EXISTS accounts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, participant_id TEXT NOT NULL, event_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN('active','finished','saved')),
  sim_date TEXT NOT NULL, cash INTEGER NOT NULL, deposits INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0,
  news_seen_upto TEXT, created_at TEXT NOT NULL, UNIQUE(participant_id, attempt));
CREATE TABLE IF NOT EXISTS holdings(
  account_id INTEGER NOT NULL, instrument_id TEXT NOT NULL, qty INTEGER NOT NULL, cost INTEGER NOT NULL,
  PRIMARY KEY(account_id, instrument_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, instrument_id TEXT NOT NULL,
  kind TEXT NOT NULL, side TEXT NOT NULL, qty INTEGER, amount INTEGER, sell_all INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN('accepted','filled','cancelled','lapsed')),
  placed_date TEXT NOT NULL, exec_date TEXT, settle_date TEXT, reserve INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL, plan_id INTEGER,
  closed_date TEXT, reason TEXT, price_milli INTEGER, gross INTEGER, fee INTEGER, units INTEGER);
CREATE INDEX IF NOT EXISTS ix_orders_acc ON orders(account_id, status);
CREATE TABLE IF NOT EXISTS receivables(
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, kind TEXT NOT NULL, instrument_id TEXT,
  amount INTEGER NOT NULL, due_date TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('pending','paid')), ref TEXT, created_date TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_recv_acc ON receivables(account_id, status);
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL,
  instrument_id TEXT, amount INTEGER NOT NULL, qty INTEGER, note TEXT, key TEXT NOT NULL, UNIQUE(account_id, key));
CREATE TABLE IF NOT EXISTS plans(
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, instrument_id TEXT NOT NULL, amount INTEGER NOT NULL,
  day_of_month INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN('active','paused','cancelled')),
  first_run_ym TEXT NOT NULL, created_date TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_plans_acc ON plans(account_id, status);
CREATE INDEX IF NOT EXISTS ix_ledger_acc ON ledger(account_id, type);
CREATE INDEX IF NOT EXISTS ix_accounts_part ON accounts(participant_id, attempt);
CREATE TABLE IF NOT EXISTS plan_runs(
  plan_id INTEGER NOT NULL, ym TEXT NOT NULL, result TEXT NOT NULL, order_id INTEGER, PRIMARY KEY(plan_id, ym)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS snapshots(
  account_id INTEGER NOT NULL, date TEXT NOT NULL, total INTEGER NOT NULL, deposits INTEGER NOT NULL,
  PRIMARY KEY(account_id, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS requests(
  account_id INTEGER NOT NULL, request_id TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, request_id)) WITHOUT ROWID;
`;
const PARTICIPANT_TABLES_BY_ACCOUNT = ['holdings', 'orders', 'receivables', 'ledger', 'plans', 'snapshots', 'requests'];

// 既存DBへの列追加（前方互換の移行。削除・型変更はしない）
const MIGRATIONS = [
  ['receivables', 'qty', 'INTEGER'],
  ['actions', 'record_date', 'TEXT'], ['actions', 'fraction_price_milli', 'INTEGER'], ['actions', 'fraction_pay_date', 'TEXT'],
  ['datasets', 'version_label', 'TEXT'], ['datasets', 'source_checksum', 'TEXT'], ['datasets', 'counts_json', "TEXT NOT NULL DEFAULT '{}'"],
];
function openDb(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(file), 0o700); } catch (_) { /* Windows 等では無視 */ }
  }
  const db = new DatabaseSync(file);
  // 同じSQL文のコンパイル結果を再利用する（同期・単一スレッドなので文の共有は安全）
  const rawPrepare = db.prepare.bind(db); const stmts = new Map();
  db.prepare = (sql) => { let s = stmts.get(sql); if (!s) { s = rawPrepare(sql); stmts.set(sql, s); } return s; };
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
  db.exec(SCHEMA);
  db.exec(PARTICIPANT_SCHEMA);
  for (const [t, c, type] of MIGRATIONS) {
    if (!db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`);
  }
  if (file !== ':memory:') { try { fs.chmodSync(file, 0o600); } catch (_) { /* noop */ } }
  return db;
}

// 単一プロセス・同期APIなので、BEGIN IMMEDIATE のトランザクションで注文・日次処理は直列化される
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ } throw e; }
}
module.exports = { openDb, tx, PARTICIPANT_TABLES_BY_ACCOUNT };
