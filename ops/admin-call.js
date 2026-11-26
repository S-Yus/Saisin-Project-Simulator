'use strict';
// 起動中のアプリの管理APIを、このサーバーの中（127.0.0.1）から運用トークンで呼ぶ。トークンは .env.staging から読み、表示しない。
//   node ops/admin-call.js GET /events
//   node ops/admin-call.js DELETE /events/<ID>
const fs = require('node:fs'); const path = require('node:path');
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '.env.staging'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const [method, p, json] = process.argv.slice(2);
if (!method || !p) { console.error('使い方: node ops/admin-call.js <GET|POST|PATCH|DELETE> <パス> [JSON]'); process.exit(1); }
fetch(`http://127.0.0.1:${env.PORT}/admin-api${p}`, { method, headers: { Authorization: 'Bearer ' + env.OPERATOR_TOKEN, 'Content-Type': 'application/json' }, body: json || undefined })
  .then(async (r) => { const j = await r.json(); if (p === '/events' && method === 'GET') console.log(j.events.map((e) => [e.id, e.status, e.participants, e.join_code, e.sim_start + '〜' + e.sim_end, e.ends_at, e.name].join(' | ')).join('\n')); else console.log(r.status, JSON.stringify(j).slice(0, 600)); if (!r.ok) process.exit(1); })
  .catch((e) => { console.error(e.message); process.exit(1); });
