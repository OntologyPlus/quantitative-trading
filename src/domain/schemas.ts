import { z } from "zod";
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const decimal = z.string().regex(/^(0|[1-9]\d{0,15})(\.\d{1,16})?$/);
export const positive = decimal.refine((v) => Number(v) > 0);
const pct = decimal.refine((v) => Number(v) <= 100);
export const symbol = z.string().regex(/^[A-Z0-9]{2,20}USDT$/);
export const interval = z.enum(["1m", "15m", "1h", "1d"]);
const conditionSchema = z
  .object({
    indicator: z.enum(["close_sma", "volume_ratio", "return_pct"]),
    period: z.number().int().min(2).max(1000),
    factor: z.number().int().min(1).max(48),
    operator: z.enum(["gt", "lt"]),
    value: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/)
      .max(32),
  })
  .strict()
  .refine((c) => (c.period + 2) * c.factor - 1 <= 2002, "条件预热最多2002根");
export const strategySchema = z
  .object({
    template: z.enum(["sma_cross", "breakout"]),
    conditions: z
      .object({
        version: z.literal(1),
        mode: z.enum(["filter", "replace"]),
        entry: z.array(conditionSchema).min(1).max(8),
        exit: z.array(conditionSchema).min(1).max(8),
      })
      .strict()
      .optional(),
    symbols: z
      .array(symbol)
      .min(1)
      .max(10)
      .refine((x) => new Set(x).size === x.length),
    interval,
    fast: z.number().int().min(2).max(500).default(20),
    slow: z.number().int().min(3).max(2000).default(60),
    entryPeriod: z.number().int().min(2).max(1000).default(20),
    exitPeriod: z.number().int().min(2).max(1000).default(10),
  })
  .strict()
  .refine((x) => x.fast < x.slow, { message: "快均线周期必须小于慢均线" });
export const riskSchema = z
  .object({
    sizing: z.enum(["weight", "risk"]).default("weight"),
    weightPct: pct.default("10"),
    riskPct: pct.default("1"),
    stopLossPct: pct.default("5"),
    takeProfitPct: pct.default("10"),
    maxSymbolPct: pct.default("20"),
    maxExposurePct: pct.default("60"),
    maxPositions: z.number().int().min(1).max(10).default(3),
    dailyLossPct: pct.default("5"),
    maxDrawdownPct: pct.default("20"),
  })
  .strict()
  .refine((x) => x.sizing !== "risk" || Number(x.stopLossPct) > 0, {
    message: "风险预算模式需要有效止损",
  });
export const costsSchema = z
  .object({
    feeBps: decimal.refine((v) => Number(v) <= 1000).default("10"),
    slippageBps: decimal.refine((v) => Number(v) <= 1000).default("5"),
    participationPct: pct.default("1"),
  })
  .strict();
export const rulesSchema = z
  .object({
    stepSize: positive,
    minQty: positive,
    maxQty: positive,
    minNotional: decimal,
    tickSize: positive,
  })
  .strict();
export const barSchema = z
  .object({
    symbol,
    time: z.number().int().nonnegative(),
    open: positive,
    high: positive,
    low: positive,
    close: positive,
    volume: decimal,
  })
  .strict();
export const configInput = z
  .object({
    initialCash: positive.default("10000"),
    risk: riskSchema.default(() => riskSchema.parse({})),
    costs: costsSchema.default(() => costsSchema.parse({})),
    from: z.number().int().nonnegative().default(0),
    to: z.number().int().nonnegative().default(8640000000000000),
  })
  .strict();
export class QuantError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function fail(code: string, message: string): never {
  throw new QuantError(code, message);
}
export function parseError(e: unknown) {
  return e instanceof QuantError
    ? { code: e.code, message: e.message }
    : e instanceof z.ZodError
      ? {
          code: "INVALID_INPUT",
          message: e.issues
            .map((x) => `${x.path.join(".")}: ${x.message}`)
            .join("；"),
        }
      : {
          code: "OPERATION_FAILED",
          message: e instanceof Error ? e.message : "操作失败",
        };
}
export const signedDecimal = z
  .string()
  .regex(/^-?(0|[1-9]\d{0,30})(\.\d{1,120})?$/);
const money = signedDecimal;
const internal = signedDecimal.refine((v) => Number(v) >= 0);
const internalPositive = signedDecimal.refine((v) => Number(v) > 0);
const timestamp = z.number().int().nonnegative();
export const stateSchema = z
  .object({
    cash: internal,
    positions: z.record(
      symbol,
      z
        .object({
          quantity: internalPositive,
          cost: internal,
          stop: internal,
          take: internal,
        })
        .strict(),
    ),
    prices: z.record(symbol, positive),
    history: z.record(symbol, z.array(barSchema).max(2002)),
    pending: z.record(
      symbol,
      z
        .object({
          id,
          symbol,
          side: z.enum(["BUY", "SELL"]),
          signalAt: timestamp,
          reason: z.string().max(100),
        })
        .strict(),
    ),
    fills: z.array(
      z
        .object({
          id,
          orderId: id,
          symbol,
          side: z.enum(["BUY", "SELL"]),
          quantity: internalPositive,
          price: internalPositive,
          fee: internal,
          slippage: internal,
          at: timestamp,
          signalAt: timestamp,
          reason: z.string().max(100),
          realizedPnl: money.nullable(),
        })
        .strict(),
    ),
    decisions: z.array(
      z
        .object({
          id,
          at: timestamp,
          symbol,
          code: z.string().max(100),
          reason: z.string().max(1000),
          orderId: id.optional(),
          facts: z.record(z.string(), z.string()).optional(),
        })
        .strict(),
    ),
    ledger: z.array(
      z
        .object({
          id,
          fillId: id,
          asset: z.string().regex(/^[A-Z0-9]{2,24}$/),
          delta: money,
          kind: z.enum(["trade", "fee"]),
        })
        .strict(),
    ),
    curve: z.array(
      z
        .object({
          at: timestamp,
          cash: internal,
          equity: internal,
          drawdownPct: internal,
        })
        .strict(),
    ),
    peak: internal,
    day: z.string().max(10),
    dayStart: internalPositive,
    sequence: z.number().int().nonnegative(),
    lastTime: z.record(symbol, timestamp),
    stoppedOpening: z.boolean(),
  })
  .strict();
