'use strict';
// 実データの取込ファイルを生成する（market-data/catalog.json ＋ market-data/raw/ → market-data/build/）。
//   node scripts/build-dataset.js            … 検証して取込ファイルと検証記録を書き出す
//   node scripts/build-dataset.js --check    … 書き出さずに検証だけ行う（終了コード 0: 問題なし / 1: エラーあり）
// 方針:
//   - 元ファイル（raw/）は読むだけで変更しない。SHA-256 を台帳と照合し、一致しなければ中止する。
//   - 解釈できない行・重複・非正値・非整数・日付の逆転・営業日の欠損はエラー（補完・丸め・推定をしない）。
//   - 分配金は出典に明記された値だけを使う。空欄・「-」は「記載なし」として保持し、0円に読み替えない。
//     対象期間内に 0 円以外の分配金があり、支払日のデータ（catalog の distribution_pay_dates）が無い商品は採用不可。
//   - 価格系列を生成・延長・補間する処理は存在しない。対象期間外のデータは取込ファイルに含めない。
//   - 利用許諾（license_status）は台帳の値をそのまま出力する（このスクリプトは許諾を確認済みにしない）。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', 'market-data');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const lines = (buf) => buf.toString('utf8').replace(/^﻿/, '').replace(/\r/g, '').split('\n').filter((l) => l !== '');
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (s) => ISO.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const slash = (s) => s.replace(/\//g, '-');

// ---- 出典ごとの形式（見出しが想定と違えば中止する。列の意味を推測しない） ----
const PARSERS = {
  // アセットマネジメントOne: 基準日,基準価額（円）,純資産額（億円）,分配金  … 値は引用符付き・桁区切りあり。分配金は "-"（記載なし）か数値
  amone(files, E) {
    const ls = lines(files.nav); const head = ls.shift();
    if (head !== '基準日,基準価額（円）,純資産額（億円）,分配金') { E(`見出しが想定と異なります: ${head}`); return null; }
    const rows = [], dist = [];
    ls.forEach((l, i) => {
      const m = l.match(/^(\d{4}\/\d{2}\/\d{2}),"([\d,]+)","[^"]*","([^"]*)"$/);
      if (!m) return E(`${i + 2}行目を解釈できません: ${l.slice(0, 60)}`);
      const date = slash(m[1]); rows.push({ date, nav: m[2].replace(/,/g, ''), line: i + 2 });
      if (m[3] !== '-') dist.push({ date, value: m[3].replace(/,/g, ''), line: i + 2 });
    });
    return { rows, dist, blank: '"-"' };
  },
  // アモーヴァ: 1行目ファンド名、2行目見出し。分配金は空欄（記載なし）か数値
  amova(files, E) {
    const ls = lines(files.nav); const title = ls.shift().replace(/^"|"$/g, ''); const head = ls.shift();
    if (head !== '基準日,基準価額（円）,前日比（円）,分配金（税引前）（円）,純資産総額（億円）,基準価額（税引前分配金再投資ベース）（円）') { E(`見出しが想定と異なります: ${head}`); return null; }
    const rows = [], dist = [];
    ls.forEach((l, i) => {
      const c = l.split(',');
      if (c.length !== 6 || !ISO.test(c[0])) return E(`${i + 3}行目を解釈できません: ${l.slice(0, 60)}`);
      rows.push({ date: c[0], nav: c[1], line: i + 3 });
      if (c[3] !== '') dist.push({ date: c[0], value: c[3], line: i + 3 });
    });
    return { rows, dist, title, blank: '空欄' };
  },
  // しんきんアセットマネジメント投信: 基準価額と分配金が別ファイル
  skam(files, E) {
    const ls = lines(files.nav); const head = ls.shift();
    if (head !== '基準日,基準価額,前日比,純資産総額') { E(`見出しが想定と異なります: ${head}`); return null; }
    const rows = [], dist = [];
    ls.forEach((l, i) => {
      const c = l.split(',');
      if (c.length !== 4 || !/^\d{4}\/\d{2}\/\d{2}$/.test(c[0])) return E(`${i + 2}行目を解釈できません: ${l.slice(0, 60)}`);
      rows.push({ date: slash(c[0]), nav: c[1], line: i + 2 });
    });
    if (!files.dis) { E('分配金ファイル（role: dis）がありません'); return null; }
    const dl = lines(files.dis); const dh = dl.shift();
    if (dh !== '日付,決算期,金額') { E(`分配金ファイルの見出しが想定と異なります: ${dh}`); return null; }
    dl.forEach((l, i) => {
      const c = l.split(',');
      if (c.length !== 3 || !/^\d{4}\/\d{2}\/\d{2}$/.test(c[0])) return E(`分配金ファイル ${i + 2}行目を解釈できません: ${l.slice(0, 60)}`);
      dist.push({ date: slash(c[0]), value: c[2], line: i + 2 });
    });
    return { rows, dist, blank: '（決算日以外は行なし）' };
  },
};

// 国内の営業日（平日 − 祝日 − 12/31〜1/3）。価格日付の欠損・余分を独立に確かめるためだけに使う
function expectedBusinessDays(holidays, start, end) {
  const out = [];
  for (let t = Date.parse(start + 'T00:00:00Z'); t <= Date.parse(end + 'T00:00:00Z'); t += 86400000) {
    const d = new Date(t); const s = d.toISOString().slice(0, 10); const w = d.getUTCDay();
    if (w === 0 || w === 6 || holidays.has(s) || ['12-31', '01-01', '01-02', '01-03'].includes(s.slice(5))) continue;
    out.push(s);
  }
  return out;
}

function build() {
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
  const { period_start: PS, period_end: PE } = cat.meta;
  const errors = [], report = { generated_by: 'scripts/build-dataset.js', catalog_sha256: sha256(fs.readFileSync(path.join(ROOT, 'catalog.json'))), period: [PS, PE], data_version: cat.meta.version, funds: [] };
  if (!realDate(PS) || !realDate(PE) || PE <= PS) errors.push('meta.period_start / period_end が不正です');

  let expected = null;
  if (cat.calendar_check) {
    const buf = fs.readFileSync(path.join(ROOT, cat.calendar_check.file));
    if (sha256(buf) !== cat.calendar_check.sha256) errors.push('祝日ファイルのハッシュが台帳と一致しません');
    else { const h = new Set(Object.keys(JSON.parse(buf.toString('utf8')).data)); expected = expectedBusinessDays(h, PS, PE); report.expected_business_days = expected.length; }
  }

  const adopted = [];
  for (const f of cat.funds) {
    const fe = []; const E = (m) => fe.push(m);
    const rec = { id: f.id, name: f.name, adoption: f.adoption, files: [], errors: fe };
    report.funds.push(rec);
    const files = {};
    for (const x of f.files) {
      const p = path.join(ROOT, x.file);
      if (!fs.existsSync(p)) { E(`元ファイルがありません: ${x.file}`); continue; }
      const buf = fs.readFileSync(p); const h = sha256(buf);
      rec.files.push({ file: x.file, role: x.role, url: x.url, retrieved_at: x.retrieved_at, sha256: h, bytes: buf.length, hash_ok: h === x.sha256 });
      if (h !== x.sha256) E(`${x.file}: SHA-256 が台帳と一致しません（元データが変更された可能性）`);
      files[x.role] = buf;
    }
    if (!files.nav || fe.length) continue;
    const parsed = (PARSERS[f.format] || (() => { E(`未対応の形式: ${f.format}`); return null; }))(files, E);
    if (!parsed) continue;
    const { rows, dist } = parsed;
    // 全行の検査（対象期間外も含め、元データ全体の一貫性を確認）
    let prev = '';
    const seen = new Set(); let dup = 0, bad = 0, unsorted = 0;
    for (const r of rows) {
      if (!realDate(r.date)) { bad++; E(`${r.line}行目: 日付が不正です (${r.date})`); continue; }
      if (seen.has(r.date)) { dup++; E(`${r.line}行目: 日付 ${r.date} が重複しています`); }
      seen.add(r.date);
      if (r.date <= prev) unsorted++; prev = r.date;
      if (!/^[1-9]\d*$/.test(r.nav)) { bad++; E(`${r.line}行目: 基準価額が正の整数ではありません (${r.nav})`); }
    }
    if (unsorted) E(`日付が昇順ではない行が ${unsorted} 件あります`);
    const sel = rows.filter((r) => r.date >= PS && r.date <= PE);
    rec.raw_rows = rows.length; rec.raw_range = rows.length ? [rows[0].date, rows[rows.length - 1].date] : null;
    rec.selected_rows = sel.length; rec.selected_range = sel.length ? [sel[0].date, sel[sel.length - 1].date] : null;
    rec.duplicates = dup; rec.invalid = bad;
    if (!sel.length) { E('対象期間の価格がありません'); continue; }
    if (rows[0].date > PS) E(`データの開始日 ${rows[0].date} が対象期間の開始 ${PS} より後です（期間不足）`);
    if (rows[rows.length - 1].date < PE && rows[rows.length - 1].date < sel[sel.length - 1].date) E('期間不足');
    const navs = sel.map((r) => Number(r.nav)); rec.nav_min = Math.min(...navs); rec.nav_max = Math.max(...navs);
    rec.unit = '円／1万口（税引前・信託報酬控除後の基準価額。調整なし）';
    if (expected) {
      const have = new Set(sel.map((r) => r.date));
      rec.missing_business_days = expected.filter((d) => !have.has(d)); rec.extra_days = sel.map((r) => r.date).filter((d) => !expected.includes(d));
      if (rec.missing_business_days.length) E(`営業日 ${rec.missing_business_days.length} 日分の基準価額がありません（例: ${rec.missing_business_days.slice(0, 3).join(', ')}）。補完しません`);
      if (rec.extra_days.length) E(`営業日ではない日付の行が ${rec.extra_days.length} 件あります（例: ${rec.extra_days.slice(0, 3).join(', ')}）`);
    }
    // 分配金: 出典に明記された行だけを扱う
    const inP = dist.filter((d) => d.date >= PS && d.date <= PE);
    rec.distributions_reported = inP.map((d) => ({ date: d.date, value: d.value }));
    rec.distribution_blank_marker = parsed.blank;
    rec.distribution_note = '上記以外の日は出典に分配金の記載がない（空欄・「-」・行なし）。0円とは読み替えず、権利処理を登録しないだけとする';
    const actions = [];
    for (const d of inP) {
      if (!/^\d+(\.\d{1,3})?$/.test(d.value)) { E(`分配金 ${d.date}: 値を解釈できません (${d.value})`); continue; }
      if (Number(d.value) === 0) continue; // 決算日に 0 円と明記 → 権利処理なし
      const pay = (f.distribution_pay_dates || {})[d.date];
      if (!pay || !realDate(pay)) { E(`分配金 ${d.date}（${d.value}円/1万口）の支払日データがありません。支払日を根拠なく決めないため、この商品は採用できません`); continue; }
      actions.push({ instrument_id: f.id, type: 'dividend', ex_date: d.date, record_date: d.date, per_unit: d.value, pay_date: pay });
    }
    rec.ok = fe.length === 0;
    if (f.adoption === 'candidate') {
      if (fe.length) errors.push(...fe.map((m) => `商品 ${f.id}: ${m}`));
      else adopted.push({ f, sel, actions });
    }
  }

  // 取込ファイル（docs/DATA_INPUT.md の形式）
  const srcIds = new Set(adopted.map((a) => a.f.source_id));
  const retrieved = (sid) => adopted.filter((a) => a.f.source_id === sid).flatMap((a) => a.f.files.map((x) => x.retrieved_at.slice(0, 10))).sort().pop();
  const bundle = {
    meta: { name: cat.meta.name, kind: 'production', version: cat.meta.version, period_start: PS, period_end: PE },
    broker_basis: { name: cat.broker_basis.name, status: cat.broker_basis.status },
    sources: cat.sources.filter((s) => srcIds.has(s.id)).map((s) => ({ id: s.id, name: s.name, url: s.url, retrieved_at: retrieved(s.id), license_status: s.license_status, license_note: s.license_note, adjustment: 'raw_unadjusted' })),
    instruments: adopted.map(({ f }) => ({ id: f.id, type: 'fund', name: f.name, category: f.category, description: f.description, source_id: f.source_id, terms: f.terms })),
    prices_csv: 'instrument_id,date,open,close,status\n' + adopted.flatMap(({ f, sel }) => sel.map((r) => `${f.id},${r.date},,${r.nav},normal`)).join('\n') + '\n',
    actions: adopted.flatMap((a) => a.actions),
    news: cat.news || [],
  };
  // アプリの取込検証（本番と同じ規則）にもかける
  const { validateBundle } = require('../server/dataset');
  const v = validateBundle(bundle, 'staging');
  errors.push(...v.errors.map((m) => `取込検証: ${m}`));
  report.adopted = adopted.map((a) => a.f.id); report.not_adopted = cat.funds.filter((f) => f.adoption !== 'candidate').map((f) => ({ id: f.id, name: f.name, reason: f.not_adopted_reason }));
  report.import_validation = { errors: v.errors, warnings: v.warnings, summary: v.summary };
  report.license = bundle.sources.map((s) => ({ id: s.id, status: s.license_status }));
  report.errors = errors;
  return { bundle, report, errors };
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  const { bundle, report, errors } = build();
  for (const f of report.funds) console.log(`${f.ok ? 'OK ' : 'NG '} ${f.id} ${f.name} [${f.adoption}] 元${f.raw_rows ?? '-'}行 対象${f.selected_rows ?? '-'}行 ${f.selected_range ? f.selected_range.join('〜') : ''} 分配金の記載 ${JSON.stringify(f.distributions_reported || [])}${f.errors.length ? '\n     ' + f.errors.join('\n     ') : ''}`);
  for (const w of report.import_validation.warnings) console.log('警告: ' + w);
  if (errors.length) { console.error('エラー:\n  ' + errors.join('\n  ')); process.exit(1); }
  if (!check) {
    const out = path.join(ROOT, 'build'); fs.mkdirSync(out, { recursive: true });
    const body = JSON.stringify(bundle); report.bundle_sha256 = sha256(Buffer.from(body));
    fs.writeFileSync(path.join(out, 'dataset.json'), body); fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
    console.log(`書き出し: market-data/build/dataset.json（${body.length} bytes, sha256 ${report.bundle_sha256.slice(0, 16)}…）, report.json`);
  }
  console.log(`採用候補 ${report.adopted.length} 商品 / 営業日 ${report.import_validation.summary.counts.calendar_days} 日 / 価格 ${report.import_validation.summary.counts.price_rows} 行。利用許諾: ${report.license.map((l) => `${l.id}=${l.status}`).join(', ')}`);
}
module.exports = { build };
