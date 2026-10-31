import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configInput, strategySchema } from "../src/domain/schemas.js";
import {
  DEFAULT_RULES,
  type Bar,
  type RunRecord,
  type RunConfig,
} from "../src/domain/contracts.js";
import type { ResearchProject, EvidenceRef } from "../src/domain/project.js";
import { backtest, ENGINE_VERSION } from "../src/engine/backtest.js";
import { portfolioBacktest } from "../src/engine/portfolio.js";
import { portfolioResearch } from "../src/research/portfolio.js";
import { researchQuality } from "../src/research/quality.js";
import { evaluate } from "../src/research/evaluation.js";
import { claimTemplate } from "../src/research/claims.js";
import { conditionMatches } from "../src/domain/conditions.js";
import { ProjectService } from "../src/agent/project-service.js";
import { Research } from "../src/host/research.js";
import { exportBackup, restoreBackup } from "../src/host/backup.js";
import { provenanceSchema } from "../src/domain/provenance.js";
import { labAction } from "../src/host/lab.js";
const start = Date.UTC(2025, 0, 1),
  step = 3600000;
const strategy = strategySchema.parse({
  template: "sma_cross",
  symbols: ["BTCUSDT"],
  interval: "1h",
  fast: 2,
  slow: 3,
});
const bars: Bar[] = Array.from({ length: 24 * 65 }, (_, i) => {
  const p = 100 + 10 * Math.sin(i / 5);
  return {
    symbol: "BTCUSDT",
    time: start + i * step,
    open: String(p),
    high: String(p + 2),
    low: String(p - 2),
    close: String(p + Math.sin(i)),
    volume: "100000",
  };
});
const cfg: RunConfig = {
  ...configInput.parse({
    initialCash: "1000",
    from: start,
    to: bars.at(-1)!.time,
    risk: {
      weightPct: "50",
      maxSymbolPct: "100",
      maxExposurePct: "100",
      dailyLossPct: "100",
      maxDrawdownPct: "100",
      stopLossPct: "0",
      takeProfitPct: "0",
    },
    costs: { feeBps: "10", slippageBps: "0", participationPct: "0" },
  }),
  rules: { BTCUSDT: { ...DEFAULT_RULES, minNotional: "0" } },
  engineVersion: ENGINE_VERSION,
};
function run(id = "run"): RunRecord {
  return {
    id,
    strategyId: "strategy",
    datasetIds: ["data"],
    config: cfg,
    status: "completed",
    progress: 100,
    createdAt: new Date(start).toISOString(),
    manifestHash: "manifest",
    result: backtest(strategy, cfg, bars),
  };
}
test("cross-period, development results and manual experiments contaminate overlapping final windows", () => {
  const p = {
    id: "current",
    protocol: { interval: "1h", symbols: ["BTCUSDT"] },
    ranges: { holdout: { from: start + 2 * step, to: start + 3 * step } },
  };
  const prior = {
    id: "other",
    protocol: { interval: "15m", symbols: ["BTCUSDT"] },
    experiments: [{ status: "completed", from: start, to: start + 4 * step }],
    ranges: p.ranges,
    holdoutRevealedAt: null,
  };
  const svc = Object.create(ProjectService.prototype);
  Object.defineProperty(svc, "store", {
    value: {
      page: (kind: string) =>
        kind === "project"
          ? [prior]
          : [
              {
                ...run("manual"),
                config: { ...cfg, from: start, to: start + 4 * step },
              },
            ],
      get: () => ({ definition: strategy }),
    },
  });
  assert.deepEqual(svc.priorExposures(p), ["manual", "other"]);
  prior.experiments[0]!.status = "failed";
  assert.deepEqual(svc.priorExposures(p), ["manual"]);
});
test("explicit acceptance distinguishes absolute from relative return and enforces duration", () => {
  const r = run();
  r.result!.metrics = {
    ...r.result!.metrics,
    closedTrades: 12,
    maxDrawdownPct: "8",
    returnPct: "-5",
  };
  r.result!.benchmarks.buyHoldReturnPct = "-20";
  const p = {
    protocol: {
      interval: "1h",
      thresholds: {
        minClosedTrades: 10,
        maxDrawdownPct: "20",
        minExcessReturnPct: "0",
      },
    },
  } as ResearchProject;
  assert.equal(evaluate(p, r).verdict, "pass");
  p.protocol.acceptance = {
    version: 1,
    benchmark: "cash",
    minReturnPct: "0",
    minDays: 100,
  };
  assert.equal(evaluate(p, r).verdict, "fail");
  assert.ok(evaluate(p, r).reasons.some((r) => r.code === "ABSOLUTE_RETURN"));
  assert.ok(
    evaluate(p, r).reasons.some((r) => r.code === "DURATION_INSUFFICIENT"),
  );
});
test("fact comparisons reject false direction, incompatible units and windows", () => {
  const a = {
      id: "a",
      path: "metrics.returnPct",
      value: "-5",
      from: 1,
      to: 2,
    } as EvidenceRef,
    b = { ...a, id: "b", path: "benchmarks.buyHoldReturnPct", value: "-20" };
  assert.ok(
    claimTemplate(
      [{ left: "a", operator: "gt", right: "b" }],
      [a, b],
      ["a", "b"],
    ).includes("高于"),
  );
  assert.throws(() =>
    claimTemplate(
      [{ left: "a", operator: "lt", right: "b" }],
      [a, b],
      ["a", "b"],
    ),
  );
  assert.throws(() =>
    claimTemplate(
      [{ left: "a", operator: "gt", right: "b" }],
      [a, { ...b, to: 3 }],
      ["a", "b"],
    ),
  );
  assert.throws(() =>
    claimTemplate(
      [{ left: "a", operator: "gt", right: "b" }],
      [a, { ...b, path: "metrics.fees" }],
      ["a", "b"],
    ),
  );
});
test("higher-timeframe conditions exclude incomplete buckets and reject oversized warmup", () => {
  const c = {
    indicator: "return_pct",
    period: 2,
    factor: 4,
    operator: "gt",
    value: "-100",
  } as const;
  assert.equal(conditionMatches(bars.slice(0, 11), c, step), false);
  assert.equal(conditionMatches(bars.slice(0, 12), c, step), true);
  assert.throws(() =>
    strategySchema.parse({
      ...strategy,
      conditions: {
        version: 1,
        mode: "replace",
        entry: [{ ...c, period: 1000, factor: 48 }],
        exit: [c],
      },
    }),
  );
  const def = strategySchema.parse({
    ...strategy,
    conditions: {
      version: 1,
      mode: "replace",
      entry: [{ ...c, value: "0" }],
      exit: [{ ...c, operator: "lt", value: "0" }],
    },
  });
  const a = backtest(def, cfg, bars.slice(0, 100)),
    b = backtest(def, cfg, [
      ...bars.slice(0, 100),
      ...bars
        .slice(100)
        .map((b) => ({
          ...b,
          open: "500",
          high: "501",
          low: "499",
          close: "500",
        })),
    ]);
  assert.deepEqual(
    a.state.fills,
    b.state.fills.filter((f) => f.at < bars[100]!.time),
  );
});
test("historical rules cannot use information unavailable at the simulation time", () => {
  assert.throws(() =>
    backtest(
      strategy,
      {
        ...cfg,
        ruleHistory: {
          BTCUSDT: [
            { effectiveAt: start, knownAt: start + step, rules: DEFAULT_RULES },
          ],
        },
      },
      bars,
    ),
  );
  assert.ok(
    backtest(
      strategy,
      {
        ...cfg,
        ruleHistory: {
          BTCUSDT: [
            { effectiveAt: start, knownAt: start, rules: DEFAULT_RULES },
          ],
        },
      },
      bars,
    ).hash,
  );
});
test("portfolio backtest conserves funding, charges real fills and rejects conflicting histories", () => {
  const protocol = {
    legs: [
      { runId: "a", weightPct: 50 },
      { runId: "b", weightPct: 50 },
    ],
    initialCash: "1000",
    rebalance: "daily" as const,
  };
  const leg = { strategy, config: cfg, bars, manifestHash: "manifest" };
  const r = portfolioBacktest(protocol, [leg, leg]);
  assert.ok(r.rebalances.length > 1);
  assert.equal(
    r.sleeves.reduce((n, s) => n + Number(s.fundingAfterTransfers), 0),
    1000,
  );
  assert.ok(
    r.sleeves.every((s) =>
      s.state.fills.some((f) => f.reason === "PORTFOLIO_REBALANCE"),
    ),
  );
  const altered = bars.map((b, i) => (i ? b : { ...b, close: "999" }));
  assert.throws(() =>
    portfolioBacktest(protocol, [leg, { ...leg, bars: altered }]),
  );
});
test("portfolio scenarios use identical basis and preserve zero-variance correlation as null", () => {
  const x = {
    legs: [
      { runId: "a", weightPct: 50 },
      { runId: "b", weightPct: 50 },
    ],
    rebalance: "monthly",
    rebalanceCostBps: 10,
  };
  const a = run("a"),
    b = run("b");
  const result = portfolioResearch(x, [a, b]);
  assert.ok(Math.abs(result.correlation[0]![1]! - 1) < 1e-10);
  assert.throws(() =>
    portfolioResearch(
      {
        ...x,
        legs: [
          { runId: "a", weightPct: 50 },
          { runId: "b", weightPct: 20 },
        ],
      },
      [a, b],
    ),
  );
  assert.throws(() =>
    portfolioResearch(x, [a, { ...b, config: { ...cfg, from: start + step } }]),
  );
});
test("block bootstrap is deterministic and insufficient samples do not invent intervals", () => {
  const r = run();
  assert.deepEqual(researchQuality(r, 2), researchQuality(r, 2));
  assert.equal(researchQuality(r, 2).meanDailyReturnIntervalPct?.length, 2);
  const small = { ...r, result: backtest(strategy, cfg, bars.slice(0, 24)) };
  assert.equal(researchQuality(small, 1).meanDailyReturnIntervalPct, null);
});
test("data provenance, revisions, source differences and cache survive backup restore", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quant-enhance-")),
    other = mkdtempSync(join(tmpdir(), "quant-restore-"));
  const r = new Research(dir),
    restored = new Research(other);
  try {
    const a = r.saveDataset(
      "cached",
      "BTCUSDT",
      "1h",
      "Binance public market data",
      bars,
    );
    const job = r.prepare({
      submissionId: "cached",
      symbol: "BTCUSDT",
      interval: "1h",
      from: start,
      to: bars.at(-1)!.time,
    });
    assert.equal(job.status, "completed");
    assert.equal(job.datasetId, a.id);
    const csv =
      "time,open,high,low,close,volume\n" +
      bars
        .map((b) =>
          [b.time, b.open, b.high, b.low, b.close, b.volume].join(","),
        )
        .join("\n");
    const b = r.importDataset({
      submissionId: "revision",
      name: "revision",
      symbol: "BTCUSDT",
      interval: "1h",
      csv,
      provenance: {
        version: 1,
        provider: "independent",
        retrievedAt: Date.now(),
        revisionOf: a.id,
        ruleHistory: [
          { effectiveAt: start, knownAt: start, rules: DEFAULT_RULES },
        ],
        listing: { listedAt: start - step, knownAt: start - step },
      },
    });
    const audit = labAction(r, "data-audit", { datasetIds: [a.id, b.id] }) as {
      comparisons: { differences: number }[];
    };
    assert.equal(audit.comparisons[0]!.differences, 0);
    const backup = exportBackup(r);
    restoreBackup(restored, { submissionId: "restore", backup });
    assert.deepEqual(
      restored.store.get<any>("dataset", b.id).provenance,
      b.provenance,
    );
    assert.throws(() =>
      provenanceSchema.parse({
        version: 1,
        provider: "bad",
        retrievedAt: 0,
        ruleHistory: [
          { effectiveAt: 2, knownAt: 0, rules: DEFAULT_RULES },
          { effectiveAt: 1, knownAt: 0, rules: DEFAULT_RULES },
        ],
      }),
    );
  } finally {
    await r.close();
    await restored.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
test("same-window replay freezes identities, matches signals and refuses unknown midstream positions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quant-replay-")),
    r = new Research(dir);
  try {
    const ds = r.saveDataset("replay", "BTCUSDT", "1h", "controlled", bars);
    const draft = r.draft(
      {
        submissionId: "draft",
        name: "replay",
        expectedRevision: 0,
        definition: strategy,
      },
      "user",
    );
    const published = r.publish({
      submissionId: "publish",
      id: draft.id,
      expectedRevision: draft.revision,
    });
    const a = r.accountCreate({
      submissionId: "account",
      name: "replay",
      strategyId: published.id,
      config: {
        initialCash: cfg.initialCash,
        risk: cfg.risk,
        costs: cfg.costs,
        from: cfg.from,
        to: cfg.to,
      },
    });
    a.createdAt = new Date(start).toISOString();
    a.state = backtest(strategy, cfg, bars).state;
    a.config = cfg;
    r.store.transaction(() => {
      r.store.saveState(a.id, a.state);
      r.store.put("account", a.id, a);
    });
    const input = {
      accountId: a.id,
      datasetIds: [ds.id],
      from: start,
      to: bars.at(-1)!.time,
    };
    const result = labAction(r, "simulation-replay", input) as {
      matches: { observed: unknown; priceDifference: number }[];
      hash: string;
    };
    assert.ok(result.matches.length > 0);
    assert.ok(
      result.matches.every((m) => m.observed && m.priceDifference === 0),
    );
    assert.equal(
      (labAction(r, "simulation-replay", input) as { hash: string }).hash,
      result.hash,
    );
    assert.throws(() =>
      labAction(r, "simulation-replay", { ...input, from: bars[100]!.time }),
    );
    assert.equal(
      r.store.get<any>("account", a.id).state.fills.length,
      a.state.fills.length,
    );
  } finally {
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("historical candidate pool excludes missing, future-known and delisted membership", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quant-universe-")),
    r = new Research(dir);
  try {
    const d = r.saveDataset("market", "BTCUSDT", "1h", "controlled", bars);
    d.provenance = {
      version: 1,
      provider: "archive",
      retrievedAt: start,
      listing: { listedAt: start, delistedAt: start + step, knownAt: start },
    };
    r.store.put("dataset", d.id, d);
    const snapshot = (asOf: number) =>
      labAction(r, "universe-asof", { datasetIds: [d.id], asOf }) as {
        rows: { eligible: boolean }[];
      };
    assert.equal(snapshot(start).rows[0]!.eligible, true);
    assert.equal(snapshot(start - step).rows[0]!.eligible, false);
    assert.equal(snapshot(start + step).rows[0]!.eligible, false);
    d.provenance.listing!.knownAt = start + 2 * step;
    r.store.put("dataset", d.id, d);
    assert.equal(snapshot(start).rows[0]!.eligible, false);
  } finally {
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("explicit goal research delivers uncertainty evidence, verifies approval facts and restores without rewriting identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quant-acceptance-")),
    dest = mkdtempSync(join(tmpdir(), "quant-acceptance-restore-"));
  const r = new Research(dir);
  r.closed = true;
  const service = new ProjectService(r),
    restored = new Research(dest);
  restored.closed = true;
  try {
    const ds = r.saveDataset(
      "controlled",
      "BTCUSDT",
      "1h",
      "controlled",
      bars,
      true,
    );
    const p = service.create(
      {
        submissionId: "acceptance",
        name: "明确目标",
        objective: "比较候选并检验明确收益门槛",
        symbols: ["BTCUSDT"],
        interval: "1h",
        from: ds.from,
        to: ds.to,
        datasetIds: [ds.id],
        mode: "protocol",
        acceptance: {
          version: 1,
          benchmark: "cash",
          minReturnPct: "-10000",
          minDays: 1,
        },
        thresholds: {
          minClosedTrades: 1,
          maxDrawdownPct: "100",
          minExcessReturnPct: "-10000",
        },
      },
      "session",
    );
    service.control({
      submissionId: "start",
      id: p.id,
      expectedRevision: p.revision,
      action: "start",
    });
    let completed: ResearchProject | undefined;
    for (let i = 0; i < 120; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const queued of r.store.withStatus<RunRecord>("run", ["queued"])) {
        const definition = r.store.get<any>(
          "strategy",
          queued.strategyId,
        ).definition;
        queued.result = backtest(definition, queued.config, bars);
        queued.status = "completed";
        queued.progress = 100;
        queued.computeMs = 1;
        r.store.put("run", queued.id, queued);
      }
      const current = r.store.get<ResearchProject>("project", p.id);
      if (current.status === "completed") {
        completed = current;
        break;
      }
    }
    assert.ok(completed);
    assert.equal(
      completed.report!.facts.filter((f) => f.path.startsWith("uncertainty."))
        .length,
      3,
    );
    const digest = service.verifyReport(p.id).report!.hash;
    restoreBackup(restored, {
      submissionId: "restore",
      backup: exportBackup(r),
    });
    assert.equal(
      restored.store.get<ResearchProject>("project", p.id).report!.hash,
      digest,
    );
    completed.report!.conclusion = "supported";
    const { hash: _old, ...body } = completed.report!;
    const { hash } = await import("../src/adapters/market.js");
    completed.report!.hash = hash(body);
    r.store.put("project", p.id, completed);
    assert.throws(() => service.verifyReport(p.id));
  } finally {
    await service.close();
    await r.close();
    await restored.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});
