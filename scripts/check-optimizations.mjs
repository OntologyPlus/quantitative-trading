import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Tools from "@deepseek-ai/dsh-tools";
import Prompt from "@deepseek-ai/dsh-system-prompt";
import { createScope } from "@deepseek-ai/dsh-scope";
import QuantService from "../dist/host/index.js";
import * as plugin from "../dist/host/tools.js";
import { needsBuild } from "./freshness.mjs";

assert.equal(
  needsBuild(process.cwd()),
  false,
  "先运行 npm run build，再验证当前构建",
);
const directory = mkdtempSync(join(tmpdir(), "quant-acceptance-")),
  root = new Context();
const fibers = [];
let scope;
try {
  for (const p of [Prompt, Tools]) {
    const f = root.plugin(p);
    await f;
    fibers.push(f);
  }
  const service = root.plugin(QuantService, { dataDirectory: directory });
  await service;
  fibers.push(service);
  const q = root.quant,
    r = q.research;
  const agent = {
    id: "verification",
    session: { id: "verification" },
    options: {},
    ctx: root,
  };
  scope = createScope(root, agent);
  agent.ctx = scope.ctx;
  const tools = scope.ctx.plugin(plugin);
  await tools;
  fibers.push(tools);
  let n = 0;
  async function call(name, args = {}) {
    const output = await root.tools.execute({
      name,
      arguments: args,
      callId: `verify-${++n}`,
      agent,
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(output.isError, false, JSON.stringify(output));
    return JSON.parse(output.content.find((c) => c.type === "text").text).data;
  }
  const bars = Array.from({ length: 4800 }, (_, i) => {
    const open = 20000 + Math.sin((i - 1) / 16) * 2500 + (i - 1) * 4,
      close = 20000 + Math.sin(i / 16) * 2500 + i * 4;
    return {
      symbol: "BTCUSDT",
      time: Date.UTC(2025, 0, 1) + i * 3600000,
      open: open.toFixed(8),
      high: (Math.max(open, close) * 1.003).toFixed(8),
      low: (Math.min(open, close) * 0.997).toFixed(8),
      close: close.toFixed(8),
      volume: "10000",
    };
  }).filter((_, i) => i !== 300);
  const dataset = r.saveDataset(
    "优化验收合成样本",
    "BTCUSDT",
    "1h",
    "synthetic-verification",
    bars,
    true,
  );
  const runs = {};
  for (const template of ["sma_cross", "expr"]) {
    const draft = await call("qt_strategy_draft", {
      input: {
        submissionId: `draft-${template}`,
        expectedRevision: 0,
        name: `验收-${template}`,
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
                    "cross_above(ema(close,12),ema(close,26)) and adx(14)>25",
                  exit: "cross_below(ema(close,12),ema(close,26))",
                },
              }
            : {}),
        },
      },
    });
    // Publish only this isolated fixture through the user's API; the Agent tool cannot publish.
    r.publish({
      submissionId: `publish-${template}`,
      id: draft.id,
      expectedRevision: draft.revision,
    });
    const queued = await call("qt_backtest_submit", {
      input: {
        submissionId: `run-${template}`,
        strategyId: draft.id,
        datasetIds: [dataset.id],
        config: {},
      },
    });
    const deadline = Date.now() + 30000;
    let completed;
    do {
      completed = await call("qt_run_read", { id: queued.id, limit: 1 });
      if (["completed", "failed", "cancelled"].includes(completed.status))
        break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    } while (Date.now() < deadline);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.usesCurrentEngine, true);
    assert.ok(completed.result.state.idle.noSignal > 0);
    const { id, createdAt, computeMs, config, manifestHash, result } =
      completed;
    runs[template] = {
      id,
      createdAt,
      computeMs,
      engineVersion: config.engineVersion,
      manifestHash,
      resultHash: result.hash,
      metrics: result.metrics,
      totalDecisions: result.totalDecisions,
      idle: result.state.idle,
    };
  }
  const grid = {
    fast: [3, 5, 7, 10, 12, 15, 18, 20],
    slow: [30, 40, 50, 60, 80, 100, 120, 150],
  };
  const performance = await call("qt_lab_analyze", {
    action: "performance-report",
    input: { runId: runs.expr.id, costMultipliers: [1] },
    limit: 5,
  });
  const sweep = await call("qt_lab_analyze", {
    action: "parameter-sweep",
    input: { runId: runs.sma_cross.id, grid, minClosedTrades: 0, top: 1 },
    limit: 5,
  });
  const forward = await call("qt_lab_analyze", {
    action: "walk-forward",
    input: {
      runId: runs.sma_cross.id,
      grid,
      trainBars: 1200,
      testBars: 800,
      minClosedTrades: 0,
    },
    limit: 5,
  });
  assert.ok("cagrPct" in performance.result.summary);
  assert.equal(
    performance.result.costSensitivity.rows[0].resultHash,
    runs.expr.resultHash,
  );
  assert.ok(sweep.result.statistics.deflatedSharpe);
  assert.ok(sweep.result.statistics.overfitting);
  assert.ok(forward.result.folds.length >= 3);
  const quality = await call("qt_dataset_inspect", {
    id: dataset.id,
    limit: 1,
  });
  assert.equal(quality.quality.missingBars, 1);
  const status = await call("qt_status");
  const report = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    node: process.version,
    engineVersion: status.engineVersion,
    capabilities: status.capabilities,
    synthetic: true,
    temporaryDatabaseRetained: false,
    dataset: quality,
    runs,
    analyses: { performance, sweep, forward },
    limitations: [
      "使用隔离目录与合成数据验证当前构建的真实 Harness 工具及后台 worker；不是市场收益证据。",
      "未联网验证目录与归档下载速度；未验收 1000组×20币种。",
      "普通委托仍固定60/20/20，实验室统计不改变委托门槛。",
    ],
  };
  mkdirSync(".runtime", { recursive: true });
  writeFileSync(
    ".runtime/optimization-verification.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    `PASS: current engine, two worker backtests, expr performance, ${sweep.result.combinations} parameter combinations with DSR/PBO, ${forward.result.folds.length} walk-forward folds and gap inspection`,
  );
  console.log("Evidence: .runtime/optimization-verification.json");
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose();
  await scope?.dispose();
  rmSync(directory, { recursive: true, force: true });
}
