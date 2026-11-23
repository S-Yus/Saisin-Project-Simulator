'use strict';
// 検証済みの Node バージョン以外では本番・確認用環境を起動しない（node:sqlite は Node 24 時点で実験的機能のため）
const PINNED = 'v' + require('../package.json').engines.node;
const cfg = require('./config');
if (process.version !== PINNED) {
  const msg = `Node ${process.version} は検証済みの ${PINNED} と異なります`;
  if (cfg.STRICT && process.env.ALLOW_UNVERIFIED_NODE !== '1') { console.error(msg + '。起動を中止します（.nvmrc / Dockerfile のバージョンを使用してください）'); process.exit(1); }
  console.warn(msg);
}
try { require('node:sqlite'); } catch (e) { console.error('node:sqlite を読み込めません: ' + e.message); process.exit(1); }
const { openDb } = require('./db');
const { createApp } = require('./app');

if (cfg.STRICT) {
  if (cfg.OPERATOR_TOKEN.length < 32 || cfg.VERIFIER_TOKEN.length < 32 || cfg.OPERATOR_TOKEN === cfg.VERIFIER_TOKEN) {
    console.error(`${cfg.ENV} 起動には、互いに異なる OPERATOR_TOKEN と VERIFIER_TOKEN（各32文字以上の乱数。例: openssl rand -hex 32）が必要です。`); process.exit(1);
  }
} else if (!cfg.OPERATOR_TOKEN || !cfg.VERIFIER_TOKEN) {
  console.error('dev 起動にも OPERATOR_TOKEN / VERIFIER_TOKEN が必要です（.env.example 参照）'); process.exit(1);
}
// 開発・検算環境は架空データや許諾未確認の実データを扱えるため、外部から到達できる待受では起動しない
if (cfg.ENV === 'dev' && !['127.0.0.1', '::1', 'localhost'].includes(cfg.HOST)) { console.error('dev 環境はループバック（127.0.0.1）でのみ起動できます。外部に公開する場合は staging / prod を使用してください'); process.exit(1); }
const db = openDb(cfg.DB_PATH);
const app = createApp(db);
app.startJobs(); // 起動直後に削除ジョブを1回実行（停止中に削除予定を過ぎた開催回を処理）
app.server.keepAliveTimeout = 5000;
app.server.listen(cfg.PORT, cfg.HOST, () => console.log(`[${cfg.ENV}] listening ${cfg.HOST}:${cfg.PORT} node=${process.version} app=${cfg.APP_VERSION} spec=${cfg.CALC_SPEC_VERSION} code=${cfg.CODE_HASH.slice(0, 12)}`));

// 正常終了: 新規受付を止め、処理中のリクエスト完了を待ってからDBを閉じる（SQLite は WAL＋synchronous=FULL でコミット済みの内容は失われない）
let closing = false;
function shutdown(sig) {
  if (closing) return; closing = true;
  console.log(`${sig} 受信: 終了処理を開始`);
  app.stopJobs();
  const force = setTimeout(() => { console.error('終了待ちがタイムアウトしました'); try { db.close(); } catch (_) { /* noop */ } process.exit(1); }, 10000);
  force.unref();
  app.server.close(() => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch (_) { /* noop */ } console.log('終了しました'); process.exit(0); });
  app.server.closeIdleConnections?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
