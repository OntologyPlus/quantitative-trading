import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Research } from "../src/host/research.js";
import { ProjectService } from "../src/agent/project-service.js";
import { MonitorService } from "../src/host/monitor.js";
import QuantService from "../src/host/index.js";
import { Paper } from "../src/host/paper.js";
import { synthetic, hash } from "../src/adapters/market.js";
import { backtest } from "../src/engine/backtest.js";
import { execute, intent, mark } from "../src/engine/core.js";
import {
  observationEvent,
  observationMarket,
} from "../src/host/observation.js";
import {
  observationHealth,
  simulationDiagnosis,
} from "../src/domain/simulation-analysis.js";
import { captureSimulation } from "../src/host/simulation-review.js";
import { exportBackup, restoreBackup } from "../src/host/backup.js";
import type {
  Account,
  RunRecord,
  StrategyRecord,
} from "../src/domain/contracts.js";
import type { ResearchProject } from "../src/domain/project.js";
import type {
  ObservationRecord,
  SimulationCheckpoint,
  SimulationReview,
  SimulationTransition,
} from "../src/domain/simulation.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const tradeBar = (time: number) => ({
  symbol: "BTCUSDT",
  time,
  open: "100",
  high: "110",
  low: "100",
  close: "110",
  volume: "1000000",
});
function fixture() {
  const r = new Research(mkdtempSync(join(tmpdir(), "quant-cycle-")));
  r.closed = true;
  const projects = new ProjectService(r),
    monitor = new MonitorService(r),
    paper = new Paper(r);
  const ds = r.saveDataset(
    "controlled lifecycle test",
    "BTCUSDT",
    "1h",
    "controlled-test-fixture",
    synthetic("BTCUSDT", "1h", 1440),
    false,
  );
  const create = () =>
    projects.create(
      {
        submissionId: "study",
        name: "观察关联研究",
        objective: "核对趋势策略与成本",
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
      },
      "cycle-session",
    );
  const drive = async (id: string) => {
    for (let i = 0; i < 120; i++) {
      await flush();
      const p = r.store.get<ResearchProject>("project", id);
      if (["completed", "waiting_input"].includes(p.status)) return p;
      for (const run of r.store.list<RunRecord>("run"))
        if (run.status === "queued") {
          run.result = backtest(
            r.store.get<StrategyRecord>("strategy", run.strategyId).definition,
            run.config,
            r.bars(ds),
          );
          run.status = "completed";
          run.computeMs = 1;
          run.progress = 100;
          r.store.put("run", run.id, run);
        }
    }
    throw Error("controlled study did not finish");
  };
  const study = async () => {
    const p = create();
    projects.control({
      submissionId: "start-study",
      id: p.id,
      expectedRevision: p.revision,
      action: "start",
    });
    const done = await drive(p.id);
    assert.equal(done.status, "completed", done.error);
    assert.equal(done.report!.conclusion, "supported");
    return done;
  };
  const approve = (id: string, extra: Record<string, unknown> = {}) => {
    const p = r.store.get<ResearchProject>("project", id);
    return projects.approve({
      submissionId: "approve-base",
      id: p.id,
      expectedRevision: p.revision,
      reportHash: p.report!.hash,
      config: p.protocol.config,
      name: "来源模拟账户",
      ...extra,
    });
  };
  const close = async () => {
    monitor.close();
    paper.close();
    await projects.close();
    await r.close();
    rmSync(r.directory, { recursive: true, force: true });
  };
  return { r, projects, monitor, paper, ds, study, approve, drive, close };
}

test("frozen simulation review survives account changes, exposes verifiable baseline facts, and produces an idempotent linked draft without starting it", async () => {
  const f = fixture();
  try {
    const p = await f.study(),
      a = f.approve(p.id);
    observationEvent(f.r.store, a, "start", "controlled start");
    observationEvent(f.r.store, a, "connected", "controlled connection");
    observationMarket(f.r.store, a.id, "bar", Date.now(), Date.now());
    const review = f.monitor.review({ submissionId: "review", id: a.id });
    assert.equal(
      f.monitor.review({ submissionId: "review", id: a.id }).id,
      review.id,
    );
    assert.equal(review.version, 2);
    assert.equal(review.diagnosis!.reference!.projectId, p.id);
    assert.ok(
      review.diagnosis!.findings.some((f) => f.code === "SAMPLE_INSUFFICIENT"),
    );
    assert.equal(
      (f.monitor.read({ id: review.id, path: "metrics.closedTrades" }) as any)
        .value,
      0,
    );
    const current = f.r.store.get<Account>("account", a.id),
      now = Date.now();
    current.state.prices.BTCUSDT = "100";
    current.config.rules.BTCUSDT = f.ds.rules;
    execute(
      current.state,
      current.config,
      intent(current.state, tradeBar(now), "BUY", "test", now),
      "100",
      "1000000",
      now,
    );
    execute(
      current.state,
      current.config,
      intent(current.state, tradeBar(now + 1), "SELL", "test", now + 1),
      "110",
      "1000000",
      now + 1,
    );
    assert.equal(
      current.state.fills.filter((f) => f.side === "SELL").length,
      1,
    );
    mark(current.state, current.config, now + 1);
    f.r.store.transaction(() => {
      f.r.store.saveState(a.id, current.state);
      f.r.store.put("account", a.id, current);
    });
    assert.equal(
      (f.monitor.read({ id: review.id, path: "metrics.closedTrades" }) as any)
        .value,
      0,
      "old review must not drift with the account",
    );
    const q = {
      research: f.r,
      projects: f.projects,
      monitor: f.monitor,
    } as unknown as QuantService;
    const input = {
      submissionId: "followup",
      id: review.id,
      reviewHash: review.hash!,
      questionCode: review.diagnosis!.researchQuestions[0]!.code,
    };
    const draft = (await QuantService.prototype.user.call(
      q,
      "monitor-followup",
      input,
      "followup-session",
    )) as ResearchProject;
    assert.equal(draft.status, "draft");
    assert.equal(draft.sourceSessionId, "followup-session");
    assert.equal(draft.protocol.parentProjectId, p.id);
    assert.deepEqual(draft.protocol.simulationSource, {
      accountId: a.id,
      reviewId: review.id,
      reviewHash: review.hash,
    });
    assert.equal(draft.experiments.length, 0);
    assert.equal(draft.authorization, undefined);
    assert.equal(
      (
        (await QuantService.prototype.user.call(
          q,
          "monitor-followup",
          input,
          "followup-session",
        )) as ResearchProject
      ).id,
      draft.id,
    );
    assert.equal(f.r.store.count("run"), 6);
    assert.equal(f.r.store.get<Account>("account", a.id).status, "created");
    assert.throws(
      () =>
        f.projects.create(
          {
            ...f.monitor.followupInput({
              reviewId: review.id,
              reviewHash: review.hash!,
              questionCode: "INVESTIGATE",
            }),
            submissionId: "wrong-source",
            simulationSource: {
              accountId: "wrong",
              reviewId: review.id,
              reviewHash: review.hash,
            },
          },
          "session",
        ),
      /来源不一致/,
    );
    const raw = f.r.store.db
      .prepare(
        "SELECT body FROM objects WHERE kind='simulationCheckpoint' AND id=?",
      )
      .get(review.checkpointId!) as { body: string };
    const artifact = JSON.parse(raw.body).resultArtifact;
    assert.match(artifact, /^[a-f0-9]{64}$/);
    writeFileSync(
      join(f.r.directory, "results", `${artifact}.json`),
      "{corrupt}",
    );
    assert.throws(
      () => f.monitor.read({ id: review.id, path: "metrics.returnPct" }),
      /产物完整性校验失败/,
    );
  } finally {
    await f.close();
  }
});

test("descriptive frequency alerts require adequate samples, matching basis and complete observation, without declaring strategy failure", async () => {
  const f = fixture();
  try {
    const p = await f.study(),
      a = f.approve(p.id),
      c = captureSimulation(f.r, a),
      now = Date.parse(c.at);
    // Synthetic inputs exercise review policy boundaries, not elapsed live observation.
    c.account.status = "running";
    c.metrics.closedTrades = 100;
    c.observation = {
      id: a.id,
      trackedFrom: now - 10 * 86400000,
      historyComplete: true,
      firstMarketAt: now - 10 * 86400000,
      lastMarketAt: now,
      lastTransportAt: now,
      lastBarCloseAt: now,
      transport: "connected",
      gapCount: 0,
      gapOpenAt: null,
      gapMs: 0,
    };
    let diagnosis = simulationDiagnosis(c);
    assert.ok(diagnosis.findings.some((f) => f.code === "FREQUENCY_SHIFT"));
    assert.match(diagnosis.basisWarnings.join(""), /不能据此判定策略失效/);
    c.observation.gapCount = 1;
    diagnosis = simulationDiagnosis(c);
    assert.equal(
      diagnosis.findings.some((f) => f.code === "FREQUENCY_SHIFT"),
      false,
    );
    assert.ok(diagnosis.findings.some((f) => f.code === "OBSERVATION_GAP"));
    c.observation.gapCount = 0;
    c.metrics.closedTrades = 1;
    diagnosis = simulationDiagnosis(c);
    assert.ok(diagnosis.findings.some((f) => f.code === "SAMPLE_INSUFFICIENT"));
    assert.equal(
      diagnosis.findings.some((f) => f.code === "FREQUENCY_SHIFT"),
      false,
    );
    c.metrics.closedTrades = 100;
    c.account.config.costs.feeBps = "8";
    assert.equal(
      simulationDiagnosis(c).findings.some((f) => f.code === "FREQUENCY_SHIFT"),
      false,
      "different costs are not the same comparison basis",
    );
  } finally {
    await f.close();
  }
});

test("health records gaps persistently and cannot mistake a new bookkeeping timestamp for fresh market data", async () => {
  const f = fixture();
  try {
    const p = await f.study(),
      a = f.approve(p.id),
      definition = f.r.store.get<StrategyRecord>(
        "strategy",
        a.strategyId,
      ).definition;
    a.status = "running";
    a.lastEventAt = Date.now();
    assert.equal(observationHealth(a, definition, null).state, "unknown");
    const now = Date.now();
    observationEvent(f.r.store, a, "start", "start", now - 10000);
    observationEvent(f.r.store, a, "connected", "connected", now - 9000);
    let record = f.r.store.get<ObservationRecord>("observation", a.id);
    assert.equal(
      observationHealth(a, definition, record, now).state,
      "waiting",
    );
    observationMarket(f.r.store, a.id, "bar", now - 8000, now - 8000);
    observationEvent(f.r.store, a, "disconnected", "network", now - 7000);
    observationEvent(f.r.store, a, "connected", "recovered", now - 1000);
    record = f.r.store.get<ObservationRecord>("observation", a.id);
    assert.equal(record.gapCount, 1);
    assert.equal(record.gapMs, 6000);
    assert.equal(
      observationHealth(a, definition, record, now).state,
      "current",
    );
    a.lastEventAt = now + 180000;
    assert.equal(
      observationHealth(a, definition, record, now + 180000).state,
      "stale",
    );
    record = {
      ...record,
      sessionStartedAt: now + 200000,
      lastTransportAt: now + 200001,
      transport: "connected",
    };
    assert.equal(
      observationHealth(a, definition, record, now + 200002).state,
      "waiting",
    );
    record.lastTransportAt = now + 4000000;
    assert.equal(
      observationHealth(a, definition, record, now + 4000000).state,
      "stale",
      "transport heartbeats cannot hide missing closed data forever",
    );
    a.status = "paused";
    a.error = "";
    a.lastEventAt = now;
    f.r.store.put("account", a.id, a);
    const review = f.monitor.review({ submissionId: "after-gap", id: a.id });
    assert.equal(review.observationGap, true);
    assert.equal(review.diagnosis!.health.gapCount, 1);
    assert.ok(
      review.diagnosis!.findings.some((f) => f.code === "OBSERVATION_GAP"),
    );
  } finally {
    await f.close();
  }
});

test("promotion preview binds exact source state, preserves accounts, records approved differences and prevents resuming a replaced account", async () => {
  const f = fixture();
  try {
    const p = await f.study();
    const old = f.r.draft(
      {
        submissionId: "old",
        expectedRevision: 0,
        name: "旧均线配置",
        definition: {
          template: "sma_cross",
          symbols: ["BTCUSDT"],
          interval: "1h",
          fast: 5,
          slow: 30,
        },
      },
      "user",
    );
    f.r.publish({
      submissionId: "old-publish",
      id: old.id,
      expectedRevision: old.revision,
    });
    const source = f.r.accountCreate({
      submissionId: "old-account",
      name: "待替换旧账户",
      strategyId: old.id,
      config: { initialCash: "12000", costs: { feeBps: "7.5" } },
    });
    const preview = f.projects.promotionPreview({
      id: p.id,
      config: p.protocol.config,
      replacementAccountId: source.id,
    });
    assert.equal(preview.canApprove, true);
    assert.ok(preview.changes.some((c) => c.field === "initialCash"));
    assert.ok(preview.changes.some((c) => c.field === "costs.feeBps"));
    await f.paper.control({
      submissionId: "source-pause",
      id: source.id,
      expectedRevision: source.revision,
      action: "pause",
    });
    assert.throws(
      () =>
        f.approve(p.id, {
          submissionId: "stale-approval",
          replacementAccountId: source.id,
          previewHash: preview.hash,
        }),
      /重新核对变更预览/,
    );
    const fresh = f.projects.promotionPreview({
      id: p.id,
      config: p.protocol.config,
      replacementAccountId: source.id,
    });
    const next = f.approve(p.id, {
      submissionId: "replacement",
      replacementAccountId: source.id,
      previewHash: fresh.hash,
    });
    assert.equal(next.status, "created");
    assert.notEqual(next.id, source.id);
    assert.equal(
      f.r.store.get<Account>("account", source.id).status,
      "stopped",
    );
    assert.equal(
      f.r.store.get<Account>("account", source.id).state.cash,
      "12000",
    );
    assert.equal(next.initialCash, "10000");
    const transition = f.r.store.get<SimulationTransition>(
      "simulationTransition",
      source.id,
    );
    assert.equal(transition.toAccountId, next.id);
    assert.equal(transition.approvedBy, "user");
    assert.equal(transition.preview.hash, fresh.hash);
    await assert.rejects(
      () =>
        f.paper.control({
          submissionId: "resume-retired",
          id: source.id,
          expectedRevision: f.r.store.get<Account>("account", source.id)
            .revision,
          action: "resume",
        }),
      /新版本接替/,
    );
    assert.equal(
      f.approve(p.id, {
        submissionId: "replacement",
        expectedRevision: p.revision,
        replacementAccountId: source.id,
        previewHash: fresh.hash,
      }).id,
      next.id,
      "successful retry returns the original account",
    );
  } finally {
    await f.close();
  }
});

test("running sources, existing holdings and unresearched risk configurations cannot pass promotion", async () => {
  const f = fixture();
  try {
    const p = await f.study(),
      source = f.approve(p.id);
    let a = f.r.store.get<Account>("account", source.id);
    a.status = "running";
    f.r.store.put("account", a.id, a);
    let preview = f.projects.promotionPreview({
      id: p.id,
      config: p.protocol.config,
      replacementAccountId: a.id,
    });
    assert.equal(preview.canApprove, false);
    assert.match(preview.blockers.join(""), /先暂停或停止/);
    a.status = "paused";
    const now = Date.now();
    a.state.prices.BTCUSDT = "100";
    a.config.rules.BTCUSDT = f.ds.rules;
    execute(
      a.state,
      a.config,
      intent(a.state, tradeBar(now), "BUY", "test", now),
      "100",
      "1000000",
      now,
    );
    assert.ok(a.state.positions.BTCUSDT);
    f.r.store.transaction(() => {
      f.r.store.saveState(a.id, a.state);
      f.r.store.put("account", a.id, a);
    });
    preview = f.projects.promotionPreview({
      id: p.id,
      config: p.protocol.config,
      replacementAccountId: a.id,
    });
    assert.equal(preview.canApprove, false);
    assert.match(preview.blockers.join(""), /仍有持仓/);
    const current = f.r.store.get<ResearchProject>("project", p.id);
    assert.throws(
      () =>
        f.approve(p.id, {
          submissionId: "blocked-holdings",
          replacementAccountId: a.id,
          previewHash: preview.hash,
        }),
      /仍有持仓/,
    );
    assert.throws(
      () =>
        f.approve(p.id, {
          submissionId: "changed-risk",
          config: {
            ...current.protocol.config,
            risk: { ...current.protocol.config.risk, maxExposurePct: "99" },
          },
        }),
      /与已验证研究配置不同/,
    );
  } finally {
    await f.close();
  }
});

test("full backup restores checkpoint artifacts, linked drafts and transitions, and rejects derived review tampering before mutation", async () => {
  const f = fixture(),
    empty = new Research(mkdtempSync(join(tmpdir(), "quant-cycle-restore-")));
  empty.closed = true;
  try {
    const p = await f.study(),
      source = f.approve(p.id);
    const review = f.monitor.review({
      submissionId: "snapshot",
      id: source.id,
    });
    const draft = f.projects.create(
      {
        submissionId: "linked",
        ...f.monitor.followupInput({
          reviewId: review.id,
          reviewHash: review.hash!,
          questionCode: "INVESTIGATE",
        }),
      },
      "linked-session",
    );
    const preview = f.projects.promotionPreview({
      id: p.id,
      config: p.protocol.config,
      replacementAccountId: source.id,
    });
    f.approve(p.id, {
      submissionId: "replace",
      replacementAccountId: source.id,
      previewHash: preview.hash,
    });
    const backup = exportBackup(f.r),
      bad = structuredClone(backup),
      badReview = bad.objects.simulationReview![0] as SimulationReview;
    badReview.diagnosis!.frequencyRatio = "999";
    const { hash: oldReviewHash, ...reviewBody } = badReview;
    badReview.hash = hash(reviewBody);
    const { hash: oldHash, ...body } = bad;
    bad.hash = hash(body);
    assert.throws(
      () => restoreBackup(empty, { submissionId: "bad", backup: bad }),
      /模拟复盘的数值、解释或来源/,
    );
    assert.equal(empty.store.count("account"), 0);
    restoreBackup(empty, { submissionId: "restore", backup });
    const restored = new MonitorService(empty);
    try {
      assert.equal(
        (restored.read({ id: review.id, path: "metrics.returnPct" }) as any)
          .value,
        review.metrics.returnPct,
      );
    } finally {
      restored.close();
    }
    assert.equal(
      empty.store.get<ResearchProject>("project", draft.id).protocol
        .simulationSource!.reviewHash,
      review.hash,
    );
    assert.equal(
      empty.store.get<SimulationCheckpoint>(
        "simulationCheckpoint",
        review.checkpointId!,
      ).hash,
      review.checkpointHash,
    );
    assert.equal(
      empty.store.get<Account>("account", source.id).status,
      "stopped",
    );
    assert.equal(
      empty.store.get<SimulationTransition>("simulationTransition", source.id)
        .preview.hash,
      preview.hash,
    );
  } finally {
    await f.close();
    await empty.close();
    rmSync(empty.directory, { recursive: true, force: true });
  }
});
