'use strict';
// 確認用環境に実データを取込・固定し、確認用の開催回を作って公開する（起動中のアプリの管理APIを 127.0.0.1 経由で呼ぶ）。
//   node ops/seed-staging.js [開催日数=14]
// 許諾・取引条件は未確定のまま（確認用環境の画面に表示される）。本番には使えない。
const fs = require('node:fs'); const path = require('node:path');
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env.staging'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const base = `http://127.0.0.1:${env.PORT}`; const days = Number(process.argv[2] || 14);
const call = async (method, p, body) => { const r = await fetch(base + '/admin-api' + p, { method, headers: { Authorization: 'Bearer ' + env.OPERATOR_TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(`${p}: ${j.error}`); return j; };
(async () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'market-data', 'build', 'dataset.json'), 'utf8'));
  const imp = await call('POST', '/datasets/import', bundle); if (!imp.ok) throw new Error('取込エラー: ' + imp.errors.join(' / '));
  const lk = await call('POST', `/datasets/${imp.id}/lock`, {}); if (!lk.ok) throw new Error('固定エラー: ' + lk.errors.join(' / '));
  console.log('データ固定:', imp.id, '未確定事項:', lk.pending.join(' / '));
  const now = Date.now();
  const ev = await call('POST', '/events', { name: '確認用（さいしん動作確認）', starts_at: new Date(now).toISOString(), ends_at: new Date(now + days * 86400000).toISOString(), max_participants: 50, initial_cash: 1000000, monthly_deposit: 30000, dataset_id: imp.id, sim_start: bundle.meta.period_start, sim_end: bundle.meta.period_end });
  await call('POST', `/events/${ev.id}/enable`, {});
  fs.writeFileSync(path.join(__dirname, '..', 'data-staging', 'join-code.txt'), ev.join_code + '\n');
  console.log(`開催回 ${ev.id} を公開（${days}日間）。参加コード: ${ev.join_code}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
