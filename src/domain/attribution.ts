import { Decimal } from "decimal.js";
import type { RunRecord } from "./contracts.js";

const Precise = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_DOWN });
const q = (value: Decimal.Value) => new Precise(value);
export interface RunAttribution {
  months: {
    month: string;
    startEquity: string;
    endEquity: string;
    pnl: string;
    returnPct: string | null;
  }[];
  symbols: {
    symbol: string;
    pnl: string;
    fees: string;
    closedTrades: number;
  }[];
  topTradeSharePct: string | null;
  positiveClosedTrades: number;
}
export function attributeRun(run: RunRecord): RunAttribution {
  if (!run.result || run.status !== "completed")
    throw Error("归因需要完整回测结果");
  const result = run.result,
    lastByMonth = new Map<string, string>();
  for (const point of result.state.curve) {
    // The curve includes the final candle close at config.to + interval.
    // Exact UTC month-boundary valuations close the preceding month.
    if (point.at <= run.config.from) continue;
    lastByMonth.set(
      new Date(point.at - 1).toISOString().slice(0, 7),
      point.equity,
    );
  }
  let previous = q(run.config.initialCash);
  const months = [...lastByMonth].map(([month, end]) => {
    const pnl = q(end).minus(previous);
    const value = {
      month,
      startEquity: previous.toFixed(),
      endEquity: end,
      pnl: pnl.toFixed(),
      returnPct: previous.gt(0) ? pnl.div(previous).mul(100).toFixed() : null,
    };
    previous = q(end);
    return value;
  });
  const symbols = Object.keys(run.config.rules)
    .sort()
    .map((symbol) => {
      let cashflow = q(0),
        fees = q(0),
        closedTrades = 0;
      for (const fill of result.state.fills.filter(
        (f) => f.symbol === symbol,
      )) {
        const value = q(fill.quantity).mul(fill.price);
        cashflow = cashflow
          .plus(fill.side === "BUY" ? value.neg() : value)
          .minus(fill.fee);
        fees = fees.plus(fill.fee);
        if (fill.side === "SELL") closedTrades++;
      }
      const held = result.state.positions[symbol];
      if (held)
        cashflow = cashflow.plus(
          q(held.quantity).mul(result.state.prices[symbol]!),
        );
      return {
        symbol,
        pnl: cashflow.toFixed(),
        fees: fees.toFixed(),
        closedTrades,
      };
    });
  const positive = result.state.fills
    .filter((f) => f.realizedPnl !== null && q(f.realizedPnl).gt(0))
    .map((f) => q(f.realizedPnl!));
  const total = positive.reduce((a, b) => a.plus(b), q(0));
  return {
    months,
    symbols,
    positiveClosedTrades: positive.length,
    topTradeSharePct: total.gt(0)
      ? positive
          .reduce((max, value) => (value.gt(max) ? value : max), q(0))
          .div(total)
          .mul(100)
          .toFixed()
      : null,
  };
}
export function attributionValues(
  run: RunRecord,
): Record<string, string | number | null> {
  const a = attributeRun(run),
    values: Record<string, string | number | null> = {
      "attribution.topTradeSharePct": a.topTradeSharePct,
      "attribution.positiveClosedTrades": a.positiveClosedTrades,
    };
  a.months.forEach((m, i) => {
    for (const key of ["startEquity", "endEquity", "pnl", "returnPct"] as const)
      values[`attribution.months.${i}.${key}`] = m[key];
  });
  a.symbols.forEach((s, i) => {
    for (const key of ["pnl", "fees", "closedTrades"] as const)
      values[`attribution.symbols.${i}.${key}`] = s[key];
  });
  return values;
}
