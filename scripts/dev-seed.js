'use strict';
// 開発・検算環境専用（ループバック限定）: 開催回を1件作る（本番DBには使えない）
//   node scripts/dev-seed.js        … 架空の開発用テストデータ（株式・ETF・投信、配当・分割あり）
//   node scripts/dev-seed.js real   … market-data/ の実データ（利用許諾は未確認。ローカルでの検算・画面確認専用で、参加者には提供できない）
process.env.APP_ENV = 'dev';
const cfg = require('../server/config');
const { openDb } = require('../server/db');
const A = require('../server/admin');
const S = require('../server/service');
const { loadDataset } = require('../server/dataset');
const { bundle36 } = require('../test/fixture');

if (cfg.ENV !== 'dev') throw new Error('dev 専用です');
const db = openDb(cfg.DB_PATH); const now = Date.now(); const iso = (t) => new Date(t).toISOString();
const REAL = process.argv[2] === 'real';
const imp = A.importDataset(db, REAL ? require('./build-dataset').build().bundle : bundle36(), 'dev', iso(now)); if (!imp.ok) throw new Error(imp.errors.join('\n'));
const lk = A.lockDataset(db, imp.id, iso(now), 'dev'); if (!lk.ok) throw new Error(lk.errors.join());
const ds = loadDataset(db, imp.id); const sim = A.simDefault({ period_start: ds.calendar[0], period_end: ds.calendar[ds.calendar.length - 1] }); // 実データでは2024年1月からの2年間
const ev = A.createEvent(db, { name: REAL ? '検算用（実データ・許諾未確認）' : '開発確認用の説明会（架空データ）', starts_at: iso(now - 60000), ends_at: iso(now + 4 * 3600000), max_participants: 100, initial_cash: 1000000, monthly_deposit: 30000, dataset_id: imp.id, sim_start: sim.start, sim_end: sim.end }, now, 'operator');
const row = db.prepare('SELECT * FROM events WHERE id=?').get(ev.id);
A.recordVerification(db, ev.id, { verified_by: '開発用（金庫の確認ではありません）', reference: 'DEV-ONLY', fingerprint: S.fingerprint(db, row) }, now, 'verifier');
A.setState(db, ev.id, 'enable', now, 'operator');
console.log(`参加URL: http://localhost:${cfg.PORT}/?code=${ev.join_code}`);
