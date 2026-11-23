'use strict';
// 金額は円の整数、価格は 1/1000 円の整数（milli）、口数・株数は整数で保持する。浮動小数は計算に使わない。
// 掛け算・割り算は BigInt で行い、結果が安全整数（±2^53−1）に収まることを確認して Number に戻す。
// 収まらない場合は例外 → 呼び出し元のトランザクションがロールバックされ、状態は変わらない（フェイルセーフ）。
function parseDecimalMilli(v, field) {
  // 文字列/数値の小数を 1/1000 単位の整数へ。小数第4位以降・指数表記・負号はエラー。
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !/^\d+(\.\d{1,3})?$/.test(s.trim())) throw new Error(`${field}: 0以上で小数第3位までの数値で指定してください（値: ${v}）`);
  const [i, f = ''] = s.trim().split('.');
  const n = BigInt(i) * 1000n + BigInt((f + '000').slice(0, 3));
  return toNum(n, field);
}
const B = (x) => { if (typeof x === 'number' && !Number.isSafeInteger(x)) throw new Error('非整数・範囲外の値: ' + x); return BigInt(x); };
function toNum(b, field = '計算値') { if (b > BigInt(Number.MAX_SAFE_INTEGER) || b < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${field}: 安全な整数範囲を超えました`); return Number(b); }
function floorDiv(a, b) { a = B(a); b = B(b); if (b === 0n) throw new Error('0除算'); let q = a / b; if ((a % b !== 0n) && ((a < 0n) !== (b < 0n))) q -= 1n; return q; }
function ceilDiv(a, b) { return -floorDiv(-B(a), b); }
// floor(a*b/c), ceil(a*b/c)
const mulDivFloor = (a, b, c) => toNum(floorDiv(B(a) * B(b), c));
const mulDivCeil = (a, b, c) => toNum(ceilDiv(B(a) * B(b), c));
// 分割・併合: 新数量 floor(q*num/den) と余り（1/den 株単位）
function splitQty(q, num, den) { const p = B(q) * B(num); const nq = p / B(den); return { q: toNum(nq), rem: toNum(p - nq * B(den)) }; }
function fmtMilli(m) { const s = (m / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); return s; }
module.exports = { parseDecimalMilli, mulDivFloor, mulDivCeil, splitQty, fmtMilli, toNum };
