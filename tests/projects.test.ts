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
      budget: { modelRequests: 2, experiments: 8 },
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
      () => f.service.reserveModelRequest(d.id, "request-3"),
      /达到委托上限/,
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
    assert.throws(
      () =>
        f.service.action(d.id, {
          action: "analyze",
          kind: "interpretation",
          text: "回测收益高达999999%",
          evidenceIds: [ref.id],
        }),
      /解释中的数字须使用/,
    );
    f.service.action(d.id, {
      action: "analyze",
      kind: "interpretation",
      text: `该指标为[[e:${ref.id}]]，其含义以对应实验为准。`,
      evidenceIds: [ref.id],
    });
    assert.ok(f.read(p.id).analyses[0]!.text.includes(String(ref.value)));
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
    const delivery = await f.drive(p.id);
    assert.equal(delivery.status, "waiting_input");
    assert.match(delivery.reason, /模型请求预算/);
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
