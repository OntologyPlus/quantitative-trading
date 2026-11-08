import { z } from "zod";
import { Decimal } from "decimal.js";
import { hash } from "../adapters/market.js";
import { backtest } from "../engine/backtest.js";
import { fail, id } from "../domain/schemas.js";
import type { Bar, RunRecord, Strategy } from "../domain/contracts.js";
import { mean, moments, probabilisticSharpe, stdev, toReturns } from "./stats.js";

export const performanceInput = z
  .object({
    runId: id,
    costMultipliers: z.array(z.number().min(0).max(10)).max(6).default([0, 1, 2, 3]),
    rollingDays: z.number().int().min(10).max(365).default(30),
    regimeDays: z.number().int().min(5).max(365).default(30),
    regimeThresholdPct: z.number().min(0.1).max(100).default(5),
  })
  .strict();

const DAY = 86400000;
const iso = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
const round = (x: number, d = 6) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);

function drawdownStats(equity: number[], days: number[]) {
  let peak = equity[0] ?? 0,
    peakDay = days[0] ?? 0,
    maxDd = 0,
    longest = 0,
    longestFrom = days[0] ?? 0,
    longestTo = days[0] ?? 0;
  for (let i = 0; i < equity.length; i++) {
    const e = equity[i]!,
      d = days[i]!;
    if (e >= peak) {
      peak = e;
      peakDay = d;
    } else {
      maxDd = Math.max(maxDd, ((peak - e) / peak) * 100);
      if (d - peakDay > longest) {
        longest = d - peakDay;
        longestFrom = peakDay;
        longestTo = d;
      }
    }
  }
  const underwater = (equity.at(-1) ?? 0) < peak ? (days.at(-1) ?? 0) - peakDay : 0;
  return { maxDd, longest, longestFrom, longestTo, underwater };
}

/** Pairs each SELL with its BUY per symbol (one position per symbol). */
export function roundTrips(run: RunRecord) {
  const open = new Map<string, { at: number; cost: number }>(),
    trips: { symbol: string; entry: number; exit: number; pnl: number; reason: string }[] = [];
  for (const f of run.result!.state.fills) {
    if (f.side === "BUY") open.set(f.symbol, { at: f.at, cost: Number(f.quantity) * Number(f.price) });
    else {
      const o = open.get(f.symbol);
      if (o)
        trips.push({ symbol: f.symbol, entry: o.at, exit: f.at, pnl: Number(f.realizedPnl), reason: f.reason });
      open.delete(f.symbol);
    }
  }
  return trips;
}

export function performanceReport(run: RunRecord, strategy: Strategy, bars: Bar[], raw: unknown) {
  const input = performanceInput.parse(raw);
  if (run.status !== "completed" || !run.result) fail("REPORT_SOURCE", "绩效报告须基于已完成的回测");
  const st = run.result.state,
    init = Number(run.config.initialCash);
  // Last equity per UTC day, as in the engine's Sharpe.
  const byDay = new Map<number, number>();
  for (const p of st.curve) byDay.set(Math.floor(Math.max(0, p.at - 1) / DAY), Number(p.equity));
  const days = [...byDay.keys()],
    equity = [...byDay.values()],
    returns = toReturns(equity);
  if (equity.length < 2) fail("REPORT_SHORT", "回测不足两天，无法生成绩效报告");
  const span = days.at(-1)! - days[0]! || 1,
    total = equity.at(-1)! / init - 1,
    cagr = (1 + total) ** (365 / span) - 1,
    vol = stdev(returns) * Math.sqrt(365),
    downside = Math.sqrt(mean(returns.map((r) => Math.min(0, r) ** 2))) * Math.sqrt(365),
    dd = drawdownStats(equity, days),
    m = moments(returns);
  const enough = returns.length >= 30;
  const summary = {
    days: span,
    totalReturnPct: round(total * 100),
    cagrPct: round(cagr * 100),
    annualVolatilityPct: enough ? round(vol * 100) : null,
    sharpe: enough && vol > 0 ? round((mean(returns) * 365) / vol) : null,
    sortino: enough && downside > 0 ? round((mean(returns) * 365) / downside) : null,
    calmar: dd.maxDd > 0 ? round((cagr * 100) / dd.maxDd) : null,
    maxDrawdownPct: run.result.metrics.maxDrawdownPct,
    dailyMaxDrawdownPct: round(dd.maxDd),
    longestDrawdownDays: dd.longest,
    longestDrawdown: { from: iso(dd.longestFrom), to: iso(dd.longestTo) },
    currentUnderwaterDays: dd.underwater,
    skew: enough ? round(m.skew) : null,
    excessKurtosis: enough ? round(m.kurt - 3) : null,
    probabilisticSharpe: enough ? round(probabilisticSharpe(returns)) : null,
    bestDayPct: round(Math.max(...returns) * 100),
    worstDayPct: round(Math.min(...returns) * 100),
  };
  // Rolling annualised Sharpe.
  const rolling: { date: string; sharpe: number | null }[] = [];
  for (let i = input.rollingDays; i <= returns.length; i++) {
    const w = returns.slice(i - input.rollingDays, i),
      sd = stdev(w);
    rolling.push({ date: iso(days[i]!), sharpe: sd > 0 ? round((mean(w) / sd) * Math.sqrt(365), 4) : null });
  }
  // Calendar breakdowns: return from the previous period's last equity.
  const periodTable = (key: (day: number) => string) => {
    const out: { period: string; returnPct: number | null; maxDrawdownPct: number | null }[] = [];
    let base = init,
      cur = "",
      seg: number[] = [];
    const flush = () => {
      if (!cur) return;
      out.push({
        period: cur,
        returnPct: round((seg.at(-1)! / base - 1) * 100, 4),
        maxDrawdownPct: round(drawdownStats([base, ...seg], seg.map((_, i) => i).concat(seg.length)).maxDd, 4),
      });
      base = seg.at(-1)!;
    };
    days.forEach((d, i) => {
      const k = key(d);
      if (k !== cur) {
        flush();
        cur = k;
        seg = [];
      }
      seg.push(equity[i]!);
    });
    flush();
    return out;
  };
  const trips = roundTrips(run),
    wins = trips.filter((t) => t.pnl > 0),
    losses = trips.filter((t) => t.pnl < 0);
  let streak = 0,
    worstStreak = 0;
  for (const t of trips) {
    streak = t.pnl < 0 ? streak + 1 : 0;
    worstStreak = Math.max(worstStreak, streak);
  }
  const reasons: Record<string, number> = {};
  for (const t of trips) reasons[t.reason] = (reasons[t.reason] ?? 0) + 1;
  const yearOf = (ms: number) => new Date(ms).toISOString().slice(0, 4);
  const yearly = periodTable((d) => iso(d).slice(0, 4)).map((y) => ({
    ...y,
    closedTrades: trips.filter((t) => yearOf(t.exit) === y.period).length,
  }));
  // Market regimes from the trailing return of an equal-weight basket.
  const closes = new Map<string, Map<number, number>>();
  for (const b of bars) {
    if (!strategy.symbols.includes(b.symbol)) continue;
    const m = closes.get(b.symbol) ?? new Map<number, number>();
    m.set(Math.floor(b.time / DAY), Number(b.close));
    closes.set(b.symbol, m);
  }
  const basket = (day: number) => {
    const v = [...closes.values()].map((m) => m.get(day));
    return v.every((x) => x !== undefined) ? v : null;
  };
  const regimes: Record<"up" | "down" | "sideways", number[]> = { up: [], down: [], sideways: [] };
  for (let i = 1; i < days.length; i++) {
    const now = basket(days[i - 1]!),
      then = basket(days[i - 1]! - input.regimeDays);
    if (!now || !then) continue;
    const trail = mean(now.map((c, j) => (c / then[j]! - 1) * 100));
    const k = trail > input.regimeThresholdPct ? "up" : trail < -input.regimeThresholdPct ? "down" : "sideways";
    regimes[k].push(returns[i - 1]!);
  }
  const regimeRows = (["up", "down", "sideways"] as const).map((k) => ({
    regime: k,
    days: regimes[k].length,
    meanDailyReturnPct: regimes[k].length ? round(mean(regimes[k]) * 100, 4) : null,
    hitRatePct: regimes[k].length ? round((regimes[k].filter((r) => r > 0).length / regimes[k].length) * 100, 2) : null,
  }));
  // Cost sensitivity with the exact engine.
  const costSensitivity = input.costMultipliers.map((k) => {
    const mul = (v: string) => new Decimal(v).mul(k).toFixed();
    const r = backtest(
      strategy,
      { ...run.config, costs: { ...run.config.costs, feeBps: mul(run.config.costs.feeBps), slippageBps: mul(run.config.costs.slippageBps) } },
      bars,
    );
    return {
      multiplier: k,
      feeBps: mul(run.config.costs.feeBps),
      slippageBps: mul(run.config.costs.slippageBps),
      returnPct: r.metrics.returnPct,
      sharpe: r.metrics.sharpe,
      trades: r.metrics.trades,
      resultHash: r.hash,
    };
  });
  const breakEven = (() => {
    for (let i = 1; i < costSensitivity.length; i++) {
      const a = costSensitivity[i - 1]!,
        b = costSensitivity[i]!,
        ra = Number(a.returnPct),
        rb = Number(b.returnPct);
      if (ra > 0 && rb <= 0) return round(a.multiplier + ((b.multiplier - a.multiplier) * ra) / (ra - rb), 3);
    }
    return null;
  })();
  const body = {
    version: 1,
    runId: run.id,
    manifestHash: run.manifestHash,
    resultHash: run.result.hash,
    summary,
    trades: {
      roundTrips: trips.length,
      winRatePct: trips.length ? round((wins.length / trips.length) * 100, 2) : null,
      averageWin: wins.length ? round(mean(wins.map((t) => t.pnl)), 4) : null,
      averageLoss: losses.length ? round(mean(losses.map((t) => t.pnl)), 4) : null,
      expectancy: trips.length ? round(mean(trips.map((t) => t.pnl)), 4) : null,
      averageHoldingHours: trips.length ? round(mean(trips.map((t) => (t.exit - t.entry) / 3600000)), 2) : null,
      maxConsecutiveLosses: worstStreak,
      exitReasons: reasons,
    },
    yearly,
    monthly: periodTable((d) => iso(d).slice(0, 7)),
    rollingSharpe: { windowDays: input.rollingDays, points: rolling },
    regimes: { lookbackDays: input.regimeDays, thresholdPct: input.regimeThresholdPct, rows: regimeRows },
    costSensitivity: { rows: costSensitivity, breakEvenMultiplier: breakEven },
    equity: days.map((d, i) => ({ date: iso(d), equity: round(equity[i]!, 4) })),
    limitations: [
      "比率基于 UTC 日终权益，年化系数 365，无风险利率为零；少于 30 个日收益时不计算。",
      "市场状态按策略标的等权篮子的过去 N 天涨跌划分，仅为描述性分组，不是可交易信号。",
      "成本敏感性对手续费和滑点同乘倍数重跑精确引擎，不改变成交量参与上限。",
    ],
  };
  return { ...body, hash: hash(body) };
}
