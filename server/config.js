'use strict';
// 実行環境・版情報。
//   APP_ENV=prod（既定・本番） / staging（確認用環境: 本番と同じ規則・本番形式データ、別DB） / dev（開発・検算: 架空データのみ）
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const ENV = ['dev', 'staging'].includes(process.env.APP_ENV) ? process.env.APP_ENV : 'prod';
const ROOT = path.join(__dirname, '..');

// 実行中のコード（server/・public/・package.json）のハッシュ。動作確認の構成指紋に含め、
// コードが1バイトでも変われば確認状態が解除される（版番号の更新忘れに依存しない）。
function codeHash() {
  const h = crypto.createHash('sha256'); const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(path.join(ROOT, 'server')); walk(path.join(ROOT, 'public')); files.push(path.join(ROOT, 'package.json'));
  for (const f of files.map((f) => path.relative(ROOT, f).split(path.sep).join('/')).sort()) h.update(f + '\0').update(fs.readFileSync(path.join(ROOT, f)).toString('utf8').replace(/\r\n/g, '\n')).update('\0');
  return h.digest('hex');
}

// 参加者が開く公開URL（QRコードに入れる）。http(s) のオリジンだけを受け付け、経路・クエリ・認証情報は入れさせない
function parsePublicUrl(v) { const s = String(v || '').trim().replace(/\/+$/, ''); return /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(s) ? s : ''; }

module.exports = {
  parsePublicUrl,
  PUBLIC_URL: parsePublicUrl(process.env.PUBLIC_URL),
  ENV,
  STRICT: ENV !== 'dev', // 本番・確認用環境: 本番形式データのみ、検証済みの Node・32文字以上のトークンが必須
  // 確認用環境（staging）は、さいしんが動作確認を行う場所。確認の前に動いている必要があるため、
  // 許諾未確認・条件仮設定・確認未記録のままでも固定・公開できる（画面に「確認用環境」と未確定事項を常時表示）。
  // 本番（prod）だけが、許諾確認済み・条件確定・仮設定なし・動作確認の記録を公開の条件にする。
  REVIEW: ENV === 'staging',
  APP_VERSION: '0.10.0',
  CALC_SPEC_VERSION: '1.4',          // docs/SPEC.md の版。計算仕様を変えたら必ず上げる
  CODE_HASH: codeHash(),
  PORT: Number(process.env.PORT || 8080),
  HOST: process.env.HOST || '127.0.0.1', // 既定はローカルのみ待受。公開はリバースプロキシ経由
  DB_PATH: process.env.DB_PATH || path.join(ROOT, 'data-' + ENV, 'app.sqlite'),
  OPERATOR_TOKEN: process.env.OPERATOR_TOKEN || '',   // 開催・停止・削除・有効化
  VERIFIER_TOKEN: process.env.VERIFIER_TOKEN || '',   // 動作確認の記録のみ
  PURGE_INTERVAL_MS: Number(process.env.PURGE_INTERVAL_MS || 60000),
  // 管理画面・管理APIを、プロキシ／トンネルを経由しない直接接続（このホスト上のブラウザー）だけに限定する
  ADMIN_LOCAL_ONLY: process.env.ADMIN_LOCAL_ONLY === '1',
  TRUST_PROXY: process.env.TRUST_PROXY === '1',       // 前段プロキシの X-Forwarded-For を信頼するか
  JOIN_RATE_PER_MIN: Number(process.env.JOIN_RATE_PER_MIN || 600), // 1送信元IPあたり/分（会場Wi-FiのNATを考慮）
  // 参加者が自分で選べる資金条件の範囲（円）。開催回の初期資金・毎月の追加資金は、選ばなかった場合の既定値になる
  FUNDS: { initial_max: 10000000, monthly_max: 300000, step: 1000 },
  DISCLAIMERS: [
    '本シミュレーションのいかなる内容も将来の結果を予測し保証するものではありません',
    '本シミュレーションを利用することで生じるいかなる損害についても当金庫が責任を負うものではありません。実際の資産運用や投資判断に当たっては、必ずご自身の責任において最終判断してください。',
    '本シミュレーションは特定の金融商品の取引を推奨し、勧誘するものではありません。',
  ],
};
