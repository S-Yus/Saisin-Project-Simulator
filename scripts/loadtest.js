'use strict';
// 負荷確認（dev 専用・架空データ）。確認用環境に近い構成として、
//   ファイルDB（WAL, synchronous=FULL）を一時ディレクトリに作り、サーバーを別プロセス（node server/index.js）で起動して HTTP で叩く。
// 使い方: node scripts/loadtest.js [人数=300] [同時実行=50] [シナリオ=session|fullrun]
//   session: 説明会らしい操作（参加→閲覧→買い→積立→月単位で12か月進行→売り→結果確認）
//   fullrun: 全員が36か月を最後まで早送り（最悪ケース）
// 起動したサーバーはこのスクリプトが PID を保持し、終了時にそのプロセスだけを停止する。
process.env.APP_ENV = 'dev';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { openDb } = require('../server/db');
const A = require('../server/admin');
const S = require('../server/service');
const { loadDataset } = require('../server/dataset');
const { bundle36 } = require('../test/fixture');

const N = Number(process.argv[2] || 300), CONC = Number(process.argv[3] || 50), MODE = process.argv[4] || 'session';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nisa-load-')); const file = path.join(dir, 'app.sqlite');
const now = Date.now(); const iso = (t) => new Date(t).toISOString();
let joinCode;
{ // 準備（別プロセス起動前に閉じる）
  const db = openDb(file);
  const imp = A.importDataset(db, bundle36(), 'dev', iso(now)); A.lockDataset(db, imp.id, iso(now), 'dev'); const ds = loadDataset(db, imp.id);
  const ev = A.createEvent(db, { name: '負荷確認', starts_at: iso(now - 1000), ends_at: iso(now + 3600000), max_participants: N, initial_cash: 3000000, monthly_deposit: 30000, dataset_id: imp.id, sim_start: ds.calendar[0], sim_end: ds.calendar[ds.calendar.length - 1] }, now, 'operator');
  A.recordVerification(db, ev.id, { verified_by: 'loadtest', reference: 'LT', fingerprint: S.fingerprint(db, db.prepare('SELECT * FROM events WHERE id=?').get(ev.id)) }, now, 'verifier');
  A.setState(db, ev.id, 'enable', now, 'operator'); joinCode = ev.join_code; db.close();
}
const PORT = 18000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
  env: { ...process.env, APP_ENV: 'dev', DB_PATH: file, PORT: String(PORT), HOST: '127.0.0.1', OPERATOR_TOKEN: 'lt-op-' + 'x'.repeat(30), VERIFIER_TOKEN: 'lt-vf-' + 'y'.repeat(30), JOIN_RATE_PER_MIN: '100000' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = ''; child.stderr.on('data', (c) => { stderr += c; });
const stopServer = () => new Promise((r) => { if (child.exitCode != null) return r(); child.once('exit', r); child.kill('SIGTERM'); setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 8000); });

const agent = new http.Agent({ keepAlive: true, maxSockets: CONC * 2 });
const call = (method, p, token, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null; const t0 = process.hrtime.bigint();
  const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, agent, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' } }, (res) => {
    let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6, body: JSON.parse(s || '{}') }));
  }); req.on('error', reject); if (data) req.write(data); req.end();
});
const lat = {}; const errs = [];
const rec = (kind, r, okStatus = [200]) => { (lat[kind] ||= []).push(r.ms); if (!okStatus.includes(r.status)) errs.push(`${kind} ${r.status} ${r.body.error}`); return r; };
async function participant(i) {
  const tok = rec('join', await call('POST', '/api/join', null, { code: joinCode })).body.token;
  const rid = (k) => `lt-${i}-${k}-${Math.random().toString(16).slice(2)}`;
  let me = rec('me', await call('GET', '/api/me', tok)).body;
  rec('list', await call('GET', '/api/instruments', tok)); rec('detail', await call('GET', '/api/instruments/E1', tok));
  rec('preview', await call('POST', '/api/orders/preview', tok, { instrument_id: 'E1', side: 'buy', qty: 100 }));
  rec('order', await call('POST', '/api/orders', tok, { request_id: rid('o1'), instrument_id: 'E1', side: 'buy', qty: 100, expected_sim_date: me.account.sim_date }));
  rec('plan', await call('POST', '/api/plans', tok, { request_id: rid('p1'), instrument_id: 'F1', amount: 10000, day_of_month: 5 }));
  const months = MODE === 'fullrun' ? 100 : 12; let guard = 0;
  while (me.account.status === 'active' && guard++ < months) {
    rec('advance', await call('POST', '/api/advance', tok, { request_id: rid('a' + guard), mode: 'month', expected_sim_date: me.account.sim_date }));
    me = rec('me', await call('GET', '/api/me', tok)).body;
    if (guard === 6) rec('order', await call('POST', '/api/orders', tok, { request_id: rid('s1'), instrument_id: 'E1', side: 'sell', qty: 50, expected_sim_date: me.account.sim_date }));
  }
  rec('history', await call('GET', '/api/history', tok)); rec('compare', await call('GET', '/api/compare', tok));
  return me.account.status;
}
(async () => {
  try {
    for (let i = 0; i < 50; i++) { try { if ((await call('GET', '/healthz')).status === 200) break; } catch { /* 起動待ち */ } await new Promise((r) => setTimeout(r, 200)); }
    const t0 = Date.now(); let next = 0; const results = [];
    await Promise.all(Array.from({ length: CONC }, async () => { while (next < N) { const i = next++; results.push(await participant(i)); } }));
    const dt = (Date.now() - t0) / 1000; const allLat = Object.values(lat).flat().sort((a, b) => a - b);
    const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))].toFixed(1);
    console.log(`環境: Node ${process.version} / ${os.platform()} ${os.release()} / CPU ${os.cpus()[0].model} x${os.cpus().length} / ファイルDB(WAL, synchronous=FULL) / サーバー別プロセス`);
    console.log(`シナリオ ${MODE} / 参加者 ${N}人 / 同時 ${CONC} / 完了 ${results.length}人（最終日到達 ${results.filter((x) => x === 'finished').length}） / 所要 ${dt.toFixed(1)}秒 / リクエスト ${allLat.length}件 / エラー ${errs.length}件 ${errs.slice(0, 3).join(' | ')}`);
    console.log(`全体(ms): p50=${q(allLat, 0.5)} p95=${q(allLat, 0.95)} p99=${q(allLat, 0.99)} max=${allLat.at(-1).toFixed(1)}`);
    for (const [k, v] of Object.entries(lat)) { v.sort((a, b) => a - b); console.log(`  ${k.padEnd(8)} n=${String(v.length).padStart(5)} p50=${q(v, 0.5)} p95=${q(v, 0.95)} max=${v.at(-1).toFixed(1)}`); }
    const sz = fs.statSync(file).size + (fs.existsSync(file + '-wal') ? fs.statSync(file + '-wal').size : 0); console.log(`DBサイズ ${(sz / 1048576).toFixed(1)}MB`);
    if (/Error|内部エラー/.test(stderr)) console.log('サーバー標準エラー:\n' + stderr.split('\n').filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).slice(0, 10).join('\n'));
    process.exitCode = errs.length ? 1 : 0;
  } finally { agent.destroy(); await stopServer(); fs.rmSync(dir, { recursive: true, force: true }); }
})();
