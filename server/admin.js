'use strict';
// 管理機能と削除ジョブ。管理者は参加者の口座を操作・閲覧できない（件数などの集計のみ）。
const crypto = require('node:crypto');
const cfg = require('./config');
const { tx } = require('./db');
const { importDataset, previewDataset, lockDataset, unresolved, validDate } = require('./dataset');
const S = require('./service');

const { HttpError, iso } = S;
const bad = (m) => new HttpError(400, m);
const audit = (db, nowMs, role, action, eventId, detail) => db.prepare('INSERT INTO admin_audit(at,role,action,event_id,detail) VALUES(?,?,?,?,?)').run(iso(nowMs), role, action, eventId ?? null, detail ?? null);
const CALC_FIELDS = ['dataset_id', 'sim_start', 'sim_end', 'initial_cash', 'monthly_deposit'];
const PROV_KEYS = ['initial_cash', 'monthly_deposit', 'max_participants', 'period', 'schedule'];

function eventRow(db, id) { const ev = db.prepare('SELECT * FROM events WHERE id=?').get(id); if (!ev) throw new HttpError(404, '開催回が見つかりません'); return ev; }

function checkEventInput(b, partial) {
  const isInt = (v, min) => Number.isSafeInteger(v) && v >= min;
  const dt = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s)) && /T/.test(s);
  if (!partial || 'name' in b) if (!b.name || b.name.length > 80) throw bad('開催名は1〜80文字');
  if (!partial || 'starts_at' in b) if (!dt(b.starts_at)) throw bad('開始日時は ISO 8601（例 2026-12-01T10:00:00+09:00）');
  if (!partial || 'ends_at' in b) if (!dt(b.ends_at)) throw bad('終了日時は ISO 8601');
  if (b.starts_at && b.ends_at && Date.parse(b.ends_at) <= Date.parse(b.starts_at)) throw bad('終了は開始より後にしてください');
  if (!partial || 'max_participants' in b) if (!isInt(b.max_participants, 1) || b.max_participants > 5000) throw bad('最大参加人数は1〜5000');
  if (!partial || 'initial_cash' in b) if (!isInt(b.initial_cash, 0) || b.initial_cash > 10000000000) throw bad('初期資金は0〜100億の整数（円）');
  if (!partial || 'monthly_deposit' in b) if (!isInt(b.monthly_deposit, 0) || b.monthly_deposit > 100000000) throw bad('毎月の追加資金は0〜1億の整数（円）');
  if ('provisional' in b && (typeof b.provisional !== 'object' || !b.provisional || Object.keys(b.provisional).some((k) => !PROV_KEYS.includes(k) || typeof b.provisional[k] !== 'boolean'))) throw bad('仮設定フラグの形式が不正です');
  if ('sim_start' in b && b.sim_start != null && !validDate(b.sim_start)) throw bad('シミュレーション開始日は YYYY-MM-DD');
  if ('sim_end' in b && b.sim_end != null && !validDate(b.sim_end)) throw bad('シミュレーション終了日は YYYY-MM-DD');
  if ('retention_hours' in b && !isInt(b.retention_hours, 0)) throw bad('保持時間は0以上の整数（時間）');
}

function createEvent(db, b, nowMs, role) {
  checkEventInput(b, false);
  const id = 'ev_' + crypto.randomBytes(5).toString('hex');
  const code = crypto.randomBytes(6).toString('base64url');
  db.prepare(`INSERT INTO events(id,name,join_code,starts_at,ends_at,retention_hours,max_participants,dataset_id,sim_start,sim_end,initial_cash,monthly_deposit,provisional_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, b.name, code, new Date(b.starts_at).toISOString(), new Date(b.ends_at).toISOString(), b.retention_hours ?? 24, b.max_participants, b.dataset_id ?? null, b.sim_start ?? null, b.sim_end ?? null, b.initial_cash, b.monthly_deposit,
      JSON.stringify({ initial_cash: true, monthly_deposit: true, max_participants: true, period: true, schedule: true }), iso(nowMs));
  audit(db, nowMs, role, 'event.create', id);
  return { id, join_code: code };
}

function updateEvent(db, id, b, nowMs, role) {
  return tx(db, () => {
    const ev = eventRow(db, id); checkEventInput(b, true);
    if (ev.purged_at) throw new HttpError(409, '削除済みの開催回は変更できません');
    const n = db.prepare('SELECT COUNT(*) c FROM participants WHERE event_id=?').get(id).c;
    const provChange = 'provisional' in b && JSON.stringify({ ...JSON.parse(ev.provisional_json), ...b.provisional }) !== ev.provisional_json;
    const calcChange = CALC_FIELDS.some((f) => f in b && b[f] !== ev[f]) || provChange;
    if (calcChange && n > 0) throw new HttpError(409, '参加者がいる開催回の計算条件（データ・期間・資金・仮設定）は変更できません。新しい開催回を作成してください');
    if (b.dataset_id) { const d = db.prepare('SELECT status FROM datasets WHERE id=?').get(b.dataset_id); if (!d) throw bad('データセットが存在しません'); if (d.status !== 'locked') throw bad('固定（ロック）済みのデータセットのみ指定できます'); }
    const f = {};
    for (const k of ['name', 'starts_at', 'ends_at', 'max_participants', 'dataset_id', 'sim_start', 'sim_end', 'initial_cash', 'monthly_deposit']) if (k in b) f[k] = (k === 'starts_at' || k === 'ends_at') ? new Date(b[k]).toISOString() : b[k];
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`UPDATE events SET ${keys.map((k) => k + '=?').join(',')} WHERE id=?`).run(...keys.map((k) => f[k]), id);
    let cleared = false;
    if (calcChange) { db.prepare("UPDATE events SET verified_fingerprint=NULL, verified_by=NULL, verified_at=NULL, verification_ref=NULL, verification_note=NULL, admin_state=CASE WHEN admin_state IN('enabled','paused') THEN 'draft' ELSE admin_state END WHERE id=?").run(id); cleared = true; }
    if (provChange) db.prepare('UPDATE events SET provisional_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(ev.provisional_json), ...b.provisional }), id);
    audit(db, nowMs, role, 'event.update', id, keys.join(',') + (cleared ? ' (確認状態を解除)' : ''));
    return { ok: true, verification_cleared: cleared };
  });
}

function recordVerification(db, id, b, nowMs, role) {
  const ev = eventRow(db, id); const fp = S.fingerprint(db, ev);
  if (!fp) throw bad('データセットが固定されていないため確認を記録できません');
  if (!b.verified_by || !b.reference) throw bad('確認者名と確認記録の識別番号（確認書番号など）が必要です');
  if (b.fingerprint !== fp) throw new HttpError(409, '確認対象の構成が現在の構成と一致しません。画面を更新して、最新の構成を確認してください');
  db.prepare('UPDATE events SET verified_fingerprint=?, verified_by=?, verified_at=?, verification_ref=?, verification_note=? WHERE id=?').run(fp, String(b.verified_by).slice(0, 80), iso(nowMs), String(b.reference).slice(0, 80), String(b.note || '').slice(0, 500), id);
  audit(db, nowMs, role, 'event.verify', id, `fp=${fp.slice(0, 12)} by=${String(b.verified_by).slice(0, 40)}`);
  return { ok: true };
}

function setState(db, id, action, nowMs, role) {
  return tx(db, () => {
    const ev = eventRow(db, id);
    if (ev.purged_at) throw new HttpError(409, '削除済みです');
    if (action === 'enable') {
      if (S.eventStatus(db, { ...ev, admin_state: 'enabled' }, 0 /* 時刻条件は別 */) === 'unverified') throw new HttpError(409, '動作確認が未了、または確認後に構成が変更されています。有効化できません');
      const ds = db.prepare('SELECT * FROM datasets WHERE id=?').get(ev.dataset_id);
      if (!ds || ds.status !== 'locked') throw new HttpError(409, 'データ未設定です');
      if (cfg.STRICT && ds.kind !== 'production') throw new HttpError(409, '本番・確認用環境では本番形式のデータのみ有効化できます');
      const prov = Object.entries(JSON.parse(ev.provisional_json)).filter(([, v]) => v).map(([k]) => k);
      // 本番は、固定済みのデータであっても未確定事項（許諾・条件・基準）が残っていれば公開しない（確認用環境のDBを持ち込んだ場合の防止）
      const un = cfg.ENV === 'prod' && ds.kind === 'production' ? unresolved(db, ds.id, ds) : [];
      if (un.length) throw new HttpError(409, '未確定事項があるため本番では公開できません: ' + un.join(' / '));
      if (cfg.ENV === 'prod' && prov.length) throw new HttpError(409, `仮設定のままの項目があるため有効化できません: ${prov.join(', ')}（確定後に「仮設定を解除」してください）`);
      if (!ev.sim_start || !ev.sim_end) throw new HttpError(409, 'シミュレーション期間が未設定です');
      db.prepare("UPDATE events SET admin_state='enabled' WHERE id=?").run(id);
    } else if (action === 'pause') db.prepare("UPDATE events SET admin_state='paused' WHERE id=? AND admin_state='enabled'").run(id);
    else if (action === 'resume') db.prepare("UPDATE events SET admin_state='enabled' WHERE id=? AND admin_state='paused'").run(id);
    else if (action === 'emergency_stop') db.prepare("UPDATE events SET admin_state='stopped' WHERE id=?").run(id);
    else throw bad('不明な操作です');
    audit(db, nowMs, role, 'event.' + action, id);
    return { ok: true, state: eventRow(db, id).admin_state };
  });
}

function retentionPreview(db, id, hours, nowMs) {
  const ev = eventRow(db, id);
  if (!Number.isSafeInteger(hours) || hours < 0) throw bad('保持時間は0以上の整数（時間）');
  const cur = S.purgeAt(ev); const nxt = iso(Date.parse(ev.ends_at) + hours * 3600000);
  const n = db.prepare('SELECT COUNT(*) c FROM participants WHERE event_id=?').get(id).c;
  const notes = [];
  if (ev.purged_at) notes.push('すでに削除済みです。保持時間を延ばしても削除済みデータは復元されません。');
  else if (Date.parse(nxt) <= nowMs) notes.push(`新しい削除予定日時（${nxt}）はすでに過ぎています。次回の削除ジョブで ${n} 人分の参加者データが削除されます。`);
  else notes.push(`削除予定: ${cur} → ${nxt}。対象は ${n} 人分です。`);
  notes.push('バックアップ・ログに参加者データを含めない構成であることが前提です（docs/OPERATIONS.md）。');
  return { current_purge_at: cur, new_purge_at: nxt, participants: n, already_purged: !!ev.purged_at, notes };
}
function setRetention(db, id, hours, confirm, nowMs, role) {
  const pv = retentionPreview(db, id, hours, nowMs);
  if (pv.already_purged) throw new HttpError(409, '削除済みの開催回の保持時間は変更できません（復元はされません）');
  if (!confirm) throw bad('影響を確認のうえ confirm を指定してください');
  db.prepare('UPDATE events SET retention_hours=? WHERE id=?').run(hours, id);
  audit(db, nowMs, role, 'event.retention', id, `${hours}h`);
  return { ok: true, ...pv };
}

function listEvents(db, nowMs) {
  return db.prepare('SELECT * FROM events ORDER BY starts_at DESC').all().map((ev) => {
    const st = S.eventStatus(db, ev, nowMs); const fp = S.fingerprint(db, ev);
    const ds = ev.dataset_id ? db.prepare('SELECT id,name,kind,status,content_hash FROM datasets WHERE id=?').get(ev.dataset_id) : null;
    return {
      id: ev.id, name: ev.name, join_code: ev.join_code, starts_at: ev.starts_at, ends_at: ev.ends_at, retention_hours: ev.retention_hours, purge_at: S.purgeAt(ev), purged_at: ev.purged_at,
      max_participants: ev.max_participants, participants: db.prepare('SELECT COUNT(*) c FROM participants WHERE event_id=?').get(ev.id).c,
      admin_state: ev.admin_state, created_by: ev.created_by || null, status: st, status_ja: S.STATUS_JA[st], dataset: ds, sim_start: ev.sim_start, sim_end: ev.sim_end, initial_cash: ev.initial_cash, monthly_deposit: ev.monthly_deposit, provisional: JSON.parse(ev.provisional_json),
      configuration: { env: cfg.ENV, app_version: cfg.APP_VERSION, calc_spec_version: cfg.CALC_SPEC_VERSION, code_hash: cfg.CODE_HASH, dataset_hash: ds?.content_hash || null, fingerprint: fp },
      verification: ev.verified_fingerprint ? { by: ev.verified_by, at: ev.verified_at, reference: ev.verification_ref, note: ev.verification_note, valid: ev.verified_fingerprint === fp } : null,
    };
  });
}

function listDatasets(db) {
  return db.prepare('SELECT id,name,kind,status,period_start,period_end,content_hash,created_at,locked_at,broker_basis_json,validation_json,version_label,source_checksum,counts_json FROM datasets ORDER BY created_at DESC').all().map((d) => ({
    ...d, broker_basis: JSON.parse(d.broker_basis_json), validation: JSON.parse(d.validation_json), counts: JSON.parse(d.counts_json || '{}'),
    sources: db.prepare('SELECT source_id,name,url,retrieved_at,license_status,license_note,adjustment FROM dataset_sources WHERE dataset_id=?').all(d.id),
    instruments: db.prepare('SELECT id,type,name,category FROM instruments WHERE dataset_id=?').all(d.id).length,
  }));
}
function setLicense(db, dsId, sourceId, status, note, nowMs, role) {
  const d = db.prepare('SELECT status FROM datasets WHERE id=?').get(dsId);
  if (!d) throw new HttpError(404, 'データセットが見つかりません');
  if (d.status === 'locked') throw new HttpError(409, '固定済みデータの許諾状態は変更できません。再取込してください');
  if (!['confirmed', 'unconfirmed'].includes(status)) throw bad('status は confirmed / unconfirmed');
  db.prepare('UPDATE dataset_sources SET license_status=?, license_note=? WHERE dataset_id=? AND source_id=?').run(status, note || null, dsId, sourceId);
  audit(db, nowMs, role, 'dataset.license', null, `${dsId}/${sourceId}=${status}`);
  return { ok: true };
}

// ---------- 削除 ----------
const PARTICIPANT_CHILD = ['holdings', 'orders', 'receivables', 'ledger', 'plans', 'snapshots', 'requests'];
function purgeEvent(db, eventId, kind, nowMs) {
  const prev = db.prepare("SELECT MAX(attempts) a FROM purge_log WHERE event_id=? AND status='failed'").get(eventId).a || 0;
  try {
    const rows = tx(db, () => {
      const accIds = db.prepare('SELECT id FROM accounts WHERE event_id=?').all(eventId).map((r) => r.id);
      let n = 0;
      for (const id of accIds) {
        for (const t of ['holdings', 'orders', 'receivables', 'ledger', 'plans', 'snapshots', 'requests']) n += Number(db.prepare(`DELETE FROM ${t} WHERE account_id=?`).run(id).changes);
        db.prepare('DELETE FROM plan_runs WHERE plan_id NOT IN (SELECT id FROM plans)').run();
      }
      n += Number(db.prepare('DELETE FROM accounts WHERE event_id=?').run(eventId).changes);
      n += Number(db.prepare('DELETE FROM participants WHERE event_id=?').run(eventId).changes);
      db.prepare('UPDATE events SET purged_at=? WHERE id=?').run(iso(nowMs), eventId);
      db.prepare("INSERT INTO purge_log(event_id,kind,status,attempts,rows_deleted,at) VALUES(?,?,'done',?,?,?)").run(eventId, kind, prev + 1, n, iso(nowMs));
      return n;
    });
    // 削除済み領域の残存を減らす（secure_delete=ON に加え、WAL を切り詰めてファイルを再構成）
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.exec('VACUUM'); } catch (e) { /* 失敗しても削除自体は完了済み。次回ジョブで再実行 */ }
    return { ok: true, rows };
  } catch (e) {
    db.prepare("INSERT INTO purge_log(event_id,kind,status,attempts,at,error) VALUES(?,?,'failed',?,?,?)").run(eventId, kind, prev + 1, iso(nowMs), String(e.message).slice(0, 200));
    return { ok: false, error: e.message };
  }
}
function runPurgeJob(db, nowMs) {
  const res = [];
  for (const ev of db.prepare('SELECT * FROM events WHERE purged_at IS NULL').all()) {
    if (nowMs >= Date.parse(S.purgeAt(ev))) res.push({ event: ev.id, ...purgeEvent(db, ev.id, 'scheduled', nowMs) });
  }
  return res;
}
function purgeNow(db, id, confirmName, nowMs, role) {
  const ev = eventRow(db, id);
  if (confirmName !== ev.name) throw bad('確認のため開催名を正確に入力してください（この操作は取り消せません）');
  db.prepare("UPDATE events SET admin_state='stopped' WHERE id=?").run(id); // 先に利用を止める
  audit(db, nowMs, role, 'event.purge_now', id);
  const r = purgeEvent(db, id, 'manual', nowMs);
  if (!r.ok) throw new HttpError(500, '削除に失敗しました。自動で再試行されます: ' + r.error);
  return r;
}
function purgeStatus(db) {
  return {
    log: db.prepare('SELECT * FROM purge_log ORDER BY id DESC LIMIT 50').all(),
    failing: db.prepare("SELECT id AS event_id FROM events e WHERE purged_at IS NULL AND (SELECT status FROM purge_log WHERE event_id=e.id ORDER BY id DESC LIMIT 1)='failed'").all().map((r) => r.event_id),
  };
}

module.exports = { previewDataset, createEvent, updateEvent, recordVerification, setState, retentionPreview, setRetention, listEvents, listDatasets, setLicense, importDataset, lockDataset, purgeEvent, runPurgeJob, purgeNow, purgeStatus, audit };
