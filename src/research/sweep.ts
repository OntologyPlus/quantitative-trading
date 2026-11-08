import { z } from "zod";
import { hash } from "../adapters/market.js";
import { backtest } from "../engine/backtest.js";
import { hasExtendedRisk } from "../engine/core.js";
import {
  expandGrid,
  sweep,
  toColumns,
  SWEEP_VERSION,
  type SweepColumns,
  type SweepParams,
  type SweepRow,
} from "../engine/sweep.js";
import { fail, id, strategySchema } from "../domain/schemas.js";
import type { Bar, RunRecord, Strategy } from "../domain/contracts.js";
import {
  deflatedSharpe,
  pbo,
  realityCheck,
  rng,
  sharpe,
  toReturns,
} from "./stats.js";

const periods = z.array(z.number().int().min(2).max(2000)).min(1).max(200);
export const sweepInput = z
  .object({
    runId: id,
    grid: z
      .object({
        fast: periods.optional(),
        slow: periods.optional(),
        entryPeriod: periods.optional(),
        exitPeriod: periods.optional(),
      })
      .strict(),
    sortBy: z.enum(["sharpe", "returnPct", "calmar"]).default("sharpe"),
    minClosedTrades: z.number().int().min(0).max(10000).default(10),
    top: z.number().int().min(0).max(10).default(5),
    /** Random search samples the grid instead of evaluating all of it. */
    search: z
      .object({
        mode: z.enum(["grid", "random"]).default("grid"),
        samples: z.number().int().min(2).max(20000).default(200),
        seed: z.number().int().min(1).max(2 ** 31).default(1),
      })
      .strict()
      .default({ mode: "grid", samples: 200, seed: 1 }),
  })
  .strict();
export type SweepInput = z.infer<typeof sweepInput>;

/** Screens combinations; pluggable so the host can fan out to worker threads. */
export type Screener = (
  columns: SweepColumns,
  template: Strategy["template"],
  combos: SweepParams[],
  config: RunRecord["config"],
  withDaily?: boolean,
) => SweepRow[] | Promise<SweepRow[]>;

export const score = (r: SweepRow, by: SweepInput["sortBy"]) =>
  by === "returnPct"
    ? r.returnPct
    : by === "calmar"
      ? r.maxDrawdownPct > 0
        ? r.returnPct / r.maxDrawdownPct
        : r.returnPct > 0
          ? Infinity
          : r.returnPct
      : (r.sharpe ?? -Infinity);

export const localScreener: Screener = (columns, template, combos, config, withDaily) =>
  sweep(columns, template, combos, config, undefined, withDaily);

/** Deterministic sample without replacement (partial Fisher–Yates). */
export function sampleCombos<T>(all: T[], samples: number, seed: number) {
  if (samples >= all.length) return all;
  const pick = all.slice(),
    random = rng(seed);
  for (let i = 0; i < samples; i++) {
    const j = i + Math.floor(random() * (pick.length - i));
    [pick[i], pick[j]] = [pick[j]!, pick[i]!];
  }
  return pick.slice(0, samples);
}

export function assertSweepable(base: Strategy, run: RunRecord) {
  if (base.symbols.length !== 1) fail("SWEEP_SYMBOL", "参数扫描目前只支持单一标的");
  if (base.conditions) fail("SWEEP_CONDITIONS", "参数扫描暂不支持附加条件策略");
  if (base.template !== "sma_cross" && base.template !== "breakout")
    fail("SWEEP_TEMPLATE", "参数扫描目前只支持均线与突破模板；表达式策略请用稳健性检验比较邻近参数");
  if (hasExtendedRisk(run.config.risk))
    fail("SWEEP_RISK", "参数扫描暂不支持 ATR/移动/时间止损与波动率仓位");
}

/**
 * Selection-bias statistics over every screened configuration's daily returns:
 * Deflated Sharpe of the chosen one, PBO by CSCV, and White's Reality Check
 * against holding cash. Screening numbers, so descriptive of the search only.
 */
export function selectionStatistics(rows: SweepRow[], chosen: number, seed: number) {
  const series = rows.map((r) => toReturns(r.daily ?? []));
  const T = Math.min(...series.map((x) => x.length));
  if (!(T >= 30) || rows.length < 2) return null;
  const matrix = Array.from({ length: T }, (_, t) => series.map((x) => x[t]!)),
    trials = series.map((x) => sharpe(x));
  return {
    observations: T,
    configurations: rows.length,
    deflatedSharpe: deflatedSharpe(series[chosen]!, trials),
    overfitting: pbo(matrix, rows.length > 2000 ? 10 : 16),
    realityCheck: realityCheck(matrix, { seed, samples: rows.length > 2000 ? 200 : 500 }),
  };
}

export async function parameterSweep(
  run: RunRecord,
  base: Strategy,
  bars: Bar[],
  raw: unknown,
  screen: Screener = localScreener,
) {
  const input = sweepInput.parse(raw);
  if (run.status !== "completed") fail("SWEEP_SOURCE", "参数扫描须基于已完成的回测");
  assertSweepable(base, run);
  const started = performance.now(),
    sorted = [...bars].sort((a, b) => a.time - b.time),
    grid = expandGrid(base, input.grid),
    combos =
      input.search.mode === "random"
        ? sampleCombos(grid, input.search.samples, input.search.seed)
        : grid,
    columns = toColumns(sorted, base.interval);
  if (!combos.length) fail("SWEEP_GRID", "参数网格为空或快线不小于慢线");
  const rows = await screen(columns, base.template, combos, run.config, true);
  const ranked = rows
    .map((r) => ({ ...r, eligible: r.closedTrades >= input.minClosedTrades }))
    .sort(
      (a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        score(b, input.sortBy) - score(a, input.sortBy),
    );
  const chosen = ranked.findIndex((r) => r.eligible),
    statistics = selectionStatistics(ranked, Math.max(0, chosen), input.search.seed);
  // Exact confirmation: only these numbers may be quoted; screening rows rank.
  const confirmed = ranked
    .filter((r) => r.eligible)
    .slice(0, input.top)
    .map((r) => {
      const strategy = strategySchema.parse({ ...base, ...r.params }) as Strategy,
        exact = backtest(strategy, run.config, sorted);
      return {
        params: r.params,
        metrics: exact.metrics,
        benchmarks: exact.benchmarks,
        resultHash: exact.hash,
        screeningReturnGapPct: Math.abs(Number(exact.metrics.returnPct) - r.returnPct),
      };
    });
  const body = {
    version: SWEEP_VERSION,
    sourceRunId: run.id,
    manifestHash: run.manifestHash,
    template: base.template,
    from: run.config.from,
    to: run.config.to,
    sortBy: input.sortBy,
    search: input.search.mode === "random" ? { ...input.search, gridSize: grid.length } : { mode: "grid" as const },
    combinations: combos.length,
    rows: ranked.map(({ daily: _d, days: _k, ...r }) => r),
    statistics,
    confirmed,
    limitations: [
      "扫描行使用二进制浮点快速估算，只用于排序；可引用的数字只来自逐笔精确引擎确认的候选。",
      `本次检验了 ${combos.length} 组参数，最优结果含选择偏差；须在未参与扫描的验证或保留区间重新检验，不能直接作为策略有效性证据。`,
      "统计检验基于扫描估算的 UTC 日收益：DSR 用全部试验的 Sharpe 离散度估计运气上限；PBO 为组合对称交叉验证中样本内最优在样本外落入后一半的比例；Reality Check 以持有现金为基准。参数组合高度相关时试验数被高估，DSR 偏保守。",
      ...(run.config.ruleHistory
        ? ["扫描阶段使用固定交易规则，历史规则只在精确确认阶段生效。"]
        : []),
    ],
  };
  return {
    ...body,
    hash: hash(body),
    elapsedMs: Math.round(performance.now() - started),
  };
}
