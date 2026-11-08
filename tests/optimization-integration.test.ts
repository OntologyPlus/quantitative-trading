import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Context } from "@deepseek-ai/cordis";
import Tools, { type ToolExecutionInput } from "@deepseek-ai/dsh-tools";
import Prompt from "@deepseek-ai/dsh-system-prompt";
import { createScope } from "@deepseek-ai/dsh-scope";
import type { Agent } from "@deepseek-ai/dsh-agent";
import QuantService from "../src/host/index.js";
import * as plugin from "../src/host/tools.js";
import { LabExecutor } from "../src/host/lab-executor.js";
import { backtest, ENGINE_VERSION } from "../src/engine/backtest.js";
import { synthetic } from "../src/adapters/market.js";
import type { RunRecord } from "../src/domain/contracts.js";

test("Harness tools expose current engine, idle counters, gaps and real P2 worker results without mutating runs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "quant-optimizations-")),
    root = new Context();
  const prompt = root.plugin(Prompt);
  await prompt;
  const tools = root.plugin(Tools);
  await tools;
  const service = root.plugin(QuantService, {
    dataDirectory: join(dir, "data"),
  });
  await service;
  const q = root.quant,
    r = q.research;
  const workerFile = join(dir, "lab.mjs");
  await build({
    entryPoints: [new URL("../src/workers/lab.ts", import.meta.url).pathname],
    outfile: workerFile,
    bundle: true,
    platform: "node",
    format: "esm",
    nodePaths: [join(process.cwd(), "node_modules")],
  });
  await q.lab.close();
  Object.defineProperty(q, "lab", {
    value: new LabExecutor(pathToFileURL(workerFile)),
  });
  const agent = {
    id: "a",
    session: { id: "optimization-session" },
    options: {},
    ctx: root,
  } as unknown as Agent;
  const scope = createScope(root, agent);
  Object.assign(agent, { ctx: scope.ctx });
  const fiber = scope.ctx.plugin(plugin);
  await fiber;
  let n = 0;
  const execute = (
    name: string,
    args: unknown = {},
    signal = new AbortController().signal,
  ) =>
    root.tools.execute({
      name,
      arguments: args,
      callId: `q${++n}` as ToolExecutionInput["callId"],
      agent,
      signal,
    });
  const call = async (name: string, args: unknown = {}) => {
    const result = await execute(name, args);
    assert.equal(result.isError, false, JSON.stringify(result));
    const text = result.content.find((v) => v.type === "text");
    assert.ok(text && text.type === "text");
    return JSON.parse(text.text).data;
  };
  try {
    const allBars = synthetic("BTCUSDT", "1h", 2400),
      holed = allBars.filter((_, i) => i !== 300);
    const ds = r.saveDataset(
      "gap fixture",
      "BTCUSDT",
      "1h",
      "synthetic",
      holed,
      true,
    );
    const makeRun = (template: "sma_cross" | "expr") => {
      const draft = r.draft(
        {
          submissionId: `draft-${template}`,
          expectedRevision: 0,
          name: template,
          definition: {
            template,
            symbols: ["BTCUSDT"],
            interval: "1h",
            fast: 5,
            slow: 20,
            ...(template === "expr"
              ? {
                  rules: {
                    version: 1,
                    entry:
                      "cross_above(ema(close,12), ema(close,26)) and adx(14)>25",
                    exit: "cross_below(ema(close,12), ema(close,26))",
                  },
                }
              : {}),
          },
        },
        "user",
      );
      const strategy = r.publish({
        submissionId: `publish-${template}`,
        id: draft.id,
        expectedRevision: draft.revision,
      });
      const run = r.submitRun({
        submissionId: `run-${template}`,
        strategyId: strategy.id,
        datasetIds: [ds.id],
        config: {},
      });
      const started = performance.now();
      run.result = backtest(strategy.definition, run.config, holed);
      run.computeMs = Math.round(performance.now() - started);
      run.status = "completed";
      run.progress = 100;
      r.store.put("run", run.id, run);
      return run;
    };
    const sma = makeRun("sma_cross"),
      expr = makeRun("expr");
    const status = await call("qt_status");
    assert.equal(status.engineVersion, ENGINE_VERSION);
    assert.equal(status.capabilities.analysis.projectIntegration, false);
    assert.equal(status.capabilities.perpetuals, false);
    const read = await call("qt_run_read", { id: sma.id });
    assert.equal(read.usesCurrentEngine, true);
    assert.deepEqual(read.result.state.idle, sma.result!.state.idle);
    assert.ok(read.result.state.idle.noSignal > 0);
    assert.equal(read.result.decisionLogging, "events-and-idle-counters");
    const inspect = await call("qt_dataset_inspect", { id: ds.id });
    assert.equal(inspect.quality.missingBars, 1);
    assert.equal(inspect.quality.longestGapMs, 3600000);
    assert.equal(inspect.quality.policy.maxMissingRatio, 0.01);

    const before = JSON.stringify(r.store.get("run", sma.id));
    const perf = await call("qt_lab_analyze", {
      action: "performance-report",
      input: { runId: expr.id, costMultipliers: [1] },
      limit: 3,
    });
    assert.ok(
      "cagrPct" in perf.result.summary &&
        "sortino" in perf.result.summary &&
        "calmar" in perf.result.summary,
    );
    assert.equal(perf.source.resultHash, expr.result!.hash);
    assert.equal(perf.source.datasets[0].synthetic, true);
    assert.equal(
      perf.result.costSensitivity.rows[0].resultHash,
      expr.result!.hash,
    );
    assert.equal(perf.result.equity.length, 3);
    assert.equal(perf.view.chartSampled, true);
    assert.match(perf.analysisHash, /^[a-f0-9]{64}$/);
    const grid = { fast: [5, 10], slow: [20, 40] };
    const sweep = await call("qt_lab_analyze", {
      action: "parameter-sweep",
      input: { runId: sma.id, grid, minClosedTrades: 0, top: 1 },
      limit: 2,
    });
    assert.ok(sweep.result.statistics.deflatedSharpe);
    assert.ok(sweep.result.statistics.overfitting);
    assert.equal(sweep.result.rows.length, 2);
    assert.equal(sweep.view.totalRows, 4);
    const next = await call("qt_lab_analyze", {
      action: "parameter-sweep",
      input: { runId: sma.id, grid, minClosedTrades: 0, top: 1 },
      offset: 2,
      limit: 2,
    });
    assert.equal(next.analysisHash, sweep.analysisHash);
    assert.equal(next.view.hasMore, false);
    assert.notDeepEqual(next.result.rows, sweep.result.rows);
    const wf = await call("qt_lab_analyze", {
      action: "walk-forward",
      input: {
        runId: sma.id,
        grid,
        trainBars: 1000,
        testBars: 500,
        minClosedTrades: 0,
      },
      limit: 3,
    });
    assert.ok(wf.result.folds.length >= 2);
    assert.ok(wf.result.outOfSample.curve.length <= 3);
    assert.equal(JSON.stringify(r.store.get("run", sma.id)), before);
    assert.equal(
      (
        await execute("qt_lab_analyze", {
          action: "parameter-sweep",
          input: { runId: expr.id, grid },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await execute("qt_lab_analyze", {
          action: "publish",
          input: { runId: sma.id },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await execute(
          "qt_lab_analyze",
          { action: "performance-report", input: { runId: expr.id } },
          AbortSignal.abort(),
        )
      ).isError,
      true,
    );
    const legacy = {
      ...sma,
      id: "legacy",
      config: { ...sma.config, engineVersion: "quant-engine-0.1.0+legacy" },
    };
    r.store.put("run", legacy.id, legacy);
    assert.equal(
      (await call("qt_run_read", { id: legacy.id })).usesCurrentEngine,
      false,
    );
    assert.equal(
      (
        await execute("qt_lab_analyze", {
          action: "performance-report",
          input: { runId: legacy.id },
        })
      ).isError,
      true,
    );
    r.store.put("run", "project-run", {
      ...sma,
      id: "project-run",
      projectId: "reserved",
    });
    assert.equal(
      (
        await execute("qt_lab_analyze", {
          action: "performance-report",
          input: { runId: "project-run" },
        })
      ).isError,
      true,
    );

    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      return Response.json({
        symbols: ["BTCUSDT", "ETHUSDT", "BNBUSDT"].map((symbol) => ({
          symbol,
          status: "TRADING",
          quoteAsset: "USDT",
          isSpotTradingAllowed: true,
          filters: [
            {
              filterType: "LOT_SIZE",
              stepSize: "0.001",
              minQty: "0.001",
              maxQty: "100000",
            },
            { filterType: "PRICE_FILTER", tickSize: "0.01" },
          ],
        })),
      });
    });
    const pool = await call("qt_symbols", { query: "", limit: 2 });
    assert.equal(pool.total, 3);
    assert.equal(pool.hasMore, true);
    const tail = await call("qt_symbols", { query: "", offset: 2, limit: 2 });
    assert.equal(tail.source, "cache");
    assert.equal(tail.symbols[0].symbol, "BNBUSDT");
    assert.equal(requests, 1);
    const project = q.projects.create(
      {
        submissionId: "p",
        name: "budget",
        objective: "guard",
        symbols: [ds.symbol],
        interval: ds.interval,
        from: ds.from,
        to: ds.to,
        datasetIds: [ds.id],
      },
      agent.session.id,
    );
    r.store.put("project", project.id, {
      ...project,
      authorization: { source: "test" },
      status: "running",
    });
    assert.equal(
      (
        await execute("qt_lab_analyze", {
          action: "performance-report",
          input: { runId: sma.id },
        })
      ).isError,
      true,
    );
  } finally {
    await fiber.dispose();
    await scope.dispose();
    await service.dispose();
    await tools.dispose();
    await prompt.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
