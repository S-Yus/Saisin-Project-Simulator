'use strict';
// 管理画面のアカウントを作る・パスワードを変える・一覧する・消す（サーバー上で実行する。パスワードは画面に表示せず、引数・履歴にも残さない）。
//   node --env-file=.env.staging scripts/admin-user.js set <ID> <operator|tester>   … 作成またはパスワード変更（パスワードを2回たずねる）
//   node --env-file=.env.staging scripts/admin-user.js list
//   node --env-file=.env.staging scripts/admin-user.js remove <ID>
// operator＝実用（すべての管理操作）、tester＝テスト用（説明会の作成と、自分が作った説明会の操作だけ）
const cfg = require('../server/config');
const { openDb } = require('../server/db');
const AU = require('../server/auth');

function ask(q) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin; process.stdout.write(q);
    if (!stdin.isTTY) { let s = ''; stdin.setEncoding('utf8'); stdin.once('data', (d) => { s += d; resolve(s.split(/\r?\n/)[0]); }); stdin.once('end', () => resolve(s.split(/\r?\n/)[0])); return; }
    let buf = ''; stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const on = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); process.stdout.write('\n'); return resolve(buf); }
        if (c === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); return reject(new Error('中止しました')); }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1); else buf += c;
      }
    };
    stdin.on('data', on);
  });
}
(async () => {
  const [cmd, id, role] = process.argv.slice(2);
  const db = openDb(cfg.DB_PATH);
  if (cmd === 'list') { const l = AU.listUsers(db); console.log(l.length ? l.map((u) => `${u.id}\t${AU.ROLE_JA[u.role]}（${u.role}）\t更新 ${u.updated_at}`).join('\n') : 'アカウントはありません'); return; }
  if (cmd === 'remove') { console.log(AU.removeUser(db, id) ? `削除しました: ${id}` : `見つかりません: ${id}`); return; }
  if (cmd !== 'set') { console.log('使い方: set <ID> <operator|tester> ／ list ／ remove <ID>'); process.exitCode = 1; return; }
  AU.checkId(id); if (!AU.ROLES.includes(role)) throw new Error('種類は operator（実用）か tester（テスト用）です');
  const tty = process.stdin.isTTY;
  const p1 = await ask(`${id}（${AU.ROLE_JA[role]}）のパスワード（${AU.MIN_PW}文字以上。入力は表示されません）: `);
  if (tty) { const p2 = await ask('もう一度: '); if (p1 !== p2) throw new Error('2回の入力が一致しません'); }
  AU.setUser(db, id, role, p1, new Date().toISOString());
  console.log(`設定しました: ${id}（${AU.ROLE_JA[role]}）。環境 ${cfg.ENV}。このアカウントのそれまでのログインは無効になりました。`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
