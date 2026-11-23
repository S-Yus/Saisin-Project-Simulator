'use strict';
// 参加者画面。計算は一切行わず、サーバーの結果を表示するだけ。残高・日付を送信しない（expected_sim_date のみ送る）。
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yen = (n) => (n == null ? '-' : Number(n).toLocaleString('ja-JP') + '円');
const signYen = (n) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n).toLocaleString('ja-JP') + '円';
const plLabel = (n) => `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${n > 0 ? '▲ 利益 ' : n < 0 ? '▼ 損失 ' : '― 損益なし '}${signYen(n)}</span>`;
const milli = (m) => (m == null ? '-' : (m / 1000).toLocaleString('ja-JP', { maximumFractionDigits: 3 }));
const jdate = (d) => (d ? `${d.slice(0, 4)}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日` : '-');
const TOKEN_KEY = 'nisa_sim_token';
const store = { get: () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }, set: (v) => { try { localStorage.setItem(TOKEN_KEY, v); } catch { /* 保存できない環境では毎回参加し直し */ } }, clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* noop */ } } };
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

const DISC = [
  '本シミュレーションのいかなる内容も将来の結果を予測し保証するものではありません',
  '本シミュレーションを利用することで生じるいかなる損害についても当金庫が責任を負うものではありません。実際の資産運用や投資判断に当たっては、必ずご自身の責任において最終判断してください。',
  '本シミュレーションは特定の金融商品の取引を推奨し、勧誘するものではありません。',
];
const discHtml = () => `<div>${DISC.map((t) => `<p class="disc">${esc(t)}</p>`).join('')}
<p class="disc">過去の実績は将来の成果を保証するものではありません。</p>
<p class="disc">このシミュレーターは<b>過去の実データに基づく取引体験</b>です。将来の価格や運用成果の予測・生成は行いません。画面の日付より後の情報を表示しないのは、過去を順番に体験するための制御で、将来を予測しているわけではありません。データの最終日より先には進めません。</p>
<p class="disc">NISA対象の商品を扱いますが、NISA口座の制度（非課税枠・年間投資枠・枠の復活・税務処理）は再現していません。取引条件（手数料・単位・締切・受渡など）は現在の条件を過去の期間に当てはめた簡略なもので、当時の取引条件を完全に再現したものではありません。</p>
<p class="disc"><b>再現していない取引要素:</b> 板・流動性・注文待ち順位・スリッページ、指値・日中売買・信用取引・空売り、NISA口座の非課税枠や制度計算、税金（損益はすべて<b>税引前</b>）、分配金の再投資、株式の積立（累積投資）。<b>初版の制限:</b> 受渡前に買った株式・口数の売却と、受渡前の売却代金での購入はできません（実際の口座では可能な場合があります）。実際の取引の約定価格・費用・日程とは異なる場合があります。</p></div>`;
const TERMS = {
  simdate: ['シミュレーション上の日付', '過去の市場データ上の日付です。実際の今日の日付や説明会の時刻とは別です。参加者ごとに、ボタンで進めます。'],
  market: ['成行注文（なりゆきちゅうもん）', '値段を指定せず、市場の価格で売買する注文です。このシミュレーターでは、日付の終わりに注文し、次の営業日の始値（寄付き）で約定します。注文時点では価格が分かりません。'],
  fill: ['約定（やくじょう）', '注文が成立して売買が決まることです。'],
  settle: ['受渡（うけわたし）', '約定の数日後に、代金と株式・口数のやり取りが実際に行われることです。買った株式・口数は受渡日まで売れず、買付代金は受渡日に現金から支払います。売却代金は受渡日まで「未受渡」で、新しい購入には使えません（どちらも総資産には反映済みです）。'],
  buying: ['買付可能額', '新しい注文に使える金額です。現金残高から、受付中の注文のために確保している金額と、受渡日を待っている買付代金を差し引いたものです。売却代金は受渡日に現金になるまで含みません。'],
  lot: ['売買単位（単元株）', '株式・ETFは決められた数量（例: 100株）の倍数で買います。'],
  nav: ['基準価額', '投資信託の1万口あたりの値段です。毎営業日に1回決まり、注文時点では分かりません。'],
  holdback: ['信託財産留保額', '投資信託を売るときに差し引かれる費用の一種です（商品によってはゼロ）。'],
  dist: ['配当・分配金', '保有している株式・投資信託から受け取るお金です。このシミュレーターでは税引前の金額で、支払日に入金します。'],
  plan: ['積立', '毎月決まった金額で投資信託を買う仕組みです。このシミュレーターでは投資信託のみ対応です。'],
  reserve: ['確保額', '株式・ETFの成行買いでは、翌日に値上がりしても買えるよう、注文日の終値に余裕（基準とする証券会社の条件で設定）を加えた金額を注文中に確保します。始値がその範囲を超えたら成立せず失効し、確保は戻ります。成立後は実際の代金だけが受渡日まで拘束されます。'],
  pretax: ['税引前', '税金を引く前の金額です。このシミュレーターでは税金を計算しません。'],
};
// 確認用環境: さいしんの動作確認のための環境。未確定のまま動いている項目を常に表示する
const reviewBanner = (d) => '確認用環境（動作確認用）。本番ではありません' + (d && d.pending && d.pending.length ? '。未確定: ' + d.pending.join('・') : '');
const devBanner = (d) => (d && d.kind === 'production' ? '開発・検算環境（実データ・利用許諾は未確認）。検算専用で、参加者への提供はできません' : '開発・検算環境（架空の開発用テストデータ）。本番ではありません');
// 対象期間と「過去の実データ」の明示（架空データの開発環境ではその旨を表示）
const periodLine = (d) => { const p = d && d.period ? `対象期間 ${jdate(d.period.start)} 〜 ${jdate(d.period.end)}` : '対象期間は未設定'; return d && d.kind === 'dev_test' ? `<b>開発用の架空データ</b>（${p}）。実際の市場データではありません。` : `<b>過去の実データに基づく取引体験</b>です（${p}）。将来の値動きを予測するものではありません。`; };
let S = { me: null, offset: 0, auto: false, autoTimer: null, last: [], stop: null, ended: false, busy: false };

// ---------- 通信 ----------
async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' }; const t = store.get(); if (t) headers.Authorization = 'Bearer ' + t;
  let res; try { res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }); } catch (e) { const err = new Error('通信できませんでした'); err.unknown = true; throw err; }
  let data = null; try { data = await res.json(); } catch { /* noop */ }
  if (res.status === 410 || (res.status === 401 && t)) { showEnded(data?.error || 'この説明会は終了しました'); const err = new Error(data?.error || '終了'); err.ended = true; throw err; }
  if (!res.ok) { const err = new Error(data?.error || 'エラーが発生しました'); err.status = res.status; err.data = data; throw err; }
  return data;
}
function showEnded(msg) {
  S.ended = true; stopAuto(); store.clear();
  $('#top').hidden = true; $('#tabs').hidden = true; $('#statusbar').hidden = true;
  $('#view').innerHTML = `<h1>この説明会の利用は終了しました</h1><div class="msg warn">${esc(msg)}</div><p>新しい操作・参加はできません。画面や端末に残った表示は、サーバー側からは消去できません。</p>${discHtml()}`;
}
function toast(t) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; $('#toasts').append(d); setTimeout(() => d.remove(), 5000); }
function modal(html) { $('#dlgbody').innerHTML = html; const d = $('#dlg'); if (!d.open) d.showModal(); }
document.addEventListener('click', (e) => {
  const q = e.target.closest('[data-term]'); if (q) { const t = TERMS[q.dataset.term]; modal(`<h2>${esc(t[0])}</h2><p>${esc(t[1])}</p>`); }
});
$('#btn-notice').addEventListener('click', () => modal('<h2>ご利用上の注意</h2>' + discHtml()));
const Q = (k) => `<button class="q" data-term="${k}" aria-label="${esc(TERMS[k][0])}の説明">?</button>`;

// ---------- 状態 ----------
async function refresh() {
  S.me = await api('GET', '/api/me'); S.offset = Date.parse(S.me.server_now) - Date.now(); renderHeader(); return S.me;
}
function renderHeader() {
  const m = S.me; $('#top').hidden = false; $('#tabs').hidden = false;
  $('#simdate').textContent = jdate(m.account.sim_date);
  const end = new Date(m.event.ends_at); $('#realend').textContent = end.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const eb = $('#envbanner'); if (m.event.env === 'dev') { eb.hidden = false; eb.textContent = devBanner(m.event.data); } else if (m.event.env === 'staging') { eb.hidden = false; eb.textContent = reviewBanner(m.event.data); }
  const sb = $('#statusbar');
  if (m.event.status === 'paused') { sb.hidden = false; sb.textContent = '管理者により一時停止中です。再開まで操作できません。'; }
  else if (m.account.status === 'saved') { sb.hidden = false; sb.textContent = `これは ${m.account.attempt} 回目の記録です（閲覧専用）。`; } else sb.hidden = true;
}
const locked = () => S.me.event.status === 'paused' || S.me.account.status !== 'active';

// ---------- ルーター ----------
const routes = { home: viewHome, market: viewMarket, i: viewInstrument, orders: viewOrders, history: viewHistory, compare: viewCompare, news: viewNews, more: viewMore };
async function route() {
  if (S.ended) return;
  const params = new URLSearchParams(location.search);
  const h = location.hash.replace(/^#\/?/, '') || ''; const [name, arg] = h.split('/');
  if (!store.get()) return viewStart(params.get('code'));
  try {
    await refresh();
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.t === (name === 'i' ? 'market' : name === 'compare' || name === 'news' ? (name === 'compare' ? 'history' : 'home') : name || 'home')));
    await (routes[name] || viewHome)(decodeURIComponent(arg || ''));
    $('#view').focus({ preventScroll: true });
  } catch (e) { if (!e.ended) $('#view').innerHTML = `<div class="msg err">${esc(e.message)}${e.unknown ? '<br>通信を確認して、画面を更新してください。' : ''}</div>`; }
}
window.addEventListener('hashchange', route);
['visibilitychange', 'pageshow', 'focus', 'online'].forEach((ev) => window.addEventListener(ev, () => { if (!document.hidden && store.get() && !S.ended && !S.auto) refreshQuiet(); }));
async function refreshQuiet() { try { await refresh(); } catch { /* 通信断は次回に再確認 */ } }
setInterval(() => { if (store.get() && !S.ended && !document.hidden && !S.auto) refreshQuiet(); }, 30000); // 期限・一時停止を定期的に再確認

// ---------- 開始画面 ----------
async function viewStart(code) {
  $('#top').hidden = true; $('#tabs').hidden = true; $('#statusbar').hidden = true;
  const v = $('#view'); if (!code) { v.innerHTML = `<h1>資産形成シミュレーター</h1><div class="msg warn">会場のQRコードから開いてください。参加用の情報がありません。</div>${discHtml()}`; return; }
  let ev; try { ev = await api('GET', '/api/event?code=' + encodeURIComponent(code)); } catch (e) { v.innerHTML = `<h1>資産形成シミュレーター</h1><div class="msg err">${esc(e.message)}</div>`; return; }
  if (ev.env === 'dev' || ev.env === 'staging') { const eb = $('#envbanner'); eb.hidden = false; eb.textContent = ev.env === 'dev' ? devBanner(ev.data) : reviewBanner(ev.data); }
  v.innerHTML = `<h1>${esc(ev.name)}</h1>
  <div class="card"><p>投資対象を自分で選び、購入・売却・積立を試せるシミュレーターです。氏名・メールアドレスなどは入力不要で、実際のお金・口座には接続しません。</p>
  <div class="msg info">${periodLine(ev.data)}</div>
  <p class="sub">開催時間: ${esc(new Date(ev.starts_at).toLocaleString('ja-JP'))} 〜 ${esc(new Date(ev.ends_at).toLocaleString('ja-JP'))}<br>終了後、新しい操作はできなくなり、参加データは終了の ${ev.retention_hours} 時間後に自動削除されます（削除には運用上の制約があります。詳しくは主催者にご確認ください）。</p>
  ${startStatusHtml(ev)}</div>
  <h2>必ずお読みください</h2>${discHtml()}
  <label><input type="checkbox" id="agree" style="width:auto;min-height:0"> 上記を読み、理解しました</label>
  <div class="btns"><button id="join" class="btn pri" disabled>${ev.joinable ? '参加する' : '現在は参加できません'}</button></div><div id="joinmsg"></div>`;
  const j = $('#join'); const chk = $('#agree'); const upd = () => { j.disabled = !(ev.joinable && chk.checked); }; chk.addEventListener('change', upd);
  j.addEventListener('click', async () => { j.disabled = true; try { const r = await api('POST', '/api/join', { code }); store.set(r.token); history.replaceState(null, '', '/#/home'); route(); } catch (e) { $('#joinmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; upd(); } });
}

function startStatusHtml(ev) {
  if (!ev.data_ready) return '<div class="msg warn"><b>データ未設定</b>のため、まだ開始できません。主催者の準備が終わるまでお待ちください。</div>';
  const m = { open: ['ok', '開催中です。下の注意事項を読んで参加してください。'], not_started: ['info', `開始前です。${new Date(ev.starts_at).toLocaleString('ja-JP')} 以降に参加できます（時刻はサーバー基準）。`],
    paused: ['warn', '主催者により一時停止中です。再開までお待ちください。'], ended: ['warn', 'この説明会は終了しました。新しい参加・操作はできません。'], purged: ['warn', 'この説明会は終了し、参加データは削除済みです。'],
    stopped: ['warn', 'この説明会は停止されています。'], not_enabled: ['info', '準備中です（公開前）。'], unverified: ['info', '準備中です（動作確認が完了していません）。'] }[ev.status] || ['info', ev.status_ja];
  return `<div class="msg ${m[0]}">状態: <b>${esc(ev.status_ja)}</b> — ${esc(m[1])}</div>`;
}

// ---------- 共通部品 ----------
function chart(series, opts = {}) {
  if (!series.length) return '<div class="sub">データがありません</div>';
  const W = 600, H = 160, P = 8; const ys = series.map((s) => s[1]); let lo = Math.min(...ys), hi = Math.max(...ys); if (lo === hi) { lo -= 1; hi += 1; }
  const x = (i) => P + (i / Math.max(1, series.length - 1)) * (W - 2 * P), y = (v) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const pts = series.map((s, i) => `${x(i).toFixed(1)},${y(s[1]).toFixed(1)}`).join(' ');
  let extra = ''; if (opts.base) { const by = y(opts.base[1]); extra = `<polyline points="${series.map((s, i) => `${x(i).toFixed(1)},${y(opts.base[0][i]).toFixed(1)}`).join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5 4" opacity=".7"/>`; void by; }
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || '推移')}" style="color:var(--sub)"><polyline points="${pts}" fill="none" stroke="var(--pri)" stroke-width="2.5"/>${extra}</svg>
  <div class="sub" style="display:flex;justify-content:space-between"><span>${esc(jdate(series[0][0]))}</span><span>最小 ${esc(Math.round(lo).toLocaleString('ja-JP'))} / 最大 ${esc(Math.round(hi).toLocaleString('ja-JP'))}</span><span>${esc(jdate(series[series.length - 1][0]))}</span></div>`;
}
const tagFor = (s) => ({ accepted: '<span class="tag acc">受付済み</span>', filled: '<span class="tag fill">成立済み</span>', cancelled: '<span class="tag cx">取消済み</span>', lapsed: '<span class="tag lap">失効</span>' }[s] || esc(s));
const sideJa = (o) => `${o.kind === 'fund' ? '投信' : '株式/ETF'} ${o.side === 'buy' ? '買い' : '売り'}`;
function orderLine(o, cancellable, curDate) {
  const qty = o.kind === 'fund' && o.side === 'buy' ? yen(o.amount) : o.kind === 'fund' ? `${(o.qty || 0).toLocaleString('ja-JP')}口` : `${(o.qty || 0).toLocaleString('ja-JP')}株`;
  let timing = ''; if (o.status === 'accepted') timing = `約定予定: ${jdate(o.exec_date)}${o.kind === 'stock' ? '（始値）' : '（基準価額）'}`;
  else if (o.status === 'filled') timing = `約定 ${jdate(o.closed_date)}${o.price_milli != null ? ` / 価格 ${milli(o.price_milli)}` : ''}${o.fee ? ` / 費用 ${yen(o.fee)}` : ''}${o.units ? ` / ${o.units.toLocaleString('ja-JP')}口` : ''}`;
  else timing = `${jdate(o.closed_date)}　${esc(o.reason || '')}`;
  const cx = o.status === 'accepted' && cancellable && o.placed_date === curDate ? `<button class="btn danger" data-cancel="${o.id}">取消</button>` : o.status === 'accepted' ? '<span class="sub">取消期限を過ぎています</span>' : '';
  return `<div class="card"><div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(o.name)}</b>${tagFor(o.status)}</div><div>${sideJa(o)} ${qty}${o.origin === 'plan' ? ' <span class="tag">積立</span>' : ''}</div><div class="sub">注文日 ${jdate(o.placed_date)}　${timing}</div>${cx}</div>`;
}
async function lookup(requestId) { try { return await api('GET', '/api/requests/' + encodeURIComponent(requestId)); } catch (e) { return e.unknown ? null : { found: false }; } }
async function doPost(path, body, onUnknown) {
  const b = { request_id: rid(), expected_sim_date: S.me.account.sim_date, ...body };
  try { return await api('POST', path, b); } catch (e) { if (e.unknown && onUnknown) onUnknown(path, b); throw e; }
}

// ---------- ホーム ----------
async function viewHome() {
  const m = S.me, a = m.assets, v = $('#view'); const fin = m.account.status !== 'active';
  const stopHtml = S.stop ? `<div class="msg warn"><b>自動停止: ${esc(S.stop.message)}</b><br>次にできること: ${esc(S.stop.next)}</div>` : '';
  const dataBase = m.series.map((s) => [s.date, s.total]);
  const attemptJa = m.account.attempt === 1 ? '初回' : `再試行（${m.account.attempt}回目）`;
  let guideSeen = false; try { guideSeen = localStorage.getItem('nisa_sim_guide') === '1'; } catch { /* noop */ }
  const guide = guideSeen ? '' : `<div class="card" id="guide"><h2 style="margin-top:0">はじめに（30秒）</h2><ol>
    <li>「投資対象」から選び、<b>買う・売る・積立</b>のどれかを押します。</li>
    <li>注文は<b>その日の終わりに受け付け</b>、翌営業日（投資信託は次の基準価額）で成立します。日付を進めるまでは取消できます。</li>
    <li>ホームの「翌営業日へ」「翌月へ」「月ごとに自動進行」で時間を進めます。</li>
    <li>データの最終日まで進むと結果を確認でき、同じ条件でやり直せます。損益は<b>税引前</b>です。</li></ol>
    <button class="btn" id="guide-ok">わかりました</button></div>`;
  const resultHtml = fin ? `<div class="card"><h2 style="margin-top:0">結果（${attemptJa}）</h2><table>
    <tr><th>期間</th><td class="n">${jdate(m.event.period.start)} 〜 ${jdate(m.account.sim_date)}</td></tr>
    <tr><th>総資産</th><td class="n">${yen(a.total)}</td></tr><tr><th>入金累計</th><td class="n">${yen(a.deposits)}</td></tr>
    <tr><th>運用損益（税引前・手数料込み）</th><td class="n">${plLabel(a.pnl)}</td></tr></table>
    ${allocHtml(m.allocation)}<div class="sub">過去の実データによる結果であり、将来の成果を保証するものではありません。順位付けや投資判断の評価はしません。${m.account.attempt > 1 ? '再試行では過去の値動きを知ったうえで操作できるため、初回とは区別して表示しています。' : ''}</div>
    <div class="btns"><a class="btn" href="#/history">履歴を見る</a><a class="btn" href="#/compare">試行を比べる</a><a class="btn" href="#/more">同じ条件でやり直す</a></div></div>` : '';
  v.innerHTML = `${stopHtml}${guide}
  <h1>ホーム <span class="tag">${attemptJa}</span></h1><p class="sub">${periodLine(m.event.data)} いまの日付は<b>シミュレーション上の日付</b>（${jdate(m.account.sim_date)}）で、実際の今日ではありません。</p>${resultHtml}
  <div class="card kpi big"><div class="k">総資産 <button class="q" data-term="settle" aria-label="説明">?</button></div><div class="v">${yen(a.total)}</div>
    <div>運用損益（税引前）${Q('pretax')}: ${plLabel(a.pnl)}</div>
    <div class="sub">総資産 = 現金残高 + 保有の評価額 − 未受渡の買付代金 + 未受渡の売却代金 + 未収配当等。約定から受渡までの間も資産が消えたり重複したりしません。</div></div>
  <div class="grid g4">
    <div class="card kpi"><div class="k">買付可能額 ${Q('buying')}</div><div class="v">${yen(a.available)}</div><div class="sub">新しい注文に使える金額</div></div>
    <div class="card kpi"><div class="k">現金残高</div><div class="v">${yen(a.cash)}</div><div class="sub">うち注文拘束 ${yen(a.reserved)}／受渡待ちの買付代金 ${yen(a.payable_purchase)}</div></div>
    <div class="card kpi"><div class="k">入金累計</div><div class="v">${yen(a.deposits)}</div></div>
    <div class="card kpi"><div class="k">保有の評価額</div><div class="v">${yen(a.holdings_value)}</div></div>
  </div>
  ${m.receivables.length ? `<div class="msg info"><b>受渡・入金の予定</b>（未受渡の売却代金は受渡日まで買付に使えません）${m.receivables.map((r) => `<br>・${esc(r.name)} ${yen(r.amount)} ${({ sale: '売却代金の受取', purchase: '買付代金の支払', dividend: '配当・分配金の入金（税引前）', split_fraction: '端数株代金の入金' })[r.kind]} ${r.due_date === '9999-12-31' ? '（期間外）' : jdate(r.due_date)}`).join('')}</div>` : ''}
  <div class="card"><h2 style="margin-top:0">時間を進める</h2>${fin ? `<div class="msg ok">${m.account.status === 'finished' ? 'データの最終日（' + jdate(m.account.final_date) + '）に到達しました。この先の価格データは存在しないため、これ以上は進められません。結果を確認できます。' : '閲覧専用です。'}</div>` : ''}
    <div class="sub">進めると、その間の約定・受渡・配当・積立が営業日ごとに順番に処理されます。${m.next_deposit_date ? `毎月の追加資金 ${yen(m.event.monthly_deposit)} は、次回 ${jdate(m.next_deposit_date)}（月の最初の営業日）に入金されます。` : ''}</div>
    <div class="btns"><button class="btn pri" id="adv-day" ${locked() || S.auto ? 'disabled' : ''}>翌営業日へ</button><button class="btn pri" id="adv-month" ${locked() || S.auto ? 'disabled' : ''}>翌月へ</button>
    <button class="btn" id="auto" ${locked() ? 'disabled' : ''}>${S.auto ? '停止' : '月ごとに自動進行'}</button></div>
    ${S.auto ? '<div class="msg info">自動進行中です。注文・積立の操作は停止してから行ってください（注文の競合を防ぐため）。注文成立・失効・資金不足・ニュースで自動的に止まります。</div>' : ''}
    <div id="advres">${eventsHtml(S.last)}</div></div>
  ${fin ? '' : `<div class="card"><h2 style="margin-top:0">資産配分</h2>${allocHtml(m.allocation)}</div>`}
  <div class="card"><h2 style="margin-top:0">資産推移</h2>${chart(dataBase, { label: '総資産の推移' })}</div>
  <h2>保有している投資対象</h2>
  ${a.holdings.length ? `<div class="card" style="overflow-x:auto"><table><tr><th>名称</th><th class="n">保有数量</th><th class="n">評価額</th><th class="n">損益（税引前）</th></tr>${a.holdings.map((h) => { const u = h.type === 'fund' ? '口' : '株'; return `<tr><td><a href="#/i/${esc(h.instrument_id)}">${esc(h.name)}</a>${h.stale ? ' <span class="tag prov">価格更新なし</span>' : ''}</td><td class="n">${h.qty.toLocaleString('ja-JP')}${u}${h.unsettled_qty ? `<br><span class="sub">うち受渡前 ${h.unsettled_qty.toLocaleString('ja-JP')}${u}</span>` : ''}<br><span class="sub">売却可能 ${h.sellable_qty.toLocaleString('ja-JP')}${u}</span></td><td class="n">${yen(h.value)}</td><td class="n">${plLabel(h.pnl)}</td></tr>`; }).join('')}</table></div>` : '<div class="msg info">まだ保有はありません。「投資対象」から選べます。</div>'}
  ${m.orders.length ? `<div class="msg info">受付済みの注文が ${m.orders.length} 件あります。<a href="#/orders">注文を見る</a></div>` : ''}
  <h2>最新のイベント</h2>${newsList(m.news.slice(0, 3))}<a href="#/news">これまでのイベントを見る</a>
  ${fin ? '<h2>ご利用上の注意（結果画面）</h2>' + discHtml() : '<details><summary>ご利用上の注意</summary>' + discHtml() + '</details>'}
  ${m.event.provisional && Object.values(m.event.provisional).some(Boolean) ? '<div class="msg warn">一部の設定（初期資金・毎月の追加資金・期間など）は仮設定です。</div>' : ''}`;
  $('#guide-ok')?.addEventListener('click', () => { try { localStorage.setItem('nisa_sim_guide', '1'); } catch { /* noop */ } $('#guide').remove(); });
  $('#adv-day')?.addEventListener('click', () => advance('day')); $('#adv-month')?.addEventListener('click', () => advance('month'));
  $('#auto')?.addEventListener('click', () => (S.auto ? stopAuto(true) : startAuto()));
}
// 資産配分: 分類ごとの金額と割合（色だけに頼らず、数値と棒の長さで示す）
function allocHtml(al) {
  if (!al || !al.length) return '';
  return `<table class="alloc"><tr><th>分類</th><th class="n">金額</th><th class="n">割合</th></tr>${al.map((x) => `<tr><td>${esc(x.label)}<div class="bar"><span style="width:${Math.max(0, Math.min(100, x.pct_bp / 100))}%"></span></div></td><td class="n">${yen(x.value)}</td><td class="n">${(x.pct_bp / 100).toFixed(1)}%</td></tr>`).join('')}</table>`;
}
// 進行中の出来事: 重要なもの（成立・失効・見送り・ニュース・終了）は1件ずつ、定型のもの（入金・受渡・積立の発注など）は種類ごとに件数でまとめる
const EV_GROUP = { deposit: '毎月の追加資金の入金', plan_order: '積立の注文', settled: '売却代金の受渡（入金）', dividend_declared: '配当・分配金の確定', dividend_paid: '配当・分配金等の入金', order_deferred: '基準価額なしによる繰り延べ', split: '分割・併合', split_fraction: '端数株の処分代金の確定' };
function eventsHtml(list) {
  if (!list.length) return '';
  const key = list.filter((e) => !EV_GROUP[e.type]); const routine = new Map();
  for (const e of list) if (EV_GROUP[e.type]) { const g = routine.get(e.type) || []; g.push(e); routine.set(e.type, g); }
  const li = (e) => `<li>${esc(jdate(e.date))} ${esc(e.text)}</li>`;
  return `<h3>今回進めた間の出来事（${esc(jdate(list[0].date))}〜${esc(jdate(list[list.length - 1].date))}）</h3>${key.length ? '<ul>' + key.slice(-12).map(li).join('') + '</ul>' + (key.length > 12 ? `<div class="sub">ほか ${key.length - 12} 件は「注文」「履歴」で確認できます。</div>` : '') : ''}
  ${[...routine].map(([t, g]) => (g.length <= 2 ? '<ul>' + g.map(li).join('') + '</ul>' : `<details><summary>${esc(EV_GROUP[t])} ${g.length}件</summary><ul>${g.map(li).join('')}</ul></details>`)).join('')}`;
}
function newsList(list) {
  if (!list.length) return '<div class="msg info">まだ表示するイベントはありません。</div>';
  return list.map((n) => `<div class="card"><div class="sub">${jdate(n.published_date)} 公表</div><div>${esc(n.summary)}</div><div class="sub">出典: <a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.source_name)}</a>　※値動きとの因果関係を示すものではありません</div></div>`).join('');
}
async function advance(mode) {
  if (S.busy) return; S.busy = true;
  document.querySelectorAll('#adv-day,#adv-month').forEach((b) => { b.disabled = true; });
  const body = { request_id: rid(), expected_sim_date: S.me.account.sim_date, mode };
  try {
    let r;
    try { r = await api('POST', '/api/advance', body); } catch (e) {
      if (!e.unknown) throw e;
      const q = await lookup(body.request_id); // 受付状況を照会
      if (q === null) throw e; if (!q.found) { toast('進行は受け付けられていませんでした。もう一度押してください'); await refresh(); if (location.hash.startsWith('#/home') || !location.hash) await viewHome(); return null; }
      r = q.response;
    }
    S.last = r.events; S.stop = mode === 'day' && r.stop?.reason !== 'end' ? null : r.stop; const onHome = location.hash.startsWith('#/home') || !location.hash; if (!S.auto && !onHome) r.events.slice(-2).forEach((e) => toast(e.text)); // ホームでは「進めた間の出来事」に同じ内容が出るため、重ねて通知しない
    await refresh(); if (location.hash.startsWith('#/home') || !location.hash) await viewHome();
    return r;
  } catch (e) {
    if (e.status === 409) { S.stop = { message: '画面の日付が古くなっていました', next: '最新の状態に更新しました。もう一度操作してください' }; await route(); }
    else if (e.unknown) { toast('通信結果が未確認です。通信が戻ったら画面を更新して日付を確認してください（二重には進みません）'); if (location.hash.startsWith('#/home') || !location.hash) viewHome(); }
    else if (!e.ended) toast(e.message);
    return null;
  } finally { S.busy = false; }
}
function startAuto() { S.auto = true; S.stop = null; viewHome(); const tick = async () => { if (!S.auto) return; const r = await advance('month'); if (!r || r.stop || S.me.account.status !== 'active') { stopAuto(); if (r?.stop) viewHome(); return; } S.autoTimer = setTimeout(tick, 1200); }; tick(); }
function stopAuto(rerender) { S.auto = false; clearTimeout(S.autoTimer); if (rerender) viewHome(); }

// ---------- 投資対象 ----------
let marketState = { q: '', cat: '' };
async function viewMarket() {
  const r = await api('GET', `/api/instruments?q=${encodeURIComponent(marketState.q)}&category=${encodeURIComponent(marketState.cat)}`);
  $('#view').innerHTML = `<h1>投資対象</h1><p class="sub">特定の商品をすすめるものではありません。並びは一覧の登録順です。</p>
  <label for="q">名称・キーワードで検索</label><input id="q" type="search" value="${esc(marketState.q)}" placeholder="例: 国内株式">
  <div class="chips" role="group" aria-label="分類">${['', ...r.categories].map((c) => `<button class="chip ${marketState.cat === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c || 'すべて')}</button>`).join('')}</div>
  ${r.items.length ? r.items.map((i) => { const chg = i.prev_close_milli ? i.price_milli - i.prev_close_milli : 0; return `<a class="card inst" href="#/i/${esc(i.id)}"><div><div class="nm">${esc(i.name)}</div><div class="sub">${esc(i.category)}${i.qty ? ` ／ 保有 ${i.qty.toLocaleString('ja-JP')}${i.type === 'fund' ? '口' : '株'}（${yen(i.value)}）` : ''}</div></div><div style="text-align:right"><div>${milli(i.price_milli)}${i.type === 'fund' ? '円/1万口' : '円'}</div><div class="sub">前日比 ${chg > 0 ? '▲ +' : chg < 0 ? '▼ −' : '― '}${milli(Math.abs(chg))}</div></div></a>`; }).join('') : '<div class="msg info">該当する投資対象がありません。</div>'}`;
  let t; const qi = $('#q'); if (marketState.focus) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); marketState.focus = false; }
  qi.addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { marketState.q = e.target.value; marketState.focus = true; viewMarket(); }, 400); });
  document.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { marketState.cat = b.dataset.cat; viewMarket(); }));
}

// ---------- 詳細・注文 ----------
let ord = null;
async function viewInstrument(id) {
  const d = await api('GET', '/api/instruments/' + encodeURIComponent(id)); const isFund = d.type === 'fund'; const t = d.terms;
  const typeJa = { stock: '国内株式', etf: '国内ETF', fund: '投資信託' }[d.type];
  const chg = d.prev_close_milli ? d.price_milli - d.prev_close_milli : 0;
  $('#view').innerHTML = `<p><a href="#/market">← 投資対象へ</a></p><h1>${esc(d.name)}</h1><div class="sub">${esc(typeJa)} ／ ${esc(d.category)}</div><p>${esc(d.description)}</p>
  <div class="card kpi"><div class="k">${d.stale ? '最後に価格がついた日' : '現在の'}${isFund ? '基準価額' : '終値'} (${jdate(d.price_date)})</div><div class="v">${milli(d.price_milli)}${isFund ? ' 円/1万口' : ' 円'}</div><div class="sub">前日比 ${chg > 0 ? '▲ +' : chg < 0 ? '▼ −' : '― '}${milli(Math.abs(chg))}</div></div>
  <div class="card">${chart(d.series.map((s) => [s[0], s[1] / 1000]), { label: '価格推移' })}<div class="sub">シミュレーション上の日付（${jdate(S.me.account.sim_date)}）までの実績のみ表示しています。過去を順番に体験するための表示で、この先の値動きを示唆・予測するものではありません。</div></div>
  <div class="card"><b>保有</b>: ${d.holding ? `${d.holding.qty.toLocaleString('ja-JP')}${isFund ? '口' : '株'}（取得額 ${yen(d.holding.cost)}）<br><span class="sub">売却可能 ${d.sellable.toLocaleString('ja-JP')}${isFund ? '口' : '株'}${d.holding.unsettled_qty > 0 ? ` ／ 受渡前の買付分は受渡日まで売れません` : ''}</span>` : 'なし'}</div>
  <div class="card"><h3 style="margin-top:0">取引条件${t.terms_status !== 'confirmed' ? ' <span class="tag prov">仮設定</span>' : ''}</h3><ul>
    ${isFund ? `<li>購入: ${t.spot_buy_ok === false ? '積立（定時定額）のみ' : `${yen(t.min_amount)}以上 ${yen(t.amount_step)}単位`}${t.savings_ok ? ` ／ 積立は ${yen(t.savings_min_amount ?? t.min_amount)}以上 ${yen(t.savings_amount_step ?? t.amount_step)}単位` : ' ／ 積立は取扱なし'} ／ 購入時手数料 ${(t.fee.rate_ppm / 10000).toFixed(2)}%（税込・購入金額に含む）</li><li>適用価格: 注文した日の${t.nav_offset}営業日後の基準価額（日付の終わりに出した注文は翌営業日の申込として扱います）。注文時点では分かりません ${Q('nav')}</li><li>購入代金の受渡 約定後${t.buy_settlement_days}営業日（受渡前の口数は売却できません）</li><li>売却: 信託財産留保額 ${(t.holdback_ppm / 10000).toFixed(2)}% ${Q('holdback')} ／ 売却代金の受渡 約定後${t.settlement_days}営業日 ${Q('settle')}</li><li>分配金は現金で受け取ります（再投資は未対応）${Q('dist')}</li>` : `<li>売買単位 ${t.lot_size.toLocaleString('ja-JP')}株（口） ${Q('lot')}</li><li>成行注文のみ。日付の終わりに注文 → 翌営業日の始値で約定 ${Q('market')}</li><li>手数料 ${(t.fee.rate_ppm / 10000).toFixed(3)}%${t.fee.min ? `（最低 ${yen(t.fee.min)}）` : ''}${t.fee.fixed ? ` + ${yen(t.fee.fixed)}` : ''}</li><li>売却代金の受渡 約定後${t.settlement_days}営業日 ${Q('settle')}</li><li>買い注文中は、値上がりに備え${t.price_limit_table ? '注文日の終値＋制限値幅' : `約${(t.buy_reserve_margin_bp / 100).toFixed(0)}%の余裕`}を含む金額を確保します ${Q('reserve')}</li><li>買付代金は受渡日（約定後${t.settlement_days}営業日）に支払い。受渡前の株式は売却できません</li>`}
  </ul><div class="sub">出典: ${d.source ? esc(d.source.name) + '（取得日 ' + esc(d.source.retrieved_at) + '）' : '-'}。条件は現在のものを過去の期間に当てはめています。板・流動性・スリッページは再現していません。</div></div>
  <div class="seg" role="group" aria-label="操作"><button data-mode="buy">買う</button><button data-mode="sell">売る</button>${isFund && t.savings_ok ? '<button data-mode="plan">積立</button>' : ''}</div><div id="orderpanel"></div>
  ${d.open_orders.length ? `<h3>この商品の受付済み注文</h3>${d.open_orders.map((o) => orderLine({ ...o, name: d.name }, !locked(), S.me.account.sim_date)).join('')}` : ''}`;
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => openOrder(d, b.dataset.mode)));
  bindCancel(() => viewInstrument(id));
  if (ord && ord.id === id && ord.mode) openOrder(d, ord.mode, true);
}
function bindCancel(after) {
  document.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; try { await doPost(`/api/orders/${b.dataset.cancel}/cancel`, {}); toast('注文を取り消しました'); await refresh(); after(); } catch (e) { if (!e.ended) { toast(e.message); b.disabled = false; } }
  }));
}
function openOrder(d, mode, keep) {
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  if (!keep) ord = { id: d.id, mode, step: 'input', vals: {} };
  const p = $('#orderpanel');
  if (locked()) { p.innerHTML = `<div class="msg warn">${S.me.account.status !== 'active' ? 'この口座では注文できません。' : '一時停止中のため注文できません。'}</div>`; return; }
  if (S.auto) { p.innerHTML = '<div class="msg warn">自動進行中は注文できません。ホームで「停止」してから操作してください。</div>'; return; }
  if (mode === 'plan') return planPanel(d, p);
  const isFund = d.type === 'fund', side = mode, buy = side === 'buy';
  const unit = isFund ? '円' : '株'; const lot = d.terms.lot_size || 1;
  const field = isFund && buy ? 'amount' : 'qty';
  if (isFund && buy && d.terms.spot_buy_ok === false) { p.innerHTML = '<div class="msg info">この商品は積立（定時定額）でのみ購入できます。「積立」から設定してください。</div>'; return; }
  const label = isFund && buy ? `購入金額（円・${d.terms.amount_step.toLocaleString('ja-JP')}円単位、最低${d.terms.min_amount.toLocaleString('ja-JP')}円）` : isFund ? '売却口数' : `${buy ? '購入' : '売却'}株数（${lot}株単位）`;
  const saved = ord.vals[field] ?? '';
  if (ord.step === 'result') return orderResult(d, p);
  if (ord.step === 'confirm') return orderConfirm(d, p, side, field);
  p.innerHTML = `<div class="card"><div class="steps"><b>① 入力</b> → ② 内容確認 → ③ 受付結果</div>
  <label for="oval">${esc(label)}</label><input id="oval" inputmode="numeric" autocomplete="off" value="${esc(saved)}">
  ${!buy ? `<div class="sub">売却可能: ${(d.sellable || 0).toLocaleString('ja-JP')}${isFund ? '口' : '株'}${d.holding && d.holding.unsettled_qty > 0 ? `（ほかに受渡前の買付分 ${d.holding.unsettled_qty.toLocaleString('ja-JP')}${isFund ? '口' : '株'}は受渡日まで売れません）` : ''}</div>${d.sellable ? `<label style="font-weight:400"><input type="checkbox" id="sellall" style="width:auto;min-height:0" ${ord.vals.sell_all ? 'checked' : ''}> 全売却（端数も含めすべて）</label>` : ''}` : ''}
  <div id="prev" aria-live="polite"></div><div class="btns"><button class="btn pri" id="tocf" disabled>内容を確認する</button></div>
  <div class="sub">買付可能額: ${yen(d.available)}（未受渡の売却代金は含みません）。${isFund ? `注文した日の${d.terms.nav_offset}営業日後の基準価額で約定します。` : '成行注文: 日付の終わりに注文し、次の営業日の始値で約定します。'}</div></div>`;
  const inp = $('#oval'); const all = $('#sellall'); let tmr;
  const run = async () => {
    const raw = inp.value.trim().replace(/,/g, ''); ord.vals[field] = inp.value; ord.vals.sell_all = !!all?.checked;
    if (all?.checked) inp.disabled = true; else inp.disabled = false;
    $('#tocf').disabled = true;
    if (!all?.checked && !raw) { $('#prev').innerHTML = ''; return; }
    if (!all?.checked && !/^\d+$/.test(raw)) { $('#prev').innerHTML = '<div class="msg err">⚠ 半角の整数で入力してください</div>'; return; }
    try {
      const body = { instrument_id: d.id, side, ...(all?.checked ? { sell_all: true } : { [field]: Number(raw) }) };
      const r = await api('POST', '/api/orders/preview', body); ord.preview = r; ord.body = body;
      $('#prev').innerHTML = r.ok ? previewHtml(r.info, d) : r.errors.map((e) => `<div class="msg err">⚠ ${esc(e)}</div>`).join('');
      $('#tocf').disabled = !r.ok;
    } catch (e) { if (!e.ended) $('#prev').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  };
  inp.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(run, 250); }); all?.addEventListener('change', run);
  $('#tocf').addEventListener('click', () => { ord.step = 'confirm'; openOrder(d, mode, true); });
  if (saved || ord.vals.sell_all) run();
}
function previewHtml(i, d) {
  const isFund = d.type === 'fund'; const rows = [];
  if (i.side === 'buy') {
    if (isFund) rows.push(['購入金額（手数料込み）', yen(i.amount)], ['うち購入時手数料（見込み）', yen(i.fee_estimate)], ['注文中に確保する金額', yen(i.reserve)]);
    else rows.push(['株数', i.qty.toLocaleString('ja-JP') + '株'], ['参考金額（現在の終値 × 株数）', yen(i.reference_amount)], ['注文中に確保する金額（値上がりに備えた余裕を含む）', yen(i.reserve)], ['手数料（見込み）', yen(i.fee_estimate)]);
    rows.push(['買付可能額', yen(i.available)]);
  } else rows.push([isFund ? '売却口数' : '売却株数', i.qty.toLocaleString('ja-JP') + (isFund ? '口' : '株')], ['売却可能数量', i.sellable.toLocaleString('ja-JP') + (isFund ? '口' : '株')]);
  const sd = i.settle_date === '9999-12-31' ? '期間外（期間内には受渡されません）' : jdate(i.settle_date);
  rows.push(['注文の締切・取消期限', jdate(i.cancel_deadline) + 'の終わり（日付を進めるまで）'], ['約定予定日', jdate(i.exec_date) + (isFund ? '（この日の基準価額）' : '（この日の始値）')],
    i.side === 'sell' ? ['売却代金の受渡予定日', sd + '（それまで買付に使えません）'] : ['受渡予定日（代金支払・売却可能になる日）', sd]);
  return `<table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td class="n">${esc(v)}</td></tr>`).join('')}</table>`;
}
function orderConfirm(d, p) {
  const i = ord.preview.info;
  p.innerHTML = `<div class="card"><div class="steps">① 入力 → <b>② 内容確認</b> → ③ 受付結果</div><h3>${esc(d.name)} を${i.side === 'buy' ? '買う' : '売る'}</h3>${previewHtml(i, d)}
  <div class="msg warn">価格は約定日まで決まりません。${i.side === 'buy' ? '成行買いでは、確保額を超えて値上がりした場合は成立せず失効します。' : ''}注文の取消は、シミュレーション上の日付を進める前までできます。</div>
  <div id="ordmsg"></div><div class="btns"><button class="btn" id="back">戻る</button><button class="btn pri" id="submit">この内容で注文する</button></div></div>`;
  // onclick（代入）で設定し、状態に応じて置き換える。addEventListener だと古い送信処理が残り二重送信になる
  $('#back').onclick = () => { ord.step = 'input'; openOrder(d, ord.mode, true); };
  $('#submit').onclick = () => submitOrder(d, p);
}
async function submitOrder(d, p) {
  if (ord.pending) return; // 送信中・結果未確認の間は新しい注文を作らない
  const btn = $('#submit'); btn.disabled = true; $('#back').disabled = true;
  ord.pending = { path: '/api/orders', body: { request_id: rid(), expected_sim_date: S.me.account.sim_date, ...ord.body } };
  await sendPending(d, p);
}
async function sendPending(d, p) {
  try {
    const r = await api('POST', ord.pending.path, ord.pending.body); ord.result = r; ord.step = 'result'; ord.pending = null; await refresh(); orderResult(d, p);
  } catch (e) {
    if (e.ended) return;
    if (e.unknown) { $('#ordmsg').innerHTML = `<div class="msg warn"><b>受付状況が未確認です。</b>通信が途中で切れたため、注文が受け付けられたか分かりません。<b>新しく注文し直さないでください。</b>下のボタンで受付状況を確認できます（同じ注文が二重に受け付けられることはありません）。</div>`; $('#submit').textContent = '受付状況を確認'; $('#submit').disabled = false; $('#submit').onclick = () => checkPending(d, p); $('#back').hidden = true; return; }
    ord.pending = null; $('#ordmsg').innerHTML = `<div class="msg err">⚠ ${esc(e.message)}</div>`; $('#submit').disabled = false; $('#back').disabled = false;
    if (e.status === 409) { await refresh(); }
  }
}
async function checkPending(d, p) {
  $('#submit').disabled = true;
  const q = await lookup(ord.pending.body.request_id);
  if (q === null) { $('#ordmsg').innerHTML = '<div class="msg warn">まだ通信できません。電波の良い場所で、もう一度「受付状況を確認」を押してください。</div>'; $('#submit').disabled = false; return; }
  if (q.found) { ord.result = q.response; ord.step = 'result'; ord.pending = null; await refresh(); return orderResult(d, p); }
  $('#ordmsg').innerHTML = '<div class="msg info">この注文は<b>受け付けられていません</b>。同じ内容でもう一度送信できます。</div>';
  $('#submit').textContent = '同じ内容で送信する'; $('#submit').disabled = false; $('#submit').onclick = () => { $('#submit').disabled = true; sendPending(d, p); };
}
function orderResult(d, p) {
  const i = ord.result.info; p.innerHTML = `<div class="card"><div class="steps">① 入力 → ② 内容確認 → <b>③ 受付結果</b></div><div class="msg ok"><b>${esc(ord.result.message)}</b>${ord.result.replayed ? '（同じ注文の結果を確認しました）' : ''}</div>
  <p>状態: ${tagFor('accepted')}（まだ成立していません）　約定予定日 ${jdate(i.exec_date)}。受渡予定日 ${i.settle_date === '9999-12-31' ? '期間外' : jdate(i.settle_date)}。<br>取消できるのは、シミュレーション上の日付を進める前までです。進めると、約定・失効の結果が「注文」に表示されます。</p>
  <div class="btns"><a class="btn" href="#/orders">注文を見る</a><button class="btn" id="again">続けて別の注文</button></div></div>`;
  $('#again').addEventListener('click', () => { ord = null; viewInstrument(d.id); });
}
function planPanel(d, p) {
  const t = { ...d.terms, min_amount: d.terms.savings_min_amount ?? d.terms.min_amount, amount_step: d.terms.savings_amount_step ?? d.terms.amount_step }; const pl = d.plan;
  if (pl) {
    p.innerHTML = `<div class="card"><h3 style="margin-top:0">積立の設定${Q('plan')}</h3><div>毎月 ${pl.day_of_month}日以降の最初の営業日 ／ ${yen(pl.amount)} ／ 状態: <b>${pl.status === 'active' ? '有効' : '休止中'}</b></div>
    <div class="sub">金額変更・休止・再開・解除は、次回以降の注文から反映されます（すでに出された注文は変わりません）。</div>
    <label for="pamt">積立額を変更（円）</label><input id="pamt" inputmode="numeric" value="${pl.amount}"><div id="pmsg"></div>
    <div class="btns"><button class="btn pri" id="pchg">金額を変更</button>${pl.status === 'active' ? '<button class="btn" id="ppause">休止</button>' : '<button class="btn" id="presume">再開</button>'}<button class="btn danger" id="pcancel">解除</button></div></div>`;
    const act = async (body, msg) => { try { await doPost('/api/plans/' + pl.id, body); toast(msg); await refresh(); viewInstrument(d.id); } catch (e) { if (!e.ended) $('#pmsg').innerHTML = `<div class="msg err">⚠ ${esc(e.message)}</div>`; } };
    $('#pchg').onclick = () => act({ action: 'amount', amount: Number($('#pamt').value.replace(/,/g, '')) }, '積立額を変更しました（次回の注文から）');
    $('#ppause')?.addEventListener('click', () => act({ action: 'pause' }, '休止しました')); $('#presume')?.addEventListener('click', () => act({ action: 'resume' }, '再開しました'));
    $('#pcancel').onclick = () => { if (confirm('この積立を解除します。よろしいですか？')) act({ action: 'cancel' }, '解除しました'); };
    return;
  }
  p.innerHTML = `<div class="card"><h3 style="margin-top:0">積立を設定${Q('plan')}</h3><div class="steps"><b>① 入力</b> → ② 確認 → ③ 結果</div>
  <label for="pamt">毎月の積立額（円・${t.amount_step.toLocaleString('ja-JP')}円単位、最低${t.min_amount.toLocaleString('ja-JP')}円）</label><input id="pamt" inputmode="numeric">
  <label for="pdom">積立日（毎月 1〜28日。休日の場合は次の営業日）</label><input id="pdom" inputmode="numeric" value="5"><div id="pmsg"></div>
  <div class="btns"><button class="btn pri" id="pgo">内容を確認する</button></div>
  <div class="sub">資金が足りない月は見送られ、自動進行は停止します。注文は日付が進んだ時点で出され、その${d.terms.nav_offset}営業日後の基準価額で約定します。</div></div>`;
  $('#pgo').onclick = () => {
    const amount = Number($('#pamt').value.replace(/,/g, '')), dom = Number($('#pdom').value);
    if (!Number.isInteger(amount) || amount < t.min_amount || amount % t.amount_step) return void ($('#pmsg').innerHTML = `<div class="msg err">⚠ 積立額は ${yen(t.min_amount)}以上、${yen(t.amount_step)}単位で入力してください</div>`);
    if (!Number.isInteger(dom) || dom < 1 || dom > 28) return void ($('#pmsg').innerHTML = '<div class="msg err">⚠ 積立日は1〜28の整数で入力してください</div>');
    const day = Number(S.me.account.sim_date.slice(8, 10)); const ym = S.me.account.sim_date.slice(0, 7); const first = day < dom ? ym : (() => { let [Y, M] = ym.split('-').map(Number); M++; if (M > 12) { M = 1; Y++; } return `${Y}年${M}月`; })();
    p.innerHTML = `<div class="card"><div class="steps">① 入力 → <b>② 確認</b> → ③ 結果</div><h3>${esc(d.name)} の積立</h3><table><tr><th>毎月の金額</th><td class="n">${yen(amount)}</td></tr><tr><th>積立日</th><td class="n">毎月${dom}日以降の最初の営業日</td></tr><tr><th>最初の注文</th><td class="n">${esc(first.includes('-') ? jdate(first + '-01').replace(/1日$/, '') : first)}（日付がその日に進んだとき）</td></tr></table><div id="pmsg"></div><div class="btns"><button class="btn" id="pback">戻る</button><button class="btn pri" id="pok">この内容で設定する</button></div></div>`;
    $('#pback').onclick = () => planPanel(d, p);
    $('#pok').onclick = async () => { $('#pok').disabled = true; try { await doPost('/api/plans', { instrument_id: d.id, amount, day_of_month: dom }); toast('積立を設定しました'); await refresh(); viewInstrument(d.id); } catch (e) { if (e.unknown) $('#pmsg').innerHTML = '<div class="msg warn">結果が未確認です。画面を更新して設定を確認してください。重複して設定されることはありません。</div>'; else if (!e.ended) { $('#pmsg').innerHTML = `<div class="msg err">⚠ ${esc(e.message)}</div>`; $('#pok').disabled = false; } } };
  };
}

// ---------- 注文・履歴・比較・ニュース・その他 ----------
async function viewOrders() {
  const h = await api('GET', '/api/history'); const cur = S.me.account.sim_date; const m = S.me;
  const open = h.orders.filter((o) => o.status === 'accepted'), done = h.orders.filter((o) => o.status !== 'accepted');
  $('#view').innerHTML = `<h1>注文</h1><h2>受付済み</h2>${open.length ? open.map((o) => orderLine(o, !locked(), cur)).join('') : '<div class="msg info">受付済みの注文はありません。</div>'}
  <h2>積立</h2>${m.plans.length ? m.plans.map((p) => `<div class="card"><b>${esc(p.name)}</b> ${yen(p.amount)} 毎月${p.day_of_month}日以降の最初の営業日 ${p.status === 'active' ? '<span class="tag acc">有効</span>' : '<span class="tag cx">休止中</span>'}<br><a href="#/i/${esc(p.instrument_id)}">変更・休止・解除</a></div>`).join('') : '<div class="msg info">積立の設定はありません。投資信託の詳細から設定できます。</div>'}
  <h2>成立・取消・失効</h2>${done.length ? done.slice(0, 50).map((o) => orderLine(o, false, cur)).join('') : '<div class="msg info">まだありません。</div>'}`;
  bindCancel(viewOrders);
}
const LTYPE = { deposit: '入金', buy: '買付（約定）', sell: '売却（約定）', fee: '手数料等（約定）', purchase_settlement: '買付代金の支払（受渡）', sale_settlement: '売却代金の受取（受渡）', dividend: '配当・分配金（税引前）', split_fraction: '端数株の処分代金' };
const NONCASH = new Set(['buy', 'sell', 'fee']);
async function viewHistory() {
  const h = await api('GET', '/api/history'); const att = S.me.account.attempt;
  $('#view').innerHTML = `<h1>履歴</h1><div class="btns"><a class="btn" href="#/compare">試行の比較</a></div>
  <h2>お金・数量の動き</h2><div class="card"><table><tr><th>日付</th><th>種別</th><th class="n">金額</th></tr>${h.ledger.slice(0, 200).map((l) => `<tr><td>${esc(l.date)}</td><td>${esc(LTYPE[l.type] || l.type)}${l.name ? '<br><span class="sub">' + esc(l.name) + (l.qty ? ' ' + l.qty.toLocaleString('ja-JP') : '') + '</span>' : ''}${l.note ? '<br><span class="sub">' + esc(l.note) + '</span>' : ''}</td><td class="n">${NONCASH.has(l.type) ? '(' + signYen(l.amount) + ')' : signYen(l.amount)}</td></tr>`).join('')}</table><div class="sub">括弧内は約定の記録で、現金は受渡日に動きます（「受渡」の行が現金の増減です）。</div></div>
  <h2>注文の履歴</h2>${h.orders.slice(0, 100).map((o) => orderLine(o, false, S.me.account.sim_date)).join('') || '<div class="msg info">まだありません。</div>'}
  ${att > 1 ? `<h2>過去の試行（閲覧専用）</h2>${Array.from({ length: att - 1 }, (_, k) => `<button class="btn" data-att="${k + 1}">${k + 1}回目を見る</button>`).join(' ')}<div id="attbox"></div>` : ''}`;
  document.querySelectorAll('[data-att]').forEach((b) => b.addEventListener('click', async () => { const r = await api('GET', '/api/history?attempt=' + b.dataset.att); $('#attbox').innerHTML = `<h3>${b.dataset.att}回目（閲覧専用）</h3>` + r.orders.map((o) => orderLine(o, false, '')).join(''); }));
}
async function viewCompare() {
  const c = await api('GET', '/api/compare');
  $('#view').innerHTML = `<p><a href="#/history">← 履歴へ</a></p><h1>試行の比較</h1><div class="msg info">${esc(c.note)} 同じ初期条件（初期資金 ${yen(c.conditions.initial_cash)}、毎月の追加資金 ${yen(c.conditions.monthly_deposit)}）で、<b>${jdate(c.common_date)}</b> 時点の値を並べています。</div>
  ${c.rows.length < 2 ? '<div class="msg info">比較するには、「その他」から結果を保存して、同じ条件でやり直してください。</div>' : ''}
  <div class="card"><table><tr><th>試行</th><th class="n">総資産</th><th class="n">入金累計</th><th class="n">損益（税引前）</th></tr>${c.rows.map((r) => `<tr><td>${r.attempt}回目${r.attempt === 1 ? '（初回）' : '（再試行）'}</td><td class="n">${yen(r.at_common?.total)}</td><td class="n">${yen(r.at_common?.deposits)}</td><td class="n">${r.at_common ? plLabel(r.at_common.total - r.at_common.deposits) : '-'}</td></tr>`).join('')}</table></div>
  <div class="card">${chart(c.rows[c.rows.length - 1].series.map((s) => [s.date, s.total]), { label: '最新の試行の総資産' })}</div>
  ${c.rows.map((r) => `<div class="card"><b>${r.attempt}回目</b>（実際の進行日: ${jdate(r.sim_date)}）<br>約定 ${r.trades}件 ／ 手数料等の合計 ${yen(r.fees)}<br>保有: ${r.holdings.map((x) => esc(x.name) + ' ' + yen(x.value)).join('、') || 'なし'}</div>`).join('')}`;
}
async function viewNews() {
  $('#view').innerHTML = `<p><a href="#/home">← ホームへ</a></p><h1>これまでのイベント</h1><p class="sub">当時すでに公表されていたものだけを表示します。出典の記事は外部サイトです。</p>${newsList(S.me.news)}`;
}
async function viewMore() {
  const m = S.me;
  $('#view').innerHTML = `<h1>その他</h1><h2>注意事項</h2>${discHtml()}
  <h2>このシミュレーターで再現していること</h2><ul><li>${m.event.data.kind === 'dev_test' ? '開発用の架空データ' : '出典を確認した過去の実データ（基準価額・価格、分配金・配当、分割）'}。期間 ${jdate(m.event.period.start)} 〜 ${jdate(m.event.period.end)}。仮定の利回り・乱数・予測による価格は使っていません</li><li>投資信託は金額指定の購入・売却・積立。株式・ETF（データに含まれる場合）は成行のみ・翌営業日の始値で約定</li><li>購入単位・手数料・信託財産留保額・受渡日（商品条件。現在の条件を過去の期間に適用）</li></ul>
  <h2>データの出典</h2><ul>${m.event.data.sources.map((s) => `<li>${esc(s.name)}（取得日 ${esc(s.retrieved_at)}）</li>`).join('') || '<li>-</li>'}</ul>
  <h2>用語</h2>${Object.keys(TERMS).map((k) => `<details><summary>${esc(TERMS[k][0])}</summary><p>${esc(TERMS[k][1])}</p></details>`).join('')}
  <h2>設定</h2><div class="card">初期資金 ${yen(m.event.initial_cash)} ／ 毎月の追加資金 ${yen(m.event.monthly_deposit)} ${Object.values(m.event.provisional || {}).some(Boolean) ? '<span class="tag prov">仮設定</span>' : ''}<div class="sub">版: アプリ ${esc(m.event.app_version)} ／ 計算仕様 ${esc(m.event.calc_spec_version)}</div></div>
  <h2>同じ条件でやり直す</h2><div class="card"><p>今回の結果は保存され、閲覧専用として残ります。初期資金・毎月の追加資金・期間は同じまま、${m.account.attempt + 1}回目を始めます。</p><div id="rsmsg"></div><button class="btn" id="restart" ${m.event.status === 'paused' ? 'disabled' : ''}>結果を保存してやり直す</button></div>
  <h2>データの扱い</h2><p class="sub">氏名・メールアドレスなどは取得しません。参加データは説明会終了の ${m.event.retention_hours} 時間後に自動削除されます。端末に残った画面表示（スクリーンショット等）は回収できません。</p>`;
  $('#restart').addEventListener('click', async () => { if (!confirm('結果を保存して、最初からやり直します。よろしいですか？')) return; try { const r = await doPost('/api/restart', {}); S.stop = null; S.last = []; toast(r.message); location.hash = '#/home'; route(); } catch (e) { if (!e.ended) $('#rsmsg').innerHTML = `<div class="msg err">${esc(e.message)}${e.unknown ? '（結果が未確認です。履歴で確認してください）' : ''}</div>`; } });
}

route();
