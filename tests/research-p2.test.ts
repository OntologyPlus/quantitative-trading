import test from "node:test";
import assert from "node:assert/strict";
import {
  deflatedSharpe,
  expectedMaxSharpe,
  normCdf,
  normInv,
  pbo,
  probabilisticSharpe,
  realityCheck,
  rng,
} from "../src/research/stats.js";
import { walkForward } from "../src/research/walkforward.js";
import { performanceReport } from "../src/research/performance.js";
import { parameterSweep } from "../src/research/sweep.js";
import { backtest, ENGINE_VERSION } from "../src/engine/backtest.js";
import { configInput, strategySchema } from "../src/domain/schemas.js";
import { DEFAULT_RULES, type Bar, type RunRecord, type Strategy } from "../src/domain/contracts.js";

const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

test("normal distribution helpers", () => {
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  for (const p of [0.001, 0.02, 0.3, 0.5, 0.9, 0.999]) assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-6);
  assert.ok(expectedMaxSharpe(1000, 0.01) > expectedMaxSharpe(10, 0.01));
  assert.equal(expectedMaxSharpe(1, 0.01), 0);
});

test("PSR/DSR: more trials demand a higher Sharpe", () => {
  const r = rng(5),
    x = Array.from({ length: 500 }, () => 0.001 + 0.01 * gauss(r));
  const psr = probabilisticSharpe(x);
  assert.ok(psr > 0.9);
  const trials = Array.from({ length: 200 }, () => 0.05 * gauss(r));
  const d = deflatedSharpe(x, trials);
  assert.ok(d.dsr < d.psr);
  assert.ok(d.benchmarkSharpe > 0);
});

test("PBO separates persistent edge from noise; Reality Check likewise", () => {
  const r = rng(11),
    T = 800,
    N = 40;
  const noise = Array.from({ length: T }, () => Array.from({ length: N }, () => 0.01 * gauss(r)));
  const pn = pbo(noise)!;
  assert.ok(pn.pbo > 0.2 && pn.pbo < 0.8, `noise PBO ${pn.pbo}`);
  const edge = noise.map((row) => row.map((v, j) => (j === 7 ? v + 0.004 : v)));
  assert.ok(pbo(edge)!.pbo < 0.1);
  assert.ok(realityCheck(noise, { seed: 3 })!.pValue > 0.05);
  assert.ok(realityCheck(edge, { seed: 3 })!.pValue < 0.05);
  assert.deepEqual(realityCheck(edge, { seed: 3 }), realityCheck(edge, { seed: 3 }));
});

function noisy(count: number, seed = 7): Bar[] {
  let x = seed,
    p = 100;
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
      volume: (100000 + rnd() * 5000).toFixed(2),
    };
  });
}
const bars = noisy(6000);
const base = strategySchema.parse({ template: "sma_cross", symbols: ["BTCUSDT"], interval: "1h", fast: 10, slow: 40 }) as Strategy;
const config = {
  ...configInput.parse({ risk: { weightPct: "30", maxSymbolPct: "40" } }),
  rules: { BTCUSDT: DEFAULT_RULES },
  from: bars[200]!.time,
  to: bars.at(-1)!.time,
  engineVersion: ENGINE_VERSION,
} as RunRecord["config"];
const result = backtest(base, config, bars);
const run: RunRecord = {
  id: "run1",
  strategyId: "s1",
  datasetIds: ["d1"],
  config,
  status: "completed",
  progress: 100,
  createdAt: "2024-01-01T00:00:00.000Z",
  manifestHash: "m".repeat(64),
  result,
};

test("parameter sweep reports DSR, PBO and Reality Check; random search samples deterministically", async () => {
  const grid = { fast: [5, 10, 15, 20, 30], slow: [40, 60, 90, 120] };
  const r = await parameterSweep(run, base, bars, { runId: "run1", grid, top: 1, minClosedTrades: 1 });
  assert.ok(r.statistics);
  assert.equal(r.statistics!.configurations, 20);
  assert.ok(r.statistics!.deflatedSharpe.dsr >= 0 && r.statistics!.deflatedSharpe.dsr <= 1);
  assert.ok(r.statistics!.overfitting!.pbo >= 0 && r.statistics!.overfitting!.pbo <= 1);
  assert.ok(r.statistics!.realityCheck!.pValue > 0 && r.statistics!.realityCheck!.pValue <= 1);
  assert.ok(!("daily" in r.rows[0]!));
  const a = await parameterSweep(run, base, bars, { runId: "run1", grid, search: { mode: "random", samples: 7, seed: 9 } }),
    b = await parameterSweep(run, base, bars, { runId: "run1", grid, search: { mode: "random", samples: 7, seed: 9 } });
  assert.equal(a.combinations, 7);
  assert.equal(a.hash, b.hash);
});

test("walk-forward: contiguous unseen test windows, exact results, no peeking", async () => {
  const input = { runId: "run1", grid: { fast: [5, 10, 20], slow: [40, 80] }, trainBars: 1500, testBars: 700, minClosedTrades: 3, sortBy: "returnPct" };
  const wf = await walkForward(run, base, bars, input);
  assert.ok(wf.folds.length >= 5);
  for (let i = 1; i < wf.folds.length; i++)
    assert.equal(wf.folds[i]!.test.from, wf.folds[i - 1]!.test.to + 3600000);
  for (const f of wf.folds) {
    assert.equal(f.train.to + 3600000, f.test.from);
    assert.equal(f.train.bars, 1500);
    if (!f.params) continue;
    const s = strategySchema.parse({ ...base, ...f.params }) as Strategy,
      r = backtest(s, { ...config, from: f.test.from, to: f.test.to }, bars.filter((b) => b.time <= f.test.to));
    assert.equal(r.hash, f.resultHash);
  }
  const compounded = wf.folds.reduce((x, f) => x * (1 + Number(f.returnPct) / 100), 1);
  assert.ok(Math.abs((compounded - 1) * 100 - wf.outOfSample.returnPct) < 1e-6);
  // Damaging the data inside fold 2's test window cannot change what fold 2 selected.
  const f2 = wf.folds[2]!,
    damaged = bars.map((b) => (b.time >= f2.test.from ? { ...b, close: b.open, high: b.open, low: b.open } : b));
  const wf2 = await walkForward(run, base, damaged, input);
  assert.deepEqual(wf2.folds[2]!.params, f2.params);
  assert.deepEqual(wf2.folds[1], wf.folds[1]);
});

test("performance report is consistent with the run and the exact engine", () => {
  const p = performanceReport(run, base, bars, { runId: "run1" });
  assert.ok(Math.abs(p.summary.totalReturnPct! - Number(result.metrics.returnPct)) < 1e-4);
  const one = p.costSensitivity.rows.find((r) => r.multiplier === 1)!;
  assert.equal(one.resultHash, result.hash);
  const zero = p.costSensitivity.rows.find((r) => r.multiplier === 0)!;
  assert.ok(Number(zero.returnPct) >= Number(one.returnPct));
  const yearly = p.yearly.reduce((x, y) => x * (1 + y.returnPct! / 100), 1);
  assert.ok(Math.abs((yearly - 1) * 100 - p.summary.totalReturnPct!) < 1e-3);
  const monthly = p.monthly.reduce((x, y) => x * (1 + y.returnPct! / 100), 1);
  assert.ok(Math.abs((monthly - 1) * 100 - p.summary.totalReturnPct!) < 1e-3);
  assert.equal(p.trades.roundTrips, result.metrics.closedTrades);
  assert.ok(p.regimes.rows.reduce((n, r) => n + r.days, 0) > 100);
  assert.ok(p.rollingSharpe.points.length > 100);
  assert.ok(p.summary.longestDrawdownDays >= 0);
});

test("lab result views render every section from real results", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { LabResult } = await import("../src/client/lab-results.js");
  const sweep = await parameterSweep(run, base, bars, { runId: "run1", grid: { fast: [5, 10, 20], slow: [40, 80] }, top: 2, minClosedTrades: 1 });
  const wf = await walkForward(run, base, bars, { runId: "run1", grid: { fast: [5, 10], slow: [40, 80] }, trainBars: 2000, testBars: 1000, minClosedTrades: 1 });
  const perf = performanceReport(run, base, bars, { runId: "run1" });
  const html = (action: string, result: unknown) => renderToStaticMarkup(createElement(LabResult, { action, result }));
  const s = html("parameter-sweep", sweep);
  assert.match(s, /参数平面/);
  assert.match(s, /DSR/);
  assert.match(html("walk-forward", wf), /样本外收益/);
  const p = html("performance-report", perf);
  assert.match(p, /月度收益/);
  assert.match(p, /成本敏感性/);
  assert.equal(html("data-audit", {}), "");
});
