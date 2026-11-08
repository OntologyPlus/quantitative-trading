import test from "node:test";
import assert from "node:assert/strict";
import { backtest, ENGINE_VERSION } from "../src/engine/backtest.js";
import { assertLedger, ingestClosedBar, initialState } from "../src/engine/core.js";
import { configInput, strategySchema, stateSchema } from "../src/domain/schemas.js";
import { DEFAULT_RULES, type Bar, type RunConfig, type Strategy } from "../src/domain/contracts.js";
import { STRATEGY_CATALOG } from "../src/domain/strategy-catalog.js";
import { parameterNeighbors } from "../src/domain/robustness.js";
import { seriesOf, parse } from "../src/domain/dsl.js";

function series(symbol: string, count: number, seed: number, drift = 0): Bar[] {
  let x = seed, p = 100;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: count }, (_, i) => {
    const open = p;
    p = Math.max(1, p * (1 + (rnd() - 0.5) * 0.04 + drift));
    return {
      symbol,
      time: Date.UTC(2024, 0, 1) + i * 3600000,
      open: open.toFixed(4),
      high: (Math.max(open, p) * (1 + rnd() * 0.01)).toFixed(4),
      low: (Math.min(open, p) * (1 - rnd() * 0.01)).toFixed(4),
      close: p.toFixed(4),
      volume: (100000 + rnd() * 5000).toFixed(2),
    };
  });
}
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];
const data = Object.fromEntries(SYMBOLS.map((s, i) => [s, series(s, 3000, 7 + i * 13, (i - 2) * 0.0004)]));
const btc = data.BTCUSDT!;
const strat = (x: object, symbols = ["BTCUSDT"]) =>
  strategySchema.parse({ symbols, interval: "1h", ...x }) as Strategy;
const cfg = (risk: object = {}, symbols = ["BTCUSDT"]): RunConfig => ({
  ...configInput.parse({ risk: { weightPct: "30", maxSymbolPct: "40", maxExposurePct: "100", maxPositions: 5, ...risk } }),
  rules: Object.fromEntries(symbols.map((s) => [s, DEFAULT_RULES])),
  from: btc[0]!.time,
  to: btc.at(-1)!.time,
  engineVersion: ENGINE_VERSION,
});
const strip = (fills: { id: string; orderId: string; reason: string }[]) =>
  fills.map(({ id: _i, orderId: _o, reason: _r, ...f }) => f);

test("expressions reproduce the built-in templates trade for trade", () => {
  const c = cfg();
  const sma = backtest(strat({ template: "sma_cross", fast: 10, slow: 40 }), c, btc),
    expr = backtest(
      strat({ template: "expr", rules: { version: 1, entry: "cross_above(sma(close, 10), sma(close, 40))", exit: "cross_below(sma(close, 10), sma(close, 40))" } }),
      c,
      btc,
    );
  assert.ok(sma.state.fills.length > 20);
  assert.deepEqual(strip(expr.state.fills), strip(sma.state.fills));
  assert.equal(expr.metrics.returnPct, sma.metrics.returnPct);
  const brk = backtest(strat({ template: "breakout", entryPeriod: 20, exitPeriod: 10 }), c, btc),
    brkExpr = backtest(
      strat({ template: "expr", rules: { version: 1, entry: "close > lag(highest(high, 20), 1)", exit: "close < lag(lowest(low, 10), 1)" } }),
      c,
      btc,
    );
  assert.deepEqual(strip(brkExpr.state.fills), strip(brk.state.fills));
});

test("schema rejects inconsistent definitions with readable messages", () => {
  assert.throws(() => strat({ template: "expr" }), /rules/);
  assert.throws(() => strat({ template: "expr", rules: { version: 1, entry: "rsi(close, 14)", exit: "close > 1" } }), /表达式错误.*需要条件/);
  assert.throws(() => strat({ template: "rotation", rotation: { version: 1, score: "roc(close, 10)", top: 1, every: 24 } }), /至少两个标的/);
  assert.throws(
    () => strat({ template: "expr", rules: { version: 1, entry: "close > 1", exit: "close < 1" }, conditions: { version: 1, mode: "filter", entry: [{ indicator: "return_pct", period: 3, factor: 1, operator: "gt", value: "0" }], exit: [{ indicator: "return_pct", period: 3, factor: 1, operator: "lt", value: "0" }] } }),
    /组合条件/,
  );
  assert.throws(() => configInput.parse({ risk: { sizing: "volatility" } }), /targetVolPct/);
});

test("every catalog strategy validates, backtests, reconciles and is deterministic", () => {
  let traded = 0;
  for (const entry of STRATEGY_CATALOG) {
    const symbols = entry.minSymbols ? SYMBOLS : ["BTCUSDT"],
      s = strat(entry.definition, symbols),
      c = cfg({ ...(entry.risk ?? {}), ...(entry.minSymbols ? { weightPct: "30", maxSymbolPct: "34" } : {}) }, symbols),
      bars = symbols.flatMap((x) => data[x]!);
    const a = backtest(s, c, bars),
      b = backtest(s, c, bars);
    assert.equal(a.hash, b.hash, entry.id);
    assertLedger(a.state, c.initialCash);
    stateSchema.parse(a.state);
    if (a.state.fills.length) traded++;
  }
  assert.ok(STRATEGY_CATALOG.length >= 10);
  assert.ok(traded >= 10, `only ${traded} catalog strategies traded`);
});

test("rotation holds the top-ranked symbols, sells before buying and never looks ahead", () => {
  const s = strat(
      { template: "rotation", rotation: { version: 1, score: "roc(close, 48)", top: 2, every: 24 } },
      SYMBOLS,
    ),
    c = cfg({ weightPct: "45", maxSymbolPct: "50" }, SYMBOLS),
    bars = SYMBOLS.flatMap((x) => data[x]!);
  const r = backtest(s, c, bars);
  assertLedger(r.state, c.initialCash);
  const rotations = r.state.decisions.filter((d) => d.code === "ROTATION");
  assert.ok(rotations.length > 50);
  // Rebalances happen only on the configured cadence.
  for (const d of rotations) assert.equal(((d.at - 3600000) / 3600000) % 24, 0);
  // Ranking matches roc computed independently at that close.
  const d = rotations[10]!,
    i = data.BTCUSDT!.findIndex((b) => b.time === d.at - 3600000),
    roc = SYMBOLS.map((x) => [x, seriesOf(data[x]!.slice(0, i + 1), parse("roc(close, 48)", "series")).at(-1)!] as const).sort((a, b) => b[1] - a[1]);
  assert.match(d.reason, new RegExp(`${roc[0]![0]}、${roc[1]![0]}`));
  // At most `top` positions; at any fill time sells come before buys.
  const byTime = new Map<number, string[]>();
  for (const f of r.state.fills)
    if (f.reason !== "STOP_LOSS" && f.reason !== "TAKE_PROFIT")
      byTime.set(f.at, [...(byTime.get(f.at) ?? []), f.side]);
  let both = 0;
  for (const sides of byTime.values()) {
    const lastSell = sides.lastIndexOf("SELL"),
      firstBuy = sides.indexOf("BUY");
    if (lastSell >= 0 && firstBuy >= 0) {
      both++;
      assert.ok(lastSell < firstBuy);
    }
  }
  assert.ok(both > 5);
  assert.ok(Object.keys(r.state.positions).length <= 2);
  // No lookahead: changing data after a point leaves earlier fills untouched.
  const cut = btc[2000]!.time,
    changed = bars.map((b) => (b.time >= cut ? { ...b, close: b.open, high: b.open, low: b.open } : b));
  const r2 = backtest(s, c, changed);
  assert.deepEqual(r2.state.fills.filter((f) => f.at < cut), r.state.fills.filter((f) => f.at < cut));
  // Paper trading refuses rotation (needs synchronised bars).
  assert.throws(() => ingestClosedBar(initialState("1000"), s, c, btc[0]!, "paper"), /模拟盘暂不支持/);
});

test("ATR stop, trailing stops, time stop and volatility sizing", () => {
  const s = strat({ template: "sma_cross", fast: 10, slow: 40 });
  // ATR stop: stop = entry price − 2 × ATR(14) at the signal close.
  const atr = backtest(s, cfg({ stopAtr: "2", atrPeriod: 14, takeProfitPct: "0" }), btc);
  const buy = atr.state.fills.find((f) => f.side === "BUY")!,
    signalBars = btc.filter((b) => b.time < buy.at),
    a14 = seriesOf(signalBars.slice(-57), parse("atr(14)", "series")).at(-1)!;
  const opened = backtest(s, { ...cfg({ stopAtr: "2", atrPeriod: 14, takeProfitPct: "0" }), to: buy.at }, btc),
    pos = opened.state.positions.BTCUSDT!;
  assert.ok(Math.abs(Number(pos.stop) - (Number(buy.price) - 2 * a14)) < 1e-8);
  assert.equal(pos.openedAt, buy.at);
  assert.ok(atr.state.fills.some((f) => f.reason === "STOP_LOSS"));
  assert.ok(Math.abs(a14) > 0);
  // Trailing stop exits more often than the fixed stop and never loosens.
  const fixed = backtest(s, cfg({ takeProfitPct: "0" }), btc),
    trailing = backtest(s, cfg({ takeProfitPct: "0", trailingStopPct: "2" }), btc);
  assert.ok(trailing.state.fills.filter((f) => f.reason === "STOP_LOSS").length > fixed.state.fills.filter((f) => f.reason === "STOP_LOSS").length);
  const chandelier = backtest(s, cfg({ takeProfitPct: "0", stopLossPct: "0", trailingAtr: "3" }), btc);
  assert.ok(chandelier.state.fills.some((f) => f.reason === "STOP_LOSS"));
  // Time stop: no position is held longer than 12 bars.
  const timed = backtest(s, cfg({ takeProfitPct: "0", stopLossPct: "0", maxHoldBars: 12 }), btc);
  assert.ok(timed.state.fills.some((f) => f.reason === "TIME_STOP"));
  const fills = timed.state.fills;
  for (let k = 0; k + 1 < fills.length; k += 2)
    assert.ok((fills[k + 1]!.at - fills[k]!.at) / 3600000 <= 12);
  // Volatility sizing: lower target volatility, smaller positions.
  const lo = backtest(s, cfg({ sizing: "volatility", targetVolPct: "10", volPeriod: 48, maxSymbolPct: "100" }), btc),
    hi = backtest(s, cfg({ sizing: "volatility", targetVolPct: "40", volPeriod: 48, maxSymbolPct: "100" }), btc);
  const notional = (f: { quantity: string; price: string }) => Number(f.quantity) * Number(f.price);
  assert.ok(notional(lo.state.fills[0]!) < notional(hi.state.fills[0]!));
  for (const r of [atr, trailing, chandelier, timed, lo, hi]) {
    assertLedger(r.state, "10000");
    stateSchema.parse(r.state);
  }
});

test("robustness neighbours shift every period in an expression", () => {
  const s = strat({ template: "expr", rules: { version: 1, entry: "rsi(close, 14) < 30", exit: "rsi(close, 20) > 55" } });
  const n = parameterNeighbors(s, 20) as Strategy[];
  assert.deepEqual(n.map((x) => x.rules!.entry), ["rsi(close, 11) < 30", "rsi(close, 17) < 30"]);
  assert.deepEqual(n.map((x) => x.rules!.exit), ["rsi(close, 16) > 55", "rsi(close, 24) > 55"]);
});
