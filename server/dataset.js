'use strict';
// 市場データの取込・検証・固定（ロック）・メモリ展開。
// 架空データの生成・欠損補完は一切しない。欠損・不足は検証エラーにし、その商品は採用不可とする。
const crypto = require('node:crypto');
const { parseDecimalMilli } = require('./money');
const { tx } = require('./db');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => typeof s === 'string' && ISO.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const ym = (d) => d.slice(0, 7);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const MAX_PRICE_MILLI = 100000000 * 1000; // 1億円
const MAX_PER_UNIT_MILLI = 10000000 * 1000;

// 商品条件。本番データ(strict)では全項目の明示が必須で、既定値は使わない。
// 開発データでは既定値で補うが、その商品は自動的に「仮設定」になる。
const STOCK_REQ = ['lot_size', 'settlement_days', 'fee'];
const FUND_REQ = ['min_amount', 'amount_step', 'nav_offset', 'settlement_days', 'buy_settlement_days', 'holdback_ppm', 'savings_ok', 'distribution_mode', 'fee'];
const DEFAULTS = { settlement_days: 2, buy_settlement_days: 0, nav_offset: 1, holdback_ppm: 0, savings_ok: true, distribution_mode: 'cash', amount_step: 1, fee: { rate_ppm: 0, fixed: 0, min: 0, max: null }, buy_reserve_margin_bp: 3000 };

function normTerms(inst, E, W, strict) {
  const t = inst.terms || {}; const p = `商品 ${inst.id}`; const defaulted = [];
  const req = inst.type === 'fund' ? FUND_REQ : STOCK_REQ;
  const get = (k) => { if (t[k] !== undefined) return t[k]; if (strict) { E(`${p}: 商品条件 terms.${k} が未設定です（本番データでは既定値を使いません）`); return DEFAULTS[k]; } defaulted.push(k); return DEFAULTS[k]; };
  const int = (v, name, min = 0, max = Number.MAX_SAFE_INTEGER) => { if (!Number.isInteger(v) || v < min || v > max) E(`${p}: terms.${name} は ${min}〜${max} の整数で指定してください（値: ${JSON.stringify(v)}）`); return v; };
  const out = {};
  for (const k of req) out[k] = get(k);
  const fee = out.fee || {};
  out.fee = { rate_ppm: int(fee.rate_ppm ?? 0, 'fee.rate_ppm', 0, 1000000), fixed: int(fee.fixed ?? 0, 'fee.fixed', 0, 10000000), min: int(fee.min ?? 0, 'fee.min', 0, 10000000), max: fee.max == null ? null : int(fee.max, 'fee.max', 0, 10000000) };
  if (fee.rate_ppm === undefined) (strict ? E : W)(`${p}: fee.rate_ppm が未設定です`);
  int(out.settlement_days, 'settlement_days', 0, 10);
  if (inst.type === 'fund') {
    int(out.min_amount, 'min_amount', 1, 100000000); int(out.amount_step, 'amount_step', 1, 100000000); int(out.nav_offset, 'nav_offset', 1, 10);
    int(out.buy_settlement_days, 'buy_settlement_days', 0, 10); int(out.holdback_ppm, 'holdback_ppm', 0, 100000);
    if (typeof out.savings_ok !== 'boolean') E(`${p}: terms.savings_ok は true/false`);
    if (out.distribution_mode !== 'cash') E(`${p}: 分配金の再投資は未実装です。distribution_mode は "cash" のみ`);
    // 任意: 積立（定時定額）専用の最低金額・単位、一括（スポット）購入の可否。未指定なら一括購入と同じ単位・購入可
    out.savings_min_amount = t.savings_min_amount ?? out.min_amount; out.savings_amount_step = t.savings_amount_step ?? out.amount_step;
    int(out.savings_min_amount, 'savings_min_amount', 1, 100000000); int(out.savings_amount_step, 'savings_amount_step', 1, 100000000);
    out.spot_buy_ok = t.spot_buy_ok ?? true; if (typeof out.spot_buy_ok !== 'boolean') E(`${p}: terms.spot_buy_ok は true/false`);
    if (out.spot_buy_ok === false && out.savings_ok === false) E(`${p}: 一括購入も積立も不可の商品は登録できません`);
  } else {
    int(out.lot_size, 'lot_size', 1, 100000);
    // 成行買いの確保ルール: 値幅の表（推奨。証券会社/取引所の規則として入力）か、確保率。どちらも無ければ受付不可。
    if (t.price_limit_table !== undefined) {
      const tbl = t.price_limit_table;
      if (!Array.isArray(tbl) || !tbl.length) E(`${p}: price_limit_table は [[基準値段の上限(未満), 制限値幅], ...] の配列`);
      else {
        try {
          out.price_limit_table = tbl.map(([below, width], i) => [parseDecimalMilli(String(below), `${p} price_limit_table[${i}] 上限`), parseDecimalMilli(String(width), `${p} price_limit_table[${i}] 値幅`)]);
          for (let i = 1; i < out.price_limit_table.length; i++) if (out.price_limit_table[i][0] <= out.price_limit_table[i - 1][0]) throw new Error(`${p}: price_limit_table の上限は昇順で指定してください`);
        } catch (e) { E(e.message); }
      }
      out.price_limit_multiplier = t.price_limit_multiplier ?? 1; int(out.price_limit_multiplier, 'price_limit_multiplier', 1, 10);
    } else if (t.buy_reserve_margin_bp !== undefined) out.buy_reserve_margin_bp = int(t.buy_reserve_margin_bp, 'buy_reserve_margin_bp', 0, 100000);
    else if (strict) E(`${p}: 成行買いの確保ルール（price_limit_table または buy_reserve_margin_bp）が未設定です。基準証券会社の条件として設定してください`);
    else { out.buy_reserve_margin_bp = DEFAULTS.buy_reserve_margin_bp; defaulted.push('buy_reserve_margin_bp'); }
  }
  out.terms_status = t.terms_status === 'confirmed' && !defaulted.length ? 'confirmed' : 'provisional';
  if (t.terms_status === 'confirmed' && defaulted.length) W(`${p}: 既定値を使った項目（${defaulted.join(', ')}）があるため「仮設定」として扱います`);
  return out;
}

function parsePricesCsv(text, E) {
  const rows = []; const lines = String(text).replace(/\r/g, '').split('\n');
  const head = (lines.shift() || '').split(',').map((s) => s.trim());
  const need = ['instrument_id', 'date', 'open', 'close', 'status'];
  if (need.some((h, i) => head[i] !== h)) { E(`prices_csv: 1行目は ${need.join(',')} にしてください（実際: ${head.join(',')}）`); return rows; }
  lines.forEach((ln, i) => {
    if (!ln.trim()) return;
    const c = ln.split(',').map((s) => s.trim());
    if (c.length !== 5 || c.some((x) => x.includes('"'))) { E(`prices_csv ${i + 2}行目: 列数が5ではないか、引用符が含まれています`); return; }
    rows.push({ instrument_id: c[0], date: c[1], open: c[2] === '' ? null : c[2], close: c[3], status: c[4] || 'normal', _line: i + 2 });
  });
  return rows;
}

function validateBundle(b, env) {
  const errors = [], warnings = [];
  const E = (m) => errors.push(m), W = (m) => warnings.push(m);
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { errors: ['JSON オブジェクトではありません'], warnings, norm: null, summary: null };
  const m = b.meta || {};
  if (!m.name) E('meta.name がありません');
  if (!['production', 'dev_test'].includes(m.kind)) E('meta.kind は "production" か "dev_test"');
  if (env !== 'dev' && m.kind === 'dev_test') E('開発用テストデータは本番・確認用環境に取り込めません');
  // 開発・検算環境（ループバック限定）は、実データ形式（production）も検算用に取り込める。許諾状態は変更されず、画面に「許諾未確認の検算用」と表示される
  const strict = m.kind === 'production';
  if (!validDate(m.period_start) || !validDate(m.period_end)) E('meta.period_start / period_end は YYYY-MM-DD（実在する日付）');
  if (strict && !m.version) E('meta.version（データ版。例 "2026-11-01版"）が必要です');
  const sources = new Map();
  for (const s of b.sources || []) {
    if (!s.id || !s.name) { E('sources: id と name が必要です'); continue; }
    if (!['confirmed', 'unconfirmed'].includes(s.license_status)) E(`出典 ${s.id}: license_status は confirmed / unconfirmed`);
    if (s.adjustment !== 'raw_unadjusted') E(`出典 ${s.id}: adjustment は "raw_unadjusted"（分割・配当で調整していない生の価格）のみ受け付けます。調整済み価格は配当・分割の二重計上になるため不可`);
    if (!validDate(s.retrieved_at)) E(`出典 ${s.id}: retrieved_at（取得日）が必要です`);
    if (sources.has(s.id)) E(`出典 ${s.id} が重複しています`);
    sources.set(s.id, s);
  }
  if (!sources.size) E('出典（sources）がありません');
  const bb = b.broker_basis || {};
  if (!bb.name || !['confirmed', 'unconfirmed'].includes(bb.status)) (strict ? E : W)('broker_basis（基準とする証券会社・販売会社 name / status）が未設定です');
  const insts = new Map();
  for (const i of b.instruments || []) {
    if (!i || !i.id || !/^[\w.-]{1,32}$/.test(i.id) || !i.name || !i.category || !i.description) { E(`商品: id（英数字._-、32文字以内）/name/category/description が必要です (${i && i.id})`); continue; }
    if (!['stock', 'etf', 'fund'].includes(i.type)) { E(`商品 ${i.id}: type は stock/etf/fund`); continue; }
    if (!sources.has(i.source_id)) E(`商品 ${i.id}: source_id ${i.source_id} が sources にありません`);
    if (insts.has(i.id)) { E(`商品 ${i.id} が重複しています`); continue; }
    insts.set(i.id, { id: i.id, type: i.type, name: i.name, category: i.category, description: i.description, source_id: i.source_id, terms: normTerms(i, E, W, strict) });
  }
  if (insts.size < 6 || insts.size > 10) W(`採用対象数が ${insts.size} です（想定は 6〜10）`);
  // 価格（JSON配列 と CSV を併用可）
  const priceRows = [...(b.prices || [])];
  if (b.prices_csv) priceRows.push(...parsePricesCsv(b.prices_csv, E));
  const prices = new Map(); const calSet = new Set(); let badRows = 0;
  const PE = (p, msg) => { badRows++; if (badRows <= 200) E(`価格 ${p._line ? `CSV ${p._line}行目 ` : ''}${p.instrument_id} ${p.date}: ${msg}`); };
  for (const p of priceRows) {
    const inst = insts.get(p.instrument_id);
    if (!inst) { PE(p, '商品IDが instruments にありません'); continue; }
    if (!validDate(p.date)) { PE(p, '日付が不正です（YYYY-MM-DD の実在日）'); continue; }
    const status = p.status || 'normal';
    if (!['normal', 'halt', 'limit'].includes(status)) { PE(p, 'status は normal/halt/limit'); continue; }
    try {
      // 売買停止・基準価額なし(halt)の日は終値を空欄にできる（0＝価格なしとして保存。評価は直近の実在する価格を使い、補完しない）
      const noClose = p.close == null || p.close === '';
      if (noClose && status !== 'halt') throw new Error('close が必要です（価格がない日は status=halt とし close を空欄に）');
      const close = noClose ? 0 : parseDecimalMilli(p.close, 'close');
      const open = p.open == null || p.open === '' ? null : parseDecimalMilli(p.open, 'open');
      if ((!noClose && close <= 0) || (open != null && open <= 0)) throw new Error('価格は正の値が必要です');
      if (noClose && open != null) throw new Error('終値のない日に始値は指定できません');
      if (close > MAX_PRICE_MILLI || (open != null && open > MAX_PRICE_MILLI)) throw new Error('価格が上限（1億円）を超えています');
      if (inst.type === 'fund' && !noClose && close < 1000) throw new Error('基準価額は1円以上が必要です');
      if (inst.type !== 'fund' && status === 'normal' && open == null) throw new Error('株式/ETFの normal 行には open が必要です（始値なしは halt）');
      if (inst.type === 'fund' && open != null) throw new Error('投資信託に open は指定しません（close＝基準価額）');
      let mp = prices.get(p.instrument_id); if (!mp) prices.set(p.instrument_id, mp = new Map());
      if (mp.has(p.date)) throw new Error('同じ商品・日付の行が重複しています');
      mp.set(p.date, { open, close, status });
      calSet.add(p.date);
    } catch (e) { PE(p, e.message); }
  }
  if (badRows > 200) E(`価格行のエラーが他に ${badRows - 200} 件あります`);
  const calendar = [...calSet].sort();
  if (validDate(m.period_start) && validDate(m.period_end)) {
    if (m.period_end <= m.period_start) E('period_end は period_start より後にしてください');
    const out = calendar.filter((d) => d < m.period_start || d > m.period_end);
    if (out.length) E(`価格日付 ${out.length} 件が対象期間外です（例: ${out.slice(0, 3).join(', ')}）`);
    const months = (Number(m.period_end.slice(0, 4)) - Number(m.period_start.slice(0, 4))) * 12 + Number(m.period_end.slice(5, 7)) - Number(m.period_start.slice(5, 7)) + 1;
    if (months !== 36) W(`対象期間は ${months} か月です（基本は 36 か月）`);
    if (addDays(m.period_end, 1).slice(8) !== '01') W('period_end が月末ではありません（確定済み月末を指定してください）');
    if (calendar.length && (calendar[0] > addDays(m.period_start, 7) || calendar[calendar.length - 1] < addDays(m.period_end, -7))) E(`必要期間不足: 価格データは ${calendar[0]}〜${calendar[calendar.length - 1]} で、対象期間 ${m.period_start}〜${m.period_end} の始め/終わりの7日以内をカバーしていません`);
  }
  for (const [id, inst] of insts) {
    const mp = prices.get(id);
    if (!mp || !mp.size) { E(`商品 ${id}: 価格データがありません（データ不足の商品は採用不可）`); continue; }
    const missing = calendar.filter((d) => !mp.has(d));
    if (missing.length) E(`商品 ${id}: ${missing.length} 営業日の価格が欠損しています（例: ${missing.slice(0, 3).join(', ')}）。補完せず、提供元で確認するか、その日を halt 行として明示するか、採用から外してください`);
    const halts = [...mp.values()].filter((x) => x.status !== 'normal').length;
    if (halts) W(`商品 ${id}: 売買停止/値幅制限/基準価額なしの日が ${halts} 日あります（株式はその日の注文が失効、投信は繰り延べ）`);
    if (inst.terms.terms_status === 'provisional') W(`商品 ${id}: 商品条件が仮設定です`);
  }
  // 権利処理
  const calIdx = new Map(calendar.map((d, i) => [d, i]));
  const actions = []; const seen = new Set();
  for (const a of b.actions || []) {
    const inst = insts.get(a.instrument_id);
    if (!inst) { E(`権利処理: 未知の商品 ${a.instrument_id}`); continue; }
    if (!validDate(a.ex_date) || !calSet.has(a.ex_date)) { E(`権利処理 ${a.instrument_id}: ex_date（権利落日/効力発生日）${a.ex_date} が営業日カレンダーにありません`); continue; }
    try {
      if (a.type === 'split') {
        if (inst.type === 'fund') throw new Error(`${a.instrument_id}: 投資信託に分割は設定できません`);
        if (!Number.isInteger(a.num) || !Number.isInteger(a.den) || a.num < 1 || a.den < 1 || a.num === a.den || a.num > 1000 || a.den > 1000) throw new Error(`${a.instrument_id} split: num/den は異なる1〜1000の整数（2:1 分割なら num=2, den=1。併合 1:10 なら num=1, den=10）`);
        const x = { instrument_id: a.instrument_id, type: 'split', ex_date: a.ex_date, num: a.num, den: a.den, fraction_price_milli: null, fraction_pay_date: null };
        if (a.num % a.den !== 0) { // 端数が生じうる比率 → 実際の端数処分代金データが必須
          if (a.fraction_price == null || !validDate(a.fraction_pay_date)) throw new Error(`${a.instrument_id} split ${a.num}:${a.den}: 端数が生じうる比率です。端数処分代金（fraction_price: 新株1株あたり）と支払日（fraction_pay_date）の実データが必要です。無い場合はこの商品を採用しないでください`);
          x.fraction_price_milli = parseDecimalMilli(a.fraction_price, `${a.instrument_id} fraction_price`); x.fraction_pay_date = a.fraction_pay_date;
        }
        actions.push(x);
      } else if (a.type === 'dividend') {
        const per = parseDecimalMilli(a.per_unit, `${a.instrument_id} 配当`);
        if (per <= 0 || per > MAX_PER_UNIT_MILLI) throw new Error(`${a.instrument_id} 配当: per_unit は正の値（上限1,000万円）`);
        if (!validDate(a.pay_date) || a.pay_date <= a.ex_date) throw new Error(`${a.instrument_id} 配当: pay_date（支払日）は権利落日より後の日付`);
        if (a.record_date != null) {
          if (!validDate(a.record_date)) throw new Error(`${a.instrument_id} 配当: record_date（権利確定日/決算日）が不正です`);
          if (a.record_date < a.ex_date || a.record_date > a.pay_date) throw new Error(`${a.instrument_id} 配当: 権利落日 ≤ 権利確定日 ≤ 支払日 になっていません`);
          if (inst.type === 'fund' && a.record_date !== a.ex_date) W(`${a.instrument_id} 分配金: 投資信託は決算日＝権利落日として扱います（record_date と ex_date が異なります）`);
          if (inst.type !== 'fund' && calIdx.has(a.record_date) && calIdx.get(a.record_date) - calIdx.get(a.ex_date) !== 1) W(`${a.instrument_id} 配当: 権利落日 ${a.ex_date} が権利確定日 ${a.record_date} の前営業日ではありません。データを確認してください`);
        } else if (strict) throw new Error(`${a.instrument_id} 配当: record_date（権利確定日/決算日）が必要です`);
        actions.push({ instrument_id: a.instrument_id, type: 'dividend', ex_date: a.ex_date, record_date: a.record_date ?? null, per_unit_milli: per, pay_date: a.pay_date });
      } else throw new Error(`${a.instrument_id}: 権利処理 type は split/dividend`);
      const k = `${a.instrument_id}|${a.ex_date}`;
      if (seen.has(k)) throw new Error(`${a.instrument_id} ${a.ex_date}: 同日に複数の権利処理は不可（分割と配当の二重反映を防ぐため）`);
      seen.add(k);
    } catch (e) { E(e.message); }
  }
  // ニュース
  const news = []; const nids = new Set();
  for (const n of b.news || []) {
    if (!n.id || !validDate(n.published_date) || !n.summary || !n.source_name || !n.url) { E(`ニュース ${n.id}: id/published_date/summary/source_name/url が必要です`); continue; }
    if (nids.has(n.id)) { E(`ニュース ${n.id} が重複しています`); continue; } nids.add(n.id);
    if (!/^https?:\/\//.test(n.url)) E(`ニュース ${n.id}: url は http(s) のみ`);
    if (validDate(m.period_start) && (n.published_date < m.period_start || n.published_date > m.period_end)) E(`ニュース ${n.id}: 公表日が対象期間外です`);
    if (n.summary.length > 200) W(`ニュース ${n.id}: 要約が長すぎます（転載にならないよう短く）`);
    // 解説と「考え方の例」（任意）。値動きの見通しや売買のすすめを書かせない
    let explain = null, views = null;
    if (n.explain != null) { if (typeof n.explain !== 'string' || !n.explain.trim() || n.explain.length > 300) E(`ニュース ${n.id}: explain は300字以内の文字列`); else explain = n.explain; }
    if (n.views != null) {
      if (!Array.isArray(n.views) || n.views.length !== 2 || n.views.some((x) => !x || typeof x.label !== 'string' || typeof x.text !== 'string' || !x.label.trim() || !x.text.trim() || x.label.length > 30 || x.text.length > 200)) E(`ニュース ${n.id}: views は {label, text} をちょうど2つ（異なる立場を1つずつ。label 30字・text 200字以内）`);
      else views = n.views.map((x) => ({ label: x.label, text: x.text }));
    }
    const said = (explain || '') + (views || []).map((x) => x.label + x.text).join('');
    for (const w of NEWS_NG) if (said.includes(w)) E(`ニュース ${n.id}: 解説・考え方の例に「${w}」は使えません（値動きの見通しや売買のすすめにあたる表現）`);
    news.push({ id: n.id, published_date: n.published_date, summary: n.summary, source_name: n.source_name, url: n.url, explain, views });
  }
  if (news.length < 5 || news.length > 12) W(`ニュース件数が ${news.length} 件です（想定は 5〜12 件）`);
  if (strict) for (const s of sources.values()) if (s.license_status !== 'confirmed') W(`出典 ${s.id}: 利用許諾が未確認です（確認済みになるまで固定不可）`);
  const summary = {
    kind: m.kind, version: m.version || null, period: [m.period_start, m.period_end], calendar: calendar.length ? [calendar[0], calendar[calendar.length - 1]] : null,
    counts: { instruments: insts.size, calendar_days: calendar.length, price_rows: [...prices.values()].reduce((s, x) => s + x.size, 0), actions: actions.length, news: news.length },
    instruments: [...insts.values()].map((i) => ({ id: i.id, type: i.type, name: i.name, rows: prices.get(i.id)?.size || 0, terms_status: i.terms.terms_status })),
    checksum: crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex'),
  };
  return { errors, warnings, summary, norm: errors.length ? null : { meta: m, sources: [...sources.values()], instruments: [...insts.values()], prices, calendar, actions, news } };
}

const NEWS_NG = ['おすすめ', '買い時', '売り時', '上がりそう', '下がりそう', '期待リターン', '値上がりが見込', '儲か', '必ず', '買うべき', '売るべき'];

function hashNorm(n) {
  const h = crypto.createHash('sha256');
  const j = (x) => h.update(JSON.stringify(x) + '\n');
  j(n.meta); j(n.sources); j(n.instruments); j(n.calendar);
  for (const i of n.instruments) j([...n.prices.get(i.id)].sort());
  j(n.actions); j(n.news);
  return h.digest('hex');
}

function previewDataset(bundle, env) { const r = validateBundle(bundle, env); return { ok: !r.errors.length, errors: r.errors, warnings: r.warnings, summary: r.summary }; }

function importDataset(db, bundle, env, now) {
  const { errors, warnings, norm, summary } = validateBundle(bundle, env);
  if (errors.length) return { ok: false, errors, warnings, summary };
  const id = 'ds_' + crypto.randomBytes(6).toString('hex');
  tx(db, () => { // 全件を1トランザクションで。途中で失敗すれば何も残らない
    db.prepare('INSERT INTO datasets(id,name,kind,status,period_start,period_end,created_at,broker_basis_json,validation_json,version_label,source_checksum,counts_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, norm.meta.name, norm.meta.kind, 'draft', norm.meta.period_start, norm.meta.period_end, now, JSON.stringify(bundle.broker_basis || { name: '未確定', status: 'unconfirmed' }), JSON.stringify({ warnings }), norm.meta.version || null, summary.checksum, JSON.stringify(summary.counts));
    for (const s of norm.sources) db.prepare('INSERT INTO dataset_sources VALUES(?,?,?,?,?,?,?,?)').run(id, s.id, s.name, s.url || null, s.retrieved_at, s.license_status, s.license_note || null, s.adjustment);
    for (const i of norm.instruments) db.prepare('INSERT INTO instruments VALUES(?,?,?,?,?,?,?,?)').run(id, i.id, i.type, i.name, i.category, i.description, i.source_id, JSON.stringify(i.terms));
    const ip = db.prepare('INSERT INTO prices VALUES(?,?,?,?,?,?)');
    for (const [iid, mp] of norm.prices) for (const [d, r] of mp) ip.run(id, iid, d, r.open, r.close, r.status);
    let seq = 0;
    const ia = db.prepare('INSERT INTO actions(dataset_id,seq,instrument_id,type,ex_date,num,den,per_unit_milli,pay_date,record_date,fraction_price_milli,fraction_pay_date) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const a of norm.actions) ia.run(id, seq++, a.instrument_id, a.type, a.ex_date, a.num ?? null, a.den ?? null, a.per_unit_milli ?? null, a.pay_date ?? null, a.record_date ?? null, a.fraction_price_milli ?? null, a.fraction_pay_date ?? null);
    for (const n of norm.news) db.prepare('INSERT INTO news(dataset_id,id,published_date,summary,source_name,url,explain,views_json) VALUES(?,?,?,?,?,?,?,?)').run(id, n.id, n.published_date, n.summary, n.source_name, n.url, n.explain, n.views ? JSON.stringify(n.views) : null);
  });
  return { ok: true, id, warnings, summary };
}

const cache = new Map();
function loadDataset(db, id) {
  if (!id) return null;
  if (cache.has(id)) return cache.get(id);
  const ds = db.prepare('SELECT * FROM datasets WHERE id=?').get(id);
  if (!ds) return null;
  const instruments = new Map();
  for (const r of db.prepare('SELECT * FROM instruments WHERE dataset_id=? ORDER BY rowid').all(id)) instruments.set(r.id, { id: r.id, type: r.type, name: r.name, category: r.category, description: r.description, source_id: r.source_id, terms: JSON.parse(r.terms_json) });
  const prices = new Map(); const calSet = new Set();
  for (const r of db.prepare('SELECT * FROM prices WHERE dataset_id=? ORDER BY date').all(id)) {
    let mp = prices.get(r.instrument_id); if (!mp) prices.set(r.instrument_id, mp = new Map());
    mp.set(r.date, { open: r.open_milli, close: r.close_milli, status: r.status }); calSet.add(r.date);
  }
  const calendar = [...calSet].sort();
  const calIdx = new Map(calendar.map((d, i) => [d, i]));
  const actionsByDate = new Map(); const actions = [];
  for (const a of db.prepare('SELECT * FROM actions WHERE dataset_id=? ORDER BY seq').all(id)) {
    const x = { instrument_id: a.instrument_id, type: a.type, ex_date: a.ex_date, num: a.num, den: a.den, per_unit_milli: a.per_unit_milli, pay_date: a.pay_date, record_date: a.record_date, fraction_price_milli: a.fraction_price_milli, fraction_pay_date: a.fraction_pay_date };
    actions.push(x);
    if (!actionsByDate.has(a.ex_date)) actionsByDate.set(a.ex_date, []);
    actionsByDate.get(a.ex_date).push(x);
  }
  const news = db.prepare('SELECT * FROM news WHERE dataset_id=? ORDER BY published_date,id').all(id);
  const sources = db.prepare('SELECT * FROM dataset_sources WHERE dataset_id=?').all(id);
  const d = { meta: ds, instruments, prices, calendar, calIdx, actionsByDate, actions, news, sources };
  if (ds.status === 'locked') cache.set(id, d); // ロック後は不変なのでキャッシュ可
  return d;
}

// 本番公開を妨げる未確定事項（許諾・商品条件・基準とする販売会社）。本番の固定時と公開時の両方で検査する
function unresolved(db, id, ds) {
  const out = [];
  const un = db.prepare("SELECT source_id FROM dataset_sources WHERE dataset_id=? AND license_status!='confirmed'").all(id);
  if (un.length) out.push('利用許諾が未確認の出典があります: ' + un.map((x) => x.source_id).join(', '));
  const prov = db.prepare('SELECT id, terms_json FROM instruments WHERE dataset_id=?').all(id).filter((i) => JSON.parse(i.terms_json).terms_status !== 'confirmed');
  if (prov.length) out.push('商品条件が仮設定のままです: ' + prov.map((x) => x.id).join(', '));
  if (JSON.parse(ds.broker_basis_json).status !== 'confirmed') out.push('基準とする証券会社・販売会社の条件が未確定です');
  return out;
}
function lockDataset(db, id, now, env) {
  const ds = db.prepare('SELECT * FROM datasets WHERE id=?').get(id);
  if (!ds) return { ok: false, errors: ['データセットが見つかりません'] };
  if (ds.status === 'locked') return { ok: false, errors: ['すでに固定済みです'] };
  const errors = [];
  if (env !== 'dev' && ds.kind !== 'production') errors.push('本番・確認用環境では production データのみ固定できます');
  const pending = unresolved(db, id, ds);
  if (ds.kind === 'production' && env === 'prod') errors.push(...pending); // 本番だけが、未確定事項のあるデータの固定を拒否する（確認用環境・開発環境は動作確認・検算のため固定できる）
  if (errors.length) return { ok: false, errors };
  const d = loadDataset(db, id);
  const norm = { meta: { name: ds.name, kind: ds.kind, period_start: ds.period_start, period_end: ds.period_end, version: ds.version_label }, sources: d.sources, instruments: [...d.instruments.values()], calendar: d.calendar, prices: d.prices, actions: d.actions, news: d.news };
  const h = hashNorm(norm) + ':' + crypto.createHash('sha256').update(ds.broker_basis_json).digest('hex').slice(0, 16);
  db.prepare("UPDATE datasets SET status='locked', content_hash=?, locked_at=? WHERE id=? AND status='draft'").run(h, now, id);
  return { ok: true, content_hash: h, pending: ds.kind === 'production' ? pending : [] };
}

module.exports = { validateBundle, previewDataset, importDataset, loadDataset, lockDataset, unresolved, validDate, ym };
