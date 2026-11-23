'use strict';
// 削除ジョブの単独実行（アプリ停止中も期限どおり削除するため、cron / systemd timer から定期実行する）。
// 何度実行しても安全（削除済みの開催回は対象外。失敗は purge_log に記録され、次回再試行）。
//   DB_PATH=/data/app.sqlite node scripts/purge.js   → 終了コード 0: 正常 / 2: 失敗あり
const cfg = require('../server/config');
const { openDb } = require('../server/db');
const A = require('../server/admin');

const db = openDb(cfg.DB_PATH);
const res = A.runPurgeJob(db, Date.now());
for (const r of res) console.log(`purge ${r.event} ${r.ok ? `ok rows=${r.rows}` : 'FAILED: ' + r.error}`);
if (!res.length) console.log('purge: 対象なし');
const failing = A.purgeStatus(db).failing;
if (failing.length) console.error(`削除に失敗している開催回: ${failing.join(', ')}`);
db.close();
process.exit(failing.length ? 2 : 0);
