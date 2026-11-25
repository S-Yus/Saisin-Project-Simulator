'use strict';
// 管理画面のログイン（IDとパスワード）。アカウントは2種類:
//   operator … 実用。すべての管理操作
//   tester   … テスト用。説明会の作成と、自分が作った説明会の公開・一時停止・再開・終了・QR表示だけ
// パスワードは scrypt（アカウントごとの乱数ソルト）でハッシュ化して保存し、平文・復元できる形では持たない。
// ログイン状態はランダムなセッショントークン（DBにはSHA-256だけを保存）で表し、ブラウザーには HttpOnly の Cookie で渡す。
const crypto = require('node:crypto');

const ROLES = ['operator', 'tester'];
const ROLE_JA = { operator: '実用アカウント', tester: 'テスト用アカウント' };
const SESSION_MS = 12 * 3600 * 1000;
const MIN_PW = 10;
const COOKIE = 'nisa_admin';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(String(pw).normalize('NFKC'), Buffer.from(salt, 'hex'), 64).toString('hex');
const DUMMY_SALT = crypto.randomBytes(16).toString('hex'); // 存在しないIDでも同じだけ計算する（IDの有無を応答時間から推測させない）

function checkId(id) { if (typeof id !== 'string' || !/^[a-z0-9_-]{3,32}$/.test(id)) throw new Error('IDは半角の英小文字・数字・「_」「-」で3〜32文字にしてください'); }
function checkPw(pw, id) {
  if (typeof pw !== 'string' || pw.length < MIN_PW || pw.length > 200) throw new Error(`パスワードは${MIN_PW}文字以上200文字以下にしてください`);
  if (id && pw.toLowerCase().includes(id)) throw new Error('パスワードにIDを含めないでください');
  if (new Set(pw).size < 5) throw new Error('同じ文字のくり返しが多すぎます。5種類以上の文字を使ってください');
}
function setUser(db, id, role, pw, nowIso) {
  checkId(id); if (!ROLES.includes(role)) throw new Error('種類は operator（実用）か tester（テスト用）です'); checkPw(pw, id);
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO admin_users(id,role,salt,hash,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET role=excluded.role, salt=excluded.salt, hash=excluded.hash, updated_at=excluded.updated_at').run(id, role, salt, hashPw(pw, salt), nowIso);
  db.prepare('DELETE FROM admin_sessions WHERE user_id=?').run(id); // パスワードを変えたら、それまでのログインは無効
}
function removeUser(db, id) { db.prepare('DELETE FROM admin_sessions WHERE user_id=?').run(id); return db.prepare('DELETE FROM admin_users WHERE id=?').run(id).changes > 0; }
function listUsers(db) { return db.prepare('SELECT id,role,updated_at FROM admin_users ORDER BY id').all(); }
function verify(db, id, pw) {
  const u = typeof id === 'string' ? db.prepare('SELECT * FROM admin_users WHERE id=?').get(id) : null;
  const h = Buffer.from(hashPw(typeof pw === 'string' ? pw.slice(0, 200) : '', u ? u.salt : DUMMY_SALT), 'hex');
  const ok = !!u && crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'));
  return ok ? { id: u.id, role: u.role } : null;
}
function createSession(db, user, nowMs) {
  db.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').run(nowMs);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO admin_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(sha(token), user.id, nowMs + SESSION_MS, nowMs);
  return token;
}
function getSession(db, token, nowMs) {
  if (!token || token.length > 200) return null;
  const s = db.prepare('SELECT s.expires_at, u.id, u.role FROM admin_sessions s JOIN admin_users u ON u.id=s.user_id WHERE s.token_hash=?').get(sha(token));
  if (!s) return null;
  if (s.expires_at <= nowMs) { db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(sha(token)); return null; }
  return { id: s.id, role: s.role, expires_at: s.expires_at };
}
function destroySession(db, token) { if (token) db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(sha(token)); }
const cookieOf = (req) => { for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim(); } return ''; };
const setCookie = (token, secure) => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/admin-api; Max-Age=${token ? SESSION_MS / 1000 : 0}${secure ? '; Secure' : ''}`;

module.exports = { ROLES, ROLE_JA, SESSION_MS, MIN_PW, checkId, checkPw, setUser, removeUser, listUsers, verify, createSession, getSession, destroySession, cookieOf, setCookie };
