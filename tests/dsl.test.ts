import test from "node:test";
import assert from "node:assert/strict";
import { compile, DslError, lookback, parse, print, scalePeriods, seriesOf, evaluate } from "../src/domain/dsl.js";
import type { Bar } from "../src/domain/contracts.js";

function noisy(count: number, seed = 3, symbol = "BTCUSDT"): Bar[] {
  let x = seed, p = 100;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: count }, (_, i) => {
    const open = p;
    p = Math.max(1, p * (1 + (rnd() - 0.5) * 0.04));
    return {
      symbol,
      time: Date.UTC(2024, 0, 1) + i * 3600000,
      open: open.toFixed(4),
      high: (Math.max(open, p) * (1 + rnd() * 0.01)).toFixed(4),
      low: (Math.min(open, p) * (1 - rnd() * 0.01)).toFixed(4),
      close: p.toFixed(4),
      volume: (1000 + rnd() * 5000).toFixed(2),
    };
  });
}
const bars = noisy(600);
const close = bars.map((b) => Number(b.close)),
  high = bars.map((b) => Number(b.high)),
  low = bars.map((b) => Number(b.low)),
  vol = bars.map((b) => Number(b.volume));
const near = (a: number, b: number, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const at = (src: string, i: number) => seriesOf(bars, parse(src, "series"))[i]!;

test("parser: precedence, canonical text, type and bound errors", () => {
  assert.equal(
    print(parse("CROSS_ABOVE(ema(close,12),ema(close , 26)) && adx(14)>25 || not close<open", "bool")),
    "cross_above(ema(close, 12), ema(close, 26)) and adx(14) > 25 or not close < open",
  );
  assert.equal(print(parse("(close - open) / (high - low) * 2 + -1", "series")), "(close - open) / (high - low) * 2 + -1");
  for (const [src, kind, msg] of [
    ["foo(close, 3) > 1", "bool", /未知函数/],
    ["sma(close, 3)", "bool", /需要条件/],
    ["close > 1", "series", /数值序列/],
    ["sma(close, 0) > 1", "bool", /1–1000/],
    ["sma(close, 2.5) > 1", "bool", /整数/],
    ["sma(close) > 1", "bool", /2 个参数/],
    ["sma(close, close) > 1", "bool", /数字常量/],
    ["macd(close, 26, 12) > 0", "bool", /快线/],
    ["close > ", "bool", /不完整/],
    ["close > 1 )", "bool", /多余/],
    ["close $ 1", "bool", /无法识别/],
    ["ema(ema(ema(close, 1000), 1000), 1000) > 1", "bool", /4000/],
  ] as const)
    assert.throws(() => parse(src, kind), (e: unknown) => e instanceof DslError && msg.test(e.message), src);
  assert.equal(lookback(parse("cross_above(sma(close, 20), sma(close, 60))", "bool")), 61);
  assert.equal(print(scalePeriods(parse("rsi(close, 14) < 30 and close > sma(close, 200)", "bool"), 1.1)), "rsi(close, 15) < 30 and close > sma(close, 220)");
});

test("indicators match straightforward reference implementations", () => {
  const i = 400;
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const sd = (a: number[]) => Math.sqrt(mean(a.map((v) => (v - mean(a)) ** 2)));
  near(at("sma(close, 20)", i), mean(close.slice(i - 19, i + 1)));
  near(at("highest(high, 20)", i), Math.max(...high.slice(i - 19, i + 1)));
  near(at("lowest(low, 20)", i), Math.min(...low.slice(i - 19, i + 1)));
  near(at("stdev(close, 20)", i), sd(close.slice(i - 19, i + 1)), 1e-7);
  near(at("bb_upper(close, 20, 2)", i), mean(close.slice(i - 19, i + 1)) + 2 * sd(close.slice(i - 19, i + 1)), 1e-9);
  near(at("zscore(close, 20)", i), (close[i]! - mean(close.slice(i - 19, i + 1))) / sd(close.slice(i - 19, i + 1)), 1e-6);
  near(at("roc(close, 10)", i), (close[i]! / close[i - 10]! - 1) * 100);
  near(at("lag(close, 3)", i), close[i - 3]!);
  const w = close.slice(i - 9, i + 1);
  near(at("wma(close, 10)", i), w.reduce((s, v, j) => s + v * (j + 1), 0) / 55);
  const tp = bars.map((_, j) => ((high[j]! + low[j]! + close[j]!) / 3) * vol[j]!);
  near(at("vwap(5)", i), tp.slice(i - 4, i + 1).reduce((a, b) => a + b) / vol.slice(i - 4, i + 1).reduce((a, b) => a + b));
  const r = close.map((c, j) => (j ? (c / close[j - 1]! - 1) * 100 : 0)).slice(i - 19, i + 1);
  near(at("rvol(20)", i), Math.sqrt(r.reduce((s, v) => s + (v - mean(r)) ** 2, 0) / 19), 1e-6);
  // EMA seeded with the SMA of the first window.
  let e = mean(close.slice(0, 12));
  for (let j = 12; j <= i; j++) e = (2 / 13) * close[j]! + (11 / 13) * e;
  near(at("ema(close, 12)", i), e);
  // Wilder RSI and ATR.
  let ag = 0, ad = 0;
  for (let j = 1; j <= 14; j++) {
    const ch = close[j]! - close[j - 1]!;
    ag += Math.max(ch, 0) / 14;
    ad += Math.max(-ch, 0) / 14;
  }
  for (let j = 15; j <= i; j++) {
    const ch = close[j]! - close[j - 1]!;
    ag = (ag * 13 + Math.max(ch, 0)) / 14;
    ad = (ad * 13 + Math.max(-ch, 0)) / 14;
  }
  near(at("rsi(close, 14)", i), 100 - 100 / (1 + ag / ad), 1e-9);
  const tr = bars.map((_, j) => (j ? Math.max(high[j]! - low[j]!, Math.abs(high[j]! - close[j - 1]!), Math.abs(low[j]! - close[j - 1]!)) : NaN));
  let atr = mean(tr.slice(1, 15));
  for (let j = 15; j <= i; j++) atr = (atr * 13 + tr[j]!) / 14;
  near(at("atr(14)", i), atr, 1e-9);
  const adx = at("adx(14)", i);
  assert.ok(adx > 0 && adx < 100);
  near(at("macd_hist(close, 12, 26, 9)", i), at("macd(close, 12, 26)", i) - at("macd_signal(close, 12, 26, 9)", i));
  // Monotone series: RSI 100, rising holds.
  const up = bars.map((b, j) => ({ ...b, open: String(100 + j), high: String(101 + j), low: String(99 + j), close: String(100.5 + j) }));
  assert.equal(seriesOf(up, parse("rsi(close, 14)", "series")).at(-1), 100);
  assert.deepEqual(evaluate(up, [compile("rising(close, 5)", "bool"), compile("falling(close, 5)", "bool")]).conditions, [true, false]);
  // Too little history is NaN, and comparisons on NaN are false.
  assert.ok(Number.isNaN(at("sma(close, 20)", 18)));
  assert.deepEqual(evaluate(bars.slice(0, 10), [compile("sma(close, 20) > 0", "bool")]).conditions, [false]);
});

test("cross detection uses the previous and current closed bar only", () => {
  const n = parse("cross_above(close, sma(close, 5))", "bool");
  const series = seriesOf(bars, parse("sma(close, 5)", "series"));
  for (let i = 10; i < 200; i++) {
    const expected = close[i - 1]! <= series[i - 1]! && close[i]! > series[i]!;
    assert.equal(evaluate(bars.slice(0, i + 1), [n]).conditions[0], expected);
  }
});
