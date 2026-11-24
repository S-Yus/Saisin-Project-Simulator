'use strict';
// 確認用環境の参加用QRコードをファイルに書き出す（data-staging/join-qr.svg）。外部サービスは使わない。
//   node ops/make-qr.js
const fs = require('node:fs'); const path = require('node:path');
const root = path.join(__dirname, '..');
const env = Object.fromEntries(fs.readFileSync(path.join(root, '.env.staging'), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const { parsePublicUrl } = require('../server/config');
const base = parsePublicUrl(env.PUBLIC_URL); if (!base) throw new Error('.env.staging の PUBLIC_URL を設定してください（https://ドメイン）');
const code = fs.readFileSync(path.join(root, 'data-staging', 'join-code.txt'), 'utf8').trim();
const qrcode = require('../public/vendor/qrcode.js');
const url = `${base}/?code=${code}`; const q = qrcode(0, 'M'); q.addData(url); q.make();
const n = q.getModuleCount(), m = 4, s = 10, size = (n + m * 2) * s; let d = '';
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${(c + m) * s},${(r + m) * s}h${s}v${s}h-${s}z`;
const out = path.join(root, 'data-staging', 'join-qr.svg');
fs.writeFileSync(out, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>\n`);
console.log(`${url}\n→ ${out}`);
