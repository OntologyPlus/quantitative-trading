import test from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "decimal.js";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { allocateCapital } from "../src/domain/allocation.js";
import { configInput, strategySchema } from "../src/domain/schemas.js";
import { configurationChanges } from "../src/domain/simulation-analysis.js";
import {
  parameterNeighbors,
  diagnosticPlan,
  robustnessInput,
} from "../src/domain/robustness.js";
import {
  portfolioBacktest,
  portfolioBacktestInput,
} from "../src/engine/portfolio.js";
import { backtest, ENGINE_VERSION } from "../src/engine/backtest.js";
import {
  DEFAULT_RULES,
  type Bar,
  type RunConfig,
  type RunRecord,
} from "../src/domain/contracts.js";
import type { ResearchProject } from "../src/domain/project.js";
import { Research } from "../src/host/research.js";
import { Paper } from "../src/host/paper.js";
import { LabExecutor } from "../src/host/lab-executor.js";

const start = Date.UTC(2020, 0, 1),
  step = 3600000;
const condition = {
  indicator: "return_pct",
  period: 2,
  factor: 1,
  operator: "gt",
  value: "-100",
} as const;
const definition = strategySchema.parse({
  template: "sma_cross",
  symbols: ["BTCUSDT"],
  interval: "1h",
  fast: 2,
  slow: 60,
  conditions: {
    version: 1,
    mode: "replace",
    entry: [condition],
    exit: [{ ...condition, operator: "lt" }],
  },
});
const inputConfig = configInput.parse({
  initialCash: "10000",
  from: start,
  to: start + 79 * step,
  risk: {
    weightPct: "100",
    maxSymbolPct: "100",
    maxExposurePct: "100",
    stopLossPct: "0",
    takeProfitPct: "0",
    dailyLossPct: "100",
    maxDrawdownPct: "100",
  },
  costs: { feeBps: "0", slippageBps: "0", participationPct: "0" },
});
const config: RunConfig = {
  ...inputConfig,
  rules: { BTCUSDT: { ...DEFAULT_RULES, minNotional: "0" } },
  engineVersion: ENGINE_VERSION,
};
const bars: Bar[] = Array.from({ length: 80 }, (_, i) => ({
  symbol: "BTCUSDT",
  time: start + i * step,
  open: "100",
  high: "100",
  low: "100",
  close: "100",
  volume: "100000",
}));
const leg = { strategy: definition, config, bars, manifestHash: "source" };
const protocol = {
  initialCash: "10000",
  legs: [
    { runId: "a", weightPct: 50 },
    { runId: "b", weightPct: 50 },
  ],
  rebalance: "none" as const,
};

test("portfolio records aggregate open and close marks without replacing a jump drawdown", () => {
  const jump = bars.map((b, i) =>
    i === 5 ? { ...b, open: "50", low: "50" } : b,
  );
  const a = { ...leg, bars: jump },
    b = {
      ...leg,
      strategy: { ...definition, symbols: ["ETHUSDT"] },
      config: { ...config, rules: { ETHUSDT: config.rules.BTCUSDT! } },
      bars: bars.map((b) => ({ ...b, symbol: "ETHUSDT" })),
    };
  const result = portfolioBacktest(protocol, [a, b]);
  assert.equal(result.maxDrawdownPct, "25");
  assert.ok(
    result.curve.some(
      (p) =>
        p.at === start + 5 * step &&
        p.phase === "open" &&
        p.drawdownPct === "25",
    ),
  );
  assert.ok(
    result.curve.some(
      (p) =>
        p.at === start + 5 * step &&
        p.phase === "close" &&
        p.drawdownPct === "0",
    ),
  );
  assert.equal(result.curve.at(-1)!.at, config.to + step);
});

test("accepted fractional weights conserve initial and repeatedly rebalanced funding exactly", () => {
  for (const weights of [
    [33.3333333333, 66.6666666666],
    Array(6).fill(16.6666666667),
    [33.33, 33.33, 33.34],
  ]) {
    const allocated = allocateCapital("10000.0000000000000001", weights);
    assert.ok(
      allocated
        .reduce((s, a) => s.plus(a), new Decimal(0))
        .eq("10000.0000000000000001"),
    );
    const p = portfolioBacktestInput.parse({
      ...protocol,
      rebalance: "daily",
      legs: weights.map((weightPct, i) => ({ runId: `r${i}`, weightPct })),
    });
    const result = portfolioBacktest(
      p,
      weights.map(() => leg),
    );
    assert.ok(result.rebalances.length > 1);
    assert.ok(
      result.sleeves
        .reduce((s, l) => s.plus(l.initialFunding), new Decimal(0))
        .eq(p.initialCash),
    );
    assert.ok(
      result.sleeves
        .reduce((s, l) => s.plus(l.fundingAfterTransfers), new Decimal(0))
        .eq(p.initialCash),
    );
    for (const at of new Set(result.transfers.map((t) => t.at)))
      assert.ok(
        result.transfers
          .filter((t) => t.at === at)
          .reduce((s, t) => s.plus(t.delta), new Decimal(0))
          .eq(0),
      );
  }
  assert.throws(() => allocateCapital("100", [40, 50]));
});

test("condition previews include add/remove, mode, period, threshold and higher-timeframe changes", () => {
  const before = { definition, config };
  for (const conditions of [
    undefined,
    { ...definition.conditions!, mode: "filter" as const },
    { ...definition.conditions!, entry: [{ ...condition, period: 3 }] },
    { ...definition.conditions!, entry: [{ ...condition, value: "10" }] },
    { ...definition.conditions!, exit: [{ ...condition, factor: 4 }] },
  ]) {
    const changes = configurationChanges(before, {
      definition: { ...definition, conditions },
      config,
    });
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.field, "conditions");
    assert.notEqual(changes[0]!.before, changes[0]!.after);
  }
  const reordered = {
    ...definition,
    conditions: {
      exit: definition.conditions!.exit,
      entry: definition.conditions!.entry,
      mode: definition.conditions!.mode,
      version: 1 as const,
    },
  };
  assert.deepEqual(
    configurationChanges(before, { definition: reordered, config }),
    [],
  );
});

test("condition neighbors perturb an active parameter and get distinct diagnostic identities", () => {
  const selected = {
    ...definition,
    conditions: {
      ...definition.conditions!,
      entry: [{ ...condition, period: 20, value: "0" }],
    },
  };
  const neighbors = parameterNeighbors(selected, 20);
  assert.deepEqual(
    neighbors.map((s) => s.conditions!.entry[0]!.period),
    [16, 24],
  );
  const rising = bars.map((b, i) => ({
    ...b,
    open: String(100 + i),
    close: String(101 + i),
    high: String(102 + i),
    low: String(100 + i),
  }));
  const base = backtest(selected, config, rising);
  for (const neighbor of neighbors) {
    strategySchema.parse(neighbor);
    assert.equal(neighbor.slow, selected.slow);
    assert.notEqual(
      backtest(neighbor, config, rising).state.fills[0]!.signalAt,
      base.state.fills[0]!.signalAt,
    );
  }
  const p = {
    protocol: {
      robustness: robustnessInput.parse({ parameterVersion: 2 }),
      interval: "1h",
      from: start,
    },
    selectedCandidateId: "selected",
    candidates: [{ id: "selected" }, { id: "other" }],
    experiments: [],
    ranges: { validation: { from: start + 40 * step, to: start + 59 * step } },
  } as unknown as ResearchProject;
  const rows = diagnosticPlan(p, selected).filter(
    (p) => p.phase === "parameter_sensitivity",
  );
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((r) => r.diagnostic.key)).size, 2);
  assert.ok(rows.every((r) => r.diagnostic.key.includes("conditions")));
  const boundary = {
    ...selected,
    conditions: {
      ...selected.conditions!,
      entry: [{ ...condition, period: 2, factor: 48 }],
    },
  };
  assert.equal(parameterNeighbors(boundary, 20).length, 1);
  assert.ok(
    parameterNeighbors(boundary, 20).every(
      (s) => strategySchema.safeParse(s).success,
    ),
  );
});

test("real lab worker keeps host controls responsive, supports abort, timeout, bounded admission and shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quant-worker-fixes-"));
  const r = new Research(dir),
    paper = new Paper(r);
  const workerFile = join(dir, "lab.mjs");
  await build({
    entryPoints: [new URL("../src/workers/lab.ts", import.meta.url).pathname],
    outfile: workerFile,
    bundle: true,
    platform: "node",
    format: "esm",
    nodePaths: [join(process.cwd(), "node_modules")],
  });
  // Resolve external dependencies from this checkout while keeping the fixture outside it.
  const workerURL = pathToFileURL(workerFile);
  const executor = new LabExecutor(workerURL, 30000);
  try {
    const longBars = Array.from({ length: 25000 }, (_, i) => ({
      ...bars[0]!,
      time: start + i * step,
    }));
    const ds = r.saveDataset(
      "controlled",
      "BTCUSDT",
      "1h",
      "controlled",
      longBars,
    );
    const draft = r.draft(
      {
        submissionId: "draft",
        expectedRevision: 0,
        name: "strategy",
        definition,
      },
      "user",
    );
    const strategy = r.publish({
      submissionId: "publish",
      id: draft.id,
      expectedRevision: draft.revision,
    });
    const cfg = { ...config, to: longBars.at(-1)!.time };
    const result = backtest(definition, cfg, longBars);
    const source: RunRecord = {
      id: "a",
      strategyId: strategy.id,
      datasetIds: [ds.id],
      config: cfg,
      status: "completed",
      progress: 100,
      createdAt: new Date().toISOString(),
      manifestHash: "fixture",
      result,
    };
    r.store.put("run", "a", source);
    r.store.put("run", "b", { ...source, id: "b" });
    const account = r.accountCreate({
      submissionId: "account",
      name: "control",
      strategyId: strategy.id,
      config: inputConfig,
    });
    const request = { ...protocol };
    let finished = false;
    const job = executor.run(r, "portfolio-backtest", request).finally(() => {
      finished = true;
    });
    assert.throws(
      () => executor.run(r, "portfolio-backtest", request),
      /已有研究分析/,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(finished, false);
    const paused = await paper.control({
      submissionId: "pause",
      id: account.id,
      expectedRevision: account.revision,
      action: "pause",
    });
    assert.equal((paused as { status: string }).status, "paused");
    assert.equal(
      finished,
      false,
      "paper pause must finish before long computation",
    );
    const combined = (await job) as { hash: string };
    assert.ok(combined.hash);
    const cancel = new AbortController();
    const cancelled = executor.run(
      r,
      "portfolio-backtest",
      request,
      cancel.signal,
    );
    const rejected = assert.rejects(cancelled, /已取消/);
    setTimeout(() => cancel.abort(), 20);
    await rejected;
    const tiny = new LabExecutor(workerURL, 1);
    try {
      await assert.rejects(
        tiny.run(r, "portfolio-backtest", request),
        /时长上限/,
      );
    } finally {
      await tiny.close();
    }
    const next = (await executor.run(r, "data-audit", {
      datasetIds: [ds.id],
    })) as { hash: string };
    assert.ok(next.hash, "slot released after cancellation");
    const closing = executor.run(r, "portfolio-backtest", request);
    const closed = assert.rejects(closing, /服务已关闭/);
    await executor.close();
    await closed;
    assert.throws(
      () => executor.run(r, "data-audit", { datasetIds: [ds.id] }),
      /服务已关闭/,
    );
  } finally {
    await executor.close();
    paper.close();
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conditional robustness completes and restores actual period neighbors with correct report labels", async () => {
  const { ProjectService } = await import("../src/agent/project-service.js");
  const { exportBackup, restoreBackup } = await import("../src/host/backup.js");
  const dir = mkdtempSync(join(tmpdir(), "quant-condition-fixes-")),
    dest = mkdtempSync(join(tmpdir(), "quant-condition-restore-"));
  const r = new Research(dir);
  r.closed = true;
  const restored = new Research(dest);
  restored.closed = true;
  const service = new ProjectService(r);
  try {
    const data = Array.from({ length: 720 }, (_, i) => ({
      ...bars[0]!,
      time: start + i * step,
    }));
    const ds = r.saveDataset(
      "conditional",
      "BTCUSDT",
      "1h",
      "controlled",
      data,
      true,
    );
    const selected = {
      ...definition,
      conditions: {
        ...definition.conditions!,
        entry: [{ ...condition, period: 20 }],
      },
    };
    const p = service.create(
      {
        submissionId: "project",
        name: "条件稳健性",
        objective: "验证条件周期邻域而不是无效模板参数",
        symbols: ["BTCUSDT"],
        interval: "1h",
        from: ds.from,
        to: ds.to,
        datasetIds: [ds.id],
        mode: "protocol",
        robustness: robustnessInput.parse({}),
        budget: { experiments: 20 },
        candidates: [
          selected,
          {
            ...selected,
            conditions: {
              ...selected.conditions!,
              entry: [{ ...condition, period: 22 }],
            },
          },
        ],
      },
      "session",
    );
    service.control({
      submissionId: "start",
      id: p.id,
      expectedRevision: p.revision,
      action: "start",
    });
    let complete: ResearchProject | undefined;
    for (let i = 0; i < 300; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const run of r.store.withStatus<RunRecord>("run", ["queued"])) {
        const strategy = r.store.get<any>(
          "strategy",
          run.strategyId,
        ).definition;
        run.result = backtest(strategy, run.config, data);
        run.status = "completed";
        run.progress = 100;
        run.computeMs = 1;
        r.store.put("run", run.id, run);
      }
      const current = r.store.get<ResearchProject>("project", p.id);
      if (current.status === "completed") {
        complete = current;
        break;
      }
    }
    assert.ok(complete, "conditional protocol must finish");
    const parameters = complete.report!.diagnostics!.rows.filter(
      (r) => r.phase === "parameter_sensitivity",
    );
    assert.equal(parameters.length, 2);
    assert.ok(
      parameters.every((r) =>
        r.parameter!.includes("conditions.entry[0].period"),
      ),
    );
    service.verifyReport(p.id);
    restoreBackup(restored, {
      submissionId: "restore",
      backup: exportBackup(r),
    });
    assert.equal(
      restored.store.get<ResearchProject>("project", p.id).report!.hash,
      complete.report!.hash,
    );
  } finally {
    await service.close();
    await r.close();
    await restored.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test("promotion discloses condition changes, preserves legacy transition records and blocks legacy conditional evidence", async () => {
  const { makePromotionPreview, verifyTransition } = await import(
    "../src/research/promotion.js"
  );
  const { hash } = await import("../src/adapters/market.js");
  const runtime = configInput.parse({
    initialCash: config.initialCash,
    risk: config.risk,
    costs: config.costs,
  });
  const after = {
    ...definition,
    conditions: {
      ...definition.conditions!,
      entry: [{ ...condition, value: "10" }],
    },
  };
  const sourceVersion = { id: "old", definition, published: true } as any,
    targetVersion = { id: "new", definition: after, published: true } as any;
  const source = {
    id: "from",
    name: "before",
    revision: 1,
    generation: 1,
    status: "stopped",
    strategyId: "old",
    config: { ...runtime, rules: {}, engineVersion: ENGINE_VERSION },
    state: { positions: {}, pending: {} },
  } as any;
  const target = {
    ...source,
    id: "to",
    name: "after",
    strategyId: "new",
    status: "created",
  };
  const p = {
    id: "project",
    status: "completed",
    protocol: { config: runtime },
    report: { hash: "report", conclusion: "supported", synthetic: false },
  } as unknown as ResearchProject;
  const preview = makePromotionPreview(
    p,
    targetVersion,
    runtime,
    ENGINE_VERSION,
    source,
    sourceVersion,
    false,
    true,
    [source, target],
  );
  assert.equal(preview.comparisonVersion, 2);
  assert.ok(preview.changes.some((c) => c.field === "conditions"));
  const check = (saved: typeof preview) => {
    const { hash: _hash, accounts: _accounts, ...previewBody } = saved;
    saved.hash = hash(previewBody);
    const body = {
      id: source.id,
      version: 1,
      fromAccountId: source.id,
      toAccountId: target.id,
      projectId: p.id,
      reportHash: p.report!.hash,
      preview: saved,
      approvedBy: "user",
      approvedAt: new Date().toISOString(),
    };
    const approval = {
      id: target.id,
      projectId: p.id,
      configHash: saved.targetConfigHash,
      definitionHash: saved.targetDefinitionHash,
      previewHash: saved.hash,
      replacementAccountId: source.id,
    } as any;
    return verifyTransition(
      { ...body, hash: hash(body) },
      [source, target],
      [sourceVersion, targetVersion],
      [p],
      [approval],
    );
  };
  assert.equal(check(structuredClone(preview)).toAccountId, "to");
  const concealed = structuredClone(preview);
  concealed.changes = [];
  assert.throws(() => check(concealed), /引用不一致/);
  const legacy = structuredClone(preview);
  delete legacy.comparisonVersion;
  legacy.changes = [];
  assert.equal(check(legacy).toAccountId, "to");
  p.protocol.robustness = robustnessInput.parse({});
  const blocked = makePromotionPreview(
    p,
    targetVersion,
    runtime,
    ENGINE_VERSION,
    null,
    null,
    false,
    true,
    [],
  );
  assert.equal(blocked.canApprove, false);
  assert.ok(blocked.blockers.some((s) => s.includes("旧条件策略")));
  p.protocol.robustness = robustnessInput.parse({ parameterVersion: 2 });
  assert.equal(
    makePromotionPreview(
      p,
      targetVersion,
      runtime,
      ENGINE_VERSION,
      null,
      null,
      false,
      true,
      [],
    ).canApprove,
    true,
  );
});
