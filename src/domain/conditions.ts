import { Decimal } from "decimal.js";
import type { Bar, Strategy } from "./contracts.js";

export interface Condition {
  indicator: "close_sma" | "volume_ratio" | "return_pct";
  period: number;
  factor: number;
  operator: "gt" | "lt";
  value: string;
}
export interface Conditions {
  version: 1;
  mode: "filter" | "replace";
  entry: Condition[];
  exit: Condition[];
}
export function historyRequired(s: Strategy) {
  return Math.max(
    s.slow + 1,
    s.entryPeriod + 1,
    s.exitPeriod + 1,
    ...(s.conditions
      ? [...s.conditions.entry, ...s.conditions.exit].map(
          (c) => (c.period + 2) * c.factor - 1,
        )
      : []),
  );
}
// Higher-timeframe buckets are UTC aligned and exposed only after all component bars closed.
export function conditionMatches(history: Bar[], c: Condition, step: number) {
  const groups = new Map<number, Bar[]>();
  for (const b of history) {
    const key = Math.floor(b.time / (step * c.factor));
    const group = groups.get(key) ?? [];
    group.push(b);
    groups.set(key, group);
  }
  const bars = [...groups.values()]
    .filter(
      (g) =>
        g.length === c.factor &&
        g[0]!.time % (step * c.factor) === 0 &&
        g.every((b, i) => b.time === g[0]!.time + i * step),
    )
    .map((g) => ({
      ...g[0]!,
      close: g.at(-1)!.close,
      volume: g.reduce((v, b) => v.plus(b.volume), new Decimal(0)).toFixed(),
    }));
  if (bars.length < c.period + 1) return false;
  const last = bars.at(-1)!,
    prior = bars.slice(-c.period - 1, -1);
  let v: Decimal;
  if (c.indicator === "return_pct")
    v = new Decimal(last.close).div(prior[0]!.close).minus(1).mul(100);
  else {
    const field = c.indicator === "close_sma" ? "close" : "volume";
    const mean = prior
      .reduce((a, b) => a.plus(b[field]), new Decimal(0))
      .div(c.period);
    if (mean.eq(0)) return false;
    v = new Decimal(last[field]).div(mean);
  }
  return c.operator === "gt" ? v.gt(c.value) : v.lt(c.value);
}
