import { z } from "zod";
import { Decimal } from "decimal.js";
import { id, fail, positive } from "../domain/schemas.js";
import { hash } from "../adapters/market.js";
import {
  assertLedger,
  equity,
  execute,
  initialState,
  ingestBatch,
  intent,
  mark,
} from "./core.js";
import type { Bar, RunConfig, Strategy } from "../domain/contracts.js";
export const portfolioBacktestInput = z
  .object({
    legs: z
      .array(
        z
          .object({ runId: id, weightPct: z.number().positive().max(100) })
          .strict(),
      )
      .min(2)
      .max(6),
    initialCash: positive,
    rebalance: z.enum(["none", "daily", "monthly"]),
  })
  .strict()
  .refine(
    (x) =>
      new Set(x.legs.map((l) => l.runId)).size === x.legs.length &&
      Math.abs(x.legs.reduce((s, l) => s + l.weightPct, 0) - 100) < 1e-8,
    "组合权重须合计100%且实验不重复",
  );
export function portfolioBacktest(
  protocol: z.infer<typeof portfolioBacktestInput>,
  legs: {
    strategy: Strategy;
    config: RunConfig;
    bars: Bar[];
    manifestHash: string;
  }[],
) {
  const sources = legs.map((l, i) => {
    const funding = new Decimal(protocol.initialCash)
      .mul(protocol.legs[i]!.weightPct)
      .div(100);
    return {
      ...l,
      state: initialState(funding.toFixed()),
      funding,
      initialFunding: funding,
      config: { ...l.config, initialCash: funding.toFixed() },
    };
  });
  const first = sources[0]!;
  if (
    sources.some(
      (l) =>
        l.strategy.interval !== first.strategy.interval ||
        l.config.from !== first.config.from ||
        l.config.to !== first.config.to ||
        l.config.engineVersion !== first.config.engineVersion,
    )
  )
    fail("PORTFOLIO_BASIS", "组合成分需要相同周期、评估区间和引擎");
  const groups = new Map<number, Map<string, Bar>>();
  for (const l of sources)
    for (const b of l.bars) {
      const group = groups.get(b.time) ?? new Map<string, Bar>();
      const old = group.get(b.symbol);
      if (old && hash(old) !== hash(b))
        fail("PORTFOLIO_DATA", "组合成分的相同市场时点行情不一致");
      group.set(b.symbol, b);
      groups.set(b.time, group);
    }
  let bucket = "",
    peak = new Decimal(protocol.initialCash);
  const transfers: { at: number; leg: number; delta: string }[] = [],
    rebalances: { at: number; status: string }[] = [],
    curve: { at: number; equity: string; drawdownPct: string }[] = [];
  for (const [at, group] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (at > first.config.to) break;
    for (const l of sources) {
      if (l.config.ruleHistory && at >= l.config.from) {
        const rules = { ...l.config.rules };
        for (const sym of l.strategy.symbols) {
          const h = l.config.ruleHistory[sym];
          if (h?.length) {
            const rule = h
              .filter((h) => h.effectiveAt <= at && h.knownAt <= at)
              .at(-1);
            if (!rule) fail("HISTORICAL_RULES", "组合历史规则未覆盖");
            rules[sym] = rule.rules;
          }
        }
        l.config = { ...l.config, rules };
      }
      for (const sym of l.strategy.symbols) {
        const b = group.get(sym);
        if (!b) fail("PORTFOLIO_DATA", "组合成分缺少同步行情");
        l.state.prices[sym] = b.open;
      }
    }
    if (at >= first.config.from) {
      const date = new Date(at).toISOString(),
        next =
          protocol.rebalance === "monthly"
            ? date.slice(0, 7)
            : date.slice(0, 10);
      if (protocol.rebalance !== "none" && bucket && next !== bucket) {
        for (const l of sources) {
          l.state.pending = {};
          for (const sym of Object.keys(l.state.positions)) {
            const b = group.get(sym)!;
            const order = intent(l.state, b, "SELL", "PORTFOLIO_REBALANCE", at);
            execute(
              l.state,
              l.config,
              order,
              b.open,
              l.state.history[sym]?.at(-1)?.volume ?? "0",
              at,
            );
          }
        }
        if (sources.every((l) => Object.keys(l.state.positions).length === 0)) {
          const total = sources.reduce(
            (s, l) => s.plus(l.state.cash),
            new Decimal(0),
          );
          for (const [i, l] of sources.entries()) {
            const cash = total.mul(protocol.legs[i]!.weightPct).div(100),
              old = new Decimal(l.state.cash),
              delta = cash.minus(old);
            l.funding = l.funding.plus(delta);
            l.state.cash = cash.toFixed();
            if (old.gt(0)) {
              l.state.peak = new Decimal(l.state.peak)
                .mul(cash.div(old))
                .toFixed();
              l.state.dayStart = new Decimal(l.state.dayStart)
                .mul(cash.div(old))
                .toFixed();
            }
            transfers.push({ at, leg: i, delta: delta.toFixed() });
          }
          rebalances.push({ at, status: "completed" });
        } else
          rebalances.push({ at, status: "liquidity_rejected_no_transfer" });
      }
      bucket = next;
    }
    for (const l of sources)
      ingestBatch(
        l.state,
        l.strategy,
        l.config,
        l.strategy.symbols.map((s) => group.get(s)!),
      );
    if (at >= first.config.from) {
      const total = sources.reduce(
        (s, l) => s.plus(equity(l.state)),
        new Decimal(0),
      );
      peak = Decimal.max(peak, total);
      curve.push({
        at: Math.max(...sources.map((l) => l.state.curve.at(-1)?.at ?? at)),
        equity: total.toFixed(),
        drawdownPct: peak.minus(total).div(peak).mul(100).toFixed(),
      });
    }
  }
  for (const l of sources) {
    l.state.pending = {};
    assertLedger(l.state, l.funding.toFixed());
  }
  if (
    !sources
      .reduce((s, l) => s.plus(l.funding), new Decimal(0))
      .eq(protocol.initialCash)
  )
    fail("PORTFOLIO_LEDGER", "组合资金转移不守恒");
  const final = sources.reduce(
    (s, l) => s.plus(equity(l.state)),
    new Decimal(0),
  );
  const body = {
    version: 1,
    protocol,
    sources: sources.map((l) => ({
      manifestHash: l.manifestHash,
      strategy: l.strategy,
      config: l.config,
    })),
    curve,
    transfers,
    rebalances,
    returnPct: final.div(protocol.initialCash).minus(1).mul(100).toFixed(),
    maxDrawdownPct: curve
      .reduce((m, p) => Decimal.max(m, p.drawdownPct), new Decimal(0))
      .toFixed(),
    sleeves: sources.map((l) => ({
      initialFunding: l.initialFunding.toFixed(),
      fundingAfterTransfers: l.funding.toFixed(),
      state: l.state,
    })),
    limitations: [
      "资金按策略分为独立子账户，不相互借款；同一标的可以由多个子账户持有。",
      "再平衡在新周期第一根开盘先平仓，再按权重分配现金；使用成分费用、滑点和上一根成交量限额。",
      "任一平仓因流动性受限时，本次不转移资金，已完成的卖出保留；不保证恢复目标权重。",
      "组合结果尚不能直接批准模拟账户。",
    ],
  };
  return { ...body, hash: hash(body) };
}
