import { INTERVAL_MS, type Bar, type RunConfig, type Strategy } from "../domain/contracts.js";
import { fail } from "../domain/schemas.js";

/**
 * Float64 screening kernel for parameter sweeps.
 *
 * Mirrors the exact engine's single-symbol rules (next-open fills, fee and
 * slippage, weight/risk sizing, step size, min notional, participation limit,
 * stop/take with stop priority, drawdown and daily loss limits) in binary
 * floating point. Results rank candidates only; they are never evidence.
 * Anything worth reporting is re-run with the exact engine (`confirm` in
 * host/sweep.ts), which is the only source of research numbers.
 */
export const SWEEP_VERSION = 1;

export interface SweepColumns {
  symbol: string;
  interval: Strategy["interval"];
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
}
export type SweepParams = Pick<
  Strategy,
  "fast" | "slow" | "entryPeriod" | "exitPeriod"
>;
export interface SweepRow {
  params: SweepParams;
  returnPct: number;
  maxDrawdownPct: number;
  trades: number;
  closedTrades: number;
  winRatePct: number | null;
  sharpe: number | null;
  exposurePct: number;
  /** Last equity of each UTC day (only when requested). */
  daily?: number[];
  /** UTC day numbers matching `daily`. */
  days?: number[];
}
export interface SweepGrid {
  fast?: number[] | undefined;
  slow?: number[] | undefined;
  entryPeriod?: number[] | undefined;
  exitPeriod?: number[] | undefined;
}

export function toColumns(bars: Bar[], interval: Strategy["interval"]): SweepColumns {
  const n = bars.length,
    symbol = bars[0]?.symbol ?? "";
  const c: SweepColumns = {
    symbol,
    interval,
    time: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    if (b.symbol !== symbol) fail("SWEEP_SYMBOL", "参数扫描目前只支持单一标的");
    if (i && b.time <= bars[i - 1]!.time) fail("SWEEP_ORDER", "行情须按时间严格递增");
    c.time[i] = b.time;
    c.open[i] = Number(b.open);
    c.high[i] = Number(b.high);
    c.low[i] = Number(b.low);
    c.close[i] = Number(b.close);
    c.volume[i] = Number(b.volume);
  }
  return c;
}

/** Cartesian grid; SMA pairs with fast >= slow are dropped. */
export function expandGrid(base: Strategy, grid: SweepGrid, max = 20000): SweepParams[] {
  const pick = (k: keyof SweepGrid) =>
    grid[k]?.length ? [...new Set(grid[k])].sort((a, b) => a - b) : [base[k]];
  const out: SweepParams[] = [];
  for (const fast of pick("fast"))
    for (const slow of pick("slow"))
      for (const entryPeriod of pick("entryPeriod"))
        for (const exitPeriod of pick("exitPeriod")) {
          if (base.template === "sma_cross" && fast >= slow) continue;
          for (const v of [fast, slow, entryPeriod, exitPeriod])
            if (!Number.isInteger(v) || v < 2 || v > 2000)
              fail("SWEEP_GRID", "参数须为 2–2000 的整数");
          out.push({ fast, slow, entryPeriod, exitPeriod });
          if (out.length > max) fail("SWEEP_TOO_LARGE", `参数组合超过 ${max} 组`);
        }
  return out;
}

/** Precomputed series shared by every combination over the same columns. */
export class SweepCache {
  private prefix: Float64Array | null = null;
  private highs = new Map<number, Float64Array>();
  private lows = new Map<number, Float64Array>();
  constructor(readonly c: SweepColumns) {}
  /** prefix[i] = sum of close[0..i) */
  closePrefix() {
    if (this.prefix) return this.prefix;
    const n = this.c.close.length,
      p = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) p[i + 1] = p[i]! + this.c.close[i]!;
    return (this.prefix = p);
  }
  /** out[i] = max(high[i-len..i)) — the window before bar i, NaN if short. */
  priorMax(len: number) {
    return this.rolling(len, this.highs, this.c.high, true);
  }
  priorMin(len: number) {
    return this.rolling(len, this.lows, this.c.low, false);
  }
  private rolling(len: number, cache: Map<number, Float64Array>, src: Float64Array, max: boolean) {
    const hit = cache.get(len);
    if (hit) return hit;
    const n = src.length,
      out = new Float64Array(n).fill(NaN),
      dq = new Int32Array(n);
    let head = 0,
      tail = 0;
    for (let i = 0; i < n; i++) {
      // window for bar i is [i-len, i); add element i-1 first
      const j = i - 1;
      if (j >= 0) {
        while (tail > head && (max ? src[dq[tail - 1]!]! <= src[j]! : src[dq[tail - 1]!]! >= src[j]!)) tail--;
        dq[tail++] = j;
      }
      while (tail > head && dq[head]! < i - len) head++;
      if (i >= len) out[i] = src[dq[head]!]!;
    }
    cache.set(len, out);
    return out;
  }
}

const floorTo = (q: number, step: number) => Math.floor(q / step + 1e-9) * step;

export function sweepOne(
  cache: SweepCache,
  template: Strategy["template"],
  p: SweepParams,
  cfg: RunConfig,
  withDaily = false,
): SweepRow {
  const c = cache.c,
    n = c.time.length,
    step = INTERVAL_MS[c.interval],
    rule = cfg.rules[c.symbol];
  if (!rule) fail("RULES_MISSING", "缺少交易规则");
  const fee = Number(cfg.costs.feeBps) / 10000,
    slip = Number(cfg.costs.slippageBps) / 10000,
    part = Number(cfg.costs.participationPct),
    r = cfg.risk,
    weight = Number(r.weightPct) / 100,
    riskPct = Number(r.riskPct) / 100,
    stopPct = Number(r.stopLossPct) / 100,
    takePct = Number(r.takeProfitPct) / 100,
    maxSym = Number(r.maxSymbolPct) / 100,
    maxExp = Number(r.maxExposurePct) / 100,
    maxDD = Number(r.maxDrawdownPct),
    maxDay = Number(r.dailyLossPct),
    stepSize = Number(rule.stepSize),
    minQty = Number(rule.minQty),
    maxQty = Number(rule.maxQty),
    minNotional = Number(rule.minNotional),
    initial = Number(cfg.initialCash);
  const sma = template === "sma_cross",
    prefix = sma ? cache.closePrefix() : null,
    hi = sma ? null : cache.priorMax(p.entryPeriod),
    lo = sma ? null : cache.priorMin(p.exitPeriod),
    warm = sma ? p.slow + 1 : Math.max(p.entryPeriod, p.exitPeriod) + 1;
  let cash = initial,
    qty = 0,
    cost = 0,
    stop = 0,
    take = 0,
    pending = 0, // 1 buy, -1 sell
    pendingAt = 0,
    peak = initial,
    dayNo = -1,
    dayStart = initial,
    stopped = false,
    maxDrawdown = 0,
    trades = 0,
    closed = 0,
    wins = 0,
    exposureSum = 0,
    marks = 0,
    lastDay = -1,
    lastDayEquity = 0,
    price = 0;
  const daily: number[] = [],
    dayKeys: number[] = [];
  const mark = (at: number, final: boolean) => {
    const e = cash + qty * price;
    if (e > peak) peak = e;
    const d = Math.floor(at / 86400000);
    if (d !== dayNo) {
      dayNo = d;
      dayStart = e;
    }
    const dd = peak > 0 ? ((peak - e) / peak) * 100 : 0;
    stopped = dd >= maxDD || (dayStart > 0 && ((dayStart - e) / dayStart) * 100 >= maxDay);
    if (final) {
      // Surviving curve points: open marks and the last close mark.
      if (dd > maxDrawdown) maxDrawdown = dd;
      exposureSum += e > 0 ? (e - cash) / e : 0;
      marks++;
      const key = Math.floor(Math.max(0, at - 1) / 86400000);
      if (key !== lastDay) {
        if (lastDay >= 0) {
          daily.push(lastDayEquity);
          dayKeys.push(lastDay);
        }
        lastDay = key;
      }
      lastDayEquity = e;
    }
  };
  const sell = (px: number) => {
    const value = qty * px,
      f = value * fee,
      pnl = value - f - cost;
    cash += value - f;
    qty = 0;
    trades++;
    closed++;
    if (pnl > 0) wins++;
  };
  for (let i = 0; i < n; i++) {
    const time = c.time[i]!,
      active = time >= cfg.from && time <= cfg.to;
    if (time > cfg.to) break;
    price = c.open[i]!;
    if (active) {
      mark(time, true);
      if (pending && pendingAt !== time) pending = 0; // data gap: signal void
      if (pending) {
        const vol = i ? c.volume[i - 1]! : 0,
          side = pending;
        pending = 0;
        if (side > 0) {
          const px = price * (1 + slip),
            e = cash + qty * price;
          if (!stopped && qty === 0) {
            let target = (e * weight) / px;
            if (r.sizing === "risk") target = (e * riskPct) / (px * (stopPct + 2 * fee + 2 * slip));
            let q = Math.min(target, (e * maxSym) / px, (e * maxExp - (e - cash)) / px, cash / (px * (1 + fee)), maxQty);
            q = floorTo(q, stepSize);
            if (q > 0 && q >= minQty && q * px >= minNotional && !(part > 0 && q > (vol * part) / 100)) {
              const value = q * px;
              cash -= value + value * fee;
              qty = q;
              cost = value + value * fee;
              stop = stopPct > 0 ? px * (1 - stopPct) : 0;
              take = takePct > 0 ? px * (1 + takePct) : 0;
              trades++;
            }
          }
        } else if (qty > 0) {
          const q = qty;
          if (!(part > 0 && q > (vol * part) / 100)) sell(price * (1 - slip));
        }
      }
      if (qty > 0) {
        let px = 0;
        if (stop > 0 && c.low[i]! <= stop) px = Math.min(price, stop);
        else if (take > 0 && c.high[i]! >= take) px = Math.max(price, take);
        if (px > 0 && !(part > 0 && qty > (c.volume[i]! * part) / 100)) sell(px * (1 - slip));
      }
    }
    price = c.close[i]!;
    if (!active) continue;
    const at = time + step;
    mark(at, i === n - 1 || c.time[i + 1]! !== at || c.time[i + 1]! > cfg.to);
    const h = i + 1; // history length including bar i
    if (h < warm) continue;
    let side = 0;
    if (sma) {
      const pf = prefix!,
        f = p.fast,
        sl = p.slow,
        prev = (pf[h - 1]! - pf[h - 1 - f]!) / f - (pf[h - 1]! - pf[h - 1 - sl]!) / sl,
        now = (pf[h]! - pf[h - f]!) / f - (pf[h]! - pf[h - sl]!) / sl;
      side = prev <= 0 && now > 0 ? 1 : prev >= 0 && now < 0 ? -1 : 0;
    } else {
      const cl = c.close[i]!;
      side = cl > hi![i]! ? 1 : cl < lo![i]! ? -1 : 0;
    }
    if (side > 0 && qty === 0 && !stopped) pending = 1;
    else if (side < 0 && qty > 0) pending = -1;
    pendingAt = at;
  }
  if (lastDay >= 0) {
    daily.push(lastDayEquity);
    dayKeys.push(lastDay);
  }
  const rets: number[] = [];
  for (let i = 1; i < daily.length; i++) if (daily[i - 1]! > 0) rets.push(daily[i]! / daily[i - 1]! - 1);
  const avg = rets.reduce((a, b) => a + b, 0) / (rets.length || 1),
    sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - avg) ** 2, 0) / (rets.length - 1)) : 0;
  const final = cash + qty * price;
  return {
    params: p,
    returnPct: (final / initial - 1) * 100,
    maxDrawdownPct: maxDrawdown,
    trades,
    closedTrades: closed,
    winRatePct: closed ? (wins / closed) * 100 : null,
    sharpe: rets.length >= 30 && sd > 0 ? (avg / sd) * Math.sqrt(365) : null,
    exposurePct: marks ? (exposureSum / marks) * 100 : 0,
    ...(withDaily ? { daily, days: dayKeys } : {}),
  };
}

export function sweep(
  columns: SweepColumns,
  template: Strategy["template"],
  combos: SweepParams[],
  cfg: RunConfig,
  cancel?: () => boolean,
  withDaily = false,
): SweepRow[] {
  const cache = new SweepCache(columns);
  return combos.map((p, i) => {
    if (i % 32 === 0 && cancel?.()) throw Error("任务已取消");
    return sweepOne(cache, template, p, cfg, withDaily);
  });
}
