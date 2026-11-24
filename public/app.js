'use strict';
// 参加者画面。計算は一切行わず、サーバーの結果を表示するだけ。残高・日付を送信しない（expected_sim_date のみ送る）。
// 開始時の質問（学年・収入・支出）への回答はこの端末の中だけで使い、サーバーへ送るのは「最初の金額」「毎月の金額」の2つだけ。
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n).toLocaleString('ja-JP');
const yen = (n) => (n == null ? '-' : num(n) + '円');
const signYen = (n) => (n > 0 ? '+' : n < 0 ? '−' : '±') + num(Math.abs(n)) + '円';
const plLabel = (n) => `<span class="pl ${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${n > 0 ? '▲ 利益 ' : n < 0 ? '▼ 損失 ' : '― 損益なし '}${signYen(n)}</span>`;
const milli = (m) => (m == null ? '-' : (m / 1000).toLocaleString('ja-JP', { maximumFractionDigits: 3 }));
const jdate = (d) => (d ? `${d.slice(0, 4)}年${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日` : '-');
const TOKEN_KEY = 'nisa_sim_token', PROFILE_KEY = 'nisa_sim_profile', GUIDE_KEY = 'nisa_sim_guide';
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 保存できない環境では毎回やり直し */ } }, del: (k) => { try { localStorage.removeItem(k); } catch { /* noop */ } } };
const store = { get: () => ls.get(TOKEN_KEY), set: (v) => ls.set(TOKEN_KEY, v), clear: () => { ls.del(TOKEN_KEY); ls.del(PROFILE_KEY); ls.del(GUIDE_KEY); } };
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

const DISC = [
  '本シミュレーションのいかなる内容も将来の結果を予測し保証するものではありません',
  '本シミュレーションを利用することで生じるいかなる損害についても当金庫が責任を負うものではありません。実際の資産運用や投資判断に当たっては、必ずご自身の責任において最終判断してください。',
  '本シミュレーションは特定の金融商品の取引を推奨し、勧誘するものではありません。',
];
const discHtml = () => `<div>${DISC.map((t) => `<p class="disc">${esc(t)}</p>`).join('')}
<p class="disc">過去の実績は将来の成果を保証するものではありません。</p>
<p class="disc">このシミュレーターは<b>過去の実データに基づく取引体験</b>です。将来の価格や運用成果の予測・生成は行いません。画面の日付より後の情報を表示しないのは、過去を順番に体験するための制御で、将来を予測しているわけではありません。データの最終日より先には進めません。</p>
<p class="disc">NISA対象の商品を扱いますが、NISA口座の制度（年間投資枠・枠の復活・対象商品の区分・税務処理）は再現していません。「NISAと普通の口座の比較」は、利益に約20%の税金がかかるかどうかだけを比べた概算です。取引条件（手数料・単位・締切・受渡など）は現在の条件を過去の期間に当てはめた簡略なもので、当時の取引条件を完全に再現したものではありません。</p>
<p class="disc"><b>再現していない取引要素:</b> 板・流動性・注文待ち順位・スリッページ、指値・日中売買・信用取引・空売り、NISA口座の投資枠や制度計算、実際の税金の計算（損益は<b>税引前</b>。口座の比較だけ概算の税額を表示）、分配金の再投資、株式の積立（累積投資）。<b>初版の制限:</b> 受渡前に買った株式・口数の売却と、受渡前の売却代金での購入はできません（実際の口座では可能な場合があります）。実際の取引の約定価格・費用・日程とは異なる場合があります。</p></div>`;
const TERMS = {
  simdate: ['シミュレーション上の日付', '過去の市場データ上の日付です。実際の今日の日付や説明会の時刻とは別です。参加者ごとに、ボタンで進めます。'],
  market: ['成行注文（なりゆきちゅうもん）', '値段を指定せず、市場の価格で売買する注文です。このシミュレーターでは、日付の終わりに注文し、次の営業日の始値（寄付き）で約定します。注文時点では価格が分かりません。'],
  fill: ['約定（やくじょう）', '注文が成立して売買が決まることです。'],
  settle: ['受渡（うけわたし）', '約定の数日後に、代金と株式・口数のやり取りが実際に行われることです。買った株式・口数は受渡日まで売れず、買付代金は受渡日に現金から支払います。売却代金は受渡日まで「未受渡」で、新しい購入には使えません（どちらも総資産には反映済みです）。'],
  buying: ['使えるお金（買付可能額）', '新しい注文に使える金額です。現金残高から、受付中の注文のために確保している金額と、受渡日を待っている買付代金を差し引いたものです。売却代金は受渡日に現金になるまで含みません。'],
  total: ['総資産', '現金残高 ＋ 持っている投資対象の評価額 − 未受渡の買付代金 ＋ 未受渡の売却代金 ＋ 未収配当等。約定から受渡までの間も、資産が消えたり重複したりしません。'],
  lot: ['売買単位（単元株）', '株式・ETFは決められた数量（例: 100株）の倍数で買います。'],
  nav: ['基準価額', '投資信託の1万口あたりの値段です。毎営業日に1回決まり、注文時点では分かりません。'],
  holdback: ['信託財産留保額', '投資信託を売るときに差し引かれる費用の一種です（商品によってはゼロ）。'],
  dist: ['配当・分配金', '保有している株式・投資信託から受け取るお金です。このシミュレーターでは税引前の金額で、支払日に入金します。'],
  plan: ['積立', '毎月決まった金額で投資信託を買う仕組みです。このシミュレーターでは投資信託のみ対応です。'],
  reserve: ['確保額', '株式・ETFの成行買いでは、翌日に値上がりしても買えるよう、注文日の終値に余裕（基準とする証券会社の条件で設定）を加えた金額を注文中に確保します。始値がその範囲を超えたら成立せず失効し、確保は戻ります。成立後は実際の代金だけが受渡日まで拘束されます。'],
  pretax: ['税引前', '税金を引く前の金額です。NISA口座では利益に税金がかからないので、この金額がそのまま手元に残ります。普通の口座だった場合の税額は「NISAと普通の口座の比較」で概算を表示します。'],
};
// 環境の帯。確認用環境では、未確定のまま動いている項目を常に表示する
const reviewBanner = (d) => '確認用環境（動作確認用）。本番ではありません' + (d && d.pending && d.pending.length ? '。未確定: ' + d.pending.join('・') : '');
const devBanner = (d) => (d && d.kind === 'production' ? '開発・検算環境（実データ・利用許諾は未確認）。検算専用で、参加者への提供はできません' : '開発・検算環境（架空の開発用テストデータ）。本番ではありません');
function showEnvBanner(env, data) { const eb = $('#envbanner'); if (env === 'dev' || env === 'staging') { eb.hidden = false; eb.textContent = env === 'dev' ? devBanner(data) : reviewBanner(data); } }
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
  $('#top').hidden = true; $('#tabs').hidden = true; $('#statusbar').hidden = true; $('#coach').hidden = true;
  $('#view').innerHTML = `<h1>この説明会の利用は終了しました</h1><div class="msg warn">${esc(msg)}</div><p>新しい操作・参加はできません。画面や端末に残った表示は、サーバー側からは消去できません。</p>${discHtml()}`;
}
function toast(t) { const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; $('#toasts').append(d); setTimeout(() => d.remove(), 5000); }
$('#dlg').addEventListener('close', () => $('#dlg').classList.remove('nc'));
function modal(html) { $('#dlgbody').innerHTML = html; const d = $('#dlg'); if (!d.open) d.showModal(); }
document.addEventListener('click', (e) => {
  const q = e.target.closest('[data-term]'); if (q) { e.preventDefault(); const t = TERMS[q.dataset.term]; modal(`<h3 style="margin-top:0">${esc(t[0])}</h3><p>${esc(t[1])}</p>`); }
});
$('#btn-notice').addEventListener('click', () => modal('<h3 style="margin-top:0">ご利用上の注意</h3>' + discHtml()));
const Q = (k) => `<button class="q" data-term="${k}" aria-label="${esc(TERMS[k][0])}の説明">?</button>`;

// ---------- 状態 ----------
async function refresh() { S.me = await api('GET', '/api/me'); S.offset = Date.parse(S.me.server_now) - Date.now(); renderHeader(); return S.me; }
function renderHeader() {
  const m = S.me; $('#top').hidden = false; $('#tabs').hidden = false;
  if (!S.playing) setClock(m.account.sim_date);
  $('#period').textContent = m.event.data.kind === 'dev_test' ? '架空データ' : '';
  showEnvBanner(m.event.env, m.event.data);
  const sb = $('#statusbar');
  if (m.event.status === 'paused') { sb.hidden = false; sb.textContent = '管理者により一時停止中です。再開まで操作できません。'; }
  else if (m.account.status === 'saved') { sb.hidden = false; sb.textContent = `これは ${m.account.attempt} 回目の記録です（閲覧専用）。`; } else sb.hidden = true;
}
const ymShort = (d) => `${d.slice(0, 4)}.${Number(d.slice(5, 7))}`;
const monthIdx = (d) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
// 日付と「何か月目か」の表示。時間を進める演出の間は、1営業日ずつここを書き換える
function setClock(d) {
  const p = S.me.event.period; const total = monthIdx(p.end) - monthIdx(p.start) + 1, cur = monthIdx(d) - monthIdx(p.start) + 1;
  $('#simdate').textContent = jdate(d);
  $('#tmonth').textContent = `${total}か月のうち ${cur}か月目`;
  const span = Date.parse(p.end) - Date.parse(p.start); $('#tprog').style.width = (span > 0 ? Math.max(0, Math.min(100, ((Date.parse(d) - Date.parse(p.start)) / span) * 100)) : 0) + '%';
}
const locked = () => S.me.event.status === 'paused' || S.me.account.status !== 'active';
const onHome = () => location.hash.startsWith('#/home') || !location.hash;

// ---------- ルーター ----------
const routes = { home: viewHome, detail: viewDetail, market: viewMarket, i: viewInstrument, orders: viewRecords, history: viewRecords, compare: viewCompare, news: viewNews, more: viewMore };
const TAB_OF = { i: 'market', detail: 'home', orders: 'more', history: 'more', compare: 'more', news: 'home' };
async function route() {
  if (S.ended) return;
  const params = new URLSearchParams(location.search);
  const h = location.hash.replace(/^#\/?/, '') || ''; const [name, arg] = h.split('/');
  if (!store.get()) return viewStart(params.get('code'));
  try {
    document.body.classList.remove('sheet-open');
    await refresh();
    const tab = TAB_OF[name] || name || 'home';
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.t === tab));
    await (routes[name] || viewHome)(decodeURIComponent(arg || ''), name);
    window.scrollTo(0, 0); $('#view').focus({ preventScroll: true }); coachSoon();
  } catch (e) { if (!e.ended) $('#view').innerHTML = `<div class="msg err">${esc(e.message)}${e.unknown ? '<br>通信を確認して、画面を更新してください。' : ''}</div>`; }
}
window.addEventListener('hashchange', route);
['visibilitychange', 'pageshow', 'focus', 'online'].forEach((ev) => window.addEventListener(ev, () => { if (!document.hidden && store.get() && !S.ended && !S.auto) refreshQuiet(); }));
async function refreshQuiet() { try { await refresh(); } catch { /* 通信断は次回に再確認 */ } }
setInterval(() => { if (store.get() && !S.ended && !document.hidden && !S.auto) refreshQuiet(); }, 30000); // 期限・一時停止を定期的に再確認

// ---------- 開始: 質問に答えて自分の条件を決める ----------
// 回答（学年・収入・支出）は端末内でのみ使う。サーバーへ送るのは initial_cash と monthly_deposit だけ。
const W = { step: 0, ev: null, code: null, grade: null, income: null, expense: null, monthly: null, initial: null };
const GRADES = ['大学1年', '大学2年', '大学3年', '大学4年', '大学院生', 'その他'];
const WIZ_STEPS = 6;
function startStatusHtml(ev) {
  if (!ev.data_ready) return '<div class="msg warn"><b>データ未設定</b>のため、まだ開始できません。主催者の準備が終わるまでお待ちください。</div>';
  const m = { open: null, not_started: ['', `開始前です。${new Date(ev.starts_at).toLocaleString('ja-JP')} 以降に参加できます（時刻はサーバー基準）。`],
    paused: ['warn', '主催者により一時停止中です。再開までお待ちください。'], ended: ['warn', 'この説明会は終了しました。新しい参加・操作はできません。'], purged: ['warn', 'この説明会は終了し、参加データは削除済みです。'],
    stopped: ['warn', 'この説明会は停止されています。'], not_enabled: ['', '準備中です（公開前）。'], unverified: ['', '準備中です（動作確認が完了していません）。'] }[ev.status];
  return m ? `<div class="msg ${m[0]}">状態: <b>${esc(ev.status_ja)}</b> — ${esc(m[1])}</div>` : '';
}
async function viewStart(code) {
  $('#top').hidden = true; $('#tabs').hidden = true; $('#statusbar').hidden = true;
  const v = $('#view'); if (!code) { v.innerHTML = `<h1>資産形成シミュレーター</h1><div class="msg warn">会場のQRコードから開いてください。参加用の情報がありません。</div>${discHtml()}`; return; }
  let ev; try { ev = await api('GET', '/api/event?code=' + encodeURIComponent(code)); } catch (e) { v.innerHTML = `<h1>資産形成シミュレーター</h1><div class="msg err">${esc(e.message)}</div>`; return; }
  showEnvBanner(ev.env, ev.data);
  W.ev = ev; W.code = code; if (W.monthly == null) W.monthly = ev.funds.defaults.monthly_deposit; if (W.initial == null) W.initial = ev.funds.defaults.initial_cash;
  wizard();
}
const INCOME_CHOICES = [0, 30000, 50000, 80000, 100000, 150000], MONTHLY_CHOICES = [1000, 3000, 5000, 10000, 30000], INITIAL_CHOICES = [0, 10000, 50000, 100000, 300000, 1000000];
const manYen = (n) => (n === 0 ? '0円' : n % 10000 === 0 ? `${num(n / 10000)}万円` : yen(n));
function moneyField(id, value, choices) {
  return `<div class="chips" role="group">${choices.map((c) => `<button type="button" class="chip ${value === c ? 'on' : ''}" data-set="${c}">${manYen(c)}</button>`).join('')}</div>
  <div class="yenin" style="margin-top:6px"><input id="${id}" inputmode="numeric" autocomplete="off" aria-label="金額を自分で入力" placeholder="自分で入力" value="${value == null ? '' : num(value)}"></div>`;
}
function readMoney(id) { const raw = $('#' + id).value.replace(/[,\s円]/g, ''); if (raw === '') return null; return /^\d+$/.test(raw) ? Number(raw) : NaN; }
function wizard() {
  const ev = W.ev; const v = $('#view'); const L = ev.funds.limits; const s = W.step;
  const head = s === 0 ? '' : `<div class="prog" role="progressbar" aria-valuemin="1" aria-valuemax="${WIZ_STEPS}" aria-valuenow="${s}"><span style="width:${(s / WIZ_STEPS) * 100}%"></span></div><div class="num">質問 ${s} / ${WIZ_STEPS}</div>`;
  const foot = (nextLabel, opts = {}) => `<div class="foot"><div id="wmsg"></div><div class="stack"><button class="btn pri" id="wnext" ${opts.disabled ? 'disabled' : ''}>${nextLabel}</button>${s > 0 ? '<button class="btn quiet" id="wback">戻る</button>' : ''}</div>${opts.skip ? '<p style="text-align:center"><button class="linkbtn" id="wskip">質問をとばして、金額だけ決める</button></p>' : ''}</div>`;
  const local = '<p class="fine">回答は送信されません（この端末の中だけ）。</p>';
  let body;
  if (s === 0) body = `<div class="eyebrow">資産形成シミュレーター</div><h1>${esc(ev.name)}</h1>
    <p>自分で選んで、買う・売る・積み立てるを試せます。名前などの入力はなく、実際のお金は動きません。</p>
    <div class="msg">${periodLine(ev.data)}</div>${startStatusHtml(ev)}
    <p>まず、<b>自分に合った金額</b>を決めます（1分）。</p>
    <p class="fine">開催時間: ${esc(new Date(ev.starts_at).toLocaleString('ja-JP'))} 〜 ${esc(new Date(ev.ends_at).toLocaleString('ja-JP'))}。終了後は操作できなくなり、参加データは終了の ${ev.retention_hours} 時間後に自動削除されます（削除には運用上の制約があります。詳しくは主催者にご確認ください）。</p>
    ${foot(ev.joinable ? 'はじめる' : '現在は参加できません', { disabled: !ev.joinable })}`;
  else if (s === 1) body = `<h1>いまの学年を教えてください</h1>${local}<div class="choices">${GRADES.map((g) => `<button type="button" class="chip ${W.grade === g ? 'on' : ''}" data-grade="${g}">${g}</button>`).join('')}</div>${foot('次へ', { skip: true })}`;
  else if (s === 2) body = `<h1>毎月の収入は、だいたいいくらですか</h1><p class="sub">アルバイト・仕送りなどの合計。だいたいでOK。</p>${local}${moneyField('wval', W.income, INCOME_CHOICES)}${foot('次へ', { skip: true })}`;
  else if (s === 3) body = `<h1>毎月の支出は、だいたいいくらですか</h1><p class="sub">家賃・食費・通信費など。だいたいでOK。</p>${local}${moneyField('wval', W.expense, INCOME_CHOICES)}${foot('次へ', { skip: true })}`;
  else if (s === 4) {
    const rest = W.income != null && W.expense != null ? W.income - W.expense : null;
    body = `<h1>毎月、投資に回す金額を決めましょう</h1>
    ${rest != null ? `<p class="calc1">収入 ${yen(W.income)} − 支出 ${yen(W.expense)} ＝ <b>${rest < 0 ? '−' + yen(-rest) : yen(rest)}</b></p>` : '<p class="sub">シミュレーションの中で、毎月はじめに入ってくる金額です。</p>'}
    ${moneyField('wval', W.monthly, [0, ...MONTHLY_CHOICES])}<p class="fine">0〜${yen(L.monthly_max)}、${yen(L.step)}単位。</p>${foot('次へ')}`;
  } else if (s === 5) body = `<h1>最初に用意する金額を決めましょう</h1><p class="sub">スタート時点で持っているお金です。</p>
    ${moneyField('wval', W.initial, INITIAL_CHOICES)}<p class="fine">0〜${yen(L.initial_max)}、${yen(L.step)}単位。</p>${foot('次へ')}`;
  else body = `<h1>この条件で始めます</h1>
    <dl class="pair"><div><dt>最初の金額</dt><dd>${yen(W.initial)}</dd></div><div><dt>毎月入ってくる金額</dt><dd>${yen(W.monthly)}</dd></div></dl>
    <p class="sub">${periodLine(ev.data)} 金額は、あとで「メニュー」から変えてやり直せます。</p>
    <h2 style="margin-top:22px">必ずお読みください</h2>${discHtml()}
    <label style="font-weight:600"><input type="checkbox" id="agree">上記を読み、理解しました</label>
    ${foot('この条件で始める', { disabled: true })}`;
  v.innerHTML = `<div class="wiz">${head}${body}</div>`;
  const msg = (t) => { $('#wmsg').innerHTML = t ? `<div class="msg err">⚠ ${esc(t)}</div>` : ''; };
  const go = (n) => { W.step = n; wizard(); window.scrollTo(0, 0); };
  $('#wback')?.addEventListener('click', () => go(s - 1)); $('#wskip')?.addEventListener('click', () => go(4));
  document.querySelectorAll('[data-grade]').forEach((b) => b.addEventListener('click', () => { W.grade = b.dataset.grade; go(2); }));
  document.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => { $('#wval').value = num(Number(b.dataset.set)); document.querySelectorAll('[data-set]').forEach((x) => x.classList.toggle('on', x === b)); msg(''); }));
  $('#agree')?.addEventListener('change', (e) => { $('#wnext').disabled = !(e.target.checked && ev.joinable); });
  $('#wnext').addEventListener('click', async () => {
    if (s === 0) return go(1);
    if (s === 1) return go(2);
    if (s >= 2 && s <= 5) {
      const val = readMoney('wval'); const key = ['income', 'expense', 'monthly', 'initial'][s - 2];
      if (Number.isNaN(val)) return msg('半角の数字で入力してください');
      if (s <= 3) { W[key] = val; return go(s + 1); } // 収入・支出は空欄でもよい
      if (val == null) return msg('金額を選ぶか、入力してください');
      const max = s === 4 ? L.monthly_max : L.initial_max;
      if (val > max) return msg(`${yen(max)}以下で入力してください`);
      if (val % L.step) return msg(`${yen(L.step)}単位で入力してください`);
      W[key] = val;
      if (s === 5 && W.initial === 0 && W.monthly === 0) return msg('最初の金額と毎月の金額のどちらかは、1,000円以上にしてください');
      return go(s + 1);
    }
    const b = $('#wnext'); b.disabled = true;
    try {
      const r = await api('POST', '/api/join', { code: W.code, initial_cash: W.initial, monthly_deposit: W.monthly });
      store.set(r.token); ls.set(PROFILE_KEY, JSON.stringify({ grade: W.grade, income: W.income, expense: W.expense }));
      ls.del(GUIDE_KEY); history.replaceState(null, '', '/#/home'); route();
    } catch (e) { msg(e.message); b.disabled = false; }
  });
}

// ---------- ガイド: いま押す場所を、画面の上で直接示す ----------
// 説明のページは出さない。対象のボタンを輪で囲み、短いことばを添えるだけ（操作はじゃましない）。最初の時間進行まで終えたら消える。
const coachEl = $('#coach');
function coachTarget() {
  if (ls.get(GUIDE_KEY) === 'done' || !S.me || S.ended || !store.get()) return null;
  const m = S.me; const h = location.hash;
  if (m.account.status !== 'active' || m.event.status === 'paused' || S.auto || S.playing) return null;
  if (onHome()) {
    if (m.series.length > 1 && !S.guideForce) { ls.set(GUIDE_KEY, 'done'); return null; }
    if (S.guideForce && m.series.length > 1 && (m.assets.holdings.length || m.orders.length)) { S.guideForce = false; ls.set(GUIDE_KEY, 'done'); return null; }
    if (!m.orders.length && !m.assets.holdings.length && !m.plans.length) return ['#go-market', 'ここを押して、えらぶ'];
    return ['#adv-month', 'ここを押して、時間を進める'];
  }
  if (h.startsWith('#/market')) return ['.rows a.row', '気になるものを押す'];
  if (h.startsWith('#/i/')) {
    if ($('#orderpanel a[href="#/home"]')) return ['#orderpanel a[href="#/home"]', 'ホームへもどる'];
    if ($('#pamt') || $('#pok')) return null;
    if ($('#submit')) return ['#submit', 'ここを押すと注文'];
    if ($('#tocf')) return $('#tocf').disabled ? ['#oval', '金額を入れる'] : ['#tocf', '内容を確認'];
    return ['[data-mode="buy"]', '「買う」を押す'];
  }
  return null;
}
let coachSel = null;
function coach() {
  const tg = coachTarget(); const el = tg && document.querySelector(tg[0]);
  if (!el || !el.getClientRects().length) { coachEl.hidden = true; coachSel = null; return; }
  const r = el.getBoundingClientRect(); const pad = 6;
  coachEl.hidden = false;
  const ring = coachEl.querySelector('.ring'), tip = coachEl.querySelector('.tip');
  ring.style.cssText = `left:${r.left + window.scrollX - pad}px;top:${r.top + window.scrollY - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
  tip.querySelector('span').textContent = tg[1];
  const below = r.bottom < window.innerHeight - 170; // 見出しを隠さないよう、基本は対象の下に出す（下に余白がなければ上）
  tip.style.cssText = `left:${Math.max(12, Math.min(window.innerWidth - 232, r.left + window.scrollX))}px;top:${below ? r.bottom + window.scrollY + 14 : r.top + window.scrollY - 54}px`;
  tip.classList.toggle('below', below);
  if (coachSel !== tg[0]) { coachSel = tg[0]; if (r.top < 90 || r.bottom > window.innerHeight - 100) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}
let coachT = null; const coachSoon = () => { clearTimeout(coachT); coachT = setTimeout(coach, 80); };
new MutationObserver(coachSoon).observe($('#view'), { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'class'] });
window.addEventListener('resize', coachSoon); window.addEventListener('scroll', coachSoon, { passive: true });
$('#coach-x').addEventListener('click', () => { ls.set(GUIDE_KEY, 'done'); coach(); });
const buzz = (ms = 12) => { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* 対応していない端末では何もしない */ } };

// ---------- 共通部品 ----------
function chart(series, opts = {}) {
  if (!series.length) return '<div class="sub">データがありません</div>';
  if (series.length < 2) return '<p class="fine" style="border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);padding:14px 0">日付を進めると、ここに値動きのグラフが表示されます。</p>';
  const W0 = 600, H = 150, P = 6; const ys = series.map((s) => s[1]); let lo = Math.min(...ys), hi = Math.max(...ys); if (lo === hi) { lo -= 1; hi += 1; }
  const x = (i) => P + (i / Math.max(1, series.length - 1)) * (W0 - 2 * P), y = (v) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const pts = series.map((s, i) => `${x(i).toFixed(1)},${y(s[1]).toFixed(1)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 ${W0} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(opts.label || '推移')}"><line x1="0" y1="${H - 1}" x2="${W0}" y2="${H - 1}" stroke="#c9d0d7" stroke-width="1"/><polyline points="${pts}" fill="none" stroke="#00754a" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>
  <div class="chart-ends"><span>${esc(jdate(series[0][0]))}</span><span>最小 ${esc(num(Math.round(lo)))} ／ 最大 ${esc(num(Math.round(hi)))}</span><span>${esc(jdate(series[series.length - 1][0]))}</span></div>`;
}
// 愛称があればそれを大きく、正式名称は小さく添える（正式名称は必ず表示する）
const shortName = (n) => { const m = String(n).match(/愛称[：:]\s*([^）)』]+)/); return m ? m[1].trim() : String(n).replace(/[（(][^（()）]*[)）]\s*$/, '').trim() || String(n); };
const nameHtml = (n) => { const s = shortName(n); return `<div class="nm">${esc(s)}</div>${s !== n ? `<div class="fine official">${esc(n)}</div>` : ''}`; };
// 分類を1文字の印で表す
const sealChar = (c) => (/金/.test(c) && !/資金/.test(c) ? '金' : /REIT|リート|不動産/i.test(c) ? '不' : /バランス/.test(c) ? '均' : /債/.test(c) ? '債' : /インデックス/.test(c) ? '指' : /海外|世界|外国/.test(c) ? '世' : /国内|日本/.test(c) ? '日' : /ETF/i.test(c) ? 'E' : (c || '・').slice(0, 1));
const seal = (c) => `<span class="seal" aria-hidden="true">${esc(sealChar(c))}</span>`;
function spark(vals) {
  if (!vals || vals.length < 2) return '<svg class="spark" viewBox="0 0 64 24" aria-hidden="true"><line x1="2" y1="12" x2="62" y2="12" stroke="#c9d0d7" stroke-width="1.5" stroke-dasharray="2 3"/></svg>';
  let lo = Math.min(...vals), hi = Math.max(...vals); if (lo === hi) { lo -= 1; hi += 1; }
  const pts = vals.map((v, i) => `${(2 + (i / (vals.length - 1)) * 60).toFixed(1)},${(21 - ((v - lo) / (hi - lo)) * 18).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 64 24" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${vals[vals.length - 1] >= vals[0] ? '#00754a' : '#d0342c'}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
const tagFor = (s) => ({ accepted: '<span class="tag acc">受付済み</span>', filled: '<span class="tag fill">成立済み</span>', cancelled: '<span class="tag cx">取消済み</span>', lapsed: '<span class="tag lap">失効</span>' }[s] || esc(s));
const sideJa = (o) => `${o.side === 'buy' ? '買い' : '売り'}`;
function orderLine(o, cancellable, curDate) {
  const qty = o.kind === 'fund' && o.side === 'buy' ? yen(o.amount) : o.kind === 'fund' ? `${num(o.qty || 0)}口` : `${num(o.qty || 0)}株`;
  let timing = ''; if (o.status === 'accepted') timing = `成立する予定の日: ${jdate(o.exec_date)}`;
  else if (o.status === 'filled') timing = `${jdate(o.closed_date)} 成立${o.price_milli != null ? ` ／ 価格 ${milli(o.price_milli)}` : ''}${o.fee ? ` ／ 費用 ${yen(o.fee)}` : ''}${o.units ? ` ／ ${num(o.units)}口` : ''}`;
  else timing = `${jdate(o.closed_date)}　${esc(o.reason || '')}`;
  const cx = o.status === 'accepted' && cancellable && o.placed_date === curDate ? `<div style="margin-top:8px"><button class="btn danger sm" data-cancel="${o.id}">この注文を取り消す</button></div>` : o.status === 'accepted' ? '<div class="fine">取消できる期限を過ぎています</div>' : '';
  return `<div class="row" style="display:block"><div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline"><span class="nm">${esc(shortName(o.name))}</span>${tagFor(o.status)}</div><div>${sideJa(o)} ${qty}${o.origin === 'plan' ? ' <span class="tag">積立</span>' : ''}</div><div class="fine">注文した日 ${jdate(o.placed_date)}　${timing}</div>${cx}</div>`;
}
async function lookup(requestId) { try { return await api('GET', '/api/requests/' + encodeURIComponent(requestId)); } catch (e) { return e.unknown ? null : { found: false }; } }
async function doPost(path, body) { return api('POST', path, { request_id: rid(), expected_sim_date: S.me.account.sim_date, ...body }); }
// 資産配分: 分類ごとの金額と割合（色だけに頼らず、数値と棒の長さで示す）
function allocHtml(al) {
  if (!al || !al.length) return '';
  return `<table class="alloc"><tr><th>分類</th><th class="n">金額</th><th class="n">割合</th></tr>${al.map((x) => `<tr><td>${esc(x.label)}<div class="bar"><span style="width:${Math.max(0, Math.min(100, x.pct_bp / 100))}%"></span></div></td><td class="n">${yen(x.value)}</td><td class="n">${(x.pct_bp / 100).toFixed(1)}%</td></tr>`).join('')}</table>`;
}
const EV_GROUP = { deposit: '毎月の入金', plan_order: '積立の注文', settled: '売却代金の受渡（入金）', dividend_declared: '配当・分配金の確定', dividend_paid: '配当・分配金等の入金', order_deferred: '基準価額なしによる繰り延べ', split: '分割・併合', split_fraction: '端数株の処分代金の確定' };
// 解説と「考え方の例」。立場の異なる2つを並べ、どちらかをすすめない
function newsMore(n) {
  if (!n.explain && !n.views) return '';
  return `<details class="nx"><summary>解説と考え方の例</summary>${n.explain ? `<p class="nx-e">${esc(n.explain)}</p>` : ''}${n.views ? `<div class="nx-v">${n.views.map((x, i) => `<div class="nx-c ${i ? 'b' : 'a'}"><b>${esc(x.label)}</b><span>${esc(x.text)}</span></div>`).join('')}</div><p class="fine">考え方の例です。どちらが正しいということはなく、今後の値動きを示すものでも、特定の商品の売買をすすめるものでもありません。</p>` : ''}</details>`;
}
// 新しいできごとは、進めた直後にカードで見せる（閉じる／売買する）
function newsCard(list) {
  if (!list.length) return;
  const one = (n) => `<div class="nc-item"><div class="fine">${jdate(n.published_date)} 公表</div><p class="nc-s">${esc(n.summary)}</p>${n.explain ? `<p class="nx-e">${esc(n.explain)}</p>` : ''}${n.views ? `<div class="nc-h">考え方の例</div><div class="nx-v">${n.views.map((x, i) => `<div class="nx-c ${i ? 'b' : 'a'}"><b>${esc(x.label)}</b><span>${esc(x.text)}</span></div>`).join('')}</div>` : ''}<div class="fine">出典: <a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.source_name)}</a></div></div>`;
  const d = $('#dlg'); d.classList.add('nc');
  modal(`<div class="eyebrow">新しいできごと</div>${list.map(one).join('')}<p class="fine">${list.some((n) => n.views) ? '考え方の例は、どちらが正しいということはなく、' : ''}今後の値動きを示すものでも、特定の商品の売買をすすめるものでもありません。</p><div class="btns"><button class="btn" id="nc-close">閉じる</button><button class="btn pri" id="nc-trade">売買する</button></div>`);
  $('#nc-close').onclick = () => d.close(); $('#nc-trade').onclick = () => { d.close(); location.hash = '#/market'; };
}
function newsList(list) {
  if (!list.length) return '<p class="sub">まだ表示するできごとはありません。</p>';
  return `<div class="rows">${list.map((n) => `<div class="row" style="display:block"><div class="fine">${jdate(n.published_date)} 公表</div><div>${esc(n.summary)}</div>${newsMore(n)}<div class="fine">出典: <a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(n.source_name)}</a>　※値動きとの因果関係を示すものではありません</div></div>`).join('')}</div>`;
}

// ---------- ホーム: スクロールなしの1画面（数字・グラフ・押すボタン） ----------
const ICON = { day: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5l11 7-11 7z"/></svg>', month: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5l9 7-9 7zM12 5l9 7-9 7z"/></svg>', auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 1 0 7.7 10h-2.1A6 6 0 1 1 12 6c1.6 0 3 .6 4.1 1.6L13 11h7V4l-2.5 2.5A8 8 0 0 0 12 4z"/></svg>', stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6z"/></svg>' };
const timeButtons = () => `<div class="timebtns"><button class="tb" id="adv-day" ${locked() || S.auto ? 'disabled' : ''}>${ICON.day}<span>1日</span></button><button class="tb main" id="adv-month" ${locked() || S.auto ? 'disabled' : ''}>${ICON.month}<span>1か月</span></button><button class="tb ${S.auto ? 'stop' : ''}" id="auto" ${locked() ? 'disabled' : ''}>${S.auto ? ICON.stop : ICON.auto}<span>${S.auto ? '止める' : '自動'}</span></button></div>`;
// いま押すもの。状態ごとに1種類だけ出す
function actionArea(m) {
  const a = m.assets;
  if (m.event.status === 'paused') return '<p class="hint">一時停止中です。再開までお待ちください。</p>';
  if (m.account.status !== 'active') return `<p class="hint">最終日（${jdate(m.account.final_date)}）に着きました。この先のデータはありません。</p><div class="btns"><a class="btn pri" href="#/orders">記録を見る</a><a class="btn" href="#/more">やり直す</a></div>`;
  if (!S.auto && !m.orders.length && !a.holdings.length && !m.plans.length) return '<a class="btn pri big" id="go-market" href="#/market">投資対象をえらぶ</a>';
  return `<p class="hint">${S.auto ? '自動で進めています' : m.orders.length ? '時間を進めると、注文が成立します' : '時間を進める'}</p>${timeButtons()}`;
}
// 直近に進めた間の出来事は1行だけ見せ、押すと全部を一覧で出す
const EV_KEY = new Set(['order_filled', 'order_lapsed', 'plan_skipped']);
function eventLine() {
  const key = S.last.filter((e) => EV_KEY.has(e.type)); const n = S.last.filter((e) => e.type !== 'end').length;
  if (!n) return '';
  const SHORT = { order_filled: '注文が成立しました', order_lapsed: '注文が失効しました', plan_skipped: '積立が見送られました', news: '新しいできごとがあります' };
  const head = key.length ? SHORT[key[key.length - 1].type] : (EV_GROUP[S.last[S.last.length - 1].type] || 'できごと');
  return `<button class="evline ${S.stop ? 'stop' : ''}" id="evline"><span>${esc(head)}</span><b>${n > 1 ? `ほか${n - 1}件` : '見る'} ›</b></button>`;
}
function showEvents() {
  const li = (e) => `<li>${esc(jdate(e.date))}　${esc(e.text)}</li>`; const list = S.last.filter((e) => e.type !== 'end');
  modal(`<h3 style="margin-top:0">進めた間のできごと</h3>${S.stop ? `<p class="fine">${esc(S.stop.message)}</p>` : ''}<ul>${list.slice(-40).map(li).join('')}</ul>`);
}
// 総資産のグラフ（ホーム）。時間を進める演出では、この線を1営業日ずつ伸ばす
function homeChartPts(series, upto) {
  const all = series.map((s) => s.total); let lo = Math.min(...all), hi = Math.max(...all);
  const minSpan = Math.max(2, hi * 0.04); if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; } // わずかな変化を大きな上下に見せない
  const n = Math.max(2, series.length); const x = (i) => 4 + (i / (n - 1)) * 592, y = (v) => 110 - ((v - lo) / (hi - lo)) * 100;
  return series.slice(0, upto).map((s, i) => `${x(i).toFixed(1)},${y(s.total).toFixed(1)}`).join(' ');
}
const homeChart = (series) => `<svg class="chart home" viewBox="0 0 600 120" preserveAspectRatio="none" role="img" aria-label="総資産の動き"><line x1="0" y1="119" x2="600" y2="119" stroke="#c9d0d7" stroke-width="1"/><polyline id="homeline" points="${homeChartPts(series, series.length)}" fill="none" stroke="#00754a" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
const plBig = (n) => `<span class="plbig ${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}"><small>${n > 0 ? '▲ 利益' : n < 0 ? '▼ 損失' : '損益'}</small>${n === 0 ? '0' : signYen(n).replace('円', '')}<small>円</small></span>`;
// NISA口座と普通の口座（課税口座）の比較。計算はサーバー、画面は表示のみ
function nisaLine(z) {
  if (!z || z.gain <= 0) return '';
  return `<button class="nisaline" id="nisaline"><span>NISAなら税金 <b>0円</b>・普通の口座なら <b>約${yen(z.tax)}</b></span><b>くらべる ›</b></button>`;
}
function nisaBlock(z) {
  if (!z) return '';
  const over = z.over_limit_years.length ? `<p class="fine warn">${z.over_limit_years.map((y) => `${y.year}年の買付は${yen(y.bought)}で、NISAで1年に買える上限（${yen(z.annual_limit)}）を超えています。`).join('')}実際には、上限を超えた分はNISA口座では買えません。</p>` : '';
  if (z.gain <= 0) return `<div class="nisab"><p>${z.gain < 0 ? 'いまは損失なので、NISA口座でも普通の口座でも税金はかかりません。' : 'いまは利益がないので、どちらの口座でも税金はかかりません。'}利益が出たときは、普通の口座では利益の約20%（${z.rate_text}）が税金になり、NISA口座では0円です。</p><p class="fine">NISA口座の損失は、ほかの口座の利益と差し引きすることができません。</p>${over}</div>`;
  return `<div class="nisab"><table>
    <tr><th></th><th class="n">NISA口座</th><th class="n">普通の口座</th></tr>
    <tr><th>利益（税引前）</th><td class="n">${yen(z.gain)}</td><td class="n">${yen(z.gain)}</td></tr>
    <tr><th>税金</th><td class="n">0円</td><td class="n">約${yen(z.tax)}</td></tr>
    <tr class="sum"><th>手元に残る利益</th><td class="n"><b>${yen(z.gain)}</b></td><td class="n"><b>約${yen(z.after_tax)}</b></td></tr></table>
    <p class="nisad">NISA口座のほうが <b>約${yen(z.tax)}</b> 多く残ります。</p>
    <p class="fine">普通の口座の税金は、いますべて売って利益を確定したと仮定し、利益（手数料を引いたあと）の${z.rate_text}で計算した概算です。年ごとの計算や損失の繰り越しは省いています。すべてをNISA口座で買えたと仮定しています。</p>${over}</div>`;
}
async function viewHome() {
  const m = S.me, a = m.assets, v = $('#view'); const fin = m.account.status !== 'active';
  const attemptJa = m.account.attempt === 1 ? '初回' : `${m.account.attempt}回目`;
  v.innerHTML = `<div class="home">
    <div class="eyebrow">${fin ? '結果' : '総資産'} ${Q('total')} <span class="tag">${attemptJa}</span></div>
    <div class="figure"><span id="fig">${num(a.total)}</span><small>円</small></div>
    <div class="heroline"><span id="figpl">${plBig(a.pnl)}</span> <span id="figdelta"></span></div>
    ${homeChart(m.series)}
    <div class="mini"><span>使えるお金 <b>${yen(a.available)}</b></span><a href="#/detail">${a.holdings.length ? `持っているもの ${a.holdings.length}件` : 'くわしく'} ›</a></div>
    ${eventLine()}
    <div class="act">${actionArea(m)}</div>
    ${fin ? `<div class="resultnote"><h2 class="h3">NISAと普通の口座の比較</h2>${nisaBlock(m.nisa)}<p class="fine">期間 ${jdate(m.event.period.start)} 〜 ${jdate(m.account.sim_date)}。過去の実データによる結果であり、将来の成果を保証するものではありません。順位付けや投資判断の評価はしません。損益は税引前です（NISA口座では税金がかからないため、そのまま手元に残る金額です）。${m.account.attempt > 1 ? '再試行では過去の値動きを知ったうえで操作できるため、初回とは区別して表示しています。' : ''}</p>${discHtml()}</div>` : ''}
  </div>`;
  $('#adv-day')?.addEventListener('click', () => advance('day')); $('#adv-month')?.addEventListener('click', () => advance('month'));
  $('#auto')?.addEventListener('click', () => (S.auto ? stopAuto(true) : startAuto()));
  $('#evline')?.addEventListener('click', showEvents);
  $('#nisaline')?.addEventListener('click', () => modal(`<h2>NISAと普通の口座の比較</h2>${nisaBlock(S.me.nisa)}`));
}
// くわしく: 持っているもの・お金の内訳・資産配分・できごと（ホームから1回押して見る）
async function viewDetail() {
  const m = S.me, a = m.assets;
  $('#view').innerHTML = `<p style="margin:10px 0 0"><a href="#/home">‹ ホームへ戻る</a></p><h1>くわしく</h1>
  <section class="blk"><h2>持っているもの</h2>${a.holdings.length ? `<div class="rows">${a.holdings.map((h) => { const u = h.type === 'fund' ? '口' : '株'; return `<a class="row" href="#/i/${esc(h.instrument_id)}">${seal(h.category)}<div class="grow"><div class="nm">${esc(shortName(h.name))}</div><div class="fine">${num(h.qty)}${u}${h.unsettled_qty ? '・受渡前あり' : ''}${h.stale ? ' <span class="tag prov">価格更新なし</span>' : ''}</div></div><div class="r"><div><b>${yen(h.value)}</b></div><div class="fine">${plLabel(h.pnl)}</div></div></a>`; }).join('')}</div>` : '<p class="sub">まだありません。</p>'}</section>
  <section class="blk"><h2>お金の内訳</h2><table>
    <tr><th>現金残高</th><td class="n">${yen(a.cash)}</td></tr><tr><th>うち注文のために確保中</th><td class="n">${yen(a.reserved)}</td></tr><tr><th>受渡を待っている買付代金 ${Q('settle')}</th><td class="n">${yen(a.payable_purchase)}</td></tr>
    <tr><th>使えるお金 ${Q('buying')}</th><td class="n">${yen(a.available)}</td></tr><tr><th>投資対象の評価額</th><td class="n">${yen(a.holdings_value)}</td></tr>${a.receivable_sale ? `<tr><th>受渡を待っている売却代金</th><td class="n">${yen(a.receivable_sale)}</td></tr>` : ''}${a.receivable_dividend ? `<tr><th>未収の配当・分配金等</th><td class="n">${yen(a.receivable_dividend)}</td></tr>` : ''}
    <tr><th>入金した合計</th><td class="n">${yen(a.deposits)}</td></tr><tr><th>損益（税引前 ${Q('pretax')}）</th><td class="n">${plLabel(a.pnl)}</td></tr></table>
    ${m.receivables.length ? `<p class="fine"><b>これからの受渡・入金</b>${m.receivables.map((r) => `<br>・${esc(shortName(r.name))} ${yen(r.amount)} ${({ sale: '売却代金の受取', purchase: '買付代金の支払', dividend: '配当・分配金の入金（税引前）', split_fraction: '端数株代金の入金' })[r.kind]} ${r.due_date === '9999-12-31' ? '（期間外）' : jdate(r.due_date)}`).join('')}</p>` : ''}
    ${m.next_deposit_date ? `<p class="fine">次の入金 ${yen(m.event.monthly_deposit)}・${jdate(m.next_deposit_date)}</p>` : ''}</section>
  <section class="blk"><h2>資産配分</h2>${allocHtml(m.allocation)}</section>
  <section class="blk"><h2>これまでのできごと</h2>${newsList(m.news.slice(0, 3))}${m.news.length > 3 ? '<p><a href="#/news">すべて見る</a></p>' : ''}</section>`;
}
// 時間が進む演出: 進めた営業日を1日ずつ、日付・総資産・グラフ・期間の進み具合に反映する（表示するのはサーバーが返した各日の実績だけ）
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
async function playTime(fromDate) {
  const series = S.me.series; const start = series.findIndex((s) => s.date === fromDate); const line = $('#homeline'), fig = $('#fig');
  if (start < 0 || start >= series.length - 1 || !line || !fig) return;
  const first = series[start], last = series[series.length - 1]; const steps = series.length - 1 - start;
  if (!reduceMotion()) {
    S.playing = true; document.body.classList.add('ticking'); coachEl.hidden = true;
    // 経過時間から「いま何日目を見せるか」を決める（端末が遅くても全体の長さは変わらず、途中の日を飛ばすだけ）
    const dur = Math.max(600, Math.min(1500, 500 + steps * 45)); const t0 = Date.now();
    const frame = () => new Promise((r) => { let done = false; const f = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(f); setTimeout(f, 60); });
    for (;;) {
      const k = Math.min(steps, Math.max(1, Math.ceil(((Date.now() - t0) / dur) * steps))); const s = series[start + k];
      setClock(s.date); fig.textContent = num(s.total); line.setAttribute('points', homeChartPts(series, start + k + 1));
      if (k >= steps || !onHome()) break;
      await frame();
    }
    document.body.classList.remove('ticking'); S.playing = false;
  }
  setClock(last.date);
  const d = last.total - first.total, dep = last.deposits - first.deposits; const el = $('#figdelta');
  if (el) el.innerHTML = `<span class="delta ${d - dep > 0 ? 'pos' : d - dep < 0 ? 'neg' : ''}">この間 ${signYen(d)}${dep ? `（うち入金 ${yen(dep)}）` : ''}</span>`;
  coachSoon();
}
async function advance(mode) {
  if (S.busy) return; S.busy = true;
  document.querySelectorAll('#adv-day,#adv-month').forEach((b) => { b.disabled = true; });
  const from = S.me.account.sim_date; buzz();
  const body = { request_id: rid(), expected_sim_date: from, mode };
  try {
    let r;
    try { r = await api('POST', '/api/advance', body); } catch (e) {
      if (!e.unknown) throw e;
      const q = await lookup(body.request_id); // 受付状況を照会
      if (q === null) throw e; if (!q.found) { toast('進行は受け付けられていませんでした。もう一度押してください'); await refresh(); if (onHome()) await viewHome(); return null; }
      r = q.response;
    }
    S.last = r.events; S.stop = r.stop && r.stop.reason !== 'end' && mode !== 'day' ? r.stop : null;
    if (!S.auto && !onHome()) r.events.slice(-2).forEach((e) => toast(e.text)); // ホームでは「進めた間の出来事」に同じ内容が出るため、重ねて通知しない
    S.playing = onHome() && !reduceMotion(); // 演出が終わるまで、ヘッダーの日付を先に進めない
    await refresh(); if (onHome()) { await viewHome(); await playTime(from); } else S.playing = false;
    if (r.events.some((e) => e.type === 'order_filled')) buzz(30);
    if (onHome()) newsCard(S.me.news.filter((n) => n.published_date > from).reverse());
    return r;
  } catch (e) {
    S.playing = false;
    if (e.status === 409) { S.stop = { message: '画面の日付が古くなっていました。最新の状態に更新しました', next: '' }; await route(); }
    else if (e.unknown) { toast('通信結果が未確認です。通信が戻ったら画面を更新して日付を確認してください（二重には進みません）'); if (onHome()) viewHome(); }
    else if (!e.ended) toast(e.message);
    return null;
  } finally { S.busy = false; }
}
function startAuto() { S.auto = true; S.stop = null; viewHome(); const tick = async () => { if (!S.auto) return; const r = await advance('month'); if (!r || r.stop || S.me.account.status !== 'active') { stopAuto(); if (onHome()) viewHome(); return; } S.autoTimer = setTimeout(tick, 250); }; tick(); }
function stopAuto(rerender) { S.auto = false; clearTimeout(S.autoTimer); if (rerender) viewHome(); }

// ---------- えらぶ ----------
let marketState = { q: '', cat: '' };
async function viewMarket() {
  const r = await api('GET', `/api/instruments?q=${encodeURIComponent(marketState.q)}&category=${encodeURIComponent(marketState.cat)}`);
  const many = r.items.length > 8 || marketState.cat || marketState.q; // 数が少ないうちは、絞り込みや検索を出さない
  $('#view').innerHTML = `<h1 class="vh">えらぶ</h1>
  ${many ? `<div class="chips" role="group" aria-label="分類">${['', ...r.categories].map((c) => `<button class="chip ${marketState.cat === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c || 'すべて')}</button>`).join('')}</div><input id="q" type="search" aria-label="名前で検索" value="${esc(marketState.q)}" placeholder="名前で検索">` : ''}
  <div class="rows compact">${r.items.length ? r.items.map((i) => `<a class="row" href="#/i/${esc(i.id)}" title="${esc(i.name)}">${seal(i.category)}<div class="grow"><div class="nm one">${esc(shortName(i.name))}</div><div class="fine one">${esc(i.category)}${i.qty ? ` ・ <b class="pos">保有 ${yen(i.value)}</b>` : ''}</div></div><div class="r">${spark(i.spark)}<div class="fine">${milli(i.price_milli)}円</div></div></a>`).join('') : '<p class="sub" style="padding:16px 0">該当する投資対象がありません。</p>'}</div>
  <p class="fine" style="margin-top:8px">グラフは直近30営業日。並びは登録順です（特定の商品をすすめるものではありません）。</p>`;
  let tm; const qi = $('#q'); if (qi && marketState.focus) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); marketState.focus = false; }
  qi?.addEventListener('input', (e) => { clearTimeout(tm); tm = setTimeout(() => { marketState.q = e.target.value; marketState.focus = true; viewMarket(); }, 400); });
  document.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { marketState.cat = b.dataset.cat; viewMarket(); }));
}

// ---------- 商品の詳細と注文 ----------
let ord = null;
async function viewInstrument(id) {
  const d = await api('GET', '/api/instruments/' + encodeURIComponent(id)); const isFund = d.type === 'fund'; const t = d.terms; const u = isFund ? '口' : '株';
  const chg = d.prev_close_milli ? d.price_milli - d.prev_close_milli : 0;
  $('#view').innerHTML = `<p style="margin:10px 0 0"><a href="#/market">‹ えらぶへ戻る</a></p>
  <section class="blk" style="padding:4px 0 14px"><div class="namehead">${seal(d.category)}<div><div class="eyebrow">${esc(d.category)}</div><h1 style="margin:2px 0 0">${esc(shortName(d.name))}</h1></div></div>${shortName(d.name) !== d.name ? `<p class="fine one" style="margin:4px 0 0">${esc(d.name)}</p>` : ''}
    <div class="fine" style="margin-top:10px">${d.stale ? '最後に価格がついた日の' : ''}${isFund ? '基準価額' : '終値'} ${isFund ? Q('nav') : ''}　前日比 ${chg > 0 ? '▲ +' : chg < 0 ? '▼ −' : '― '}${milli(Math.abs(chg))}</div>
    <div class="figure md">${milli(d.price_milli)}<small>円</small></div>
    <div style="margin-top:8px">${chart(d.series.map((s) => [s[0], s[1] / 1000]), { label: '価格推移' })}</div>
    <p class="fine">${jdate(S.me.account.sim_date)} までの実績。この先は表示しません。</p>
    ${d.holding ? `<p class="mini" style="margin:8px 0 0"><span><b class="pos">保有中</b> ${num(d.holding.qty)}${u}</span><span class="fine">売れる数量 ${num(d.sellable)}${u}</span></p>` : ''}
    <div class="seg" role="group" aria-label="操作"><button data-mode="buy">買う</button><button data-mode="sell" ${d.holding ? '' : 'disabled style="opacity:.4"'}>売る</button>${isFund && t.savings_ok ? '<button data-mode="plan">積立</button>' : ''}</div>
    <div id="sheet" class="sheet" hidden><div class="sheet-h"><b>${esc(shortName(d.name))}</b><button class="linkbtn" id="sheet-x">とじる</button></div><div id="orderpanel"></div></div>
  </section>
  ${d.open_orders.length ? `<section class="blk"><h2>この商品の受付済み注文</h2><div class="rows">${d.open_orders.map((o) => orderLine({ ...o, name: d.name }, !locked(), S.me.account.sim_date)).join('')}</div></section>` : ''}
  <section class="blk" style="padding:0"><details><summary>説明・取引の条件・出典${t.terms_status !== 'confirmed' ? '　<span class="tag prov">仮設定</span>' : ''}</summary><div class="in"><p>${esc(d.description)}</p><p class="fine">過去を順番に体験するための表示で、この先の値動きを示唆・予測するものではありません。</p><ul>
    ${isFund ? `<li>購入: ${t.spot_buy_ok === false ? '積立（定時定額）のみ' : `${yen(t.min_amount)}以上 ${yen(t.amount_step)}単位`}${t.savings_ok ? ` ／ 積立は ${yen(t.savings_min_amount ?? t.min_amount)}以上 ${yen(t.savings_amount_step ?? t.amount_step)}単位` : ' ／ 積立は取扱なし'}</li><li>購入時手数料 ${(t.fee.rate_ppm / 10000).toFixed(2)}%（税込・購入金額に含む）</li><li>適用価格: 注文した日の${t.nav_offset}営業日後の基準価額（日付の終わりに出した注文は翌営業日の申込として扱います）。注文時点では分かりません</li><li>購入代金の受渡 約定後${t.buy_settlement_days}営業日（受渡前の口数は売却できません）</li><li>売却: 信託財産留保額 ${(t.holdback_ppm / 10000).toFixed(2)}% ${Q('holdback')} ／ 売却代金の受渡 約定後${t.settlement_days}営業日 ${Q('settle')}</li><li>分配金は現金で受け取ります（再投資は未対応）${Q('dist')}</li>` : `<li>売買単位 ${num(t.lot_size)}株（口） ${Q('lot')}</li><li>成行注文のみ。日付の終わりに注文 → 翌営業日の始値で約定 ${Q('market')}</li><li>手数料 ${(t.fee.rate_ppm / 10000).toFixed(3)}%${t.fee.min ? `（最低 ${yen(t.fee.min)}）` : ''}${t.fee.fixed ? ` + ${yen(t.fee.fixed)}` : ''}</li><li>売却代金の受渡 約定後${t.settlement_days}営業日 ${Q('settle')}</li><li>買い注文中は、値上がりに備え${t.price_limit_table ? '注文日の終値＋制限値幅' : `約${(t.buy_reserve_margin_bp / 100).toFixed(0)}%の余裕`}を含む金額を確保します ${Q('reserve')}</li><li>買付代金は受渡日（約定後${t.settlement_days}営業日）に支払い。受渡前の株式は売却できません</li>`}
  </ul><p class="fine">出典: ${d.source ? esc(d.source.name) + '（取得日 ' + esc(d.source.retrieved_at) + '）' : '-'}。条件は現在のものを過去の期間に当てはめています。板・流動性・スリッページは再現していません。</p></div></details></section>`;
  document.body.classList.remove('sheet-open');
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => openOrder(d, b.dataset.mode)));
  $('#sheet-x').addEventListener('click', () => { ord = null; $('#sheet').hidden = true; document.body.classList.remove('sheet-open'); document.querySelectorAll('[data-mode]').forEach((b) => b.classList.remove('on')); coachSoon(); });
  bindCancel(() => viewInstrument(id));
  if (ord && ord.id === id && ord.mode) openOrder(d, ord.mode, true);
}
function bindCancel(after) {
  document.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; try { await doPost(`/api/orders/${b.dataset.cancel}/cancel`, {}); toast('注文を取り消しました'); await refresh(); after(); } catch (e) { if (!e.ended) { toast(e.message); b.disabled = false; } }
  }));
}
const orderSteps = (n) => `<div class="steps">${['入力', '内容確認', '受付結果'].map((s, i) => (i + 1 === n ? `<b>${i + 1} ${s}</b>` : `${i + 1} ${s}`)).join(' › ')}</div>`;
function openOrder(d, mode, keep) {
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  if (!keep) ord = { id: d.id, mode, step: 'input', vals: {} };
  const p = $('#orderpanel'); $('#sheet').hidden = false; document.body.classList.add('sheet-open'); $('#sheet').scrollTop = 0;
  if (locked()) { p.innerHTML = `<div class="msg warn">${S.me.account.status !== 'active' ? 'この口座では注文できません。' : '一時停止中のため注文できません。'}</div>`; return; }
  if (S.auto) { p.innerHTML = '<div class="msg warn">自動進行中は注文できません。ホームで止めてから操作してください。</div>'; return; }
  if (mode === 'plan') return planPanel(d, p);
  const isFund = d.type === 'fund', side = mode, buy = side === 'buy';
  const lot = d.terms.lot_size || 1;
  const field = isFund && buy ? 'amount' : 'qty';
  if (isFund && buy && d.terms.spot_buy_ok === false) { p.innerHTML = '<div class="msg">この商品は積立（定時定額）でのみ購入できます。「積立」から設定してください。</div>'; return; }
  const label = isFund && buy ? `いくら買いますか（${num(d.terms.min_amount)}円以上・${num(d.terms.amount_step)}円単位）` : isFund ? '何口売りますか' : `何株${buy ? '買い' : '売り'}ますか（${lot}株単位）`;
  const saved = ord.vals[field] ?? '';
  if (ord.step === 'result') return orderResult(d, p);
  if (ord.step === 'confirm') return orderConfirm(d, p, side, field);
  p.innerHTML = `<div class="card">${orderSteps(1)}
  <label for="oval">${esc(label)}</label><div class="${isFund && buy ? 'yenin' : ''}"><input id="oval" inputmode="numeric" autocomplete="off" value="${esc(saved)}"></div>
  ${buy ? `<p class="fine">使えるお金: ${yen(d.available)}</p>` : `<p class="fine">売れる数量: ${num(d.sellable || 0)}${isFund ? '口' : '株'}${d.holding && d.holding.unsettled_qty > 0 ? `（ほかに受渡前の買付分 ${num(d.holding.unsettled_qty)}${isFund ? '口' : '株'}は受渡日まで売れません）` : ''}</p>${d.sellable ? `<label style="font-weight:600"><input type="checkbox" id="sellall" ${ord.vals.sell_all ? 'checked' : ''}>すべて売る</label>` : ''}`}
  <div id="prev" aria-live="polite"></div><div class="stack"><button class="btn pri" id="tocf" disabled>内容を確認する</button></div></div>`;
  const inp = $('#oval'); const all = $('#sellall'); let tmr;
  const run = async () => {
    const raw = inp.value.trim().replace(/,/g, ''); ord.vals[field] = inp.value; ord.vals.sell_all = !!all?.checked;
    inp.disabled = !!all?.checked;
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
    if (isFund) rows.push(['購入金額（手数料込み）', yen(i.amount)], ['うち購入時手数料（見込み）', yen(i.fee_estimate)]);
    else rows.push(['株数', num(i.qty) + '株'], ['参考金額（現在の終値 × 株数）', yen(i.reference_amount)], ['注文中に確保する金額（値上がりに備えた余裕を含む）', yen(i.reserve)], ['手数料（見込み）', yen(i.fee_estimate)]);
  } else rows.push([isFund ? '売却口数' : '売却株数', num(i.qty) + (isFund ? '口' : '株')]);
  const sd = i.settle_date === '9999-12-31' ? '期間外（期間内には受渡されません）' : jdate(i.settle_date);
  rows.push(['成立する日', jdate(i.exec_date)]);
  const more = [['成立する価格', isFund ? 'この日の基準価額（いまは分かりません）' : 'この日の始値（いまは分かりません）'], i.side === 'sell' ? ['代金を受け取る日', sd + '（それまで買付に使えません）'] : ['受渡の予定日（売れるようになる日）', sd], ['取消できる期限', '日付を進める前まで'], ['使えるお金', yen(i.available)]];
  if (i.side === 'buy' && isFund) more.push(['注文中に確保する金額', yen(i.reserve)]);
  const tr = ([k, v]) => `<tr><th>${esc(k)}</th><td class="n">${esc(v)}</td></tr>`;
  return `<table>${rows.map(tr).join('')}</table><details class="plain"><summary>くわしく</summary><div class="in"><table>${more.map(tr).join('')}</table></div></details>`;
}
function orderConfirm(d, p) {
  const i = ord.preview.info;
  p.innerHTML = `<div class="card">${orderSteps(2)}<h3>${esc(shortName(d.name))} を${i.side === 'buy' ? '買う' : '売る'}</h3>${previewHtml(i, d)}
  <p class="fine">価格は成立する日まで決まりません。${i.side === 'buy' && d.type !== 'fund' ? '成行買いでは、確保額を超えて値上がりした場合は成立せず失効します。' : ''}</p>
  <div id="ordmsg"></div><div class="stack"><button class="btn pri" id="submit">この内容で注文する</button><button class="btn quiet" id="back">戻る</button></div></div>`;
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
  $('#ordmsg').innerHTML = '<div class="msg">この注文は<b>受け付けられていません</b>。同じ内容でもう一度送信できます。</div>';
  $('#submit').textContent = '同じ内容で送信する'; $('#submit').disabled = false; $('#submit').onclick = () => { $('#submit').disabled = true; sendPending(d, p); };
}
function orderResult(d, p) {
  const i = ord.result.info; buzz(25); p.innerHTML = `<div class="card done">${orderSteps(3)}<div class="stampwrap"><span class="stamp" role="img" aria-label="受付済み">受付</span><div><b>${esc(ord.result.message)}</b>${ord.result.replayed ? '（同じ注文の結果を確認しました）' : ''}<div class="fine">${jdate(i.exec_date)} の価格で成立する予定（まだ成立していません）</div></div></div>
  <div class="stack"><a class="btn pri" href="#/home">ホームで時間を進める</a><button class="btn quiet" id="again">続けて別の注文をする</button></div></div>`;
  $('#again').addEventListener('click', () => { ord = null; viewInstrument(d.id); });
}
function planPanel(d, p) {
  const t = { ...d.terms, min_amount: d.terms.savings_min_amount ?? d.terms.min_amount, amount_step: d.terms.savings_amount_step ?? d.terms.amount_step }; const pl = d.plan;
  if (pl) {
    p.innerHTML = `<div class="card"><h3 style="margin-top:0">積立の設定 ${Q('plan')}</h3><p>毎月 ${pl.day_of_month}日以降の最初の営業日に ${yen(pl.amount)} ／ <b>${pl.status === 'active' ? '有効' : '休止中'}</b></p>
    <label for="pamt">積立額を変える</label><div class="yenin"><input id="pamt" inputmode="numeric" value="${pl.amount}"></div><p class="fine">変更・休止・再開・解除は、次回以降の注文から反映されます。</p><div id="pmsg"></div>
    <div class="stack"><button class="btn pri" id="pchg">金額を変更する</button>${pl.status === 'active' ? '<button class="btn quiet" id="ppause">休止する</button>' : '<button class="btn" id="presume">再開する</button>'}<button class="btn danger" id="pcancel">解除する</button></div></div>`;
    const act = async (body, msg) => { try { await doPost('/api/plans/' + pl.id, body); toast(msg); await refresh(); viewInstrument(d.id); } catch (e) { if (!e.ended) $('#pmsg').innerHTML = `<div class="msg err">⚠ ${esc(e.message)}</div>`; } };
    $('#pchg').onclick = () => act({ action: 'amount', amount: Number($('#pamt').value.replace(/,/g, '')) }, '積立額を変更しました（次回の注文から）');
    $('#ppause')?.addEventListener('click', () => act({ action: 'pause' }, '休止しました')); $('#presume')?.addEventListener('click', () => act({ action: 'resume' }, '再開しました'));
    $('#pcancel').onclick = () => { if (confirm('この積立を解除します。よろしいですか？')) act({ action: 'cancel' }, '解除しました'); };
    return;
  }
  p.innerHTML = `<div class="card">${orderSteps(1)}
  <label for="pamt">毎月いくら積み立てますか（${num(t.min_amount)}円以上・${num(t.amount_step)}円単位）</label><div class="yenin"><input id="pamt" inputmode="numeric" autocomplete="off"></div>
  <label for="pdom">毎月何日に買いますか（1〜28。休みの日は次の営業日）</label><input id="pdom" inputmode="numeric" value="5"><div id="pmsg"></div>
  <p class="fine">使えるお金が足りない月は見送られます。${Q('plan')}</p>
  <div class="stack"><button class="btn pri" id="pgo">内容を確認する</button></div></div>`;
  $('#pgo').onclick = () => {
    const amount = Number($('#pamt').value.replace(/,/g, '')), dom = Number($('#pdom').value);
    if (!Number.isInteger(amount) || amount < t.min_amount || amount % t.amount_step) return void ($('#pmsg').innerHTML = `<div class="msg err">⚠ 積立額は ${yen(t.min_amount)}以上、${yen(t.amount_step)}単位で入力してください</div>`);
    if (!Number.isInteger(dom) || dom < 1 || dom > 28) return void ($('#pmsg').innerHTML = '<div class="msg err">⚠ 積立日は1〜28の整数で入力してください</div>');
    const day = Number(S.me.account.sim_date.slice(8, 10)); const ym = S.me.account.sim_date.slice(0, 7); let [Y, M] = ym.split('-').map(Number); if (day >= dom) { M++; if (M > 12) { M = 1; Y++; } }
    p.innerHTML = `<div class="card">${orderSteps(2)}<h3>${esc(d.name)} の積立</h3><table><tr><th>毎月の金額</th><td class="n">${yen(amount)}</td></tr><tr><th>買う日</th><td class="n">毎月${dom}日以降の最初の営業日</td></tr><tr><th>最初の注文</th><td class="n">${Y}年${M}月</td></tr><tr><th>適用される価格</th><td class="n">注文の${d.terms.nav_offset}営業日後の基準価額</td></tr></table><div id="pmsg"></div><div class="stack"><button class="btn pri" id="pok">この内容で設定する</button><button class="btn quiet" id="pback">戻る</button></div></div>`;
    $('#pback').onclick = () => planPanel(d, p);
    $('#pok').onclick = async () => { $('#pok').disabled = true; try { await doPost('/api/plans', { instrument_id: d.id, amount, day_of_month: dom }); await refresh();
      buzz(25); p.innerHTML = `<div class="card done">${orderSteps(3)}<div class="stampwrap"><span class="stamp" role="img" aria-label="設定済み">設定</span><div><b>積立を設定しました</b><div class="fine">日付が進むと、毎月自動で注文が出ます</div></div></div><div class="stack"><a class="btn pri" href="#/home">ホームで時間を進める</a></div></div>`;
    } catch (e) { if (e.unknown) $('#pmsg').innerHTML = '<div class="msg warn">結果が未確認です。画面を更新して設定を確認してください。重複して設定されることはありません。</div>'; else if (!e.ended) { $('#pmsg').innerHTML = `<div class="msg err">⚠ ${esc(e.message)}</div>`; $('#pok').disabled = false; } } };
  };
}

// ---------- 記録（注文・お金の動き）・比較・できごと・メニュー ----------
const LTYPE = { deposit: '入金', buy: '買付（約定）', sell: '売却（約定）', fee: '手数料等（約定）', purchase_settlement: '買付代金の支払（受渡）', sale_settlement: '売却代金の受取（受渡）', dividend: '配当・分配金（税引前）', split_fraction: '端数株の処分代金' };
const NONCASH = new Set(['buy', 'sell', 'fee']);
async function viewRecords(_arg, name) {
  const tab = name === 'history' ? 'money' : 'orders';
  const h = await api('GET', '/api/history'); const cur = S.me.account.sim_date; const m = S.me; const att = m.account.attempt;
  const open = h.orders.filter((o) => o.status === 'accepted'), done = h.orders.filter((o) => o.status !== 'accepted');
  const seg = `<div class="seg" role="group" aria-label="表示の切り替え"><button data-go="#/orders" class="${tab === 'orders' ? 'on' : ''}">注文と積立</button><button data-go="#/history" class="${tab === 'money' ? 'on' : ''}">お金の動き</button></div>`;
  const body = tab === 'orders' ? `
  <section class="blk"><h2>受付済みの注文</h2>${open.length ? `<div class="rows">${open.map((o) => orderLine(o, !locked(), cur)).join('')}</div>` : '<p class="sub">ありません。</p>'}</section>
  <section class="blk"><h2>積立</h2>${m.plans.length ? `<div class="rows">${m.plans.map((p) => `<a class="row" href="#/i/${esc(p.instrument_id)}"><div class="grow"><div class="nm">${esc(p.name)}</div><div class="fine">毎月${p.day_of_month}日以降の最初の営業日 ／ ${p.status === 'active' ? '有効' : '休止中'}</div></div><div class="r"><b>${yen(p.amount)}</b></div></a>`).join('')}</div>` : '<p class="sub">ありません。投資信託の画面から設定できます。</p>'}</section>
  <section class="blk"><h2>成立・取消・失効</h2>${done.length ? `<div class="rows">${done.slice(0, 60).map((o) => orderLine(o, false, cur)).join('')}</div>` : '<p class="sub">まだありません。</p>'}</section>` : `
  <section class="blk"><h2>お金・数量の動き</h2>${h.ledger.length ? `<table><tr><th>日付</th><th>内容</th><th class="n">金額</th></tr>${h.ledger.slice(0, 200).map((l) => `<tr><td>${esc(l.date)}</td><td>${esc(LTYPE[l.type] || l.type)}${l.name ? '<br><span class="fine">' + esc(l.name) + (l.qty ? ' ' + num(l.qty) : '') + '</span>' : ''}</td><td class="n">${NONCASH.has(l.type) ? '(' + signYen(l.amount) + ')' : signYen(l.amount)}</td></tr>`).join('')}</table><p class="fine">括弧内は約定の記録で、現金は受渡日に動きます（「受渡」の行が現金の増減です）。</p>` : '<p class="sub">まだありません。</p>'}</section>`;
  $('#view').innerHTML = `<p style="margin:10px 0 0"><a href="#/more">‹ メニューへ戻る</a></p><h1>記録</h1>${seg}${body}
  <section class="blk"><h2>試行の比較</h2><p class="sub">やり直した回がある場合、同じ日付の時点で並べて見られます。</p><div class="stack"><a class="btn quiet" href="#/compare">試行を比べる</a></div>
  ${att > 1 ? `<p class="fine" style="margin-top:14px">過去の試行の注文（閲覧専用）</p><div class="chips">${Array.from({ length: att - 1 }, (_, k) => `<button class="chip" data-att="${k + 1}">${k + 1}回目</button>`).join('')}</div><div id="attbox"></div>` : ''}</section>`;
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.go; }));
  document.querySelectorAll('[data-att]').forEach((b) => b.addEventListener('click', async () => { const r = await api('GET', '/api/history?attempt=' + b.dataset.att); $('#attbox').innerHTML = `<h3>${b.dataset.att}回目（閲覧専用）</h3><div class="rows">${r.orders.map((o) => orderLine(o, false, '')).join('') || '<p class="sub">注文はありません。</p>'}</div>`; }));
  bindCancel(() => viewRecords(_arg, name));
}
async function viewCompare() {
  const c = await api('GET', '/api/compare');
  $('#view').innerHTML = `<p style="margin:10px 0 0"><a href="#/orders">‹ 記録へ戻る</a></p><h1>試行を比べる</h1><p class="sub">${esc(c.note)}</p>
  <p class="fine"><b>${jdate(c.common_date)}</b> 時点の値を並べています。</p>
  ${c.rows.length < 2 ? '<div class="msg">比べるには、「メニュー」からやり直して2回目を進めてください。</div>' : ''}
  <table><tr><th>試行</th><th class="n">総資産</th><th class="n">入金した合計</th><th class="n">損益（税引前）</th></tr>${c.rows.map((r) => `<tr><td>${r.attempt}回目${r.attempt === 1 ? '（初回）' : '（再試行）'}<br><span class="fine">最初 ${yen(r.conditions.initial_cash)}・毎月 ${yen(r.conditions.monthly_deposit)}</span></td><td class="n">${yen(r.at_common?.total)}</td><td class="n">${yen(r.at_common?.deposits)}</td><td class="n">${r.at_common ? plLabel(r.at_common.total - r.at_common.deposits) : '-'}</td></tr>`).join('')}</table>
  <section class="blk"><h2>最新の試行の総資産の動き</h2>${chart(c.rows[c.rows.length - 1].series.map((s) => [s.date, s.total]), { label: '最新の試行の総資産' })}</section>
  <section class="blk"><h2>各試行の内容</h2><div class="rows">${c.rows.map((r) => `<div class="row" style="display:block"><div class="nm">${r.attempt}回目</div><div class="fine">進めた日付 ${jdate(r.sim_date)} ／ 成立 ${r.trades}件 ／ 手数料等の合計 ${yen(r.fees)}</div><div class="fine">保有: ${r.holdings.map((x) => esc(x.name) + ' ' + yen(x.value)).join('、') || 'なし'}</div></div>`).join('')}</div></section>`;
}
async function viewNews() {
  $('#view').innerHTML = `<p style="margin:10px 0 0"><a href="#/home">‹ ホームへ戻る</a></p><h1>これまでのできごと</h1><p class="sub">その日までに公表されていたものだけを表示します。出典の記事は外部サイトです。</p>${newsList(S.me.news)}`;
}
async function viewMore() {
  const m = S.me; let prof = null; try { prof = JSON.parse(ls.get(PROFILE_KEY) || 'null'); } catch { /* noop */ }
  const end = new Date(m.event.ends_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const L = m.event.funds_limits;
  $('#view').innerHTML = `<h1>メニュー</h1>
  <div class="rows"><a class="row" href="#/orders"><div class="grow nm">記録（注文・お金の動き・比較）</div></a><a class="row" href="#/detail"><div class="grow nm">くわしく（内訳・資産配分・できごと）</div></a></div>
  <section class="blk"><h2>いまの条件</h2><dl class="pair" style="border-top:0;margin-top:0"><div><dt>最初の金額</dt><dd>${yen(m.event.initial_cash)}</dd></div><div><dt>毎月入ってくる金額</dt><dd>${yen(m.event.monthly_deposit)}</dd></div></dl>
    ${prof && (prof.grade || prof.income != null) ? `<p class="fine">はじめの回答（この端末の中だけに保存）: ${[prof.grade, prof.income != null ? `収入 ${yen(prof.income)}` : null, prof.expense != null ? `支出 ${yen(prof.expense)}` : null].filter(Boolean).map(esc).join(' ／ ')}</p>` : ''}
    <p class="fine">説明会の終了予定（実際の時刻）: ${esc(end)}。${Object.values(m.event.provisional || {}).some(Boolean) ? '一部の設定は仮設定です。' : ''}</p></section>
  <section class="blk"><h2>やり直す</h2><p class="sub">いまの結果は保存され、閲覧専用で残ります。${m.account.attempt + 1}回目を最初の日付から始めます。</p>
    <label for="r-init">最初の金額</label><div class="yenin"><input id="r-init" inputmode="numeric" value="${num(m.event.initial_cash)}"></div>
    <label for="r-mon">毎月入ってくる金額</label><div class="yenin"><input id="r-mon" inputmode="numeric" value="${num(m.event.monthly_deposit)}"></div>
    <p class="fine">金額を変えなければ、同じ条件でのやり直しになります。最初 0〜${yen(L.initial_max)}、毎月 0〜${yen(L.monthly_max)}、${yen(L.step)}単位。</p>
    <div id="rsmsg"></div><div class="stack"><button class="btn" id="restart" ${m.event.status === 'paused' ? 'disabled' : ''}>結果を保存してやり直す</button></div></section>
  <section class="blk"><h2>ガイド</h2><p class="sub">押す場所を、画面の上に表示します。</p><div class="stack"><button class="btn quiet" id="reguide">ガイドをもう一度表示する</button></div></section>
  <section class="blk" style="padding-bottom:0"><h2>このシミュレーターについて</h2>
    <details><summary>ご利用上の注意</summary><div class="in">${discHtml()}</div></details>
    <details><summary>再現していること・データの出典</summary><div class="in"><ul><li>${m.event.data.kind === 'dev_test' ? '開発用の架空データ' : '出典を確認した過去の実データ（基準価額・価格、分配金・配当、分割）'}。期間 ${jdate(m.event.period.start)} 〜 ${jdate(m.event.period.end)}。仮定の利回り・乱数・予測による価格は使っていません</li><li>投資信託は金額指定の購入・売却・積立。株式・ETF（データに含まれる場合）は成行のみ・翌営業日の始値で約定</li><li>購入単位・手数料・信託財産留保額・受渡日（商品条件。現在の条件を過去の期間に適用）</li></ul>
      <p class="fine">出典: ${m.event.data.sources.map((s) => `${esc(s.name)}（取得日 ${esc(s.retrieved_at)}）`).join('／') || '-'}</p></div></details>
    <details><summary>用語</summary><div class="in">${Object.keys(TERMS).map((k) => `<p><b>${esc(TERMS[k][0])}</b><br><span class="sub">${esc(TERMS[k][1])}</span></p>`).join('')}</div></details>
    <details><summary>データの扱い</summary><div class="in"><p class="sub">氏名・メールアドレスなどは取得しません。はじめの質問への回答はこの端末の中だけで使い、サーバーには2つの金額だけを送ります。参加データは説明会終了の ${m.event.retention_hours} 時間後に自動削除されます。端末に残った画面表示（スクリーンショット等）は回収できません。</p><p class="fine">版: アプリ ${esc(m.event.app_version)} ／ 計算仕様 ${esc(m.event.calc_spec_version)}</p></div></details>
  </section>`;
  $('#reguide').addEventListener('click', () => { ls.del(GUIDE_KEY); S.guideForce = true; location.hash = '#/home'; });
  $('#restart').addEventListener('click', async () => {
    const rd = (id) => { const raw = $('#' + id).value.replace(/[,\s円]/g, ''); return /^\d+$/.test(raw) ? Number(raw) : NaN; };
    const ic = rd('r-init'), md = rd('r-mon'); const msg = (t) => { $('#rsmsg').innerHTML = `<div class="msg err">⚠ ${esc(t)}</div>`; };
    if (Number.isNaN(ic) || Number.isNaN(md)) return msg('金額は半角の数字で入力してください');
    const same = ic === m.event.initial_cash && md === m.event.monthly_deposit;
    if (!confirm(`結果を保存して、最初からやり直します（${same ? '同じ条件' : `最初 ${yen(ic)}・毎月 ${yen(md)}`}）。よろしいですか？`)) return;
    try { const r = await doPost('/api/restart', same ? {} : { initial_cash: ic, monthly_deposit: md }); S.stop = null; S.last = []; toast(r.message); location.hash = '#/home'; route(); } catch (e) { if (!e.ended) msg(e.message + (e.unknown ? '（結果が未確認です。記録で確認してください）' : '')); }
  });
}

route();
