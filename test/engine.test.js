'use strict';
// 手計算で確認した値と照合する検算テスト。期待値の導出はコメントに記載。
const test = require('node:test');
const assert = require('node:assert/strict');
const { weekdays, tiny, setup, api, stockTerms, fundTerms } = require('./fixture');
const E = require('../server/engine');
const M = require('../server/money');

const DAYS = weekdays('2024-01-04', '2024-02-02'); // D0=01-04(木) D1=01-05 D2=01-08 D3=01-09 D4=01-10 D5=01-11 D6=01-12 D7=01-15 D8=01-16 ...
const inst = (id, type, terms) => ({ id, type, name: id, category: 'c', description: 'd', source_id: 'src', terms });
const ser = (arr) => Object.fromEntries(DAYS.map((d, i) => [d, arr[i] ?? arr[arr.length - 1]]));
function mk(spec, evOver = { monthly_deposit: 0 }) {
  const env = setup(tiny({ days: DAYS, ...spec }), evOver); const a = api(env); const tok = a.join(); return { env, a, tok };
}
const acc = (env) => env.db.prepare('SELECT * FROM accounts ORDER BY id DESC LIMIT 1').get();
const val = (env) => E.valuation(env.db, acc(env), env.ds);
const T1PX = ser([[null, 1000], [1010, 1020], [1030, 1040], [1050, 1060], [1070, 1080]]);

test('株式: 成行買い→翌営業日始値で約定、手数料、確保額。代金は受渡日に支払、受渡前は売却不可', () => {
  const { env, a, tok } = mk({ instruments: [inst('T1', 'stock', stockTerms(100, { rate_ppm: 1000, min: 50 }))], prices: { T1: T1PX } });
  const r = a.order(tok, { instrument_id: 'T1', side: 'buy', qty: 100, expected_sim_date: DAYS[0] });
  // 確保額 = ceil(100*1000*(1+30%)) = 130,000 + 手数料見積 floor(130,000*0.1%)=130 → 130,130（注文日の終値のみ使用）
  assert.equal(r.info.reserve, 130130); assert.equal(r.info.exec_date, DAYS[1]); assert.equal(r.info.settle_date, DAYS[3]);
  assert.equal(val(env).available, 1000000 - 130130); assert.equal(val(env).cash, 1000000);
  a.advance(tok, 'day'); // D1 約定: 100*1010=101,000、手数料101 → 未受渡の買付代金 101,101（受渡 D3）
  let v = val(env);
  assert.equal(v.cash, 1000000, '現金残高は受渡日まで減らない');
  assert.equal(v.payable_purchase, 101101); assert.equal(v.reserved, 0);
  assert.equal(v.available, 898899, '買付可能額 = 現金 − 拘束 − 未受渡買付代金');
  assert.equal(v.holdings[0].qty, 100); assert.equal(v.holdings[0].unsettled_qty, 100); assert.equal(v.holdings[0].sellable_qty, 0);
  assert.equal(v.holdings_value, 102000); assert.equal(v.total, 1000000 + 102000 - 101101); assert.equal(v.pnl, 899);
  assert.throws(() => a.order(tok, { instrument_id: 'T1', side: 'sell', qty: 100 }), /受渡前の買付分 100株 は受渡日まで売れません/);
  assert.throws(() => a.order(tok, { instrument_id: 'T1', side: 'sell', sell_all: true }), /受渡後/);
  a.advance(tok, 'day'); const tD2 = val(env).total; // D2: 終値1040
  a.advance(tok, 'day'); v = val(env); // D3 受渡: 現金−101,101、未受渡0
  assert.equal(v.cash, 898899); assert.equal(v.payable_purchase, 0); assert.equal(v.holdings[0].sellable_qty, 100);
  assert.equal(v.total - tD2, 100 * (1060 - 1040), '受渡で総資産は動かない（値動き分のみ）');
});

test('株式: 売却は受渡日まで未受渡、売却代金は受渡前の再購入に使えない、総資産は不変', () => {
  const { env, a, tok } = mk({ instruments: [inst('T1', 'stock', stockTerms(100, { rate_ppm: 1000, min: 50 }))], prices: { T1: T1PX } });
  a.order(tok, { instrument_id: 'T1', side: 'buy', qty: 100 }); for (let i = 0; i < 3; i++) a.advance(tok, 'day'); // D3 受渡済み
  const sell = a.order(tok, { instrument_id: 'T1', side: 'sell', qty: 100 });
  assert.equal(sell.info.exec_date, DAYS[4]); assert.equal(sell.info.settle_date, DAYS[6]);
  a.advance(tok, 'day'); // D4 約定: 100*1070=107,000 手数料107 → 受取106,893
  let v = val(env);
  assert.equal(v.cash, 898899); assert.equal(v.receivable_sale, 106893); assert.equal(v.holdings.length, 0);
  assert.equal(v.available, 898899, '未受渡の売却代金は買付可能額に含めない');
  assert.throws(() => a.order(tok, { instrument_id: 'T1', side: 'buy', qty: 800 }), /買付可能額が足りません/); // 確保 1,404,000 > 898,899
  const t4 = v.total; assert.equal(t4, 898899 + 106893);
  a.advance(tok, 'day'); v = val(env); assert.equal(v.total, t4); assert.equal(v.receivable_sale, 106893);
  a.advance(tok, 'day'); v = val(env); assert.equal(v.total, t4); assert.equal(v.receivable_sale, 0); assert.equal(v.cash, 898899 + 106893);
});

test('株式: 翌日の値上がりで確保額を超えた買いは失効（境界: 1300円は成立/1301円は失効）、拘束は解放', () => {
  const { env, a, tok } = mk({
    instruments: [inst('T3', 'stock', stockTerms(100)), inst('T4', 'stock', stockTerms(100))],
    prices: { T3: ser([[null, 1000], [1301, 1300]]), T4: ser([[null, 1000], [1300, 1300]]) },
  });
  a.order(tok, { instrument_id: 'T3', side: 'buy', qty: 100 }); a.order(tok, { instrument_id: 'T4', side: 'buy', qty: 100 });
  assert.equal(val(env).available, 1000000 - 260000);
  const res = a.advance(tok, 'day');
  const o = env.db.prepare('SELECT instrument_id,status,reason FROM orders ORDER BY id').all();
  assert.equal(o[0].status, 'lapsed'); assert.match(o[0].reason, /確保した範囲/);
  assert.equal(o[1].status, 'filled'); assert.equal(res.stop.reason, 'order_lapsed');
  const v = val(env); assert.equal(v.reserved, 0); assert.equal(v.payable_purchase, 130000); assert.equal(v.available, 870000); assert.equal(v.cash, 1000000);
});

test('株式: 値幅表（商品条件）による確保。注文日の終値＋制限値幅まで成立、範囲外の価格帯は受付不可', () => {
  const tbl = [['500', '80'], ['1000', '150'], ['1500', '300']];
  const terms = { ...stockTerms(100), buy_reserve_margin_bp: undefined, price_limit_table: tbl };
  const { env, a, tok } = mk({
    instruments: [inst('L1', 'stock', terms), inst('L2', 'stock', terms), inst('L3', 'stock', terms)],
    prices: { L1: ser([[null, 1000], [1300, 1300]]), L2: ser([[null, 1000], [1301, 1301]]), L3: ser([[null, 2000], [2000, 2000]]) },
  });
  const r = a.order(tok, { instrument_id: 'L1', side: 'buy', qty: 100 }); // 1000円は「1500円未満」の行 → 値幅300 → 確保価格1,300円
  assert.equal(r.info.reserve_price_milli, 1300000); assert.equal(r.info.reserve, 130000);
  a.order(tok, { instrument_id: 'L2', side: 'buy', qty: 100 });
  assert.throws(() => a.order(tok, { instrument_id: 'L3', side: 'buy', qty: 100 }), /確保ルールが商品条件に設定されていない/);
  a.advance(tok, 'day');
  assert.deepEqual(env.db.prepare('SELECT status FROM orders ORDER BY id').all().map((x) => x.status), ['filled', 'lapsed']);
});

test('株式: 売買停止日・始値なしは失効して確保が戻る / 取消期限', () => {
  const { env, a, tok } = mk({ instruments: [inst('T5', 'stock', stockTerms(100))], prices: { T5: ser([[null, 1000], [null, 1000, 'halt'], [1000, 1000]]) } });
  const o = a.order(tok, { instrument_id: 'T5', side: 'buy', qty: 100 });
  assert.ok(val(env).available < 1000000);
  a.advance(tok, 'day');
  assert.equal(env.db.prepare('SELECT status FROM orders WHERE id=?').get(o.order_id).status, 'lapsed');
  assert.equal(val(env).available, 1000000);
  assert.throws(() => a.cancel(tok, o.order_id), /すでに/);
  const o2 = a.order(tok, { instrument_id: 'T5', side: 'buy', qty: 100 });
  a.cancel(tok, o2.order_id);
  assert.equal(val(env).available, 1000000, '取消で拘束が解放される');
});

test('入力検証: 売買単位・資金超過・保有超過・不正値を理由付きで拒否', () => {
  const { env, a, tok } = mk({ instruments: [inst('T5', 'stock', stockTerms(100))], prices: { T5: ser([[null, 1000], [1000, 1000]]) } });
  assert.throws(() => a.order(tok, { instrument_id: 'T5', side: 'buy', qty: 150 }), /100 株（口）です/);
  assert.throws(() => a.order(tok, { instrument_id: 'T5', side: 'buy', qty: 1000 }), /買付可能額が足りません/);
  assert.throws(() => a.order(tok, { instrument_id: 'T5', side: 'sell', qty: 100 }), /売却できる数量を超えています/);
  for (const q of [1.5, -100, 0, '100', 1e20, null]) assert.throws(() => a.order(tok, { instrument_id: 'T5', side: 'buy', qty: q }), /整数/);
  assert.throws(() => a.order(tok, { instrument_id: 'T5', side: 'buy', qty: 100 * 1000000 }), /大きすぎ|足りません/);
  assert.equal(env.db.prepare('SELECT COUNT(*) c FROM orders').get().c, 0);
});

test('資金の二重拘束防止: 拘束済みの資金を超える2件目は拒否', () => {
  const { a, tok } = mk({ instruments: [inst('T5', 'stock', stockTerms(100))], prices: { T5: ser([[null, 1000], [1000, 1000]]) } });
  a.order(tok, { instrument_id: 'T5', side: 'buy', qty: 600 }); // 確保 780,000
  assert.throws(() => a.order(tok, { instrument_id: 'T5', side: 'buy', qty: 300 }), /買付可能額が足りません/);
});

test('投資信託: 金額指定購入（手数料込み）→口数・端数、受渡前は売却不可、売却（信託財産留保額）と受渡', () => {
  const { env, a, tok } = mk({ instruments: [inst('F1', 'fund', fundTerms({ rate_ppm: 11000 }))], prices: { F1: ser([[null, 12000], [null, 12345], [null, 12345], [null, 12400]]) } });
  const o = a.order(tok, { instrument_id: 'F1', side: 'buy', amount: 100000 });
  assert.equal(o.info.exec_date, DAYS[1]); assert.equal(o.info.settle_date, DAYS[2]);
  a.advance(tok, 'day');
  // 手数料 floor(100,000*11,000/1,011,000)=1,088 → 正味 98,912 → 口数 floor(98,912*10^7/12,345,000)=80,123
  // 約定代金 ceil(80,123*12,345,000/10^7)=98,912 → 支払 98,912+1,088=100,000（受渡 D2）
  let v = val(env); const h = v.holdings[0];
  assert.equal(h.qty, 80123); assert.equal(h.sellable_qty, 0); assert.equal(v.cash, 1000000); assert.equal(v.payable_purchase, 100000); assert.equal(v.available, 900000);
  assert.throws(() => a.order(tok, { instrument_id: 'F1', side: 'sell', qty: 80123 }), /受渡前/);
  a.advance(tok, 'day'); v = val(env); assert.equal(v.cash, 900000); assert.equal(v.holdings[0].sellable_qty, 80123);
  const so = a.order(tok, { instrument_id: 'F1', side: 'sell', qty: 80123 });
  assert.equal(so.info.exec_date, DAYS[3]);
  a.advance(tok, 'day');
  // 売却 gross=floor(80,123*12,400,000/10^7)=99,352 留保額 floor(99,352*3000/10^6)=298 → 99,054、受渡 D3+4=D7
  v = val(env);
  assert.equal(v.receivable_sale, 99054); assert.equal(v.cash, 900000);
  assert.equal(env.db.prepare("SELECT due_date FROM receivables WHERE kind='sale'").get().due_date, DAYS[7]);
});

test('投資信託: 基準価額が未設定の日は約定を次の公表日へ繰り延べ、その間は取消できない', () => {
  const days = DAYS;
  const spec = { instruments: [inst('F1', 'fund', fundTerms())], prices: { F1: { [days[0]]: [null, 10000], [days[1]]: [null, 10000, 'halt'], [days[2]]: [null, 10000], [days[3]]: [null, 10000] } } };
  const env = setup(tiny({ days, ...spec, period_end: days[3] }), { monthly_deposit: 0 }); const a = api(env); const tok = a.join();
  const o = a.order(tok, { instrument_id: 'F1', side: 'buy', amount: 10000 });
  a.advance(tok, 'day');
  assert.equal(env.db.prepare('SELECT status FROM orders WHERE id=?').get(o.order_id).status, 'accepted');
  assert.throws(() => a.cancel(tok, o.order_id), /取消期限は過ぎています/);
  a.advance(tok, 'day');
  assert.equal(env.db.prepare('SELECT status FROM orders WHERE id=?').get(o.order_id).status, 'filled');
});

test('配当: 権利付最終日に約定（受渡前）なら受取、権利落日の売却でも受取、権利付最終日の売却は対象外', () => {
  // D2=権利付最終日、D3=権利落日、D4=権利確定日、支払 D6
  const div = { instrument_id: 'D1', type: 'dividend', ex_date: DAYS[3], record_date: DAYS[4], per_unit: '10', pay_date: DAYS[6] };
  const px = ser([[null, 1000], [1000, 1000]]);
  // A: D1注文→D2約定(権利付最終日・受渡前) → 権利あり
  let { env, a, tok } = mk({ instruments: [inst('D1', 'stock', stockTerms(100))], prices: { D1: px }, actions: [div] });
  a.advance(tok, 'day'); a.order(tok, { instrument_id: 'D1', side: 'buy', qty: 100 }); a.advance(tok, 'day'); a.advance(tok, 'day');
  assert.equal(val(env).receivable_dividend, 1000, '100株×10円');
  // B: 受渡0日の条件で D0買い→D1約定。D2に売り注文 → 権利落日D3の始値で約定 → 権利落日の売却なので受取
  const t0 = { ...stockTerms(100), settlement_days: 0 };
  ({ env, a, tok } = mk({ instruments: [inst('D1', 'stock', t0)], prices: { D1: px }, actions: [div] }));
  a.order(tok, { instrument_id: 'D1', side: 'buy', qty: 100 }); a.advance(tok, 'day'); a.advance(tok, 'day');
  a.order(tok, { instrument_id: 'D1', side: 'sell', qty: 100 }); a.advance(tok, 'day');
  assert.equal(val(env).holdings.length, 0); assert.equal(val(env).receivable_dividend, 1000);
  // C: 権利付最終日(D2)に売り約定 → 権利なし
  ({ env, a, tok } = mk({ instruments: [inst('D1', 'stock', t0)], prices: { D1: px }, actions: [div] }));
  a.order(tok, { instrument_id: 'D1', side: 'buy', qty: 100 }); a.advance(tok, 'day'); // D1 約定・受渡
  a.order(tok, { instrument_id: 'D1', side: 'sell', qty: 100 }); a.advance(tok, 'day'); a.advance(tok, 'day'); // D2 売り約定 → D3 権利落
  assert.equal(val(env).receivable_dividend, 0);
  for (let i = 0; i < 3; i++) a.advance(tok, 'day');
  assert.equal(env.db.prepare("SELECT COUNT(*) c FROM ledger WHERE type='dividend'").get().c, 0);
});

test('配当の入金と分割の端数処分代金（データの値のみ使用）。受渡前の買付分も分割で換算', () => {
  const { env, a, tok } = mk({
    instruments: [inst('T6', 'stock', stockTerms(100)), inst('T7', 'etf', stockTerms(1))],
    prices: { T6: ser([[null, 500], [500, 500]]), T7: ser([[null, 800], [800, 800], [800, 800], [600, 600]]) },
    actions: [{ instrument_id: 'T6', type: 'dividend', ex_date: DAYS[3], record_date: DAYS[4], per_unit: '12.5', pay_date: DAYS[5] },
      { instrument_id: 'T7', type: 'split', ex_date: DAYS[2], num: 3, den: 2, fraction_price: '590', fraction_pay_date: DAYS[8] }],
  });
  a.order(tok, { instrument_id: 'T6', side: 'buy', qty: 300 }); a.order(tok, { instrument_id: 'T7', side: 'buy', qty: 101 });
  a.advance(tok, 'day'); // D1 約定（受渡 D3）
  a.advance(tok, 'day'); // D2 T7 分割（受渡前の101株も対象）
  let v = val(env); const t7 = v.holdings.find((h) => h.instrument_id === 'T7');
  assert.equal(t7.qty, 151); assert.equal(t7.unsettled_qty, 151); assert.equal(t7.sellable_qty, 0); // floor(101*3/2)=151、余り 1/2 株
  // 端数処分代金 = floor(余り1 × 590円 / 分母2) = 295円（データで与えた値。終値で補完しない）、支払 D8
  assert.equal(env.db.prepare("SELECT amount,due_date FROM receivables WHERE kind='split_fraction'").get().amount, 295);
  a.advance(tok, 'day'); // D3 権利落 & 受渡
  v = val(env);
  assert.equal(v.receivable_dividend, 3750 + 295); // 300株 × 12.5円 + 端数代金
  assert.equal(v.holdings.find((h) => h.instrument_id === 'T7').sellable_qty, 151);
  const tAt3 = v.total; a.advance(tok, 'day'); a.advance(tok, 'day'); // D5 配当支払
  v = val(env); assert.equal(v.cash, 1000000 - 150000 - 80800 + 3750);
  assert.equal(v.total, tAt3, '配当の入金で総資産は変わらない');
  for (let i = 0; i < 3; i++) a.advance(tok, 'day'); // D8
  assert.equal(val(env).cash, 1000000 - 150000 - 80800 + 3750 + 295);
});

test('分割の効力発生日に未約定の株式注文は失効する', () => {
  const { env, a, tok } = mk({ instruments: [inst('T7', 'etf', stockTerms(1))], prices: { T7: ser([[null, 800], [800, 800]]) }, actions: [{ instrument_id: 'T7', type: 'split', ex_date: DAYS[1], num: 2, den: 1 }] });
  const o = a.order(tok, { instrument_id: 'T7', side: 'buy', qty: 10 }); a.advance(tok, 'day');
  assert.equal(env.db.prepare('SELECT status FROM orders WHERE id=?').get(o.order_id).status, 'lapsed');
  assert.equal(val(env).available, 1000000);
});

test('積立: 毎月の発注・金額変更・休止・再開・解除、反映時期', () => {
  const days = weekdays('2024-01-04', '2024-04-30');
  const env = setup(tiny({ days, instruments: [inst('F1', 'fund', fundTerms())], prices: { F1: Object.fromEntries(days.map((d) => [d, [null, 10000]])) } }), { monthly_deposit: 0 });
  const a = api(env); const tok = a.join();
  assert.throws(() => a.plan(tok, { instrument_id: 'F1', amount: 50, day_of_month: 5 }), /100円以上/);
  const p = a.plan(tok, { instrument_id: 'F1', amount: 10000, day_of_month: 5 });
  assert.equal(p.first_run_ym, '2024-01');
  a.advance(tok, 'day'); assert.equal(env.db.prepare('SELECT COUNT(*) c FROM orders').get().c, 1);
  a.advance(tok, 'day'); assert.equal(val(env).holdings[0].qty, 10000);
  a.planUpd(tok, p.plan_id, { action: 'amount', amount: 20000 }); a.planUpd(tok, p.plan_id, { action: 'pause' });
  while (acc(env).sim_date < '2024-02-20') a.advance(tok, 'day');
  assert.equal(env.db.prepare('SELECT COUNT(*) c FROM orders').get().c, 1, '休止中は発注されない');
  a.planUpd(tok, p.plan_id, { action: 'resume' });
  while (acc(env).sim_date < '2024-03-08') a.advance(tok, 'day');
  const os = env.db.prepare('SELECT amount,placed_date FROM orders ORDER BY id').all();
  assert.equal(os.length, 2); assert.equal(os[1].amount, 20000); assert.equal(os[1].placed_date, '2024-03-05');
  a.planUpd(tok, p.plan_id, { action: 'cancel' });
  assert.throws(() => a.planUpd(tok, p.plan_id, { action: 'resume' }), /解除済み/);
  while (acc(env).sim_date < '2024-04-12') a.advance(tok, 'day');
  assert.equal(env.db.prepare('SELECT COUNT(*) c FROM orders').get().c, 2, '解除後は発注されない');
});

test('積立: 資金不足の月は見送って自動停止し、二重に発注しない', () => {
  const days = weekdays('2024-01-04', '2024-02-29');
  const env = setup(tiny({ days, instruments: [inst('F1', 'fund', fundTerms())], prices: { F1: Object.fromEntries(days.map((d) => [d, [null, 10000]])) } }), { monthly_deposit: 0, initial_cash: 15000 });
  const a = api(env); const tok = a.join();
  a.plan(tok, { instrument_id: 'F1', amount: 10000, day_of_month: 5 });
  const stops = []; do { stops.push(a.advance(tok, 'day').stop?.reason); } while (acc(env).sim_date < '2024-02-06');
  const runs = env.db.prepare('SELECT ym,result FROM plan_runs ORDER BY ym').all();
  assert.equal(runs[0].result, 'ordered'); assert.match(runs[1].result, /^skipped: 買付可能額が足りません/);
  assert.ok(stops.includes('plan_skipped')); assert.ok(val(env).cash >= 0);
});

test('月初の追加資金は月が変わる最初の営業日に1回だけ入る', () => {
  const days = weekdays('2024-01-29', '2024-03-05');
  const env = setup(tiny({ days, instruments: [inst('T5', 'stock', stockTerms(100))], prices: { T5: Object.fromEntries(days.map((d) => [d, [1000, 1000]])) } }), { monthly_deposit: 30000 });
  const a = api(env); const tok = a.join();
  while (acc(env).status === 'active') a.advance(tok, 'day');
  const dep = env.db.prepare("SELECT date,amount FROM ledger WHERE type='deposit' ORDER BY id").all();
  assert.deepEqual(dep.map((d) => d.date), ['2024-01-29', '2024-02-01', '2024-03-01']);
  assert.equal(acc(env).deposits, 1000000 + 60000);
});

test('数値の精度・範囲: 小数第3位まで、負値・指数表記を拒否、安全整数を超える計算は例外（状態は変えない）', () => {
  assert.equal(M.parseDecimalMilli('1234.5', 'x'), 1234500); assert.equal(M.parseDecimalMilli('0.001', 'x'), 1);
  for (const bad of ['1.2345', '-1', '1e5', '', 'abc', '1,000']) assert.throws(() => M.parseDecimalMilli(bad, 'x'));
  assert.throws(() => M.parseDecimalMilli('99999999999999', 'x'), /安全な整数/);
  assert.throws(() => M.mulDivFloor(Number.MAX_SAFE_INTEGER, 10, 1), /安全な整数/);
  assert.throws(() => M.mulDivFloor(1.5, 1, 1), /非整数/);
  // 上限値での最大計算（数量1,000万 × 価格1億円 = 1京円）が安全整数内であること
  assert.equal(M.mulDivCeil(E.MAX_QTY, 100000000 * 1000, 1000), 1e15);
  assert.ok(M.mulDivFloor(1000000000, 10000000, 1000) <= Number.MAX_SAFE_INTEGER); // 投信: 10億円 / 基準価額1円 の口数
  assert.deepEqual(M.splitQty(101, 3, 2), { q: 151, rem: 1 });
});
