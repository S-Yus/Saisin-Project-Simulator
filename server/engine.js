'use strict';
// 計算・約定・日次処理エンジン。仕様は docs/SPEC.md。
// すべて整数演算（乗除は BigInt、結果は安全整数を検査）。呼び出し側がトランザクション内で実行する。
const { mulDivFloor, mulDivCeil, splitQty } = require('./money');

const FAR = '9999-12-31';
const ymOf = (d) => d.slice(0, 7);
const dayOf = (d) => Number(d.slice(8, 10));
const nextYm = (y) => { let [Y, M] = y.split('-').map(Number); M += 1; if (M > 12) { M = 1; Y += 1; } return `${Y}-${String(M).padStart(2, '0')}`; };
const MAX_QTY = 10000000, MAX_AMOUNT = 1000000000;

function finalDate(ds, ev) { let last = null; for (const d of ds.calendar) if (d <= ev.sim_end) last = d; return last; }
function startDate(ds, ev) { return ds.calendar.find((d) => d >= ev.sim_start) || null; }
function dateAt(ds, d, n) { const i = ds.calIdx.get(d); return i == null ? null : ds.calendar[i + n] ?? null; }

function calcFee(fee, gross, inclusive) {
  let f = inclusive ? mulDivFloor(gross, fee.rate_ppm, 1000000 + fee.rate_ppm) : mulDivFloor(gross, fee.rate_ppm, 1000000);
  f += fee.fixed;
  if (f < fee.min) f = fee.min;
  if (fee.max != null && f > fee.max) f = fee.max;
  return f;
}
// 成行買いの確保価格（1株あたり milli）。注文日の終値（＝注文時点で既知の情報）だけから求める。
// 商品条件の price_limit_table（基準値段の上限→制限値幅）があればそれを、無ければ buy_reserve_margin_bp を使う。
function reservePrice(t, closeMilli) {
  if (Array.isArray(t.price_limit_table)) {
    const row = t.price_limit_table.find(([below]) => closeMilli < below);
    if (!row) return null; // 表の範囲外 → 受付不可
    return closeMilli + row[1] * (t.price_limit_multiplier || 1);
  }
  return mulDivCeil(closeMilli, 10000 + t.buy_reserve_margin_bp, 10000);
}
function lastPrice(ds, instId, date) {
  const mp = ds.prices.get(instId); if (!mp) return null;
  let i = ds.calIdx.get(date);
  if (i == null) { i = ds.calendar.length - 1; while (i >= 0 && ds.calendar[i] > date) i--; }
  for (; i >= 0; i--) { const r = mp.get(ds.calendar[i]); if (r && r.close > 0) return { ...r, date: ds.calendar[i], stale: ds.calendar[i] !== date }; }
  return null;
}
const lineValue = (inst, qty, closeMilli) => inst.type === 'fund' ? mulDivFloor(qty, closeMilli, 10000000) : mulDivFloor(qty, closeMilli, 1000);

// ---------- 状態の読み出し ----------
function getAcc(db, id) { return db.prepare('SELECT * FROM accounts WHERE id=?').get(id); }
function reservedCash(db, accId) { return db.prepare("SELECT COALESCE(SUM(reserve),0) s FROM orders WHERE account_id=? AND status='accepted'").get(accId).s; }
function pendingSum(db, accId, kind) { return db.prepare("SELECT COALESCE(SUM(amount),0) s FROM receivables WHERE account_id=? AND status='pending' AND kind=?").get(accId, kind).s; }
// 買付可能額 = 現金残高 − 注文拘束額 − 未受渡の買付代金。未受渡の売却代金は含めない（初版の制限）
function availableCash(db, acc) { return acc.cash - reservedCash(db, acc.id) - pendingSum(db, acc.id, 'purchase'); }
function heldQty(db, accId, instId) { return db.prepare('SELECT qty FROM holdings WHERE account_id=? AND instrument_id=?').get(accId, instId)?.qty || 0; }
function unsettledQty(db, accId, instId) { return db.prepare("SELECT COALESCE(SUM(qty),0) s FROM receivables WHERE account_id=? AND instrument_id=? AND kind='purchase' AND status='pending'").get(accId, instId).s; }
function openSellQty(db, accId, instId) { return db.prepare("SELECT COALESCE(SUM(qty),0) s FROM orders WHERE account_id=? AND instrument_id=? AND side='sell' AND status='accepted'").get(accId, instId).s; }
// 売却可能数量 = 保有（評価）数量 − 受渡前の買付数量 − 受付済み売り注文
function sellableQty(db, accId, instId) { return Math.max(0, heldQty(db, accId, instId) - unsettledQty(db, accId, instId)) - openSellQty(db, accId, instId); }

// 総資産 = 現金残高 + 保有評価額（受渡前の買付分を含む） − 未受渡の買付代金 + 未受渡の売却代金 + 未収配当等
// 約定時: 保有+、未払買付代金+（同額） / 受渡時: 現金−、未払買付代金−（同額） → 受渡で総資産は動かない。売却も対称。
function valuation(db, acc, ds) {
  const rows = db.prepare('SELECT * FROM holdings WHERE account_id=? AND qty>0 ORDER BY instrument_id').all(acc.id);
  let hv = 0; const holdings = [];
  for (const h of rows) {
    const inst = ds.instruments.get(h.instrument_id); const p = lastPrice(ds, h.instrument_id, acc.sim_date);
    const value = p ? lineValue(inst, h.qty, p.close) : 0;
    const unsettled = Math.min(h.qty, unsettledQty(db, acc.id, h.instrument_id));
    hv += value; holdings.push({ instrument_id: h.instrument_id, qty: h.qty, unsettled_qty: unsettled, sellable_qty: Math.max(0, h.qty - unsettled - openSellQty(db, acc.id, h.instrument_id)), cost: h.cost, price_milli: p?.close ?? null, price_date: p?.date ?? null, stale: !!p?.stale, value, pnl: value - h.cost });
  }
  const recSale = pendingSum(db, acc.id, 'sale'), recDiv = pendingSum(db, acc.id, 'dividend'), recFrac = pendingSum(db, acc.id, 'split_fraction'), payable = pendingSum(db, acc.id, 'purchase');
  const reserved = reservedCash(db, acc.id);
  const total = acc.cash + hv + recSale + recDiv + recFrac - payable;
  return { cash: acc.cash, reserved, payable_purchase: payable, available: acc.cash - reserved - payable, holdings_value: hv, receivable_sale: recSale, receivable_dividend: recDiv + recFrac, total, deposits: acc.deposits, pnl: total - acc.deposits, holdings };
}
function snapshot(db, acc, ds) {
  const v = valuation(db, acc, ds);
  db.prepare('INSERT OR REPLACE INTO snapshots(account_id,date,total,deposits) VALUES(?,?,?,?)').run(acc.id, acc.sim_date, v.total, v.deposits);
  return v;
}

function createAccount(db, participantId, ev, ds, attempt, now) {
  const d0 = startDate(ds, ev);
  const r = db.prepare('INSERT INTO accounts(participant_id,event_id,attempt,status,sim_date,cash,deposits,news_seen_upto,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(participantId, ev.id, attempt, 'active', d0, ev.initial_cash, ev.initial_cash, d0, now);
  const acc = getAcc(db, r.lastInsertRowid);
  db.prepare('INSERT INTO ledger(account_id,date,type,amount,note,key) VALUES(?,?,?,?,?,?)').run(acc.id, d0, 'deposit', ev.initial_cash, '初期資金', 'deposit:initial');
  snapshot(db, acc, ds);
  return acc;
}

// ---------- 注文の検証（プレビューと受付で共用） ----------
const jpy = (n) => n.toLocaleString('ja-JP');
function evaluateOrder(db, acc, ds, ev, inp) {
  const errors = []; const inst = ds.instruments.get(inp.instrument_id);
  if (!inst) return { errors: ['投資対象が見つかりません'] };
  if (acc.status !== 'active') return { errors: ['この口座では新しい注文はできません（終了または保存済み）'] };
  const t = inst.terms; const side = inp.side;
  if (!['buy', 'sell'].includes(side)) return { errors: ['売買区分が不正です'] };
  const info = { instrument_id: inst.id, side, kind: inst.type === 'fund' ? 'fund' : 'stock', terms_status: t.terms_status, order_date: acc.sim_date, cancel_deadline: acc.sim_date };
  let execDate = dateAt(ds, acc.sim_date, inst.type === 'fund' ? t.nav_offset : 1);
  const fin = finalDate(ds, ev);
  if (execDate && fin && execDate > fin) execDate = null; // 期間の最終日より後に成立する注文は受け付けない（データの終了日より先の価格は存在しない）
  if (!execDate) errors.push('シミュレーション期間の最終日付近のため、この注文は成立する日がありません');
  info.exec_date = execDate;
  const sd = inst.type === 'fund' && side === 'buy' ? t.buy_settlement_days : t.settlement_days;
  info.settle_date = execDate ? (dateAt(ds, execDate, sd) || FAR) : null;
  const avail = availableCash(db, acc);
  info.available = avail;
  const int = (v) => Number.isSafeInteger(v) && v > 0;
  const ref = lastPrice(ds, inst.id, acc.sim_date);
  info.ref_price_milli = ref?.close ?? null; info.ref_price_date = ref?.date ?? null;
  if (!ref) errors.push('価格データがありません');
  if (side === 'sell') {
    const held = heldQty(db, acc.id, inst.id), uns = Math.min(held, unsettledQty(db, acc.id, inst.id)), open = openSellQty(db, acc.id, inst.id), free = held - uns - open;
    info.held = held; info.unsettled = uns; info.sellable = Math.max(0, free); info.reserve = 0;
    const u = inst.type === 'fund' ? '口' : '株';
    if (inp.sell_all) {
      if (open > 0) errors.push('売却注文が出ているため全売却にできません。先に取り消してください');
      else if (uns > 0) errors.push(`受渡前の買付分（${jpy(uns)}${u}）があるため、全売却はその受渡後にできます（初版の制限）`);
      else if (free <= 0) errors.push('売却できる保有がありません');
      else { info.qty = free; info.sell_all = true; }
    } else if (!int(inp.qty)) errors.push(`${inst.type === 'fund' ? '口数' : '株数'}は1以上の整数で入力してください`);
    else if (inst.type !== 'fund' && inp.qty % t.lot_size !== 0) errors.push(`一部売却は ${t.lot_size} 株（口）単位です。端数を含めて売るには「全売却」を選んでください`);
    else if (inp.qty > free) errors.push(`売却できる数量を超えています（売却可能 ${jpy(Math.max(0, free))}${u}${uns ? `。うち受渡前の買付分 ${jpy(uns)}${u} は受渡日まで売れません` : ''}）`);
    else info.qty = inp.qty;
    return { errors, info };
  }
  if (inst.type !== 'fund') {
    if (!int(inp.qty)) errors.push('株数（口数）は1以上の整数で入力してください');
    else if (inp.qty % t.lot_size !== 0) errors.push(`売買単位は ${t.lot_size} 株（口）です。${t.lot_size} の倍数で入力してください`);
    else if (inp.qty > MAX_QTY) errors.push('数量が大きすぎます');
    else if (ref) {
      const rp = reservePrice(t, ref.close);
      if (rp == null) errors.push('この価格帯の確保ルールが商品条件に設定されていないため、受け付けできません');
      else {
        const gross = mulDivCeil(inp.qty, rp, 1000);
        info.qty = inp.qty; info.reserve_price_milli = rp; info.reserve_gross = gross; info.fee_estimate = calcFee(t.fee, gross, false); info.reserve = gross + info.fee_estimate;
        info.reference_amount = mulDivCeil(inp.qty, ref.close, 1000);
        if (info.reserve > avail) errors.push(`買付可能額が足りません（必要な確保額 ${jpy(info.reserve)}円 / 買付可能額 ${jpy(avail)}円）`);
      }
    }
  } else {
    const minA = inp._plan ? (t.savings_min_amount ?? t.min_amount) : t.min_amount, stepA = inp._plan ? (t.savings_amount_step ?? t.amount_step) : t.amount_step;
    if (!int(inp.amount)) errors.push('金額は1円以上の整数で入力してください');
    else if (inp.amount < minA) errors.push(`最低購入金額は ${jpy(minA)}円です`);
    else if (inp.amount % stepA !== 0) errors.push(`購入は ${jpy(stepA)}円単位です`);
    else if (inp.amount > MAX_AMOUNT) errors.push('金額が大きすぎます');
    else if (t.spot_buy_ok === false && !inp._plan) errors.push('この商品は積立（定時定額）でのみ購入できます');
    else {
      info.amount = inp.amount; info.reserve = inp.amount; info.fee_estimate = calcFee(t.fee, inp.amount, true);
      if (inp.amount > avail) errors.push(`買付可能額が足りません（必要 ${jpy(inp.amount)}円 / 買付可能額 ${jpy(avail)}円）`);
    }
  }
  return { errors, info };
}

function placeOrder(db, acc, ds, ev, inp, origin = 'manual', planId = null) {
  const r = evaluateOrder(db, acc, ds, ev, inp);
  if (r.errors.length) return { ok: false, errors: r.errors };
  const i = r.info;
  const res = db.prepare(`INSERT INTO orders(account_id,instrument_id,kind,side,qty,amount,sell_all,status,placed_date,exec_date,settle_date,reserve,origin,plan_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(acc.id, i.instrument_id, i.kind, i.side, i.qty ?? null, i.amount ?? null, i.sell_all ? 1 : 0, 'accepted', acc.sim_date, i.exec_date, i.settle_date, i.reserve || 0, origin, planId);
  db.prepare('UPDATE accounts SET version=version+1 WHERE id=?').run(acc.id);
  return { ok: true, order_id: Number(res.lastInsertRowid), info: i };
}

function cancelOrder(db, acc, orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id=? AND account_id=?').get(orderId, acc.id);
  if (!o) return { ok: false, error: '注文が見つかりません' };
  if (o.status !== 'accepted') return { ok: false, error: `この注文はすでに「${statusJa(o.status)}」のため取り消せません` };
  if (acc.status !== 'active') return { ok: false, error: 'この口座では取消できません' };
  if (o.placed_date !== acc.sim_date) return { ok: false, error: '取消できるのは、注文した日の締切（その日の終了）までです。この注文の取消期限は過ぎています' };
  db.prepare("UPDATE orders SET status='cancelled', closed_date=?, reserve=0, reason='ご自身で取消' WHERE id=?").run(acc.sim_date, o.id);
  db.prepare('UPDATE accounts SET version=version+1 WHERE id=?').run(acc.id);
  return { ok: true };
}
const statusJa = (s) => ({ accepted: '受付済み', filled: '成立済み', cancelled: '取消済み', lapsed: '失効' }[s] || s);

// ---------- 日次処理 ----------
function ledger(db, acc, date, type, amount, key, instId, qty, note) {
  db.prepare('INSERT INTO ledger(account_id,date,type,instrument_id,amount,qty,note,key) VALUES(?,?,?,?,?,?,?,?)').run(acc.id, date, type, instId ?? null, amount, qty ?? null, note ?? null, key);
}
function closeOrder(db, o, status, date, reason, extra = {}) {
  db.prepare('UPDATE orders SET status=?, closed_date=?, reason=?, reserve=0, price_milli=?, gross=?, fee=?, units=? WHERE id=?')
    .run(status, date, reason ?? null, extra.price_milli ?? null, extra.gross ?? null, extra.fee ?? null, extra.units ?? null, o.id);
}
function addHolding(db, accId, instId, qty, cost) {
  const h = db.prepare('SELECT * FROM holdings WHERE account_id=? AND instrument_id=?').get(accId, instId);
  if (h) db.prepare('UPDATE holdings SET qty=qty+?, cost=cost+? WHERE account_id=? AND instrument_id=?').run(qty, cost, accId, instId);
  else db.prepare('INSERT INTO holdings VALUES(?,?,?,?)').run(accId, instId, qty, cost);
}
function removeHolding(db, accId, instId, qty) {
  const h = db.prepare('SELECT * FROM holdings WHERE account_id=? AND instrument_id=?').get(accId, instId);
  const costOut = qty === h.qty ? h.cost : mulDivFloor(h.cost, qty, h.qty);
  if (qty === h.qty) db.prepare('DELETE FROM holdings WHERE account_id=? AND instrument_id=?').run(accId, instId);
  else db.prepare('UPDATE holdings SET qty=qty-?, cost=cost-? WHERE account_id=? AND instrument_id=?').run(qty, costOut, accId, instId);
  return costOut;
}
function addPending(db, acc, kind, instId, amount, qty, due, ref, d) {
  db.prepare("INSERT INTO receivables(account_id,kind,instrument_id,amount,qty,due_date,status,ref,created_date) VALUES(?,?,?,?,?,?,'pending',?,?)").run(acc.id, kind, instId, amount, qty ?? null, due, ref, d);
}
const dueText = (due) => (due === FAR ? '期間外' : due);

function processDay(db, accId, ds, ev, out) {
  let acc = getAcc(db, accId);
  const prev = acc.sim_date; const d = dateAt(ds, prev, 1);
  if (!d) throw new Error('最終日です');
  const stops = []; const note = (type, text, stop) => { out.push({ date: d, type, text }); if (stop) stops.push(stop); };
  let cash = acc.cash, deposits = acc.deposits;
  const instName = (id) => ds.instruments.get(id)?.name || id;

  // 0) 月初の追加資金
  if (ymOf(d) !== ymOf(prev) && ev.monthly_deposit > 0) {
    cash += ev.monthly_deposit; deposits += ev.monthly_deposit;
    ledger(db, acc, d, 'deposit', ev.monthly_deposit, `deposit:${ymOf(d)}`, null, null, '毎月の追加資金');
    note('deposit', `毎月の追加資金 ${jpy(ev.monthly_deposit)}円 が入金されました`);
  }
  db.prepare('UPDATE accounts SET cash=?, deposits=?, sim_date=? WHERE id=?').run(cash, deposits, d, acc.id);
  acc = getAcc(db, accId);

  // 1) 株式分割・併合（効力発生＝権利落日の開始時点の保有に適用。受渡前の買付分も対象）
  for (const a of ds.actionsByDate.get(d) || []) if (a.type === 'split') {
    for (const o of db.prepare("SELECT * FROM orders WHERE account_id=? AND instrument_id=? AND status='accepted' AND kind='stock'").all(acc.id, a.instrument_id)) {
      closeOrder(db, o, 'lapsed', d, '株式分割・併合の権利処理のため失効'); note('order_lapsed', `${instName(o.instrument_id)} の注文は株式分割・併合のため失効しました（確保は戻りました）`, 'order_lapsed');
    }
    const h = db.prepare('SELECT * FROM holdings WHERE account_id=? AND instrument_id=?').get(acc.id, a.instrument_id);
    if (!h) continue;
    const { q: nq, rem } = splitQty(h.qty, a.num, a.den);
    db.prepare('UPDATE holdings SET qty=? WHERE account_id=? AND instrument_id=?').run(nq, acc.id, a.instrument_id);
    // 受渡前の買付数量も換算（売却可能数量を多く見積もらないよう切上げ）
    for (const p of db.prepare("SELECT id,qty FROM receivables WHERE account_id=? AND instrument_id=? AND kind='purchase' AND status='pending'").all(acc.id, a.instrument_id)) {
      db.prepare('UPDATE receivables SET qty=? WHERE id=?').run(Math.min(nq, mulDivCeil(p.qty, a.num, a.den)), p.id);
    }
    note('split', `${instName(a.instrument_id)} が ${a.num}:${a.den} の分割・併合: ${jpy(h.qty)} → ${jpy(nq)}`);
    if (rem > 0) {
      // 端数はデータで与えられた「端数処分代金（新株1株あたり）」でのみ精算。値を補完しない（取込時に必須化）
      const amt = mulDivFloor(rem, a.fraction_price_milli, a.den * 1000);
      if (amt > 0) { addPending(db, acc, 'split_fraction', a.instrument_id, amt, null, a.fraction_pay_date || FAR, `frac:${a.instrument_id}:${d}`, d); note('split_fraction', `端数株（${rem}/${a.den}株）の処分代金 ${jpy(amt)}円 は ${dueText(a.fraction_pay_date || FAR)} に入金予定です`); }
    }
    if (nq === 0) db.prepare('DELETE FROM holdings WHERE account_id=? AND instrument_id=?').run(acc.id, a.instrument_id);
  }
  // 2) 配当・分配金: 権利落日の開始時点（＝権利付最終日の約定まで反映済み）の保有数量で確定し、支払日に入金
  for (const a of ds.actionsByDate.get(d) || []) if (a.type === 'dividend') {
    const h = db.prepare('SELECT * FROM holdings WHERE account_id=? AND instrument_id=? AND qty>0').get(acc.id, a.instrument_id);
    if (!h) continue;
    const inst = ds.instruments.get(a.instrument_id);
    const amt = inst.type === 'fund' ? mulDivFloor(h.qty, a.per_unit_milli, 10000 * 1000) : mulDivFloor(h.qty, a.per_unit_milli, 1000);
    if (amt <= 0) continue;
    const ref = `div:${a.instrument_id}:${a.ex_date}`;
    if (db.prepare('SELECT 1 FROM receivables WHERE account_id=? AND ref=?').get(acc.id, ref)) continue;
    addPending(db, acc, 'dividend', a.instrument_id, amt, h.qty, a.pay_date, ref, d);
    note('dividend_declared', `${instName(a.instrument_id)} の${inst.type === 'fund' ? '分配金' : '配当'} ${jpy(amt)}円（税引前、${jpy(h.qty)}${inst.type === 'fund' ? '口' : '株'}分）が確定。入金予定日 ${a.pay_date}`);
  }
  // 3) 株式・ETFの約定（前営業日の終了時点で出した成行注文を当日の始値で）
  for (const o of db.prepare("SELECT * FROM orders WHERE account_id=? AND status='accepted' AND kind='stock' AND exec_date<=? ORDER BY id").all(acc.id, d)) {
    const inst = ds.instruments.get(o.instrument_id); const t = inst.terms; const row = ds.prices.get(o.instrument_id)?.get(d);
    if (!row) { closeOrder(db, o, 'lapsed', d, '当日の価格データがないため不成立'); note('order_lapsed', `${inst.name} の注文は価格データがなく失効しました`, 'order_lapsed'); continue; }
    if (row.status !== 'normal' || row.open == null) { closeOrder(db, o, 'lapsed', d, '売買停止・始値なし・値幅制限等のため不成立'); note('order_lapsed', `${inst.name} の注文は売買停止等で成立せず失効しました（確保した資金・数量は戻りました）`, 'order_lapsed'); continue; }
    if (o.side === 'buy') {
      const gross = mulDivCeil(o.qty, row.open, 1000); const fee = calcFee(t.fee, gross, false);
      if (gross + fee > o.reserve) { closeOrder(db, o, 'lapsed', d, '始値が確保した範囲を超えたため不成立'); note('order_lapsed', `${inst.name} の買い注文は始値が確保額を超えたため失効しました（確保は戻りました）`, 'order_lapsed'); continue; }
      addHolding(db, acc.id, o.instrument_id, o.qty, gross + fee);
      addPending(db, acc, 'purchase', o.instrument_id, gross + fee, o.qty, o.settle_date, `purchase:${o.id}`, d);
      ledger(db, acc, d, 'buy', -gross, `buy:${o.id}`, o.instrument_id, o.qty, `約定（代金は受渡日 ${dueText(o.settle_date)} に支払）`); if (fee) ledger(db, acc, d, 'fee', -fee, `fee:${o.id}`, o.instrument_id, null, '売買手数料（受渡日に支払）');
      closeOrder(db, o, 'filled', d, null, { price_milli: row.open, gross, fee });
      note('order_filled', `${inst.name} を ${jpy(o.qty)}株 購入しました（約定 ${d} 始値、受渡 ${dueText(o.settle_date)}）`, o.origin === 'manual' ? 'order_filled' : null);
    } else {
      const free = heldQty(db, acc.id, o.instrument_id) - unsettledQty(db, acc.id, o.instrument_id);
      if (free < o.qty) { closeOrder(db, o, 'lapsed', d, '売却可能数量が不足したため不成立'); note('order_lapsed', `${inst.name} の売り注文は数量不足で失効しました`, 'order_lapsed'); continue; }
      const gross = mulDivFloor(o.qty, row.open, 1000); const fee = calcFee(t.fee, gross, false); const net = Math.max(0, gross - fee);
      removeHolding(db, acc.id, o.instrument_id, o.qty);
      addPending(db, acc, 'sale', o.instrument_id, net, o.qty, o.settle_date, `sale:${o.id}`, d);
      ledger(db, acc, d, 'sell', gross, `sell:${o.id}`, o.instrument_id, o.qty, `約定（代金は受渡日 ${dueText(o.settle_date)} に入金）`); if (fee) ledger(db, acc, d, 'fee', -fee, `fee:${o.id}`, o.instrument_id, null, '売買手数料（売却代金から差引）');
      closeOrder(db, o, 'filled', d, null, { price_milli: row.open, gross, fee });
      note('order_filled', `${inst.name} を ${jpy(o.qty)}株 売却しました。受渡日 ${dueText(o.settle_date)} に現金になります`, 'order_filled');
    }
  }
  // 4) 投資信託の約定（基準価額が公表された日。基準価額なしの日は次の公表日へ繰り延べ）
  for (const o of db.prepare("SELECT * FROM orders WHERE account_id=? AND status='accepted' AND kind='fund' AND exec_date<=? ORDER BY id").all(acc.id, d)) {
    const inst = ds.instruments.get(o.instrument_id); const t = inst.terms; const row = ds.prices.get(o.instrument_id)?.get(d);
    if (!row || row.status !== 'normal') { note('order_deferred', `${inst.name} の基準価額が ${d} は未設定のため、注文は次の基準価額の日に繰り延べます`); continue; }
    const nav = row.close;
    if (o.side === 'buy') {
      const fee = calcFee(t.fee, o.amount, true); const net = o.amount - fee;
      const units = mulDivFloor(net, 10000000, nav);
      if (units <= 0) { closeOrder(db, o, 'lapsed', d, '購入口数が0口になるため不成立'); note('order_lapsed', `${inst.name} の購入は口数が0のため失効しました`, 'order_lapsed'); continue; }
      const invested = mulDivCeil(units, nav, 10000000); const charged = invested + fee;
      const due = dateAt(ds, d, t.buy_settlement_days) || FAR;
      addHolding(db, acc.id, o.instrument_id, units, charged);
      addPending(db, acc, 'purchase', o.instrument_id, charged, units, due, `purchase:${o.id}`, d);
      ledger(db, acc, d, 'buy', -invested, `buy:${o.id}`, o.instrument_id, units, `約定（代金は受渡日 ${dueText(due)} に支払）`); if (fee) ledger(db, acc, d, 'fee', -fee, `fee:${o.id}`, o.instrument_id, null, '購入時手数料（受渡日に支払）');
      closeOrder(db, o, 'filled', d, null, { price_milli: nav, gross: invested, fee, units });
      note('order_filled', `${inst.name} を ${jpy(charged)}円 購入（${jpy(units)}口、基準価額 ${d} 適用、受渡 ${dueText(due)}）`, o.origin === 'manual' ? 'order_filled' : null);
    } else {
      const free = heldQty(db, acc.id, o.instrument_id) - unsettledQty(db, acc.id, o.instrument_id);
      if (free < o.qty) { closeOrder(db, o, 'lapsed', d, '売却可能口数が不足したため不成立'); note('order_lapsed', `${inst.name} の売却は口数不足で失効しました`, 'order_lapsed'); continue; }
      const gross = mulDivFloor(o.qty, nav, 10000000); const fee = mulDivFloor(gross, t.holdback_ppm, 1000000); const net = gross - fee;
      removeHolding(db, acc.id, o.instrument_id, o.qty);
      const due = dateAt(ds, d, t.settlement_days) || FAR;
      addPending(db, acc, 'sale', o.instrument_id, net, o.qty, due, `sale:${o.id}`, d);
      ledger(db, acc, d, 'sell', gross, `sell:${o.id}`, o.instrument_id, o.qty, `約定（代金は受渡日 ${dueText(due)} に入金）`); if (fee) ledger(db, acc, d, 'fee', -fee, `fee:${o.id}`, o.instrument_id, null, '信託財産留保額（売却代金から差引）');
      closeOrder(db, o, 'filled', d, null, { price_milli: nav, gross, fee, units: o.qty });
      note('order_filled', `${inst.name} を ${jpy(o.qty)}口 売却しました。受渡日 ${dueText(due)} に現金になります`, 'order_filled');
    }
  }
  acc = getAcc(db, accId); acc.cash = cash;
  // 5) 積立（当日分の注文を自動作成。成立は次回以降の基準価額日）
  for (const p of db.prepare("SELECT * FROM plans WHERE account_id=? AND status='active' ORDER BY id").all(acc.id)) {
    const y = ymOf(d);
    if (y < p.first_run_ym || dayOf(d) < p.day_of_month) continue;
    if (db.prepare('SELECT 1 FROM plan_runs WHERE plan_id=? AND ym=?').get(p.id, y)) continue;
    const r = placeOrder(db, acc, ds, ev, { instrument_id: p.instrument_id, side: 'buy', amount: p.amount, _plan: true }, 'plan', p.id);
    if (r.ok) { db.prepare('INSERT INTO plan_runs VALUES(?,?,?,?)').run(p.id, y, 'ordered', r.order_id); note('plan_order', `積立: ${instName(p.instrument_id)} ${jpy(p.amount)}円 の注文を出しました（約定予定 ${r.info.exec_date}）`); }
    else { db.prepare('INSERT INTO plan_runs VALUES(?,?,?,?)').run(p.id, y, 'skipped: ' + r.errors[0], null); note('plan_skipped', `積立: ${instName(p.instrument_id)} は今月分を見送りました（${r.errors[0]}）`, 'plan_skipped'); }
  }
  // 6) 受渡・入金（受渡日・支払日が来たもの）。買付代金の支払は拘束済みのため現金が負になることはない
  const SETTLE = { sale: ['sale_settlement', 1, '売却代金の受渡'], dividend: ['dividend', 1, '配当・分配金（税引前）'], split_fraction: ['split_fraction', 1, '端数株の処分代金'], purchase: ['purchase_settlement', -1, '買付代金の受渡（支払）'] };
  for (const r of db.prepare("SELECT * FROM receivables WHERE account_id=? AND status='pending' AND due_date<=? ORDER BY id").all(acc.id, d)) {
    const [type, sign, label] = SETTLE[r.kind];
    cash += sign * r.amount; db.prepare("UPDATE receivables SET status='paid' WHERE id=?").run(r.id);
    if (cash < 0) throw new Error('invariant: cash < 0');
    ledger(db, acc, d, type, sign * r.amount, `settle:${r.ref}`, r.instrument_id, r.kind === 'purchase' ? r.qty : null, label);
    if (r.kind !== 'purchase') note(r.kind === 'sale' ? 'settled' : 'dividend_paid', `${instName(r.instrument_id)}: ${label} ${jpy(r.amount)}円 が入金されました`);
  }
  // 7) 保存・ニュース・終了判定
  const fin = finalDate(ds, ev);
  const newNews = ds.news.filter((n) => n.published_date > acc.news_seen_upto && n.published_date <= d);
  for (const n of newNews) note('news', `ニュース: ${n.summary}`, 'news');
  const done = d >= fin;
  if (done) { // 期間終了: これ以上価格データがないため、成立しなかった注文（基準価額なしで繰り延べ中の投信注文など）は失効させ、確保を解放する
    for (const o of db.prepare("SELECT * FROM orders WHERE account_id=? AND status='accepted'").all(acc.id)) { closeOrder(db, o, 'lapsed', d, 'シミュレーション期間の終了のため失効'); note('order_lapsed', `${instName(o.instrument_id)} の注文は期間終了のため失効しました`); }
  }
  db.prepare('UPDATE accounts SET cash=?, news_seen_upto=?, status=?, version=version+1 WHERE id=?').run(cash, d, done ? 'finished' : 'active', acc.id);
  acc = getAcc(db, accId); snapshot(db, acc, ds);
  if (done) { stops.push('end'); out.push({ date: d, type: 'end', text: 'シミュレーション期間の最終日に到達しました' }); }
  return { date: d, stops };
}

const STOP_TEXT = {
  order_filled: ['注文が成立したため停止しました', '保有と現金を確認し、続ける場合は進行ボタンを押してください'],
  order_lapsed: ['注文が失効したため停止しました', '失効の理由を確認し、必要なら注文し直してください'],
  plan_skipped: ['積立が資金不足などで見送られたため停止しました', '買付可能額を確認し、積立額の変更・休止もできます'],
  news: ['新しいニュース・イベントが公表されたため停止しました', '内容を確認してから再開してください（因果関係は断定できません）'],
  end: ['シミュレーション期間の最終日に到達しました', '結果画面で確認できます。同じ条件でやり直すこともできます'],
};
function advance(db, accId, ds, ev, mode) {
  const events = []; let stopReason = null; let n = 0;
  const startYm = ymOf(getAcc(db, accId).sim_date);
  while (true) {
    const acc = getAcc(db, accId);
    if (acc.status !== 'active') break;
    const r = processDay(db, accId, ds, ev, events); n++;
    if (r.stops.length) stopReason = r.stops.includes('end') ? 'end' : r.stops[0];
    if (mode === 'day' || stopReason) break;
    if (ymOf(r.date) !== startYm) break;
  }
  const stop = stopReason ? { reason: stopReason, message: STOP_TEXT[stopReason][0], next: STOP_TEXT[stopReason][1] } : null;
  return { days: n, events, stop };
}

function createPlan(db, acc, ds, inp) {
  const inst = ds.instruments.get(inp.instrument_id); const errors = [];
  if (!inst || inst.type !== 'fund') errors.push('積立は投資信託のみ対応しています');
  else {
    const t = inst.terms;
    if (!t.savings_ok) errors.push('この商品は積立に対応していません');
    const mn = t.savings_min_amount ?? t.min_amount, st = t.savings_amount_step ?? t.amount_step;
    if (!Number.isSafeInteger(inp.amount) || inp.amount < mn || inp.amount % st !== 0 || inp.amount > MAX_AMOUNT) errors.push(`積立額は ${jpy(mn)}円以上、${jpy(st)}円単位で指定してください`);
  }
  if (!Number.isInteger(inp.day_of_month) || inp.day_of_month < 1 || inp.day_of_month > 28) errors.push('積立日は1〜28日で指定してください');
  if (acc.status !== 'active') errors.push('この口座では設定できません');
  if (!errors.length && db.prepare("SELECT 1 FROM plans WHERE account_id=? AND instrument_id=? AND status!='cancelled'").get(acc.id, inp.instrument_id)) errors.push('この商品にはすでに積立設定があります。金額変更・休止・解除で操作してください');
  if (errors.length) return { ok: false, errors };
  const first = dayOf(acc.sim_date) < inp.day_of_month ? ymOf(acc.sim_date) : nextYm(ymOf(acc.sim_date));
  const r = db.prepare("INSERT INTO plans(account_id,instrument_id,amount,day_of_month,status,first_run_ym,created_date) VALUES(?,?,?,?,'active',?,?)").run(acc.id, inp.instrument_id, inp.amount, inp.day_of_month, first, acc.sim_date);
  db.prepare('UPDATE accounts SET version=version+1 WHERE id=?').run(acc.id);
  return { ok: true, plan_id: Number(r.lastInsertRowid), first_run_ym: first };
}
function updatePlan(db, acc, ds, planId, inp) {
  const p = db.prepare('SELECT * FROM plans WHERE id=? AND account_id=?').get(planId, acc.id);
  if (!p) return { ok: false, errors: ['積立設定が見つかりません'] };
  if (p.status === 'cancelled') return { ok: false, errors: ['解除済みの積立は変更できません'] };
  if (acc.status !== 'active') return { ok: false, errors: ['この口座では設定できません'] };
  const t = ds.instruments.get(p.instrument_id).terms;
  if (inp.action === 'amount') {
    const mn = t.savings_min_amount ?? t.min_amount, st = t.savings_amount_step ?? t.amount_step;
    if (!Number.isSafeInteger(inp.amount) || inp.amount < mn || inp.amount % st !== 0 || inp.amount > MAX_AMOUNT) return { ok: false, errors: [`積立額は ${jpy(mn)}円以上、${jpy(st)}円単位で指定してください`] };
    db.prepare('UPDATE plans SET amount=? WHERE id=?').run(inp.amount, p.id);
  } else if (inp.action === 'pause') {
    if (p.status !== 'active') return { ok: false, errors: ['すでに休止中です'] };
    db.prepare("UPDATE plans SET status='paused' WHERE id=?").run(p.id);
  } else if (inp.action === 'resume') {
    if (p.status !== 'paused') return { ok: false, errors: ['休止中ではありません'] };
    const first = dayOf(acc.sim_date) < p.day_of_month ? ymOf(acc.sim_date) : nextYm(ymOf(acc.sim_date));
    db.prepare("UPDATE plans SET status='active', first_run_ym=? WHERE id=?").run(first, p.id);
  } else if (inp.action === 'cancel') {
    db.prepare("UPDATE plans SET status='cancelled' WHERE id=?").run(p.id);
  } else return { ok: false, errors: ['操作が不正です'] };
  db.prepare('UPDATE accounts SET version=version+1 WHERE id=?').run(acc.id);
  return { ok: true };
}

module.exports = { FAR, finalDate, startDate, dateAt, calcFee, reservePrice, lastPrice, lineValue, getAcc, availableCash, sellableQty, valuation, snapshot, createAccount, evaluateOrder, placeOrder, cancelOrder, advance, createPlan, updatePlan, statusJa, ymOf, dayOf, nextYm, MAX_QTY, MAX_AMOUNT };
