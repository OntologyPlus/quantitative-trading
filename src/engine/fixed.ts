import { Decimal } from "decimal.js";
import type { Bar } from "../domain/contracts.js";

/**
 * Exact fixed-point view of decimal strings for the signal hot path.
 *
 * Values are scaled by 10^16 into BigInt, which represents every decimal the
 * schemas accept (≤16 fractional digits) exactly. Comparisons and sums are
 * therefore identical to Decimal.js on the same inputs, without parsing a
 * Decimal per bar per indicator.
 */
export const SCALE_DIGITS = 16;
const SCALE = 10n ** BigInt(SCALE_DIGITS);
const plain = /^(-?)(\d+)(?:\.(\d+))?$/;

export function fixed(value: string): bigint {
  const m = plain.exec(value);
  if (m && (m[3]?.length ?? 0) <= SCALE_DIGITS) {
    const frac = (m[3] ?? "").padEnd(SCALE_DIGITS, "0");
    const v = BigInt(m[2]!) * SCALE + BigInt(frac);
    return m[1] ? -v : v;
  }
  // Exponent notation or extra precision: defer to Decimal for exact scaling.
  const d = new Decimal(value).mul(SCALE.toString());
  if (!d.isInteger()) throw Error(`精度超过 ${SCALE_DIGITS} 位小数：${value}`);
  return BigInt(d.toFixed(0));
}

type Field = "open" | "high" | "low" | "close" | "volume";
type Parsed = Partial<Record<Field, bigint>>;
const parsed = new WeakMap<Bar, Parsed>();

/** Parse a bar field once; bars are treated as immutable after ingestion. */
export function field(bar: Bar, name: Field): bigint {
  let p = parsed.get(bar);
  if (!p) parsed.set(bar, (p = {}));
  return (p[name] ??= fixed(bar[name]));
}

interface WindowCache {
  last: Bar;
  sum: bigint;
}
const windows = new WeakMap<Bar[], Map<string, WindowCache>>();

/**
 * Sum of `name` over history[end - len, end). Rolls forward by one bar when the
 * previous call ended on the bar just before `end - 1`; otherwise recomputes.
 * Identity of bar objects (not indexes) is used, so front-trimming is safe.
 */
export function windowSum(
  history: Bar[],
  end: number,
  len: number,
  name: Field,
): bigint {
  let cache = windows.get(history);
  if (!cache) windows.set(history, (cache = new Map()));
  const key = `${name}:${len}`,
    hit = cache.get(key),
    last = history[end - 1]!;
  let sum: bigint;
  if (hit && hit.last === last) return hit.sum;
  if (hit && end - len - 1 >= 0 && hit.last === history[end - 2])
    sum =
      hit.sum + field(last, name) - field(history[end - len - 1]!, name);
  else {
    sum = 0n;
    for (let i = end - len; i < end; i++) sum += field(history[i]!, name);
  }
  cache.set(key, { last, sum });
  return sum;
}

export function windowMax(history: Bar[], from: number, to: number, name: Field) {
  let m = field(history[from]!, name);
  for (let i = from + 1; i < to; i++) {
    const v = field(history[i]!, name);
    if (v > m) m = v;
  }
  return m;
}
export function windowMin(history: Bar[], from: number, to: number, name: Field) {
  let m = field(history[from]!, name);
  for (let i = from + 1; i < to; i++) {
    const v = field(history[i]!, name);
    if (v < m) m = v;
  }
  return m;
}
