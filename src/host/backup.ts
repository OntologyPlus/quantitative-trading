import { z } from "zod";
import { hash, validateBars } from "../adapters/market.js";
import type {
  Account,
  Dataset,
  RunRecord,
  StrategyRecord,
} from "../domain/contracts.js";
import { assertLedger, metrics } from "../engine/core.js";
import {
  configInput,
  fail,
  id,
  interval,
  rulesSchema,
  stateSchema,
  strategySchema,
} from "../domain/schemas.js";
import { ENGINE_VERSION } from "../engine/backtest.js";
import { Research } from "./research.js";
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ResearchProject } from "../domain/project.js";
import { validateProjects, validateDispatches } from "../research/backup.js";
import type { MonitorRecord, Notice, SimulationReview } from "./monitor.js";
const MAX = 64 * 1024 * 1024;
export function exportBackup(r: Research) {
  if (
    r.store.list<Account>("account").some((a) => a.status === "running") ||
    r.worker ||
    r.store
      .list<ResearchProject>("project")
      .some((p) =>
        ["ready", "running", "waiting_job", "waiting_agent"].includes(p.status),
      )
  )
    fail("STOP_FIRST", "请先暂停模拟盘并等待回测结束再备份");
  const kinds = [
    "dataset",
    "strategy",
    "run",
    "account",
    "review",
    "dataJob",
    "project",
    "dispatch",
    "approval",
    "monitor",
    "notice",
    "simulationReview",
  ];
  const objects = Object.fromEntries(
      kinds.map((k) => [k, r.store.list<any>(k)]),
    ),
    data = Object.fromEntries(
      (objects.dataset as Dataset[]).map((d) => [d.id, r.bars(d)]),
    );
  const body = {
    format: "quant-assistant-v2",
    schemaVersion: 2,
    engineVersion: ENGINE_VERSION,
    createdAt: new Date().toISOString(),
    objects,
    data,
    events: r.store.db
      .prepare(
        "SELECT project_id,revision,type,body,at FROM project_events ORDER BY sequence",
      )
      .all(),
  };
  const result = { ...body, hash: hash(body) };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX)
    fail("TOO_LARGE", "完整备份超过 64 MB，请停机后备份整个数据目录");
  return result;
}
export function restoreBackup(r: Research, input: unknown) {
  const x = z
    .object({ submissionId: id, backup: z.unknown() })
    .strict()
    .parse(input);
  if (Buffer.byteLength(JSON.stringify(x.backup)) > MAX)
    fail("TOO_LARGE", "备份超过 64 MB");
  const b = z
    .object({
      format: z.enum(["quant-assistant-v1", "quant-assistant-v2"]),
      schemaVersion: z.union([z.literal(1), z.literal(2)]),
      engineVersion: z.string().min(1),
      createdAt: z.string(),
      objects: z
        .object({
          dataset: z.array(z.unknown()),
          strategy: z.array(z.unknown()),
          run: z.array(z.unknown()),
          account: z.array(z.unknown()),
          review: z.array(z.unknown()),
          dataJob: z.array(z.unknown()),
          project: z.array(z.unknown()).optional(),
          dispatch: z.array(z.unknown()).optional(),
          approval: z.array(z.unknown()).optional(),
          monitor: z.array(z.unknown()).optional(),
          notice: z.array(z.unknown()).optional(),
          simulationReview: z.array(z.unknown()).optional(),
        })
        .strict(),
      data: z.record(id, z.unknown()),
      events: z
        .array(
          z
            .object({
              project_id: id,
              revision: z.number().int(),
              type: z.string().max(100),
              body: z.string(),
              at: z.string(),
            })
            .strict(),
        )
        .optional(),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(x.backup);
  const { hash: digest, ...body } = b;
  if (hash(body) !== digest) fail("HASH_MISMATCH", "备份完整性检查失败");
  if (Object.keys(b.objects).some((k) => r.store.list(k).length))
    fail("RESTORE_NOT_EMPTY", "恢复只支持空数据目录，请在新目录启动应用后恢复");
  const datasets = b.objects.dataset.map(
    (v) =>
      z
        .object({
          id,
          name: z.string(),
          symbol: z.string(),
          interval,
          source: z.string(),
          hash: z.string().regex(/^[a-f0-9]{64}$/),
          file: z.string(),
          count: z.number().int(),
          from: z.number(),
          to: z.number(),
          createdAt: z.string(),
          rules: rulesSchema,
          ruleAsOf: z.string(),
          quality: z.object({
            gaps: z.literal(0),
            duplicates: z.literal(0),
            valid: z.literal(true),
          }),
          synthetic: z.boolean(),
        })
        .strict()
        .parse(v) as Dataset,
  );
  const strategies = b.objects.strategy.map(
    (v) =>
      z
        .object({
          id,
          name: z.string().max(100),
          revision: z.number().int().positive(),
          definition: strategySchema,
          published: z.boolean(),
          author: z.enum(["user", "ai"]),
          createdAt: z.string(),
          purpose: z.literal("research").optional(),
          projectId: id.optional(),
          definitionHash: z.string().optional(),
          createdBy: z.enum(["user", "ai"]).optional(),
          approvedBy: z.literal("user").optional(),
          approvedAt: z.string().optional(),
          approvedConfigHash: z.string().optional(),
        })
        .strict()
        .parse(v) as StrategyRecord,
  );
  const ids = new Set<string>();
  for (const list of [
    datasets,
    strategies,
    b.objects.run,
    b.objects.account,
    b.objects.review,
    b.objects.dataJob,
  ])
    for (const v of list) {
      const value = z.object({ id }).passthrough().parse(v);
      if (ids.has(value.id)) fail("DUPLICATE_ID", "备份存在重复身份");
      ids.add(value.id);
    }
  for (const kind of [
    "project",
    "dispatch",
    "approval",
    "monitor",
    "notice",
    "simulationReview",
  ] as const) {
    const withinKind = new Set<string>();
    for (const v of b.objects[kind] ?? []) {
      const value = z.object({ id }).passthrough().parse(v);
      if (withinKind.has(value.id)) fail("DUPLICATE_ID", "备份存在重复身份");
      withinKind.add(value.id);
    }
  }
  const configSchema = configInput.extend({
    rules: z.record(z.string(), rulesSchema),
    engineVersion: z.string().min(1),
  });
  const accounts = b.objects.account.map(
    (v) =>
      z
        .object({
          id,
          name: z.string(),
          revision: z.number().int().positive(),
          initialCash: z.string(),
          status: z.enum(["created", "running", "paused", "stopped", "failed"]),
          strategyId: id,
          config: configSchema,
          state: stateSchema,
          seen: z.record(z.string(), z.number()),
          lastQuoteAt: z.record(z.string(), z.number()),
          lastEventAt: z.number(),
          error: z.string(),
          generation: z.number().int(),
          createdAt: z.string(),
          approvalHash: z.string().optional(),
        })
        .strict()
        .parse(v) as Account,
  );
  for (const a of accounts) {
    if (
      !strategies.some((s) => s.id === a.strategyId && s.published) ||
      a.initialCash !== a.config.initialCash
    )
      fail("BROKEN_REFERENCE", "账户引用无效");
    assertLedger(a.state, a.initialCash);
    a.status = "stopped";
    a.state.pending = {};
    a.generation++;
    a.revision++;
    a.error = "从备份恢复，需检查后手动启动";
  }
  const runs = b.objects.run.map(
    (v) =>
      z
        .object({
          id,
          strategyId: id,
          datasetIds: z.array(id),
          config: configSchema,
          status: z.enum([
            "queued",
            "running",
            "completed",
            "failed",
            "cancelled",
          ]),
          progress: z.number(),
          createdAt: z.string(),
          error: z.string().optional(),
          result: z.unknown().optional(),
          manifestHash: z.string(),
          projectId: id.optional(),
          experimentId: id.optional(),
          computeMs: z.number().nonnegative().optional(),
          maxComputeMs: z.number().positive().optional(),
        })
        .strict()
        .parse(v) as RunRecord,
  );
  for (const run of runs) {
    const strategy = strategies.find((s) => s.id === run.strategyId),
      ds = run.datasetIds.map((d) => datasets.find((v) => v.id === d));
    if (!strategy || ds.some((d) => !d))
      fail("BROKEN_REFERENCE", "回测引用无效");
    if (
      hash({
        strategy: strategy.definition,
        datasets: ds.map((d) => d!.hash),
        config: run.config,
      }) !== run.manifestHash
    )
      fail("HASH_MISMATCH", "回测配置不匹配");
    if (run.status === "completed" && !run.result)
      fail("RESULT_MISMATCH", "已完成回测缺少结果");
    if (run.result) {
      stateSchema.parse(run.result.state);
      assertLedger(run.result.state, run.config.initialCash);
      const { hash: h, ...result } = run.result;
      if (
        hash(result) !== h ||
        JSON.stringify(metrics(run.result.state, run.config)) !==
          JSON.stringify(run.result.metrics)
      )
        fail("RESULT_MISMATCH", "回测结果不一致");
    }
    if (run.status === "running" || run.status === "queued") {
      run.status = "cancelled";
      run.error = "备份恢复不自动执行任务";
    }
  }
  for (const review of b.objects.review) {
    const v = z
      .object({
        id,
        runId: id,
        manifestHash: z.string(),
        resultHash: z.string(),
        title: z.string(),
        body: z.string().max(10000),
        author: z.enum(["ai", "user"]),
        createdAt: z.string(),
      })
      .strict()
      .parse(review);
    if (
      !runs.some(
        (run) =>
          run.id === v.runId &&
          run.manifestHash === v.manifestHash &&
          run.result?.hash === v.resultHash,
      )
    )
      fail("BROKEN_REFERENCE", "复盘引用无效");
  }
  const dataJobs = b.objects.dataJob.map((v) =>
    z
      .object({
        id,
        submissionId: id.optional(),
        symbol: z.string(),
        interval,
        from: z.number().int().nonnegative(),
        to: z.number().int().positive(),
        status: z.enum([
          "queued",
          "running",
          "completed",
          "failed",
          "cancelled",
        ]),
        progress: z.number().min(0).max(100),
        error: z.string(),
        datasetId: z.string().max(100),
        createdAt: z.string(),
      })
      .strict()
      .parse(v),
  );
  for (const job of dataJobs) {
    if (
      job.status === "completed" &&
      !datasets.some(
        (d) =>
          d.id === job.datasetId &&
          d.symbol === job.symbol &&
          d.interval === job.interval,
      )
    )
      fail("BROKEN_REFERENCE", "数据任务引用无效");
    if (job.status === "queued" || job.status === "running") {
      job.status = "cancelled";
      job.error = "备份恢复不自动执行任务";
    }
  }
  const projects = validateProjects(
    b.objects.project ?? [],
    runs,
    datasets,
    strategies,
  );
  const dispatches = validateDispatches(b.objects.dispatch ?? [], projects);
  const approvals = (b.objects.approval ?? []).map((v) =>
    z
      .object({
        id,
        projectId: id,
        strategyId: id,
        definitionHash: z.string(),
        configHash: z.string(),
        reportHash: z.string(),
        actor: z.literal("user"),
        at: z.string(),
      })
      .strict()
      .parse(v),
  );
  for (const a of approvals)
    if (
      !projects.some(
        (p) => p.id === a.projectId && p.report?.hash === a.reportHash,
      ) ||
      !accounts.some((v) => v.id === a.id && v.strategyId === a.strategyId)
    )
      fail("BROKEN_REFERENCE", "模拟授权引用无效");
  const monitors = (b.objects.monitor ?? []).map(
    (v) =>
      z
        .object({
          id,
          enabled: z.boolean(),
          reviewHours: z.number().int().min(1).max(168),
          nextReviewAt: z.number().nonnegative(),
          activeFault: z.string(),
          lastCheckedAt: z.number().nonnegative(),
          lastAccountStatus: z.string(),
        })
        .strict()
        .parse(v) as MonitorRecord,
  );
  const notices = (b.objects.notice ?? []).map(
    (v) =>
      z
        .object({
          id,
          accountId: id,
          kind: z.enum(["fault", "recovered", "review"]),
          message: z.string(),
          at: z.string(),
          resolvedAt: z.string().nullable(),
          acknowledged: z.boolean(),
        })
        .strict()
        .parse(v) as Notice,
  );
  const simulationReviews = (b.objects.simulationReview ?? []).map(
    (v) =>
      z
        .object({
          id,
          accountId: id,
          at: z.string(),
          from: z.number().nonnegative(),
          to: z.number().nonnegative(),
          metrics: z.record(
            z.string(),
            z.union([z.string(), z.number(), z.null()]),
          ),
          observationGap: z.boolean(),
          status: z.string(),
          reason: z.string(),
          kind: z.literal("deterministic"),
        })
        .strict()
        .parse(v) as unknown as SimulationReview,
  );
  for (const m of monitors) {
    if (!accounts.some((a) => a.id === m.id))
      fail("BROKEN_REFERENCE", "运行监测账户引用无效");
    m.enabled = false;
  }
  for (const v of [...notices, ...simulationReviews])
    if (!accounts.some((a) => a.id === v.accountId))
      fail("BROKEN_REFERENCE", "运行观察引用无效");
  for (const e of b.events ?? []) {
    if (!projects.some((p) => p.id === e.project_id))
      fail("BROKEN_REFERENCE", "研究事件引用无效");
    JSON.parse(e.body);
  }
  // Validate everything before any DB mutation. Ready files are content-addressed.
  for (const d of datasets) {
    const bars = validateBars(b.data[d.id], d.symbol, d.interval),
      text = JSON.stringify(bars);
    if (
      hash(text) !== d.hash ||
      d.file !== `${d.hash}.json` ||
      bars.length !== d.count ||
      bars[0]!.time !== d.from ||
      bars.at(-1)!.time !== d.to
    )
      fail("HASH_MISMATCH", "备份数据快照不一致");
  }
  return r.store.submit(x.submissionId, "restore", { hash: digest }, () => {
    for (const d of datasets) {
      const text = JSON.stringify(b.data[d.id]),
        temp = join(r.directory, "datasets", `${d.hash}.tmp`);
      writeFileSync(temp, text);
      renameSync(temp, join(r.directory, "datasets", d.file));
      r.store.put("dataset", d.id, d);
    }
    for (const s of strategies) r.store.put("strategy", s.id, s);
    for (const run of runs) r.store.put("run", run.id, run);
    for (const job of dataJobs) r.store.put("dataJob", job.id, job);
    for (const a of accounts) {
      r.store.saveState(a.id, a.state);
      r.store.put("account", a.id, a);
    }
    for (const v of b.objects.review) {
      const review = v as {
        id: string;
      };
      r.store.put("review", review.id, review);
    }
    for (const p of projects) r.store.put("project", p.id, p);
    for (const d of dispatches) r.store.put("dispatch", d.id, d);
    for (const a of approvals) r.store.put("approval", a.id, a);
    for (const m of monitors) r.store.put("monitor", m.id, m);
    for (const n of notices) r.store.put("notice", n.id, n);
    for (const v of simulationReviews) r.store.put("simulationReview", v.id, v);
    for (const e of b.events ?? [])
      r.store.db
        .prepare(
          "INSERT INTO project_events(project_id,revision,type,body,at) VALUES (?,?,?,?,?)",
        )
        .run(e.project_id, e.revision, e.type, e.body, e.at);
    return {
      restored: true,
      datasets: datasets.length,
      strategies: strategies.length,
      runs: runs.length,
      accounts: accounts.length,
      dataJobs: dataJobs.length,
      projects: projects.length,
    };
  });
}
