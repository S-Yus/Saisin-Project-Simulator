'use strict';
const PUB = { url: '' }; const LIVE = ['open', 'not_started', 'paused']; let EVENTS = []; // 参加者が開く公開URL（サーバーの設定 PUBLIC_URL）
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// ログインはIDとパスワード。ログイン状態はサーバーが発行する HttpOnly の Cookie で保たれ、画面のスクリプトからは読めない（12時間で切れる）。
// 管理トークン（確認担当・復旧用）で入った場合は、メモリ上の変数にのみ保持する（再読み込みで再入力）
let memToken = null;
const tokStore = { get: () => memToken, set: (v) => { memToken = v || null; }, clear: () => { memToken = null; } };
let who = null;
async function api(method, path, body) {
  const res = await fetch('/admin-api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tokStore.get() ? { Authorization: 'Bearer ' + tokStore.get() } : {}) }, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const data = await res.json().catch(() => ({})); if (!res.ok) { const e = new Error(data.error || 'エラー'); e.status = res.status; if (res.status === 401 && who && path !== '/login' && path !== '/password') { who = null; tokStore.clear(); loginView('ログインが切れました。もう一度ログインしてください'); } throw e; } return data;
}
const fdt = (s) => (s ? new Date(s).toLocaleString('ja-JP') : '-');
const toast = (m, bad) => { const d = document.createElement('div'); d.className = 'msg ' + (bad ? 'err' : 'ok'); d.textContent = m; $('#app').prepend(d); setTimeout(() => d.remove(), 6000); };
async function login() {
  try { who = await api('GET', '/whoami'); } catch (e) { tokStore.clear(); return loginView(e.status === 429 ? e.message : ''); }
  if (who.env !== 'prod') { const b = $('#envbanner'); b.hidden = false; b.textContent = who.env === 'dev' ? '開発・検算環境（本番ではありません）' : '確認用環境（本番ではありません）'; }
  main();
}
function loginView(msg) {
  $('#app').innerHTML = `<div class="loginbox"><h1>管理画面</h1><p class="sub">説明会の作成・QRコードの表示・公開と停止を行う画面です。</p>${msg ? `<div class="msg err">${esc(msg)}</div>` : ''}
  <form id="lf" class="card" autocomplete="on"><label for="lid">ID</label><input id="lid" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required>
  <label for="lpw">パスワード</label><input id="lpw" name="password" type="password" autocomplete="current-password" required>
  <div class="btns"><button class="btn pri big" id="lgo" type="submit">ログイン</button></div><div id="lmsg"></div>
  <p class="fine">ログインは12時間で自動的に切れます。5回続けてまちがえると、そのIDは15分使えなくなります。参加者の口座は、この画面からは閲覧・操作できません。</p></form>
  <details class="adv"><summary>管理トークンで入る（確認担当・復旧用）</summary><label for="tk">管理トークン</label><input id="tk" type="password" autocomplete="off"><div class="btns"><button class="btn" id="go" type="button">トークンで入る</button></div><p class="fine">トークンはこの画面のメモリ上にだけ保持し、再読み込みすると再入力が必要です。</p></details></div>`;
  $('#lf').addEventListener('submit', async (e) => {
    e.preventDefault(); const b = $('#lgo'); b.disabled = true;
    try { await api('POST', '/login', { id: $('#lid').value, password: $('#lpw').value }); $('#lpw').value = ''; login(); }
    catch (err) { b.disabled = false; $('#lpw').value = ''; $('#lmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
  });
  const go = async () => { tokStore.set($('#tk').value); $('#tk').value = ''; try { who = await api('GET', '/whoami'); login(); } catch (err) { tokStore.clear(); loginView(err.status === 429 ? err.message : 'トークンが違います'); } };
  $('#go').onclick = go; $('#tk').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
async function main() {
  const [ev, ds, pg] = await Promise.all([api('GET', '/events'), api('GET', '/datasets'), api('GET', '/purge')]);
  PUB.url = ev.public_url || ''; EVENTS = ev.events;
  const op = who.role === 'operator'; const run = op || who.role === 'tester'; // run: 説明会を作成・操作できる
  $('#app').innerHTML = `<h1>管理画面 <span class="tag ${who.role === 'tester' ? 'prov' : 'acc'}">${esc(who.role_ja)}${who.user ? ' ' + esc(who.user) : ''}</span></h1><div class="sub">環境: <b>${esc({ prod: '本番', staging: '確認用環境', dev: '開発・検算' }[who.env] || who.env)}</b> ／ アプリ版 ${esc(who.app_version)} ／ サーバー時刻 ${fdt(who.server_now)} <button class="linkbtn" id="reload">最新の状態に更新</button> <button class="linkbtn" id="logout">ログアウト</button></div>
  ${pg.failing.length ? `<div class="msg err"><b>削除ジョブが失敗しています</b>（開催 ${pg.failing.map(esc).join(', ')}）。自動で再試行しますが、続く場合は対応してください。</div>` : ''}
  ${who.role === 'tester' ? '<div class="msg info">テスト用アカウントです。説明会の作成（定員50人・7日まで。名前の先頭に【テスト】が付きます）と、自分が作った説明会の操作だけができます。</div>' : ''}
  ${run ? quickForm(ds.datasets) : ''}
  <div class="sechead"><h2 class="sec">説明会の一覧</h2>${run && ev.events.some((e) => !LIVE.includes(e.status)) ? '<button class="linkbtn" id="del-done">終了・停止した説明会をまとめて削除</button>' : ''}</div>${ev.events.map((e) => eventCard(e, op, run)).join('') || '<div class="msg info">まだ説明会がありません。上の「説明会をはじめる」から作成してください。</div>'}
  ${who.role === 'tester' ? '' : `<h2 class="sec">くわしい設定</h2>
  ${op ? `<details class="adv"><summary>日時・期間・金額を指定して作成する</summary>${createForm(ds.datasets)}</details>` : ''}
  <details class="adv"><summary>市場データ（${ds.datasets.length}件）</summary>${ds.datasets.map(dsCard).join('') || '<div class="msg warn">データ未設定です。下から取り込んでください（入力仕様: docs/DATA_INPUT.md）。</div>'}${op ? importForm() : ''}</details>
  <details class="adv"><summary>削除記録（参加者情報を含みません）</summary><div class="card"><table><tr><th>日時</th><th>開催</th><th>種別</th><th>結果</th><th class="n">試行</th><th class="n">件数</th></tr>${pg.log.map((l) => `<tr><td>${fdt(l.at)}</td><td>${esc(l.event_id)}</td><td>${esc(l.kind)}</td><td>${l.status === 'done' ? '完了' : '<b>失敗</b> ' + esc(l.error || '')}</td><td class="n">${l.attempts}</td><td class="n">${l.rows_deleted ?? '-'}</td></tr>`).join('')}</table></div></details>
  <details class="adv"><summary>確認対象の構成</summary><div class="card"><pre>計算仕様版: ${esc(who.calc_spec_version)}\n実行コード: ${esc(who.code_hash)}\nNode: ${esc(who.node)}</pre></div></details>`}
  ${who.via === 'session' ? `<details class="adv"><summary>パスワードを変更する</summary><label for="pw-c">現在のパスワード</label><input id="pw-c" type="password" autocomplete="current-password"><label for="pw-n">新しいパスワード（10文字以上）</label><input id="pw-n" type="password" autocomplete="new-password"><div class="btns"><button class="btn" id="pw-go">変更する</button></div><div id="pw-msg"></div></details>` : ''}`;
  $('#reload').onclick = () => main();
  $('#del-done')?.addEventListener('click', async () => {
    const list = EVENTS.filter((e) => !LIVE.includes(e.status)); if (!list.length) return;
    if (!confirm(`終了・停止した説明会 ${list.length} 件を削除します（開催中・開始前・一時停止中のものは残ります）。参加者のデータも消え、取り消せません。`)) return;
    let ok = 0; for (const e of list) { try { await api('DELETE', `/events/${e.id}`); ok++; } catch (err) { toast(`「${e.name}」: ${err.message}`, true); } }
    await main(); toast(`${ok} 件を削除しました`);
  });
  $('#logout').onclick = async () => { try { await api('POST', '/logout'); } catch { /* 切れていても画面は戻す */ } tokStore.clear(); who = null; loginView(); };
  $('#pw-go')?.addEventListener('click', async () => {
    try { await api('POST', '/password', { current: $('#pw-c').value, new: $('#pw-n').value }); $('#pw-c').value = ''; $('#pw-n').value = ''; $('#pw-msg').innerHTML = '<div class="msg ok">パスワードを変更しました。ほかの端末でのログインは無効になりました。</div>'; }
    catch (e) { $('#pw-msg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  });
  wire();
}
function eventCard(e, op, run) {
  const c = e.configuration; const v = e.verification;
  const joinUrl = `${PUB.url || location.origin}/?code=${e.join_code}`;
  const localOnly = !PUB.url && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const live = !e.purged_at && LIVE.includes(e.status);
  const B = (act, label, cls = '') => `<button class="btn ${cls}" data-act="${act}">${label}</button>`;
  const acts = e.purged_at || !run ? '' : e.admin_state === 'draft' ? B('enable', '公開する', 'pri') : e.admin_state === 'enabled' ? B('pause', '一時停止') + B('emergency_stop', '終了する（緊急停止）', 'danger') : e.admin_state === 'paused' ? B('resume', '再開する', 'pri') + B('emergency_stop', '終了する（緊急停止）', 'danger') : '';
  return `<div class="card evcard" data-ev="${esc(e.id)}"><h3 style="margin-top:0">${esc(e.name)} <span class="tag ${e.status === 'open' ? 'acc' : 'prov'}">${esc(e.status_ja)}</span></h3>
  <div class="evmeta"><b>参加 ${e.participants} / ${e.max_participants}人</b><span>${fdt(e.starts_at)} 〜 ${fdt(e.ends_at)}</span></div>
  ${live ? `${localOnly ? '<div class="msg warn">公開URL（環境変数 PUBLIC_URL）が未設定です。このQRコードはこのPCからしか開けません。</div>' : ''}<div class="sub joinurl">参加URL: <code>${esc(joinUrl)}</code></div>` : ''}
  <div class="btns">${live ? `<button class="btn pri" data-qrbig="${esc(joinUrl)}" data-qrname="${esc(e.name)}" data-qrid="${esc(e.id)}">QRコードを表示</button>` : ''}${acts}${run ? `<button class="btn quiet del" data-act="delete" data-name="${esc(e.name)}" data-n="${e.participants}" data-live="${live ? 1 : 0}">削除</button>` : ''}</div>
  ${who.role === 'tester' ? '' : `<details class="more"><summary>くわしく（設定・動作確認・削除）</summary>
  <div class="sub">操作状態 ${esc(e.admin_state)}</div>
  <div class="sub">削除予定: <b>${e.purged_at ? '削除済み ' + fdt(e.purged_at) : fdt(e.purge_at)}</b>（終了後 ${e.retention_hours} 時間）</div>
  <div class="sub">データ: ${e.dataset ? esc(e.dataset.name) + '（' + esc(e.dataset.kind) + '）' : '<b>データ未設定</b>'} ／ 期間 ${esc(e.sim_start || '-')}〜${esc(e.sim_end || '-')} ／ 初期資金 ${e.initial_cash.toLocaleString('ja-JP')}円 ／ 毎月 ${e.monthly_deposit.toLocaleString('ja-JP')}円 <span class="tag prov">${Object.values(e.provisional).some(Boolean) ? '仮設定あり' : '仮設定なし'}</span></div>
  <details><summary>確認対象の構成（動作確認の単位）</summary><pre>環境: ${esc(c.env)}\nアプリ版: ${esc(c.app_version)}\n計算仕様版: ${esc(c.calc_spec_version)}\n実行コード: ${esc(c.code_hash)}\nデータ版(ハッシュ): ${esc(c.dataset_hash || '未固定')}\n構成指紋: ${esc(c.fingerprint || '未確定')}</pre><div class="sub">確認用環境と本番で構成指紋が一致すれば、同じコード・データ・設定です。</div></details>
  <details><summary>仮設定の状態（本番・確認用環境では全項目の確定が公開の条件）</summary>${Object.entries(e.provisional).map(([k, v]) => `<label style="font-weight:400"><input type="checkbox" style="width:auto;min-height:0" data-prov="${esc(k)}" ${v ? 'checked' : ''} ${op && !e.participants ? '' : 'disabled'}> ${esc({ initial_cash: '初期資金', monthly_deposit: '毎月の追加資金', max_participants: '最大参加人数', period: 'シミュレーション期間', schedule: '開催日時' }[k] || k)} は仮設定</label>`).join('')}${op && !e.participants ? '<div class="btns"><button class="btn" data-act="prov">仮設定の状態を保存（動作確認は解除されます）</button></div>' : ''}</details>
  <div>動作確認: ${v ? (v.valid ? `<span class="tag fill">確認済み</span> ${esc(v.by)} / ${fdt(v.at)} / 記録番号 ${esc(v.reference)}` : '<span class="tag lap">解除（構成が変更されました）</span>') : '<span class="tag lap">未確認</span>'}</div>
  <div class="sub">金庫による確認は自動テストでは代替できません。確認担当が、確認記録の番号とともに入力してください。</div>
  ${who.role === 'verifier' && c.fingerprint && !e.purged_at ? `<div class="row"><input data-f="vby" placeholder="確認者名"><input data-f="vref" placeholder="確認記録の識別番号"><input data-f="vnote" placeholder="備考（任意）"></div><div class="btns"><button class="btn pri" data-act="verify" data-fp="${esc(c.fingerprint)}">この構成の確認完了を記録</button></div>` : ''}
  ${op && !e.purged_at ? `  <details><summary>保持時間・削除</summary><div class="row"><input data-f="hours" type="number" min="0" value="${e.retention_hours}"><button class="btn" data-act="rprev">影響を確認</button></div><div data-f="rmsg"></div><div class="row"><input data-f="pname" placeholder="即時削除: 開催名を入力"><button class="btn danger" data-act="purge">参加者データを今すぐ削除</button></div></details>` : ''}
  </details>`}</div>`;
}
// かんたん作成: 名前・長さ・定員だけ決めて、作成→公開→QR表示まで行う（データは固定済みの最新のもの、期間はその全体）
function quickForm(dsl) {
  const d = dsl.find((x) => x.status === 'locked');
  if (!d) return '<div class="card quick"><h2 class="sec" style="margin-top:0">説明会をはじめる</h2><div class="msg warn">固定済みの市場データがありません。「くわしい設定 › 市場データ」で取り込み、固定してください。</div></div>';
  const today = new Date().toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
  return `<div class="card quick"><h2 class="sec" style="margin-top:0">説明会をはじめる</h2>
  <ol class="steps3"><li>下の3つを決めて「作成してQRコードを表示」を押す</li><li>表示されたQRコードを会場に映す（印刷もできます）</li><li>参加者がスマートフォンで読み取ると、すぐに始まります</li></ol>
  <div class="row"><div><label for="q-name">説明会の名前</label><input id="q-name" maxlength="80" value="NISA説明会 ${esc(today)}"></div>
  <div><label for="q-len">使える時間（いまから）</label><select id="q-len"><option value="2">2時間</option><option value="4">4時間</option><option value="24">1日</option><option value="168">7日</option>${who.role === 'tester' ? '' : '<option value="720">30日</option>'}</select></div>
  <div><label for="q-max">定員（人）</label><input id="q-max" type="number" min="1" max="${who.role === 'tester' ? 50 : 5000}" value="50"></div></div>
  <div class="sub">データ: ${esc(d.name)}（${esc(d.period_start)}〜${esc(d.period_end)}）／ 参加者が金額を選ばなかったときの既定は、最初100万円・毎月3万円 ／ 参加データは終了の24時間後に自動で削除</div>
  <div class="btns"><button class="btn pri big" id="q-go" data-ds="${esc(d.id)}" data-ss="${esc(d.period_start)}" data-se="${esc(d.period_end)}">作成してQRコードを表示</button></div><div id="q-msg"></div></div>`;
}
function createForm(dsl) {
  const locked = dsl.filter((d) => d.status === 'locked');
  return `<h3>開催回の作成</h3><div class="card"><div class="row"><div><label>開催名</label><input id="n-name"></div><div><label>最大参加人数</label><input id="n-max" type="number" value="100"></div></div>
  <div class="row"><div><label>開始日時</label><input id="n-s" type="datetime-local"></div><div><label>終了日時</label><input id="n-e" type="datetime-local"></div></div>
  <div class="row"><div><label>データ</label><select id="n-ds"><option value="">（データ未設定）</option>${locked.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} [${esc(d.kind)}]</option>`).join('')}</select></div><div><label>シミュレーション期間（開始日 / 終了日: YYYY-MM-DD）</label><div class="row"><input id="n-ss" placeholder="開始日"><input id="n-se" placeholder="終了日"></div></div></div>
  <div class="row"><div><label>初期資金（円・仮設定）</label><input id="n-cash" type="number" value="1000000"></div><div><label>毎月の追加資金（円・仮設定）</label><input id="n-dep" type="number" value="30000"></div></div>
  <div class="btns"><button class="btn pri" id="n-go">作成</button></div><div class="sub">保持時間の初期値は終了後24時間です。作成後に変更できます。</div></div>`;
}
function dsCard(d) {
  return `<div class="card"><b>${esc(d.name)}</b> <span class="tag">${esc(d.kind)}</span> <span class="tag ${d.status === 'locked' ? 'fill' : 'prov'}">${d.status === 'locked' ? '固定済み' : '下書き'}</span>
  <div class="sub">データ版 ${esc(d.version_label || '（未記入）')} ／ 期間 ${esc(d.period_start)}〜${esc(d.period_end)} ／ 商品 ${d.instruments}件 ／ 営業日 ${d.counts.calendar_days ?? '-'} ／ 価格行 ${d.counts.price_rows ?? '-'} ／ 権利 ${d.counts.actions ?? '-'} ／ ニュース ${d.counts.news ?? '-'}</div><div class="sub">取込ファイルのチェックサム ${esc((d.source_checksum || '-').slice(0, 16))}… ／ 固定後のハッシュ ${esc((d.content_hash || '未固定').slice(0, 16))}…</div>
  <div class="sub">基準とする証券会社・販売会社: ${esc(d.broker_basis.name)}（${d.broker_basis.status === 'confirmed' ? '確認済み' : '<b>未確定</b>'}）</div>
  <table><tr><th>出典</th><th>取得日</th><th>調整方法</th><th>利用許諾</th></tr>${d.sources.map((s) => `<tr><td>${esc(s.name)}${s.url ? '<br><span class="sub">' + esc(s.url) + '</span>' : ''}</td><td>${esc(s.retrieved_at)}</td><td>${esc(s.adjustment)}</td><td>${s.license_status === 'confirmed' ? '確認済み' : '<b>未確認</b>'}${d.status === 'draft' && who.role === 'operator' ? ` <button class="linkbtn" data-lic="${esc(d.id)}|${esc(s.source_id)}|${s.license_status === 'confirmed' ? 'unconfirmed' : 'confirmed'}">${s.license_status === 'confirmed' ? '未確認に戻す' : '確認済みにする'}</button>` : ''}</td></tr>`).join('')}</table>
  ${(d.validation.warnings || []).length ? `<details><summary>警告 ${d.validation.warnings.length}件</summary><ul>${d.validation.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
  ${d.status === 'draft' && who.role === 'operator' ? `<div class="btns"><button class="btn pri" data-lock="${esc(d.id)}">データを固定する（以後変更不可）</button></div><div class="sub">固定には、全出典の利用許諾確認・商品条件の確定・基準証券会社の確定が必要です（本番データ）。</div>` : ''}</div>`;
}
function importForm() {
  return `<h3>市場データの取込</h3><div class="card"><div class="sub">JSON の形式は docs/DATA_INPUT.md を参照。取込は検証のみで、固定するまで開催には使えません。架空データで欠損を補うことはしません。</div><input type="file" id="i-file" accept=".json,application/json"><textarea id="i-text" placeholder="または JSON を貼り付け"></textarea><div class="btns"><button class="btn pri" id="i-pv">① 検証（保存しない）</button><button class="btn" id="i-go" disabled>② 取り込む（下書き）</button></div><div id="i-res"></div></div>`;
}
function wire() {
  $('#q-go')?.addEventListener('click', async (ev0) => {
    const b = ev0.currentTarget; b.disabled = true; let id = null;
    try {
      const now = Date.now(); const hours = Number($('#q-len').value);
      const r = await api('POST', '/events', { name: $('#q-name').value.trim(), max_participants: Number($('#q-max').value), starts_at: new Date(now).toISOString(), ends_at: new Date(now + hours * 3600000).toISOString(), initial_cash: 1000000, monthly_deposit: 30000, dataset_id: b.dataset.ds, sim_start: b.dataset.ss, sim_end: b.dataset.se });
      id = r.id; await api('POST', `/events/${id}/enable`);
      await main(); document.querySelector(`[data-qrid="${id}"]`)?.click();
    } catch (e) { b.disabled = false; if (id) await main(); toast(id ? '作成しましたが、公開できませんでした: ' + e.message : e.message, true); }
  });
  $('#n-go')?.addEventListener('click', async () => {
    try {
      const b = { name: $('#n-name').value, max_participants: Number($('#n-max').value), starts_at: new Date($('#n-s').value).toISOString(), ends_at: new Date($('#n-e').value).toISOString(), initial_cash: Number($('#n-cash').value), monthly_deposit: Number($('#n-dep').value), dataset_id: $('#n-ds').value || null, sim_start: $('#n-ss').value || null, sim_end: $('#n-se').value || null };
      await api('POST', '/events', b); toast('開催回を作成しました'); main();
    } catch (e) { toast(e.message, true); }
  });
  $('#i-file')?.addEventListener('change', async (e) => { $('#i-text').value = await e.target.files[0].text(); });
  const parseIn = () => { try { return JSON.parse($('#i-text').value); } catch (e) { $('#i-res').innerHTML = '<div class="msg err">JSON として読み込めません: ' + esc(e.message) + '</div>'; return null; } };
  $('#i-text')?.addEventListener('input', () => { $('#i-go').disabled = true; });
  $('#i-pv')?.addEventListener('click', async () => {
    const body = parseIn(); if (!body) return;
    try {
      const r = await api('POST', '/datasets/preview', body); const sm = r.summary;
      $('#i-res').innerHTML = `${r.ok ? '<div class="msg ok">検証に合格しました（まだ保存していません）</div>' : `<div class="msg err"><b>エラー ${r.errors.length}件（取り込めません）</b><ul>${r.errors.slice(0, 100).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`}
      ${sm ? `<table><tr><th>種別</th><td>${esc(sm.kind)}</td></tr><tr><th>データ版</th><td>${esc(sm.version || '-')}</td></tr><tr><th>対象期間</th><td>${esc(sm.period.join(' 〜 '))}</td></tr><tr><th>価格の範囲</th><td>${esc(sm.calendar ? sm.calendar.join(' 〜 ') : '-')}</td></tr><tr><th>件数</th><td>商品 ${sm.counts.instruments} ／ 営業日 ${sm.counts.calendar_days} ／ 価格行 ${sm.counts.price_rows} ／ 権利 ${sm.counts.actions} ／ ニュース ${sm.counts.news}</td></tr><tr><th>チェックサム</th><td><code>${esc(sm.checksum)}</code></td></tr></table>
      <table><tr><th>商品</th><th>種類</th><th class="n">価格行</th><th>条件</th></tr>${sm.instruments.map((i) => `<tr><td>${esc(i.id)} ${esc(i.name)}</td><td>${esc(i.type)}</td><td class="n">${i.rows}</td><td>${i.terms_status === 'confirmed' ? '確定' : '<b>仮設定</b>'}</td></tr>`).join('')}</table>` : ''}
      ${r.warnings.length ? `<details open><summary>警告 ${r.warnings.length}件</summary><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}`;
      $('#i-go').disabled = !r.ok;
    } catch (e) { $('#i-res').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  });
  $('#i-go')?.addEventListener('click', async () => {
    const body = parseIn(); if (!body) return; $('#i-go').disabled = true;
    try { const r = await api('POST', '/datasets/import', body); $('#i-res').innerHTML = r.ok ? `<div class="msg ok">取り込みました（下書き）。警告 ${r.warnings.length} 件</div>${r.warnings.length ? '<ul>' + r.warnings.map((w) => `<li>${esc(w)}</li>`).join('') + '</ul>' : ''}` : `<div class="msg err"><b>取り込めません（${r.errors.length}件）</b><ul>${r.errors.slice(0, 50).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`; if (r.ok) setTimeout(main, 1500); } catch (e) { $('#i-res').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  });
  document.querySelectorAll('[data-lock]').forEach((b) => b.addEventListener('click', async () => { if (!confirm('データを固定します。以後、内容は変更できません。よろしいですか？')) return; const r = await api('POST', `/datasets/${b.dataset.lock}/lock`, {}); if (r.ok) { toast('固定しました'); main(); } else toast(r.errors.join(' / '), true); }));
  document.querySelectorAll('[data-lic]').forEach((b) => b.addEventListener('click', async () => { const [d, s, st] = b.dataset.lic.split('|'); const note = st === 'confirmed' ? prompt('許諾の確認内容（契約書・規約の名称、確認日など）') : ''; if (st === 'confirmed' && !note) return; try { await api('POST', `/datasets/${d}/license`, { source_id: s, status: st, note }); main(); } catch (e) { toast(e.message, true); } }));
  document.querySelectorAll('[data-qrbig]').forEach((b) => b.addEventListener('click', () => {
    const url = b.dataset.qrbig, id = b.dataset.qrid; let svg = '';
    try { const q = qrcode(0, 'M'); q.addData(url); q.make(); svg = q.createSvgTag({ cellSize: 8, margin: 4, scalable: true }); } catch { svg = '<p>QRを生成できませんでした。URLを使ってください。</p>'; }
    document.getElementById('qrbig')?.remove();
    const o = document.createElement('div'); o.id = 'qrbig';
    o.innerHTML = `<div class="qb-in"><div class="qb-t">${esc(b.dataset.qrname)}</div><div class="qb-h">スマートフォンのカメラで読み取ってください</div><div class="qb-q">${svg}</div><div class="qb-u">${esc(url)}</div><div class="qb-n noprint" id="qb-n"></div><div class="btns noprint"><button class="btn" id="qb-print">印刷</button><button class="btn pri" id="qb-x">閉じる</button></div></div>`;
    document.body.appendChild(o); document.body.classList.add('qrmode');
    // 参加人数を5秒ごとに更新（表示している間だけ）
    const tick = async () => { try { const r = await api('GET', '/events'); const e = r.events.find((x) => x.id === id); if (e && document.getElementById('qb-n')) document.getElementById('qb-n').textContent = `いま参加 ${e.participants} / ${e.max_participants}人（${e.status_ja}）`; } catch { /* 次の周期で再試行 */ } };
    tick(); const timer = setInterval(tick, 5000);
    const close = () => { clearInterval(timer); o.remove(); document.body.classList.remove('qrmode'); main(); };
    o.querySelector('#qb-x').onclick = close; o.querySelector('#qb-print').onclick = () => window.print();
  }));
  document.querySelectorAll('[data-qr]').forEach((el) => { try { const q = qrcode(0, 'M'); q.addData(el.dataset.qr); q.make(); el.innerHTML = q.createSvgTag({ cellSize: 5, margin: 4, scalable: true }); el.firstChild.style.maxWidth = '220px'; el.firstChild.style.background = '#fff'; } catch { el.textContent = 'QRを生成できませんでした。URLを使ってください。'; } });
  document.querySelectorAll('[data-ev]').forEach((card) => {
    const id = card.dataset.ev; const f = (n) => card.querySelector(`[data-f="${n}"]`);
    card.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
      const a = b.dataset.act;
      try {
        if (a === 'prov') { const prov = {}; card.querySelectorAll('[data-prov]').forEach((c) => { prov[c.dataset.prov] = c.checked; }); if (!confirm('仮設定の状態を保存します。動作確認の記録は解除され、再確認が必要です。')) return; await api('PATCH', `/events/${id}`, { provisional: prov }); toast('保存しました（動作確認は解除されました）'); }
        else if (a === 'verify') { await api('POST', `/events/${id}/verify`, { verified_by: f('vby').value, reference: f('vref').value, note: f('vnote').value, fingerprint: b.dataset.fp }); toast('確認記録を保存しました'); }
        else if (a === 'rprev') {
          const r = await api('POST', `/events/${id}/retention-preview`, { hours: Number(f('hours').value) });
          f('rmsg').innerHTML = `<div class="msg warn">${r.notes.map(esc).join('<br>')}<br>現在の削除予定 ${fdt(r.current_purge_at)} → 変更後 ${fdt(r.new_purge_at)}（対象 ${r.participants} 人）</div><button class="btn pri">この保持時間に変更する</button>`;
          f('rmsg').querySelector('button').onclick = async () => { try { await api('POST', `/events/${id}/retention`, { hours: Number(f('hours').value), confirm: true }); toast('保持時間を変更しました'); main(); } catch (e) { toast(e.message, true); } };
          return;
        } else if (a === 'purge') { if (!confirm('参加者データを今すぐ削除します。取り消せません。')) return; await api('POST', `/events/${id}/purge`, { confirm_name: f('pname').value }); toast('削除しました'); }
        else if (a === 'delete') { if (!confirm(`「${b.dataset.name}」を削除します。${b.dataset.live === '1' ? '開催中の説明会です。参加者は直ちに使えなくなります。' : ''}${Number(b.dataset.n) ? `参加者 ${b.dataset.n} 人のデータも消えます。` : ''}取り消せません。`)) return; await api('DELETE', `/events/${id}`); toast('削除しました'); }
        else if (a === 'emergency_stop') { if (!confirm('緊急停止します。参加者は直ちに利用できなくなります。')) return; await api('POST', `/events/${id}/emergency_stop`); toast('緊急停止しました'); }
        else { await api('POST', `/events/${id}/${a}`); toast('実行しました'); }
        main();
      } catch (e) { toast(e.message, true); }
    }));
  });
}
login();
