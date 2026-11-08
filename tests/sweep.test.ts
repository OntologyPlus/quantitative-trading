import test from "node:test";
import assert from "node:assert/strict";
import { backtest, ENGINE_VERSION } from "../src/engine/backtest.js";
import { expandGrid, sweep, toColumns } from "../src/engine/sweep.js";
import { parameterSweep } from "../src/research/sweep.js";
import { poolScreener } from "../src/host/sweep-pool.js";
import { configInput, strategySchema } from "../src/domain/schemas.js";
import { DEFAULT_RULES, type Bar, type RunRecord, type Strategy } from "../src/domain/contracts.js";

function noisy(count: number, seed = 7): Bar[] {
  let x = seed, p = 100;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: count }, (_, i) => {
    const open = p;
    p = Math.max(1, p * (1 + (rnd() - 0.5) * 0.04));
    return {
      symbol: "BTCUSDT",
      time: Date.UTC(2024, 0, 1) + i * 3600000,
      open: open.toFixed(4),
      high: (Math.max(open, p) * (1 + rnd() * 0.01)).toFixed(4),
      low: (Math.min(open, p) * (1 - rnd() * 0.01)).toFixed(4),
      close: p.toFixed(4),
      volume: (1000 + rnd() * 5000).toFixed(2),
    };
  });
}
const bars = noisy(4000);
const config = (risk: object = {}) =>
  ({
    ...configInput.parse({ risk: { weightPct: "30", maxSymbolPct: "40", maxExposurePct: "90", ...risk } }),
    rules: { BTCUSDT: DEFAULT_RULES },
    from: bars[100]!.time,
    to: bars.at(-1)!.time,
    engineVersion: ENGINE_VERSION,
  }) as RunRecord["config"];
const strategy = (x: object) =>
  strategySchema.parse({ symbols: ["BTCUSDT"], interval: "1h", ...x }) as Strategy;

test("float screening reproduces the exact engine on trades and metrics", () => {
  const cases: [Strategy, RunRecord["config"]][] = [
    [strategy({ template: "sma_cross", fast: 5, slow: 30 }), config()],
    [strategy({ template: "sma_cross", fast: 12, slow: 60 }), config({ dailyLossPct: "1", maxDrawdownPct: "8" })],
    [strategy({ template: "breakout", entryPeriod: 24, exitPeriod: 12 }), config()],
    [strategy({ template: "breakout", entryPeriod: 48, exitPeriod: 24 }), config({ sizing: "risk", stopLossPct: "3", takeProfitPct: "6" })],
  ];
  const cols = toColumns(bars, "1h");
  for (const [s, c] of cases) {
    const exact = backtest(s, c, bars).metrics,
      [row] = sweep(cols, s.template, [s], c);
    assert.equal(row!.trades, exact.trades);
    assert.equal(row!.closedTrades, exact.closedTrades);
    assert.ok(Math.abs(row!.returnPct - Number(exact.returnPct)) < 1e-6);
    assert.ok(Math.abs(row!.maxDrawdownPct - Number(exact.maxDrawdownPct)) < 1e-6);
    assert.ok(Math.abs(row!.exposurePct - Number(exact.exposurePct)) < 1e-6);
    if (exact.sharpe !== null) assert.ok(Math.abs(row!.sharpe! - Number(exact.sharpe)) < 1e-6);
  }
});

test("grid expansion drops invalid SMA pairs and enforces bounds", () => {
  const base = strategy({ template: "sma_cross" });
  const combos = expandGrid(base, { fast: [5, 20, 60], slow: [20, 60] });
  assert.deepEqual(combos.map((c) => [c.fast, c.slow]), [[5, 20], [5, 60], [20, 60]]);
  assert.throws(() => expandGrid(base, { fast: [1] }), /2–2000/);
  assert.throws(() => expandGrid(base, { fast: [2, 3, 4], slow: [10, 11, 12] }, 5), /超过/);
});

const run = (s: Strategy, c: RunRecord["config"]): RunRecord => ({
  id: "run1",
  strategyId: "s1",
  datasetIds: ["d1"],
  config: c,
  status: "completed",
  progress: 100,
  createdAt: "2024-01-01T00:00:00.000Z",
  manifestHash: "m".repeat(64),
});

test("sweep ranks by screening and confirms leaders with the exact engine", async () => {
  const base = strategy({ template: "sma_cross" }),
    c = config();
  const result = await parameterSweep(run(base, c), base, bars, {
    runId: "run1",
    grid: { fast: [5, 10, 20], slow: [30, 60, 90] },
    top: 3,
    minClosedTrades: 1,
  });
  assert.equal(result.combinations, 9);
  assert.equal(result.rows.length, 9);
  assert.equal(result.confirmed.length, 3);
  for (const k of result.confirmed) {
    const exact = backtest(strategy({ template: "sma_cross", ...k.params }), c, bars);
    assert.equal(k.resultHash, exact.hash);
    assert.ok(k.screeningReturnGapPct < 1e-6);
  }
  const again = await parameterSweep(run(base, c), base, bars, {
    runId: "run1",
    grid: { fast: [5, 10, 20], slow: [30, 60, 90] },
    top: 3,
    minClosedTrades: 1,
  });
  assert.equal(again.hash, result.hash);
  await assert.rejects(
    parameterSweep(run(base, c), strategy({ template: "sma_cross", symbols: ["BTCUSDT", "ETHUSDT"] }), bars, { runId: "run1", grid: {} }),
    /单一标的/,
  );
});

test("worker pool returns the same rows in combination order", async () => {
  const base = strategy({ template: "breakout" }),
    c = config(),
    cols = toColumns(bars, "1h"),
    combos = expandGrid(base, { entryPeriod: [10, 20, 30, 40, 50, 60], exitPeriod: [5, 10, 15, 20, 25, 30] });
  const pooled = await poolScreener({
    workerURL: new URL("../src/workers/sweep.ts", import.meta.url),
    threads: 3,
    minPerThread: 1,
  })(cols, "breakout", combos, c);
  assert.deepEqual(pooled, sweep(cols, "breakout", combos, c));
});
