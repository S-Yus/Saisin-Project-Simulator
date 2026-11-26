'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cfg = require('./config');
const S = require('./service');
const A = require('./admin');
const AU = require('./auth');
const { HttpError } = S;

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const SEC = {
  'Cache-Control': 'no-store', // 端末へのキャッシュを残さない（Service Worker も使わない）
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
};
const safeEq = (a, b) => { const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest(); return crypto.timingSafeEqual(x, y); };

function createApp(db, opts = {}) {
  const now = opts.now || (() => Date.now());
  const operatorToken = opts.operatorToken ?? cfg.OPERATOR_TOKEN, verifierToken = opts.verifierToken ?? cfg.VERIFIER_TOKEN;
  const fails = new Map(); // 管理認証の失敗制限（IP単位、メモリのみ）
  const joins = new Map();
  const locks = new Map(); // ログイン失敗によるIDごとの一時停止（メモリのみ）
  const limit = (m, key, max, winMs) => { const t = now(); const a = (m.get(key) || []).filter((x) => t - x < winMs); a.push(t); m.set(key, a); return a.length > max; };

  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      let n = 0; const chunks = [];
      req.on('data', (c) => { n += c.length; if (n > max) { reject(new HttpError(413, '送信データが大きすぎます')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { if (!chunks.length) return resolve({}); let v; try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new HttpError(400, 'JSON を解釈できません')); } if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new HttpError(400, 'JSON オブジェクトで送信してください')); resolve(v); });
      req.on('error', reject);
    });
  }
  const send = (res, status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, { ...SEC, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
  const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const trustProxy = opts.trustProxy ?? cfg.TRUST_PROXY;
  const adminLocalOnly = opts.adminLocalOnly ?? cfg.ADMIN_LOCAL_ONLY;
  const VIA_PROXY = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'via', 'cf-ray', 'cf-connecting-ip', 'cdn-loop', 'x-real-ip'];
  // 送信元IP（レート制限にのみ使用。ログには出さない）。プロキシ配下では X-Forwarded-For の末尾＝プロキシが見た接続元
  const clientIp = (req) => { if (trustProxy) { const x = String(req.headers['x-forwarded-for'] || '').split(',').map((v) => v.trim()).filter(Boolean); if (x.length) return x[x.length - 1]; } return req.socket.remoteAddress; };

  async function participantApi(req, res, url, route) {
    const t = now(); const token = bearer(req); const m = req.method;
    const body = m === 'POST' ? await readBody(req, 32 * 1024) : {};
    let mm;
    if (route === 'GET /api/event') return S.publicEvent(db, url.searchParams.get('code') || '', t);
    if (route === 'POST /api/join') {
      if (limit(joins, clientIp(req), opts.joinRatePerMin || cfg.JOIN_RATE_PER_MIN, 60000)) throw new HttpError(429, '短時間に参加操作が集中しています。少し待ってください');
      return S.join(db, String(body.code || ''), t, body);
    }
    if (m === 'GET') {
      const ctx = S.auth(db, token, t, { write: false }); const q = url.searchParams;
      if (route === 'GET /api/me') return S.me(db, ctx, t);
      if (route === 'GET /api/instruments') return S.instruments(db, ctx, q.get('q'), q.get('category'));
      if ((mm = url.pathname.match(/^\/api\/instruments\/([\w.-]+)$/))) return S.instrumentDetail(db, ctx, mm[1]);
      if (route === 'GET /api/history') return S.history(db, ctx, q.get('attempt') ? Number(q.get('attempt')) : null);
      if (route === 'GET /api/compare') return S.compare(db, ctx);
      if ((mm = url.pathname.match(/^\/api\/requests\/([\w-]{8,80})$/))) return S.requestStatus(db, ctx, mm[1]);
    }
    if (m === 'POST') {
      if (route === 'POST /api/orders/preview') { const ctx = S.auth(db, token, t, { write: false }); return S.orderPreview(db, ctx, body); }
      if (route === 'POST /api/orders') return S.opPlaceOrder(db, body)(t, token);
      if ((mm = url.pathname.match(/^\/api\/orders\/(\d+)\/cancel$/))) return S.opCancel(db, body, Number(mm[1]))(t, token);
      if (route === 'POST /api/advance') return S.opAdvance(db, body)(t, token);
      if (route === 'POST /api/plans') return S.opPlanCreate(db, body)(t, token);
      if ((mm = url.pathname.match(/^\/api\/plans\/(\d+)$/))) return S.opPlanUpdate(db, body, Number(mm[1]))(t, token);
      if (route === 'POST /api/restart') return S.opRestart(db, body)(t, token);
      if (route === 'POST /api/monthly') return S.opMonthly(db, body)(t, token);
    }
    throw new HttpError(404, 'not found');
  }

  async function adminApi(req, res, url) {
    const t = now(); const tok = bearer(req); const ip = clientIp(req);
    const m = req.method; const p = url.pathname.replace('/admin-api', '');
    const recent = (fails.get(ip) || []).filter((x) => t - x < 60000);
    const failed = () => { recent.push(t); fails.set(ip, recent); };
    const secure = cfg.ENV !== 'dev' || req.headers['x-forwarded-proto'] === 'https';
    // ログイン（IDとパスワード）。失敗は送信元ごとに1分10回まで、同じIDで5回続くと15分使えない
    if (m === 'POST' && p === '/login') {
      if (recent.length >= 10) throw new HttpError(429, '認証の失敗が続いたため一時的に制限しています');
      const b0 = await readBody(req, 4096); const id = String(b0.id || '').trim().toLowerCase().slice(0, 64);
      const lk = locks.get(id); if (lk && lk.until > t) throw new HttpError(429, 'ログインの失敗が続いたため、このIDは一時的に使えません。15分ほど待ってからやり直してください');
      const u = AU.verify(db, id, b0.password);
      if (!u) {
        failed(); const cur = lk && t - lk.first < 900000 ? lk : { count: 0, first: t }; cur.count += 1; cur.until = cur.count >= 5 ? t + 900000 : 0; locks.set(id, cur);
        if (locks.size > 5000) locks.clear();
        throw new HttpError(401, 'IDまたはパスワードが違います');
      }
      locks.delete(id); res.setHeader('Set-Cookie', AU.setCookie(AU.createSession(db, u, t), secure)); A.audit(db, t, u.role, 'admin.login', null, u.id);
      return { ok: true, role: u.role, user: u.id };
    }
    // 認証: ①ログイン済みの Cookie ②管理トークン（確認担当・復旧・運用スクリプト用）
    let role = null, user = null, via = null; const ck = AU.cookieOf(req);
    if (ck) { const s = AU.getSession(db, ck, t); if (s) { role = s.role; user = s.id; via = 'session'; } }
    if (!role && tok) { if (operatorToken && safeEq(tok, operatorToken)) role = 'operator'; else if (verifierToken && safeEq(tok, verifierToken)) role = 'verifier'; if (role) via = 'token'; }
    if (m === 'POST' && p === '/logout') { AU.destroySession(db, ck); res.setHeader('Set-Cookie', AU.setCookie('', secure)); return { ok: true }; }
    if (!role) { if (recent.length >= 10) throw new HttpError(429, '認証の失敗が続いたため一時的に制限しています'); if (tok || ck) failed(); throw new HttpError(401, '管理者認証が必要です'); }
    // Cookie で認証した変更操作は、同じサイトの画面からの要求だけを受け付ける（他サイトからの送信を拒否）
    if (via === 'session' && m !== 'GET' && req.headers.origin) { let oh = ''; try { oh = new URL(req.headers.origin).host; } catch { /* 不正な Origin */ } if (oh !== req.headers.host) throw new HttpError(403, 'この画面以外からの操作は受け付けません'); }
    const body = m === 'GET' || m === 'DELETE' ? {} : await readBody(req, 12 * 1024 * 1024);
    if (m === 'POST' && p === '/password') {
      if (via !== 'session') throw new HttpError(400, 'パスワードの変更はログインして行ってください');
      if (!AU.verify(db, user, body.current)) { failed(); throw new HttpError(401, '現在のパスワードが違います'); }
      try { AU.setUser(db, user, role, body.new, S.iso(t)); } catch (e) { throw new HttpError(422, e.message); }
      res.setHeader('Set-Cookie', AU.setCookie(AU.createSession(db, { id: user }, t), secure)); A.audit(db, t, role, 'admin.password', null, user);
      return { ok: true };
    }
    const TESTER_MAX = { participants: 50, hours: 168 }; // テスト用アカウントで作れる説明会の上限（定員・長さ）
    const own = (id) => { const e = db.prepare('SELECT created_by FROM events WHERE id=?').get(id); if (!e || e.created_by !== user) throw new HttpError(403, 'テスト用アカウントでは、自分が作った説明会だけを操作できます'); };
    const needOp = () => { if (role !== 'operator') throw new HttpError(403, 'この操作の権限がありません（運用担当のみ）'); };
    let mm;
    if (m === 'GET' && p === '/whoami') return { role, user, via, role_ja: AU.ROLE_JA[role] || (role === 'verifier' ? '確認担当' : '運用担当（トークン）'), env: cfg.ENV, app_version: cfg.APP_VERSION, calc_spec_version: cfg.CALC_SPEC_VERSION, code_hash: cfg.CODE_HASH, node: process.version, server_now: S.iso(t) };
    if (m === 'GET' && p === '/events') return { events: A.listEvents(db, t).filter((e) => role !== 'tester' || e.created_by === user), public_url: opts.publicUrl ?? cfg.PUBLIC_URL };
    if (m === 'GET' && p === '/datasets') return { datasets: A.listDatasets(db) };
    if (m === 'GET' && p === '/purge') return role === 'tester' ? { failing: [], log: [] } : A.purgeStatus(db);
    if (m === 'POST' && (mm = p.match(/^\/events\/([\w]+)\/verify$/))) { if (role !== 'verifier') throw new HttpError(403, '動作確認の記録は確認担当のみ可能です（運用担当とは別トークン）'); return A.recordVerification(db, mm[1], body, t, role); }
    if (role === 'tester') {
      // テスト用アカウント: 説明会の作成と、自分が作った説明会の公開・一時停止・再開・終了だけ
      if (m === 'POST' && p === '/events') {
        if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(422, '説明会の名前を入れてください');
        if (!(body.max_participants <= TESTER_MAX.participants)) throw new HttpError(422, `テスト用アカウントで作れる説明会の定員は${TESTER_MAX.participants}人までです`);
        if (!(Date.parse(body.ends_at) - Date.parse(body.starts_at) <= TESTER_MAX.hours * 3600000)) throw new HttpError(422, 'テスト用アカウントで作れる説明会は7日までです');
        const r = A.createEvent(db, { ...body, name: ('【テスト】' + body.name.trim().replace(/^【テスト】/, '')).slice(0, 80) }, t, role);
        db.prepare('UPDATE events SET created_by=? WHERE id=?').run(user, r.id); return r;
      }
      if (m === 'POST' && (mm = p.match(/^\/events\/(\w+)\/(enable|pause|resume|emergency_stop)$/))) { own(mm[1]); return A.setState(db, mm[1], mm[2], t, role); }
      if (m === 'DELETE' && (mm = p.match(/^\/events\/(\w+)$/))) { own(mm[1]); return A.deleteEvent(db, mm[1], t, role); }
      throw new HttpError(403, 'テスト用アカウントではこの操作はできません');
    }
    needOp();
    if (m === 'POST' && p === '/events') { const r = A.createEvent(db, body, t, role); if (user) db.prepare('UPDATE events SET created_by=? WHERE id=?').run(user, r.id); return r; }
    if (m === 'PATCH' && (mm = p.match(/^\/events\/(\w+)$/))) return A.updateEvent(db, mm[1], body, t, role);
    if (m === 'DELETE' && (mm = p.match(/^\/events\/(\w+)$/))) return A.deleteEvent(db, mm[1], t, role);
    if (m === 'POST' && (mm = p.match(/^\/events\/(\w+)\/(enable|pause|resume|emergency_stop)$/))) return A.setState(db, mm[1], mm[2], t, role);
    if (m === 'POST' && (mm = p.match(/^\/events\/(\w+)\/retention-preview$/))) return A.retentionPreview(db, mm[1], body.hours, t);
    if (m === 'POST' && (mm = p.match(/^\/events\/(\w+)\/retention$/))) return A.setRetention(db, mm[1], body.hours, body.confirm === true, t, role);
    if (m === 'POST' && (mm = p.match(/^\/events\/(\w+)\/purge$/))) return A.purgeNow(db, mm[1], body.confirm_name, t, role);
    if (m === 'POST' && p === '/datasets/preview') return A.previewDataset(body, cfg.ENV);
    if (m === 'POST' && p === '/datasets/import') { const r = A.importDataset(db, body, cfg.ENV, S.iso(t)); A.audit(db, t, role, 'dataset.import', null, r.ok ? r.id : 'rejected'); return r; }
    if (m === 'POST' && (mm = p.match(/^\/datasets\/(\w+)\/lock$/))) { const r = A.lockDataset(db, mm[1], S.iso(t), cfg.ENV); A.audit(db, t, role, 'dataset.lock', null, mm[1] + (r.ok ? '' : ' rejected')); return r; }
    if (m === 'POST' && (mm = p.match(/^\/datasets\/(\w+)\/license$/))) return A.setLicense(db, mm[1], body.source_id, body.status, body.note, t, role);
    throw new HttpError(404, 'not found');
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x'); const t0 = Date.now();
    let status = 200; const route = `${req.method} ${url.pathname.replace(/\/\d+(?=\/|$)/g, '/:n').replace(/(instruments\/)[\w.-]+$/, '$1:id').replace(/(events\/)\w+/, '$1:id').replace(/(datasets\/)\w+/, '$1:id').replace(/(requests\/)[\w-]+/, '$1:id')}`;
    try {
      // 管理系の経路（URL正規化後に判定。/x/../admin のような書き方もここで同じ経路になる）。
      // ADMIN_LOCAL_ONLY のときは、プロキシやトンネルが付けるヘッダーのある要求（＝外部から来た要求）には存在しないものとして 404 を返す
      if (adminLocalOnly && /^\/(admin|admin\.html|admin\.js|admin-api)(\/|$)/i.test(url.pathname) && VIA_PROXY.some((h) => req.headers[h] !== undefined)) { status = 404; res.writeHead(404, SEC); return res.end('not found'); }
      if (url.pathname === '/healthz') { db.prepare('SELECT 1').get(); return send(res, 200, { ok: true }); } // 内部情報は返さない
      if (url.pathname.startsWith('/admin-api/')) { const r = await adminApi(req, res, url); return send(res, 200, r); }
      if (url.pathname.startsWith('/api/')) {
        const routeKey = `${req.method} ${url.pathname}`;
        const r = await participantApi(req, res, url, routeKey); return send(res, 200, r);
      }
      // 静的ファイル
      let f = url.pathname === '/' ? '/index.html' : url.pathname === '/admin' ? '/admin.html' : url.pathname;
      const full = path.normalize(path.join(PUBLIC, f));
      if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { status = 404; res.writeHead(404, SEC); return res.end('not found'); }
      res.writeHead(200, { ...SEC, 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' }); return res.end(fs.readFileSync(full));
    } catch (e) {
      status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) { try { console.error('内部エラー', route, e.message); } catch (_) { /* noop */ } }
      send(res, status, { error: e instanceof HttpError ? e.message : 'サーバーで問題が発生しました。画面を更新して状態を確認してください（二重に操作しないでください）', ...(e.extra || {}) });
    } finally {
      // ログにはトークン・参加者ID・IPを含めない
      if (!opts.quiet) console.log(`${route} ${status} ${Date.now() - t0}ms`);
    }
  }
  const server = http.createServer(handle);
  let timer = null;
  const startJobs = () => {
    const tick = () => { try { const r = A.runPurgeJob(db, now()); for (const x of r) console.log(`purge ${x.event} ${x.ok ? 'ok' : 'FAILED（次回再試行）'}`); } catch (e) { console.error('purge job error', e.message); } };
    tick(); timer = setInterval(tick, cfg.PURGE_INTERVAL_MS); timer.unref();
  };
  return { server, handle, startJobs, stopJobs: () => timer && clearInterval(timer), runPurgeOnce: () => A.runPurgeJob(db, now()) };
}
module.exports = { createApp };
