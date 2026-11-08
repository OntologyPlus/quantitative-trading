import { z } from "zod";
import { hash } from "../adapters/market.js";
import { backtest } from "../engine/backtest.js";
import { expandGrid, toColumns } from "../engine/sweep.js";
import { fail, strategySchema } from "../domain/schemas.js";
import type { Bar, RunRecord, Strategy } from "../domain/contracts.js";
import {
  assertSweepable,
  localScreener,
  sampleCombos,
  score,
  sweepInput,
  type Screener,
} from "./sweep.js";
import { sharpe, toReturns } from "./stats.js";

export const walkForwardInput = sweepInput
  .omit({ top: true })
  .extend({
    mode: z.enum(["rolling", "anchored"]).default("rolling"),
    trainBars: z.number().int().min(50).max(1000000),
    testBars: z.number().int().min(10).max(1000000),
    maxFolds: z.number().int().min(1).max(60).default(24),
  })
  .strict();

const dailyEquity = (curve: { at: number; equity: string }[]) => {
  const days = new Map<number, number>();
  for (const p of curve) days.set(Math.floor(Math.max(0, p.at - 1) / 86400000), Number(p.equity));
  return [...days.entries()];
};
const annualise = (returnPct: number, days: number) =>
  days > 0 ? ((1 + returnPct / 100) ** (365 / days) - 1) * 100 : NaN;
const drawdown = (equity: number[]) => {
  let peak = -Infinity,
    worst = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    worst = Math.max(worst, peak > 0 ? ((peak - e) / peak) * 100 : 0);
  }
  return worst;
};

/**
 * Walk-forward analysis: in each fold, choose parameters on the training
 * window with the screening kernel, then run the exact engine on the
 * following unseen test window. Test windows never overlap and are stitched
 * into one out-of-sample equity curve.
 */
export async function walkForward(
  run: RunRecord,
  base: Strategy,
  bars: Bar[],
  raw: unknown,
  screen: Screener = localScreener,
) {
  const input = walkForwardInput.parse(raw);
  if (run.status !== "completed") fail("WF_SOURCE", "滚动前推须基于已完成的回测");
  assertSweepable(base, run);
  const sorted = [...bars].sort((a, b) => a.time - b.time),
    columns = toColumns(sorted, base.interval),
    grid = expandGrid(base, input.grid),
    combos =
      input.search.mode === "random"
        ? sampleCombos(grid, input.search.samples, input.search.seed)
        : grid,
    first = sorted.findIndex((b) => b.time >= run.config.from),
    last = sorted.findLastIndex((b) => b.time <= run.config.to);
  if (first < 0 || last < first) fail("WF_RANGE", "源回测区间内没有行情");
  const results: {
    index: number;
    train: { from: number; to: number; bars: number };
    test: { from: number; to: number; bars: number };
    params: (typeof combos)[number] | null;
    trainScore: number | null;
    trainReturnPct: number | null;
    returnPct: string;
    maxDrawdownPct: string;
    trades: number;
    closedTrades: number;
    resultHash: string | null;
    note?: string;
  }[] = [];
  const stitched: { day: number; equity: number }[] = [];
  let level = 1,
    isAnnual = 0,
    isCount = 0;
  for (let k = 0; k < input.maxFolds; k++) {
    const testStart = first + input.trainBars + k * input.testBars,
      testEnd = Math.min(last + 1, testStart + input.testBars),
      trainStart = input.mode === "rolling" ? testStart - input.trainBars : first;
    if (testStart > last || testEnd - testStart < Math.min(10, input.testBars)) break;
    const train = { from: sorted[trainStart]!.time, to: sorted[testStart - 1]!.time, bars: testStart - trainStart },
      test = { from: sorted[testStart]!.time, to: sorted[testEnd - 1]!.time, bars: testEnd - testStart };
    const rows = await screen(columns, base.template, combos, { ...run.config, from: train.from, to: train.to });
    const best = rows
      .filter((r) => r.closedTrades >= input.minClosedTrades)
      .sort((a, b) => score(b, input.sortBy) - score(a, input.sortBy))[0];
    if (!best) {
      // No configuration qualified in training: stay in cash for this test window.
      results.push({
        index: k,
        train,
        test,
        params: null,
        trainScore: null,
        trainReturnPct: null,
        returnPct: "0",
        maxDrawdownPct: "0",
        trades: 0,
        closedTrades: 0,
        resultHash: null,
        note: "训练窗口内没有满足最少平仓数的参数，测试窗口保持现金",
      });
      for (let d = Math.floor(test.from / 86400000); d <= Math.floor(test.to / 86400000); d++)
        stitched.push({ day: d, equity: level });
      continue;
    }
    const strategy = strategySchema.parse({ ...base, ...best.params }) as Strategy,
      exact = backtest(strategy, { ...run.config, from: test.from, to: test.to }, sorted.slice(0, testEnd));
    const init = Number(run.config.initialCash);
    for (const [day, e] of dailyEquity(exact.state.curve)) stitched.push({ day, equity: (level * e) / init });
    level = (level * Number(exact.state.curve.at(-1)?.equity ?? init)) / init;
    const trainDays = (train.to - train.from) / 86400000 + 1;
    isAnnual += annualise(best.returnPct, trainDays);
    isCount++;
    results.push({
      index: k,
      train,
      test,
      params: best.params,
      trainScore: Number.isFinite(score(best, input.sortBy)) ? score(best, input.sortBy) : null,
      trainReturnPct: best.returnPct,
      returnPct: exact.metrics.returnPct,
      maxDrawdownPct: exact.metrics.maxDrawdownPct,
      trades: exact.metrics.trades,
      closedTrades: exact.metrics.closedTrades,
      resultHash: exact.hash,
    });
  }
  if (!results.length) fail("WF_FOLDS", "数据不足以形成一个训练+测试窗口，请缩短窗口");
  // Merge per-day points (a fold boundary inside a day keeps the later value).
  const byDay = new Map<number, number>();
  for (const p of stitched) byDay.set(p.day, p.equity);
  const curve = [...byDay.entries()].map(([day, equity]) => ({ at: day * 86400000, equity }));
  const oos = curve.map((p) => p.equity),
    returns = toReturns(oos),
    oosDays = (results.at(-1)!.test.to - results[0]!.test.from) / 86400000 + 1,
    oosReturnPct = (level - 1) * 100,
    oosAnnual = annualise(oosReturnPct, oosDays);
  // Static baseline: the source parameters over the same out-of-sample span.
  const baseline = backtest(base, { ...run.config, from: results[0]!.test.from, to: results.at(-1)!.test.to }, sorted);
  const paramKeys = results.map((r) => JSON.stringify(r.params));
  const body = {
    version: 1,
    sourceRunId: run.id,
    manifestHash: run.manifestHash,
    template: base.template,
    mode: input.mode,
    trainBars: input.trainBars,
    testBars: input.testBars,
    sortBy: input.sortBy,
    combinationsPerFold: combos.length,
    folds: results,
    outOfSample: {
      from: results[0]!.test.from,
      to: results.at(-1)!.test.to,
      returnPct: oosReturnPct,
      annualisedReturnPct: oosAnnual,
      maxDrawdownPct: drawdown(oos),
      sharpe: returns.length >= 30 ? sharpe(returns) * Math.sqrt(365) : null,
      curve,
    },
    inSampleAnnualisedReturnPct: isCount ? isAnnual / isCount : null,
    // Walk-forward efficiency: out-of-sample vs average in-sample annualised return.
    efficiency: isCount && isAnnual / isCount > 0 ? oosAnnual / (isAnnual / isCount) : null,
    parameterStability: {
      distinct: new Set(paramKeys).size,
      changes: paramKeys.filter((k, i) => i > 0 && k !== paramKeys[i - 1]).length,
    },
    staticBaseline: {
      params: { fast: base.fast, slow: base.slow, entryPeriod: base.entryPeriod, exitPeriod: base.exitPeriod },
      returnPct: baseline.metrics.returnPct,
      maxDrawdownPct: baseline.metrics.maxDrawdownPct,
      resultHash: baseline.hash,
    },
    limitations: [
      "每个测试窗口从现金重新开始，窗口末未平仓位按收盘估值计入，不跨窗口持仓；拼接曲线按窗口收益连乘。",
      "训练窗口用浮点筛选内核选参，测试窗口用逐笔精确引擎；测试窗口在选参时不可见。",
      "静态基准沿用源回测参数，而源参数可能本身选自这段数据，仅作对照。",
    ],
  };
  return { ...body, hash: hash(body) };
}
