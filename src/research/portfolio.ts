import { allocateCapital } from "../domain/allocation.js";
import { z } from "zod";
import { Decimal } from "decimal.js";
import { id, fail } from "../domain/schemas.js";
import type { RunRecord } from "../domain/contracts.js";
import { verifyRun } from "./evaluation.js";
import { hash } from "../adapters/market.js";
export const portfolioInput = z
  .object({
    legs: z
      .array(
        z
          .object({ runId: id, weightPct: z.number().positive().max(100) })
          .strict(),
      )
      .min(2)
      .max(10),
    rebalance: z.enum(["none", "daily", "monthly"]),
    rebalanceCostBps: z.number().min(0).max(1000),
  })
  .strict()
  .refine(
    (x) =>
      new Set(x.legs.map((l) => l.runId)).size === x.legs.length &&
      x.legs
        .reduce((s, l) => s.plus(String(l.weightPct)), new Decimal(0))
        .minus(100)
        .abs()
        .lt("0.00000001"),
    "权重须合计100%，实验不能重复",
  );
export function portfolioResearch(input: unknown, runs: RunRecord[]) {
  const x = portfolioInput.parse(input),
    selected = x.legs.map((l) => {
      const r = runs.find((r) => r.id === l.runId);
      if (!r) fail("NOT_FOUND", "组合实验不存在");
      verifyRun(r);
      return r;
    });
  const first = selected[0]!;
  if (
    selected.some(
      (r) =>
        r.config.from !== first.config.from ||
        r.config.to !== first.config.to ||
        r.config.engineVersion !== first.config.engineVersion,
    )
  )
    fail("PORTFOLIO_BASIS", "组合需要相同区间和引擎版本");
  const maps = selected.map(
    (r) =>
      new Map(
        r.result!.state.curve.map((p) => [
          p.at,
          new Decimal(p.equity).div(r.config.initialCash),
        ]),
      ),
  );
  const times = [...maps[0]!.keys()]
    .filter((t) => maps.every((m) => m.has(t)))
    .sort((a, b) => a - b);
  if (times.length < 2) fail("PORTFOLIO_SAMPLE", "组合缺少共同估值时点");
  const normalized = allocateCapital(
    "1",
    x.legs.map((l) => l.weightPct),
  );
  let values = [...normalized],
    previous = maps.map(() => new Decimal(1)),
    peak = new Decimal(1),
    fees = new Decimal(0),
    lastBucket = "";
  const contributions = x.legs.map(() => new Decimal(0)),
    curve: { at: number; equity: string; drawdownPct: string }[] = [];
  for (const at of times) {
    values = values.map((v, i) => {
      const price = maps[i]!.get(at)!;
      if (previous[i]!.lte(0)) fail("PORTFOLIO_EQUITY", "成分权益无效");
      const next = v.mul(price.div(previous[i]!));
      contributions[i] = contributions[i]!.plus(next.minus(v));
      previous[i] = price;
      return next;
    });
    let total = values.reduce((s, v) => s.plus(v), new Decimal(0));
    const date = new Date(at).toISOString(),
      bucket = x.rebalance === "monthly" ? date.slice(0, 7) : date.slice(0, 10);
    if (x.rebalance !== "none" && lastBucket && lastBucket !== bucket) {
      const turnover = values.reduce(
        (s, v, i) => s.plus(v.minus(total.mul(normalized[i]!)).abs()),
        new Decimal(0),
      );
      const cost = turnover.mul(x.rebalanceCostBps).div(10000);
      fees = fees.plus(cost);
      total = total.minus(cost);
      values = allocateCapital(
        total,
        x.legs.map((l) => l.weightPct),
      );
    }
    lastBucket = bucket;
    peak = Decimal.max(peak, total);
    curve.push({
      at,
      equity: total.toFixed(),
      drawdownPct: peak.minus(total).div(peak).mul(100).toFixed(),
    });
  }
  const changes = maps.map((m) =>
    times
      .slice(1)
      .map((t, i) => m.get(t)!.div(m.get(times[i]!)!).minus(1).toNumber()),
  );
  const covariance = (a: number[], b: number[]) => {
    const ma = a.reduce((s, v) => s + v, 0) / a.length,
      mb = b.reduce((s, v) => s + v, 0) / b.length;
    return (
      a.reduce((s, v, i) => s + (v - ma) * (b[i]! - mb), 0) /
      Math.max(1, a.length - 1)
    );
  };
  const cov = changes.map((a) => changes.map((b) => covariance(a, b)));
  const correlation = cov.map((row, i) =>
    row.map((v, j) =>
      cov[i]![i]! > 0 && cov[j]![j]! > 0
        ? v / Math.sqrt(cov[i]![i]! * cov[j]![j]!)
        : null,
    ),
  );
  const weights = normalized.map((w) => w.toNumber()),
    variance = cov.reduce(
      (s, row, i) =>
        s + weights[i]! * row.reduce((v, c, j) => v + c * weights[j]!, 0),
      0,
    );
  const body = {
    version: 1,
    protocol: x,
    sources: selected.map((r) => ({
      id: r.id,
      manifestHash: r.manifestHash,
      resultHash: r.result!.hash,
    })),
    curve,
    returnPct: new Decimal(curve.at(-1)!.equity).minus(1).mul(100).toFixed(),
    rebalanceCosts: fees.toFixed(),
    correlation,
    legs: x.legs.map((l, i) => ({
      ...l,
      contribution: contributions[i]!.toFixed(),
      riskContributionPct:
        variance > 0
          ? ((weights[i]! *
              cov[i]!.reduce((s, c, j) => s + c * weights[j]!, 0)) /
              variance) *
            100
          : null,
    })),
    limitations: [
      "这是策略净值序列组合情景，不是共享资金的逐笔成交回测，不能直接批准模拟运行。",
      "成分已有成本计入；再平衡按共同估值时点及配置的换仓费用近似，不模拟流动性与订单竞争。",
      "相关性与风险贡献基于共同估值时点的简单收益，零方差时为空；历史相关性不代表未来。",
    ],
  };
  return { ...body, hash: hash(body) };
}
