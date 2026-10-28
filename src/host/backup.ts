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
const MAX = 64 * 1024 * 1024;
export function exportBackup(r: Research) {
  if (
    r.store.list<Account>("account").some((a) => a.status === "running") ||
    r.worker
  )
    fail("STOP_FIRST", "请先暂停模拟盘并等待回测结束再备份");
  const kinds = ["dataset", "strategy", "run", "account", "review", "dataJob"];
  const objects = Object.fromEntries(
      kinds.map((k) => [k, r.store.list<any>(k)]),
    ),
    data = Object.fromEntries(
      (objects.dataset as Dataset[]).map((d) => [d.id, r.bars(d)]),
    );
  const body = {
    format: "quant-assistant-v1",
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    createdAt: new Date().toISOString(),
    objects,
    data,
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
      format: z.literal("quant-assistant-v1"),
      schemaVersion: z.literal(1),
      engineVersion: z.literal(ENGINE_VERSION),
      createdAt: z.string(),
      objects: z
        .object({
          dataset: z.array(z.unknown()),
          strategy: z.array(z.unknown()),
          run: z.array(z.unknown()),
          account: z.array(z.unknown()),
          review: z.array(z.unknown()),
          dataJob: z.array(z.unknown()),
        })
        .strict(),
      data: z.record(id, z.unknown()),
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
  const configSchema = configInput.extend({
    rules: z.record(z.string(), rulesSchema),
    engineVersion: z.literal(ENGINE_VERSION),
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
    return {
      restored: true,
      datasets: datasets.length,
      strategies: strategies.length,
      runs: runs.length,
      accounts: accounts.length,
      dataJobs: dataJobs.length,
    };
  });
}
