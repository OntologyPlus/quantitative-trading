import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Research } from "../src/host/research.js";
import {
  ProjectService,
  type AgentBridge,
} from "../src/agent/project-service.js";
import { Store } from "../src/host/store.js";
import { MonitorService } from "../src/host/monitor.js";
import { hash, synthetic } from "../src/adapters/market.js";
import { backtest } from "../src/engine/backtest.js";
import type { RunRecord, StrategyRecord } from "../src/domain/contracts.js";
import type { ModelDispatch, ResearchProject } from "../src/domain/project.js";
import { exportBackup, restoreBackup } from "../src/host/backup.js";
import { Decimal } from "decimal.js";
import {
  diagnosticPlan,
  robustnessInput,
  parameterNeighbors,
} from "../src/domain/robustness.js";
import { researchConclusion } from "../src/research/evaluation.js";

const flush = () => new Promise<void>((r) => setImmediate(r));
function fixture(real = false) {
  const r = new Research(mkdtempSync(join(tmpdir(), "quant-project-")));
  // Domain tests control task settlement. The built smoke runs real workers.
  r.closed = true;
  const service = new ProjectService(r),
    bars = synthetic("BTCUSDT", "1h", 1440);
  const ds = r.saveDataset(
    "受控研究测试数据",
    "BTCUSDT",
    "1h",
    "controlled-test-fixture",
    bars,
    !real,
  );
  const input = {
    submissionId: "project",
    name: "趋势研究",
    objective: "比较均线与突破并检查成本增加后的表现",
    symbols: [ds.symbol],
    interval: ds.interval,
    from: ds.from,
    to: ds.to,
    datasetIds: [ds.id],
    mode: "protocol",
    thresholds: {
      minClosedTrades: 1,
      maxDrawdownPct: "100",
      minExcessReturnPct: "-10000",
    },
  };
  const create = (extra: Record<string, unknown> = {}) =>
    service.create({ ...input, ...extra }, "source-session");
  const start = (p: ResearchProject) =>
    service.control({
      submissionId: `start-${p.id}`,
      id: p.id,
      expectedRevision: p.revision,
      action: "start",
    });
  const read = (id: string) => r.store.get<ResearchProject>("project", id);
  const settle = () => {
    for (const run of r.store.list<RunRecord>("run"))
      if (run.status === "queued") {
        const strategy = r.store.get<StrategyRecord>(
          "strategy",
          run.strategyId,
        );
        run.result = backtest(strategy.definition, run.config, r.bars(ds));
        run.status = "completed";
        run.progress = 100;
        run.computeMs = 10;
        r.store.put("run", run.id, run);
      }
  };
  const drive = async (
    id: string,
    stop: (p: ResearchProject) => boolean = (p) =>
      ["completed", "waiting_input"].includes(p.status),
  ) => {
    for (let i = 0; i < 120; i++) {
      await flush();
      const p = read(id);
      if (stop(p)) return p;
      settle();
    }
    throw Error(`研究未收敛：${JSON.stringify(read(id))}`);
  };
  const close = async () => {
    await service.close();
    await r.close();
    rmSync(r.directory, { recursive: true, force: true });
  };
  return { r, service, ds, input, create, start, read, settle, drive, close };
}
test("authorized research autonomously completes six experiments with frozen selection, evidence and explicit synthetic conclusion", async () => {
  const f = fixture();
  try {
    const p = f.create();
    assert.equal(f.create().id, p.id);
    assert.equal(p.status, "draft");
    await flush();
    assert.equal(f.r.store.count("run"), 0);
    f.start(p);
    const completed = await f.drive(p.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.experiments.length, 6);
    assert.equal(completed.budgetUsed.experiments, 6);
    assert.equal(completed.report!.facts.length, 48);
    assert.equal(completed.report!.conclusion, "inconclusive");
    assert.equal(completed.report!.synthetic, true);
    assert.match(completed.report!.markdown, /未使用模型规划/);
    assert.ok(completed.selectionHash);
    assert.ok(completed.holdoutRevealedAt);
    const events = f.r.store.events(p.id);
    assert.ok(
      events.findIndex((e) => e.type === "selection_frozen") <
        events.findIndex(
          (e) =>
            e.type === "experiment_submitted" &&
            (e.facts as { phase: string }).phase === "holdout",
        ),
    );
    const ref = completed.report!.facts[0]!;
    assert.equal(f.service.readEvidence(p.id, ref.id).value, ref.value);
    const run = f.r.store.get<RunRecord>("run", ref.runId);
    run.result!.metrics.returnPct = "999999";
    f.r.store.put("run", run.id, run);
    assert.throws(() => f.service.readEvidence(p.id, ref.id), /实验结果已改变/);
  } finally {
    await f.close();
  }
});
test("research versions cannot be edited, directly published, submitted through old tools or bound to accounts", async () => {
  const f = fixture();
  try {
    const p = f.create(),
      s = f.r.store.get<StrategyRecord>(
        "strategy",
        p.candidates[0]!.strategyId,
      );
    assert.equal(s.published, false);
    assert.equal(s.purpose, "research");
    assert.throws(
      () =>
        f.r.draft(
          {
            submissionId: "edit",
            id: s.id,
            expectedRevision: 1,
            name: "overwrite",
            definition: s.definition,
          },
          "ai",
        ),
      /不可修改/,
    );
    assert.throws(
      () =>
        f.r.publish({ submissionId: "publish", id: s.id, expectedRevision: 1 }),
      /不可直接发布/,
    );
    assert.throws(
      () =>
        f.r.submitRun({
          submissionId: "bypass",
          strategyId: s.id,
          datasetIds: [f.ds.id],
          config: {},
        }),
      /只能由对应委托/,
    );
    assert.throws(
      () =>
        f.r.accountCreate({
          submissionId: "account",
          name: "模拟",
          strategyId: s.id,
          config: {},
        }),
      /不能绑定模拟账户/,
    );
  } finally {
    await f.close();
  }
});
test("Agent actions enforce evidence, budget, same-market candidates, one selection and terminal dispatch idempotency", async () => {
  const f = fixture();
  const dispatches: ModelDispatch[] = [];
  const bridge: AgentBridge = {
    deliver: async (d) => {
      dispatches.push(d);
      f.service.markDelivered(d.id);
      if (d.stage === "planning")
        f.service.action(d.id, {
          action: "begin",
          reason: "目标符合协议模板能力",
        });
    },
    cancel: () => {},
    close: async () => {},
  };
  f.service.attachBridge(bridge);
  try {
    const p = f.create({
      mode: "agent",
      budget: { modelRequests: 4, experiments: 8 },
    });
    f.start(p);
    const waiting = await f.drive(p.id, (p) => p.status === "waiting_agent");
    assert.equal(waiting.stage, "selection");
    assert.equal(waiting.experiments.length, 4);
    assert.equal(waiting.holdoutRevealedAt, null);
    const d = dispatches.find((d) => d.stage === "selection")!,
      context = f.service.context(p.id),
      ref = context.evidence[0]!,
      c = context.candidates[0]!;
    f.service.reserveModelRequest(d.id, "request-1");
    f.service.reserveModelRequest(d.id, "request-1");
    f.service.reserveModelRequest(d.id, "request-2");
    assert.equal(f.read(p.id).budgetUsed.modelRequests, 2);
    assert.throws(
      () =>
        f.service.action(d.id, {
          action: "analyze",
          kind: "interpretation",
          text: `该指标为[[e:${ref.id}]]`,
          evidenceIds: [ref.id],
        }),
      /候选选择与规划阶段不能 analyze/,
    );
    assert.throws(
      () =>
        f.service.action(d.id, {
          action: "select",
          candidateId: c.id,
          reason: "测试",
          evidenceIds: ["invented"],
        }),
      /证据/,
    );
    assert.throws(
      () => f.service.action(d.id, { action: "finish" }),
      /必须完成/,
    );
    const definition = f.r.store.get<StrategyRecord>(
      "strategy",
      c.strategyId,
    ).definition;
    assert.throws(
      () =>
        f.service.action(d.id, {
          action: "propose",
          definition: { ...definition, symbols: ["ETHUSDT"] },
          reason: "变化",
          evidenceIds: [ref.id],
        }),
      /不能改变/,
    );
    const action = {
      action: "select",
      candidateId: c.id,
      reason: "基于开发与验证证据",
      evidenceIds: [ref.id],
    };
    f.service.action(d.id, action);
    const again = f.service.action(d.id, action);
    assert.equal(again.selectedCandidateId, c.id);
    assert.throws(
      () => f.service.action(d.id, { ...action, reason: "改选" }),
      /取消、暂停或过期/,
    );
    const reporting = await f.drive(
      p.id,
      (p) => p.stage === "report" && p.status === "waiting_agent",
    );
    assert.equal(reporting.status, "waiting_agent");
    const report = dispatches.find((x) => x.stage === "report")!;
    const reportCtx = f.service.context(p.id);
    const reportRef = reportCtx.evidence[0]!;
    assert.throws(
      () =>
        f.service.action(report.id, {
          action: "analyze",
          kind: "interpretation",
          text: "回测收益高达999999%",
          evidenceIds: [reportRef.id],
        }),
      /解释中的数字须使用/,
    );
    f.service.action(report.id, {
      action: "analyze",
      kind: "interpretation",
      text: `该指标为[[e:${reportRef.id}]]，其含义以对应实验为准。`,
      evidenceIds: [reportRef.id],
    });
    assert.ok(f.read(p.id).analyses[0]!.text.includes(String(reportRef.value)));
    f.service.action(report.id, { action: "finish" });
    const delivery = await f.drive(p.id);
    assert.equal(delivery.status, "completed");
    assert.equal(delivery.experiments.length, 6);
  } finally {
    await f.close();
  }
});
test("pause preserves completed calculations; cancel fences late results and stale revisions", async () => {
  const f = fixture();
  try {
    const p = f.create();
    f.start(p);
    const pending = await f.drive(p.id, (p) => p.experiments.length === 1);
    const paused = f.service.control({
      submissionId: "pause",
      id: p.id,
      expectedRevision: pending.revision,
      action: "pause",
    });
    f.settle();
    await flush();
    assert.equal(f.read(p.id).status, "paused");
    assert.equal(f.read(p.id).experiments.length, 1);
    assert.throws(
      () =>
        f.service.control({
          submissionId: "stale",
          id: p.id,
          expectedRevision: pending.revision,
          action: "resume",
        }),
      /已更新/,
    );
    f.service.control({
      submissionId: "resume",
      id: p.id,
      expectedRevision: paused.revision,
      action: "resume",
    });
    const next = await f.drive(p.id, (p) => p.experiments.length === 2);
    f.service.control({
      submissionId: "cancel",
      id: p.id,
      expectedRevision: next.revision,
      action: "cancel",
    });
    const late = f.r.store.get<RunRecord>("run", next.experiments[1]!.runId);
    late.status = "completed";
    f.r.store.put("run", late.id, late);
    for (let i = 0; i < 5; i++) await flush();
    assert.equal(f.read(p.id).status, "cancelled");
    assert.equal(f.read(p.id).experiments.length, 2);
    assert.equal(f.read(p.id).report, undefined);
  } finally {
    await f.close();
  }
});
test("restart pauses a project without replaying an experiment; authorized resume reconciles the persisted task", async () => {
  const f = fixture();
  let replacement: ProjectService | undefined;
  try {
    const p = f.create();
    f.start(p);
    const pending = await f.drive(p.id, (p) => p.experiments.length === 1);
    await f.service.close();
    replacement = new ProjectService(f.r);
    const paused = f.read(p.id);
    assert.equal(paused.status, "paused");
    assert.match(paused.reason, /重启/);
    replacement.control({
      submissionId: "resume-restart",
      id: p.id,
      expectedRevision: paused.revision,
      action: "resume",
    });
    await flush();
    assert.equal(
      f.read(p.id).experiments[0]!.runId,
      pending.experiments[0]!.runId,
    );
    assert.equal(f.r.store.count("run"), 1);
  } finally {
    await replacement?.close();
    await f.close();
  }
});
test("completed research backups restore protocol, reports and evidence; corrupt references are rejected before mutation", async () => {
  const f = fixture(),
    other = fixture();
  try {
    const p = f.create();
    f.start(p);
    const completed = await f.drive(p.id);
    // Restore must start with an empty directory, not a fixture dataset.
    const empty = new Research(
      mkdtempSync(join(tmpdir(), "quant-project-restore-")),
    );
    empty.closed = true;
    try {
      const backup = exportBackup(f.r),
        bad = structuredClone(backup);
      (bad.objects.project![0] as ResearchProject).candidates[0]!.strategyId =
        "missing";
      const { hash: oldHash, ...body } = bad;
      bad.hash = hash(body);
      assert.throws(
        () => restoreBackup(empty, { submissionId: "bad", backup: bad }),
        /候选引用无效/,
      );
      assert.equal(empty.store.count("project"), 0);
      const restored = restoreBackup(empty, {
        submissionId: "restore",
        backup,
      });
      assert.equal(restored.projects, 1);
      const project = empty.store.get<ResearchProject>("project", p.id);
      assert.equal(project.report!.hash, completed.report!.hash);
      assert.equal(project.activeDispatchId, null);
    } finally {
      await empty.close();
      rmSync(empty.directory, { recursive: true, force: true });
    }
  } finally {
    await f.close();
    await other.close();
  }
});
test("simulation promotion checks report gate and binds an immutable strategy plus exact user-confirmed configuration", async () => {
  const f = fixture(true);
  try {
    const p = f.create();
    f.start(p);
    const completed = await f.drive(p.id);
    assert.equal(completed.report!.conclusion, "supported");
    const account = f.service.approve({
      submissionId: "approve",
      id: p.id,
      expectedRevision: completed.revision,
      reportHash: completed.report!.hash,
      name: "观察",
      config: completed.protocol.config,
    });
    assert.equal(account.status, "created");
    assert.ok(account.approvalHash);
    const strategy = f.r.store.get<StrategyRecord>(
      "strategy",
      account.strategyId,
    );
    assert.equal(strategy.approvedBy, "user");
    assert.equal(strategy.published, true);
    assert.equal(strategy.createdBy, "user");
    assert.throws(
      () =>
        f.r.accountCreate({
          submissionId: "changed-cash",
          name: "变更",
          strategyId: strategy.id,
          config: { initialCash: "20000" },
        }),
      /配置与已确认/,
    );
  } finally {
    await f.close();
  }
});
test("schema 1 migration keeps a coherent backup and advances schema only under the writer lease", () => {
  const dir = mkdtempSync(join(tmpdir(), "quant-migration-")),
    path = join(dir, "quant.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO metadata VALUES ('schema','1')",
    );
    db.close();
    const s = new Store(path);
    assert.ok(existsSync(`${path}.schema1.bak`));
    assert.equal(
      (
        s.db.prepare("SELECT value FROM metadata WHERE key='schema'").get() as {
          value: string;
        }
      ).value,
      "2",
    );
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("reusing an already revealed final interval is tracked and cannot be promoted as fresh blind evidence", async () => {
  const f = fixture(true);
  try {
    const first = f.create();
    f.start(first);
    const a = await f.drive(first.id);
    assert.equal(a.report!.conclusion, "supported");
    const second = f.create({
      submissionId: "followup",
      name: "再次研究同一区间",
    });
    f.start(second);
    const b = await f.drive(second.id);
    assert.equal(b.status, "completed");
    assert.ok(b.priorExposures!.includes(first.id));
    assert.equal(b.report!.conclusion, "inconclusive");
    assert.ok(b.report!.limitations.some((s) => s.includes("此前已揭示")));
    assert.throws(
      () =>
        f.service.approve({
          submissionId: "promote-reused",
          id: b.id,
          expectedRevision: b.revision,
          reportHash: b.report!.hash,
          name: "不应推进",
          config: b.protocol.config,
        }),
      /未满足模拟观察门槛/,
    );
  } finally {
    await f.close();
  }
});
test("failed attempts consume experiment budget; resume never resets it to fit the remaining plan", async () => {
  const f = fixture();
  try {
    const p = f.create({ budget: { experiments: 6 } });
    f.start(p);
    const pending = await f.drive(p.id, (p) => p.experiments.length === 1);
    const run = f.r.store.get<RunRecord>("run", pending.experiments[0]!.runId);
    run.status = "failed";
    run.error = "受控计算故障";
    run.computeMs = 1;
    f.r.store.put("run", run.id, run);
    const failed = await f.drive(p.id);
    assert.equal(failed.status, "waiting_input");
    assert.equal(failed.budgetUsed.experiments, 1);
    f.service.control({
      submissionId: "continue-after-failure",
      id: p.id,
      expectedRevision: failed.revision,
      action: "resume",
    });
    const stopped = await f.drive(p.id);
    assert.equal(stopped.status, "waiting_input");
    assert.match(stopped.error, /实验预算已用尽/);
    assert.equal(stopped.budgetUsed.experiments, 6);
    assert.equal(stopped.report, undefined);
  } finally {
    await f.close();
  }
});
test("archiving a source session pauses every owned project and fences its pending work", async () => {
  const f = fixture();
  try {
    const p = f.create();
    f.start(p);
    await f.drive(p.id, (p) => p.experiments.length === 1);
    assert.equal(f.service.activeForSession("source-session").length, 1);
    f.service.pauseForSession("source-session");
    await flush();
    assert.equal(f.read(p.id).status, "paused");
    assert.equal(f.service.activeForSession("source-session").length, 0);
  } finally {
    await f.close();
  }
});
test("lost writer lease stops background scheduling and projects failure without writing over persisted state", async () => {
  const f = fixture(),
    monitor = new MonitorService(f.r);
  try {
    const p = f.create();
    f.start(p);
    await f.drive(p.id, (p) => p.experiments.length === 1);
    f.r.store.db.prepare("UPDATE lease SET expires=0 WHERE id=1").run();
    assert.equal(f.service.health().storage, "lease_lost");
    for (let i = 0; i < 5; i++) await flush();
    const view = f.service.read({ id: p.id }).project;
    assert.equal(view.status, "failed");
    assert.match(view.reason, /租约/);
    assert.equal(f.read(p.id).status, "waiting_job");
    assert.equal(f.r.store.count("run"), 1);
    assert.throws(
      () =>
        f.r.draft(
          {
            submissionId: "after-lease",
            expectedRevision: 0,
            name: "不允许写入",
            definition: {
              template: "sma_cross",
              symbols: ["BTCUSDT"],
              interval: "1h",
            },
          },
          "ai",
        ),
      /租约/,
    );
  } finally {
    monitor.close();
    await f.close();
  }
});

test("report reading preserves actual cost and data assumptions, exposes counterevidence early, and remains verifiable after export and restore", async () => {
  const f = fixture();
  const empty = new Research(
    mkdtempSync(join(tmpdir(), "quant-reading-restore-")),
  );
  empty.closed = true;
  try {
    const p = f.create({
      config: { costs: { feeBps: "7.5", slippageBps: "1.25" } },
    });
    f.start(p);
    const done = await f.drive(p.id),
      report = done.report!;
    assert.equal(done.status, "completed", done.error);
    assert.match(report.markdown, /7\.5 bps（0\.075%）/);
    assert.match(report.markdown, /1\.25 bps（0\.0125%）/);
    assert.match(report.markdown, /controlled-test-fixture/);
    assert.match(report.markdown, new RegExp(f.ds.hash));
    assert.ok(
      report.markdown.indexOf("## 限制（引用时务必保留）") <
        report.markdown.indexOf("## 全部实验"),
    );
    assert.match(report.markdown, /## 关键依据与反证/);
    assert.match(report.markdown, /## 下一步/);
    assert.match(report.markdown, /合成结果只用于检查流程/);
    assert.ok(report.limitations.some((s) => s.includes("0.075%")));
    assert.equal(f.service.read({ id: p.id }).datasets[0]!.hash, f.ds.hash);
    assert.equal(f.service.verifyReport(p.id).report!.hash, report.hash);
    restoreBackup(empty, {
      submissionId: "reading-restore",
      backup: exportBackup(f.r),
    });
    assert.equal(
      empty.store.get<ResearchProject>("project", p.id).report!.hash,
      report.hash,
    );
  } finally {
    await f.close();
    await empty.close();
    rmSync(empty.directory, { recursive: true, force: true });
  }
});

test("legacy report bodies retain their original identity rather than being regenerated with a new reading layout", async () => {
  const f = fixture();
  try {
    const p = f.create();
    f.start(p);
    const done = await f.drive(p.id),
      report = done.report!;
    const { hash: oldHash, ...body } = {
      ...report,
      markdown: "# 历史研究\n\n## 限制\n\n保留历史限制。\n",
    };
    done.report = { ...body, hash: hash(body) };
    f.r.store.put("project", done.id, done);
    const before = done.report.hash;
    assert.equal(f.service.verifyReport(p.id).report!.hash, before);
    assert.equal(
      f.service.read({ id: p.id }).project.report!.markdown,
      body.markdown,
    );
    const backup = exportBackup(f.r);
    assert.equal(
      (backup.objects.project![0] as ResearchProject).report!.hash,
      before,
    );
  } finally {
    await f.close();
  }
});

test("robust research executes budgeted scenarios, immutable parameter neighbors and chronological rolling windows before revealing holdout", async () => {
  const f = fixture();
  try {
    const p = f.create({ robustness: {}, budget: { experiments: 20 } });
    f.start(p);
    const done = await f.drive(p.id);
    assert.equal(done.status, "completed", done.error);
    assert.equal(done.budgetUsed.experiments, 20);
    assert.equal(
      done.experiments.filter((e) => e.phase === "cost_sensitivity").length,
      3,
    );
    assert.equal(
      done.experiments.filter((e) => e.phase === "parameter_sensitivity")
        .length,
      2,
    );
    assert.equal(
      done.experiments.filter((e) => e.phase === "walk_train").length,
      6,
    );
    const windows = done.experiments.filter((e) => e.phase === "walk_test");
    assert.equal(windows.length, 3);
    for (const window of windows) {
      assert.ok(window.to < done.ranges.holdout.from);
      const training = window.diagnostic!.trainingExperimentIds!.map(
        (id) => done.experiments.find((e) => e.id === id)!,
      );
      assert.equal(training.length, 2);
      assert.ok(
        training.every((e) => e.to < window.from && e.status === "completed"),
      );
      assert.ok(training.some((e) => e.candidateId === window.candidateId));
    }
    const events = f.r.store.events(p.id);
    const holdoutIndex = events.findIndex(
      (e) =>
        e.type === "experiment_submitted" &&
        (e.facts as any).phase === "holdout",
    );
    assert.ok(
      events.filter(
        (e, i) => i < holdoutIndex && e.type === "experiment_complete",
      ).length >= 18,
    );
    const selected = done.candidates.find(
      (c) => c.id === done.selectedCandidateId,
    )!;
    for (const neighbor of done.experiments.filter(
      (e) => e.phase === "parameter_sensitivity",
    )) {
      const run = f.r.store.get<RunRecord>("run", neighbor.runId);
      assert.notEqual(run.strategyId, selected.strategyId);
      assert.equal(run.strategyId, neighbor.diagnostic!.strategyId);
      assert.equal(
        f.r.store.get<StrategyRecord>("strategy", run.strategyId).published,
        false,
      );
    }
    const report = done.report!,
      data = report.diagnostics!.attribution.data;
    const pnl = new Decimal(
      f.r.store
        .get<RunRecord>("run", report.diagnostics!.attribution.runId)
        .result!.state.curve.at(-1)!.equity,
    ).minus(done.protocol.config.initialCash);
    const sum = (values: string[]) =>
      values.reduce((a, b) => a.plus(b), new Decimal(0));
    assert.ok(
      sum(data.months.map((m) => m.pnl))
        .minus(pnl)
        .abs()
        .lt("0.0000000000000000000000000001"),
    );
    assert.ok(
      sum(data.symbols.map((s) => s.pnl))
        .minus(pnl)
        .abs()
        .lt("0.0000000000000000000000000001"),
    );
    assert.match(report.markdown, /## 稳健性研究/);
    assert.match(report.markdown, /## 最终区间收益归因/);
    const ref = report.facts.find((f) =>
      f.path.startsWith("attribution.months."),
    )!;
    assert.ok(ref);
    assert.equal(f.service.readEvidence(p.id, ref.id).value, ref.value);
    assert.equal(f.service.verifyReport(p.id).report!.hash, report.hash);
    assert.equal(
      report.conclusion,
      "inconclusive",
      "synthetic results must stay inconclusive despite any diagnostic pass",
    );
    const gated = structuredClone(done);
    for (const e of gated.experiments)
      e.evaluation = { verdict: "pass", reasons: [] };
    assert.equal(researchConclusion(gated, false), "supported");
    for (const e of gated.experiments.filter(
      (e) => e.phase === "cost_sensitivity",
    ))
      e.evaluation = {
        verdict: "fail",
        reasons: [{ code: "DRAWDOWN_LIMIT", message: "超限" }],
      };
    assert.equal(researchConclusion(gated, false), "rejected");
    for (const e of gated.experiments.filter(
      (e) => e.phase === "cost_sensitivity",
    ))
      e.evaluation = { verdict: "pass", reasons: [] };
    for (const e of gated.experiments.filter((e) => e.phase === "walk_test"))
      e.evaluation = {
        verdict: "insufficient",
        reasons: [{ code: "SAMPLE_INSUFFICIENT", message: "样本不足" }],
      };
    assert.equal(researchConclusion(gated, false), "inconclusive");
    const original = f.r.store.get<StrategyRecord>(
      "strategy",
      selected.strategyId,
    ).definition;
    const before = diagnosticPlan(done, original)
      .filter((p) => p.phase === "walk_test")
      .map((p) => [p.candidateId, p.diagnostic.trainingExperimentIds]);
    const changed = structuredClone(done);
    changed.candidates.push({
      ...selected,
      id: "future-proposal",
      name: "看过后续数据才追加的候选",
    });
    for (const e of changed.experiments.filter(
      (e) =>
        e.phase === "holdout" ||
        e.phase === "walk_test" ||
        e.phase === "validation",
    ))
      e.metrics!.returnPct = "999999";
    assert.deepEqual(
      diagnosticPlan(changed, original)
        .filter((p) => p.phase === "walk_test")
        .map((p) => [p.candidateId, p.diagnostic.trainingExperimentIds]),
      before,
    );
    assert.ok(
      diagnosticPlan(changed, original)
        .filter((p) => p.phase === "walk_train")
        .every((p) => p.candidateId !== "future-proposal"),
    );
  } finally {
    await f.close();
  }
});

test("robust report backups recompute diagnostic evidence and reject altered windows, configurations or derived values before restore", async () => {
  const f = fixture();
  const empty = new Research(
    mkdtempSync(join(tmpdir(), "quant-robust-restore-")),
  );
  empty.closed = true;
  try {
    const p = f.create({ robustness: {}, budget: { experiments: 20 } });
    f.start(p);
    const done = await f.drive(p.id);
    assert.equal(done.status, "completed", done.error);
    const backup = exportBackup(f.r);
    const rehash = (b: typeof backup) => {
      const { hash: old, ...body } = b;
      b.hash = hash(body);
      return b;
    };
    const window = structuredClone(backup);
    const altered = window.objects.project![0] as ResearchProject;
    altered.experiments.find(
      (e) => e.phase === "walk_test",
    )!.diagnostic!.trainingExperimentIds = ["made-up-training"];
    assert.throws(
      () =>
        restoreBackup(empty, {
          submissionId: "bad-window",
          backup: rehash(window),
        }),
      /窗口|训练|协议/,
    );
    assert.equal(empty.store.count("project"), 0);
    const derived = structuredClone(backup),
      alteredReport = (derived.objects.project![0] as ResearchProject).report!;
    alteredReport.diagnostics!.attribution.data.months[0]!.pnl = "99999";
    const { hash: oldReport, ...reportBody } = alteredReport;
    alteredReport.hash = hash(reportBody);
    assert.throws(
      () =>
        restoreBackup(empty, {
          submissionId: "bad-derived",
          backup: rehash(derived),
        }),
      /稳健性结果与真实实验不一致/,
    );
    assert.equal(empty.store.count("project"), 0);
    const conclusion = structuredClone(backup),
      forged = (conclusion.objects.project![0] as ResearchProject).report!;
    forged.conclusion = "supported";
    const { hash: forgedHash, ...forgedBody } = forged;
    forged.hash = hash(forgedBody);
    assert.throws(
      () =>
        restoreBackup(empty, {
          submissionId: "bad-conclusion",
          backup: rehash(conclusion),
        }),
      /稳健性报告结论与冻结协议不一致/,
    );
    const restored = restoreBackup(empty, {
      submissionId: "robust-restore",
      backup,
    });
    assert.equal(restored.projects, 1);
    assert.equal(
      empty.store.get<ResearchProject>("project", p.id).report!.hash,
      done.report!.hash,
    );
  } finally {
    await f.close();
    await empty.close();
    rmSync(empty.directory, { recursive: true, force: true });
  }
});

test("robustness is explicit, has adequate reserved budget, and integer parameter boundaries do not create duplicate evidence", async () => {
  const f = fixture();
  try {
    assert.throws(() => f.create({ robustness: {} }), /至少需要 20 个实验/);
    assert.throws(
      () =>
        f.create({
          robustness: { costMultipliers: [2, 2] },
          budget: { experiments: 24 },
        }),
      /不能重复/,
    );
    const p = f.create();
    assert.equal(p.protocol.robustness, undefined);
    const original = f.r.store.get<StrategyRecord>(
      "strategy",
      p.candidates[1]!.strategyId,
    ).definition;
    const neighbors = parameterNeighbors({ ...original, entryPeriod: 2 }, 10);
    assert.equal(neighbors.length, 1);
    assert.equal(neighbors[0]!.entryPeriod, 3);
    assert.equal(robustnessInput.parse({}).walkForwardFolds, 3);
  } finally {
    await f.close();
  }
});

test("diagnostic failure consumes budget and cancellation fences a pending rolling experiment", async () => {
  const f = fixture();
  try {
    const p = f.create({ robustness: {}, budget: { experiments: 24 } });
    f.start(p);
    const pending = await f.drive(p.id, (p) =>
      p.experiments.some((e) => e.phase === "cost_sensitivity"),
    );
    const run = f.r.store.get<RunRecord>(
      "run",
      pending.experiments.at(-1)!.runId,
    );
    run.status = "failed";
    run.error = "受控诊断故障";
    run.computeMs = 1;
    f.r.store.put("run", run.id, run);
    const stopped = await f.drive(p.id);
    assert.equal(stopped.status, "waiting_input");
    f.service.control({
      submissionId: "retry-robust",
      id: p.id,
      expectedRevision: stopped.revision,
      action: "resume",
    });
    const rolling = await f.drive(p.id, (p) =>
      p.experiments.some((e) => e.phase === "walk_train"),
    );
    assert.equal(
      rolling.experiments.filter((e) => e.diagnostic?.key === "cost:1.5")
        .length,
      2,
    );
    assert.equal(rolling.budgetUsed.experiments, rolling.experiments.length);
    f.service.control({
      submissionId: "cancel-robust",
      id: p.id,
      expectedRevision: rolling.revision,
      action: "cancel",
    });
    f.settle();
    await flush();
    assert.equal(f.read(p.id).status, "cancelled");
    assert.equal(f.read(p.id).holdoutRevealedAt, null);
  } finally {
    await f.close();
  }
});
