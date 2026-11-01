import {
  portfolioBacktestInput,
  portfolioBacktest,
} from "../engine/portfolio.js";
import { z } from "zod";
import { id, fail } from "../domain/schemas.js";
import {
  INTERVAL_MS,
  type Account,
  type Dataset,
  type RunRecord,
  type StrategyRecord,
} from "../domain/contracts.js";
import { hash } from "../adapters/market.js";
import { backtest, ENGINE_VERSION } from "../engine/backtest.js";
import { researchQuality } from "../research/quality.js";
import { portfolioInput, portfolioResearch } from "../research/portfolio.js";
export interface LabReader {
  store: {
    assertLease(): void;
    get<T>(kind: string, id: string): T;
    metadata?<T>(kind: string, id: string): T;
    count(kind: string): number;
  };
  bars(dataset: Dataset): import("../domain/contracts.js").Bar[];
}

export function labAction(r: LabReader, action: string, input: unknown) {
  r.store.assertLease();
  if (action === "research-quality") {
    const x = z.object({ runId: id }).strict().parse(input);
    return researchQuality(
      r.store.get<RunRecord>("run", x.runId),
      r.store.count("run"),
    );
  }
  if (action === "portfolio-backtest") {
    const x = portfolioBacktestInput.parse(input);
    const sourceRuns = x.legs.map((l) =>
      r.store.metadata
        ? r.store.metadata<RunRecord>("run", l.runId)
        : r.store.get<RunRecord>("run", l.runId),
    );
    const sources = sourceRuns.map((run) => ({
      run,
      datasets: run.datasetIds.map((id) => r.store.get<Dataset>("dataset", id)),
    }));
    if (
      sources.reduce(
        (n, s) => n + s.datasets.reduce((n, d) => n + d.count, 0),
        0,
      ) > 1000000
    )
      fail("TOO_LARGE", "组合最多一百万根");
    const legs = sources.map(({ run, datasets }) => {
      if (
        run.status !== "completed" ||
        run.config.engineVersion !== ENGINE_VERSION
      )
        fail("PORTFOLIO_SOURCE", "成分须为当前引擎的完整回测");
      const strategy = r.store.get<StrategyRecord>(
        "strategy",
        run.strategyId,
      ).definition;
      return {
        strategy,
        config: run.config,
        manifestHash: run.manifestHash,
        bars: datasets.flatMap((d) => r.bars(d)),
      };
    });
    if (legs.reduce((n, l) => n + l.bars.length, 0) > 1000000)
      fail("TOO_LARGE", "组合最多一百万根");
    return portfolioBacktest(x, legs);
  }
  if (action === "portfolio-research") {
    const x = portfolioInput.parse(input);
    return portfolioResearch(
      x,
      x.legs.map((l) => r.store.get<RunRecord>("run", l.runId)),
    );
  }
  if (action === "universe-asof") {
    const x = z
      .object({
        datasetIds: z.array(id).min(1).max(1000),
        asOf: z.number().int().nonnegative(),
      })
      .strict()
      .parse(input);
    const rows = x.datasetIds
      .map((id) => r.store.get<Dataset>("dataset", id))
      .map((d) => {
        const listing = d.provenance?.listing;
        const eligible =
          !d.synthetic &&
          !!listing &&
          listing.knownAt <= x.asOf &&
          listing.listedAt <= x.asOf &&
          (listing.delistedAt === undefined || listing.delistedAt > x.asOf);
        return {
          datasetId: d.id,
          hash: d.hash,
          symbol: d.symbol,
          eligible,
          listing: listing ?? null,
          reason: d.synthetic
            ? "合成数据"
            : !listing
              ? "上市历史未知"
              : listing.knownAt > x.asOf
                ? "信息在该时点尚不可用"
                : eligible
                  ? "符合已提供上市记录"
                  : "该时点尚未上市或已经退市",
        };
      });
    const body = {
      version: 1,
      asOf: x.asOf,
      rows,
      limitations: [
        "仅从用户提供的候选与上市档案重建；不能宣称覆盖历史全市场或已消除幸存者偏差。",
      ],
    };
    return { ...body, hash: hash(body) };
  }
  if (action === "data-audit") {
    const x = z
      .object({ datasetIds: z.array(id).min(1).max(10) })
      .strict()
      .parse(input);
    const datasets = x.datasetIds.map((i) =>
      r.store.get<Dataset>("dataset", i),
    );
    const rows = datasets.map((d) => {
      const bars = r.bars(d);
      return {
        id: d.id,
        hash: d.hash,
        symbol: d.symbol,
        interval: d.interval,
        from: d.from,
        to: d.to,
        synthetic: d.synthetic,
        provenance: d.provenance ?? null,
        historicalRules: !!d.provenance?.ruleHistory?.length,
        warnings: [
          ...(!d.provenance ? ["缺少结构化来源记录"] : []),
          ...(!d.provenance?.listing
            ? ["缺少历史上市/退市记录，不能用于无幸存者偏差选币"]
            : []),
          ...(!d.provenance?.ruleHistory?.length
            ? ["使用当前或默认规则近似"]
            : []),
        ],
        bars,
      };
    });
    const comparisons = [];
    for (let i = 0; i < rows.length; i++)
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i]!,
          b = rows[j]!;
        if (a.symbol !== b.symbol || a.interval !== b.interval) continue;
        const map = new Map(b.bars.map((v) => [v.time, v]));
        let overlap = 0,
          differences = 0;
        for (const bar of a.bars) {
          const other = map.get(bar.time);
          if (other) {
            overlap++;
            if (hash(bar) !== hash(other)) differences++;
          }
        }
        comparisons.push({ left: a.id, right: b.id, overlap, differences });
      }
    const body = {
      version: 1,
      datasets: rows.map(({ bars, ...row }) => row),
      comparisons,
      limitations: [
        "来源、上市和规则记录由导入者提供；完整性校验不等于第三方真实性认证。",
      ],
    };
    return { ...body, hash: hash(body) };
  }
  if (action === "simulation-replay") {
    const x = z
      .object({
        accountId: id,
        datasetIds: z.array(id).min(1).max(10),
        from: z.number().int().nonnegative(),
        to: z.number().int().positive(),
      })
      .strict()
      .parse(input);
    const a = r.store.get<Account>("account", x.accountId),
      strategy = r.store.get<StrategyRecord>(
        "strategy",
        a.strategyId,
      ).definition;
    if (a.config.engineVersion !== ENGINE_VERSION)
      fail("ENGINE_MISMATCH", "重放需要与观察账户相同的引擎版本");
    if (
      x.to <= x.from ||
      x.from <
        Math.floor(Date.parse(a.createdAt) / INTERVAL_MS[strategy.interval]) *
          INTERVAL_MS[strategy.interval] ||
      x.from % INTERVAL_MS[strategy.interval] !== 0 ||
      x.to % INTERVAL_MS[strategy.interval] !== 0
    )
      fail("REPLAY_RANGE", "重放区间须从账户创建后开始");
    if (a.state.fills.some((f) => f.at < x.from))
      fail(
        "REPLAY_INITIAL_STATE",
        "区间前已有成交，不能从空仓重放；请从账户首个交易前的区间开始",
      );
    const ds = x.datasetIds.map((i) => r.store.get<Dataset>("dataset", i));
    if (
      ds.length !== strategy.symbols.length ||
      new Set(ds.map((d) => d.symbol)).size !== ds.length ||
      ds.some(
        (d) =>
          !strategy.symbols.includes(d.symbol) ||
          d.interval !== strategy.interval ||
          d.from > x.from ||
          d.to < x.to,
      )
    )
      fail("REPLAY_DATA", "每个交易对须有覆盖重放区间的同周期快照");
    if (ds.reduce((n, d) => n + d.count, 0) > 1000000)
      fail("TOO_LARGE", "重放最多一百万根");
    const result = backtest(
      strategy,
      { ...a.config, from: x.from, to: x.to },
      ds.flatMap((d) => r.bars(d)),
    );
    const end = x.to + INTERVAL_MS[strategy.interval];
    const observed = a.state.fills.filter((f) => f.at >= x.from && f.at <= end);
    const replay = result.state.fills,
      used = new Set<string>();
    const matches = replay.map((f) => {
      const other = observed.find(
        (o) =>
          !used.has(o.id) &&
          o.symbol === f.symbol &&
          o.side === f.side &&
          o.signalAt === f.signalAt,
      );
      if (other) used.add(other.id);
      return {
        symbol: f.symbol,
        side: f.side,
        signalAt: f.signalAt,
        replay: f,
        observed: other ?? null,
        latencyMs: other ? other.at - f.at : null,
        priceDifference: other ? Number(other.price) - Number(f.price) : null,
      };
    });
    const body = {
      version: 1,
      accountId: a.id,
      accountHash: hash(a),
      config: a.config,
      definition: strategy,
      from: x.from,
      to: x.to,
      datasets: ds.map((d) => ({ id: d.id, hash: d.hash })),
      resultHash: result.hash,
      matches,
      observedOnly: observed.filter((f) => !used.has(f.id)),
      decisions: a.state.decisions.filter((d) => d.at >= x.from && d.at <= end),
      limitations: [
        "独立历史行情与本地模拟成交按同一信号身份对账；不将缺失成交直接归因于策略失效。",
        "历史重放从空仓和初始资金开始；若截取账户中途区间或存在观察缺口，仓位路径不同，收益不能直接归因。",
        "历史使用下一根开盘与K线保护退出；模拟使用观察报价与抽样保护，时间及成交模型差异保留展示。",
      ],
    };
    return { ...body, hash: hash(body) };
  }
  fail("UNKNOWN_ACTION", "未知研究增强动作");
}
