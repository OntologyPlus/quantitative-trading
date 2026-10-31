import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Store } from "./store.js";
import {
  hash,
  parseCSV,
  synthetic,
  validateBars,
  download,
  symbols,
} from "../adapters/market.js";
import {
  configInput,
  fail,
  id,
  interval,
  positive,
  strategySchema,
  symbol,
} from "../domain/schemas.js";
import {
  DEFAULT_RULES,
  INTERVAL_MS,
  type Account,
  type Bar,
  type Dataset,
  type RunConfig,
  type RunRecord,
  type RunResult,
  type StrategyRecord,
} from "../domain/contracts.js";
import { ENGINE_VERSION } from "../engine/backtest.js";
import { assertLedger, initialState } from "../engine/core.js";
import { observationEvent } from "./observation.js";
export interface DataJob {
  id: string;
  symbol: string;
  interval: import("../domain/contracts.js").Interval;
  from: number;
  to: number;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  error: string;
  datasetId: string;
  createdAt: string;
}
export const uid = () => randomUUID();
const at = () => new Date().toISOString();
export class Research {
  readonly store: Store;
  readonly directory: string;
  worker: Worker | null = null;
  cancelBuffer: SharedArrayBuffer | null = null;
  private currentId = "";
  private dataAbort: AbortController | null = null;
  private lastJobKind: "data" | "run" = "run";
  closed = false;
  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(join(directory, "datasets"), { recursive: true });
    this.store = new Store(join(directory, "quant.sqlite"));
    for (const r of this.store.withStatus<RunRecord>("run", ["running"]))
      if (r.status === "running") {
        r.status = "queued";
        r.progress = 0;
        this.store.put("run", r.id, r);
      }
    for (const j of this.store.withStatus<DataJob>("dataJob", ["running"]))
      if (j.status === "running") {
        j.status = "queued";
        this.store.put("dataJob", j.id, j);
      }
    for (const a of this.store.list<Account>("account"))
      if (a.status === "running") {
        a.status = "paused";
        a.error = "宿主已重启；检查数据与账本后手动恢复，不补记缺口成交";
        a.revision++;
        a.generation++;
        this.store.transaction(() => {
          observationEvent(this.store, a, "restart", a.error);
          this.store.put("account", a.id, a);
        });
      }
    setImmediate(() => void this.pump());
  }
  bars(dataset: Dataset) {
    if (!/^[a-f0-9]{64}\.json$/.test(dataset.file))
      fail("INVALID_FILE", "数据文件身份无效");
    const text = readFileSync(
      join(this.directory, "datasets", dataset.file),
      "utf8",
    );
    if (hash(text) !== dataset.hash)
      fail("HASH_MISMATCH", "数据快照 hash 不匹配");
    return validateBars(JSON.parse(text), dataset.symbol, dataset.interval);
  }
  saveDataset(
    name: string,
    sym: string,
    int: Dataset["interval"],
    source: string,
    input: unknown,
    syntheticFlag = false,
    rules = DEFAULT_RULES,
  ): Dataset {
    const bars = validateBars(input, sym, int),
      body = JSON.stringify(bars),
      digest = hash(body),
      file = `${digest}.json`,
      temp = join(this.directory, "datasets", `${uid()}.tmp`);
    writeFileSync(temp, body, { flag: "wx" });
    renameSync(temp, join(this.directory, "datasets", file));
    const record: Dataset = {
      id: uid(),
      name,
      symbol: sym,
      interval: int,
      source,
      hash: digest,
      file,
      count: bars.length,
      from: bars[0]!.time,
      to: bars.at(-1)!.time,
      createdAt: at(),
      rules,
      ruleAsOf: at(),
      quality: { gaps: 0, duplicates: 0, valid: true },
      synthetic: syntheticFlag,
    };
    this.store.put("dataset", record.id, record);
    return record;
  }
  importDataset(input: unknown) {
    const x = z
      .object({
        submissionId: id,
        name: z.string().min(1).max(100),
        symbol,
        interval,
        csv: z.string().max(64 * 1024 * 1024),
      })
      .strict()
      .parse(input);
    return this.store.submit(x.submissionId, "import", x, () =>
      this.saveDataset(
        x.name,
        x.symbol,
        x.interval,
        "用户 CSV；交易规则为近似默认值",
        parseCSV(x.csv, x.symbol),
      ),
    );
  }
  demo(input: unknown) {
    const x = z.object({ submissionId: id }).strict().parse(input);
    return this.store.submit(x.submissionId, "demo", x, () =>
      this.saveDataset(
        "合成演示行情（非真实业绩）",
        "BTCUSDT",
        "1h",
        "deterministic-fixture",
        synthetic("BTCUSDT", "1h"),
        true,
      ),
    );
  }
  draft(input: unknown, author: "user" | "ai") {
    const x = z
      .object({
        submissionId: id,
        id: id.optional(),
        expectedRevision: z.number().int().nonnegative(),
        name: z.string().min(1).max(100),
        definition: strategySchema,
      })
      .strict()
      .parse(input);
    return this.store.submit(x.submissionId, `draft-${author}`, x, () => {
      const old = x.id
        ? this.store.get<StrategyRecord>("strategy", x.id)
        : null;
      if (old?.published || old?.purpose === "research")
        fail("IMMUTABLE_VERSION", "已发布版本不可修改，请复制为新草稿");
      if ((old?.revision ?? 0) !== x.expectedRevision)
        fail("REVISION_CONFLICT", "策略版本已改变，请重新读取");
      const record: StrategyRecord = {
        id: old?.id ?? uid(),
        name: x.name,
        revision: x.expectedRevision + 1,
        definition: x.definition,
        published: false,
        author,
        createdBy: old?.createdBy ?? author,
        createdAt: old?.createdAt ?? at(),
      };
      this.store.put("strategy", record.id, record);
      return record;
    });
  }
  publish(input: unknown) {
    const x = z
      .object({
        submissionId: id,
        id,
        expectedRevision: z.number().int().positive(),
      })
      .strict()
      .parse(input);
    return this.store.submit(x.submissionId, "publish", x, () => {
      const record = this.store.get<StrategyRecord>("strategy", x.id);
      if (record.purpose === "research")
        fail("RESEARCH_ONLY", "研究版本不可直接发布，请从研究报告确认模拟配置");
      if (record.revision !== x.expectedRevision)
        fail("REVISION_CONFLICT", "策略版本已改变");
      if (record.published) fail("IMMUTABLE_VERSION", "该版本已经发布");
      record.published = true;
      record.createdBy ??= record.author;
      record.author = "user";
      record.approvedBy = "user";
      record.approvedAt = at();
      record.revision++;
      this.store.put("strategy", record.id, record);
      return record;
    });
  }
  makeConfig(input: unknown, rules: RunConfig["rules"]): RunConfig {
    const x = configInput.parse(input);
    if (x.to <= x.from) fail("INVALID_RANGE", "结束时间必须晚于开始时间");
    return { ...x, rules, engineVersion: ENGINE_VERSION };
  }
  submitRun(
    input: unknown,
    grant?: { projectId: string; experimentId: string; maxComputeMs: number },
  ) {
    const x = z
      .object({
        submissionId: id,
        strategyId: id,
        datasetIds: z.array(id).min(1).max(10),
        config: configInput,
      })
      .strict()
      .parse(input);
    const result = this.store.submit(
      x.submissionId,
      "backtest",
      { input: x, grant: grant ?? null },
      () => {
        if (this.store.pendingCount("run") >= 5)
          fail("QUEUE_LIMIT", "最多允许五个待完成回测，请先等待或取消任务");
        const strategy = this.store.get<StrategyRecord>(
          "strategy",
          x.strategyId,
        );
        if (strategy.purpose === "research") {
          if (!grant || grant.projectId !== strategy.projectId)
            fail("RESEARCH_ONLY", "研究实验只能由对应委托调度");
        } else if (!strategy.published)
          fail("NOT_PUBLISHED", "请先在工作台发布策略");
        const datasets = x.datasetIds.map((d) =>
          this.store.get<Dataset>("dataset", d),
        );
        if (
          new Set(datasets.map((d) => d.symbol)).size !== datasets.length ||
          datasets.length !== strategy.definition.symbols.length ||
          datasets.some(
            (d) =>
              !strategy.definition.symbols.includes(d.symbol) ||
              d.interval !== strategy.definition.interval,
          )
        )
          fail("DATASET_MISMATCH", "每个策略交易对需要一份相同周期的数据");
        if (datasets.reduce((n, d) => n + d.count, 0) > 1000000)
          fail("TOO_LARGE", "单次任务最多一百万根 K 线");
        const from = Math.max(x.config.from, ...datasets.map((d) => d.from)),
          to = Math.min(x.config.to, ...datasets.map((d) => d.to));
        if (to <= from) fail("INVALID_RANGE", "数据与请求区间没有共同覆盖");
        const config = this.makeConfig(
          { ...x.config, from, to },
          Object.fromEntries(datasets.map((d) => [d.symbol, d.rules])),
        );
        const record: RunRecord = {
          id: uid(),
          strategyId: strategy.id,
          datasetIds: x.datasetIds,
          config,
          status: "queued",
          progress: 0,
          createdAt: at(),
          manifestHash: hash({
            strategy: strategy.definition,
            datasets: datasets.map((d) => d.hash),
            config,
          }),
          ...(grant
            ? {
                projectId: grant.projectId,
                experimentId: grant.experimentId,
                maxComputeMs: grant.maxComputeMs,
              }
            : {}),
        };
        this.store.put("run", record.id, record);
        return record;
      },
    );
    setImmediate(() => void this.pump());
    return result;
  }
  prepare(input: unknown) {
    const x = z
      .object({
        submissionId: id,
        symbol,
        interval,
        from: z.number().int().nonnegative(),
        to: z.number().int().positive(),
      })
      .strict()
      .parse(input);
    if (
      x.to <= x.from ||
      x.from % INTERVAL_MS[x.interval] ||
      Math.ceil((x.to - x.from) / INTERVAL_MS[x.interval]) > 1000000
    )
      fail("INVALID_RANGE", "时间区间无效、起点未对齐或超过一百万根");
    const result = this.store.submit(x.submissionId, "prepare", x, () => {
      if (this.store.pendingCount("dataJob") >= 5)
        fail("QUEUE_LIMIT", "最多允许五个待完成下载，请先等待或取消任务");
      const job: DataJob = {
        id: uid(),
        ...x,
        status: "queued",
        progress: 0,
        error: "",
        datasetId: "",
        createdAt: at(),
      };
      this.store.put("dataJob", job.id, job);
      return job;
    });
    setImmediate(() => void this.pump());
    return result;
  }
  async pump() {
    if (this.closed || this.currentId) return;
    if (!this.ensureWriter()) return;
    const data = this.store.withStatus<DataJob>("dataJob", ["queued"], 1)[0];
    const queuedRun =
      this.store.withStatus<RunRecord>("run", ["queued"], 1).length > 0;
    if (data && (this.lastJobKind !== "data" || !queuedRun)) {
      this.lastJobKind = "data";
      this.currentId = data.id;
      this.dataAbort = new AbortController();
      data.status = "running";
      this.store.put("dataJob", data.id, data);
      try {
        const list = await symbols(this.dataAbort.signal),
          rule = list.find((s) => s.symbol === data.symbol)?.rules;
        if (!rule) fail("SYMBOL_UNSUPPORTED", "该现货交易对不受支持");
        const bars = await download(
          data.symbol,
          data.interval,
          data.from,
          data.to,
          this.dataAbort.signal,
          (n) => {
            if (
              !this.closed &&
              data.status === "running" &&
              this.ensureWriter()
            ) {
              data.progress = n;
              this.store.put("dataJob", data.id, data);
            }
          },
        );
        if (
          !this.closed &&
          this.store.get<DataJob>("dataJob", data.id).status === "running"
        ) {
          this.store.transaction(() => {
            const ds = this.saveDataset(
              `${data.symbol} 公共行情`,
              data.symbol,
              data.interval,
              "Binance public market data",
              bars,
              false,
              rule,
            );
            data.datasetId = ds.id;
            data.progress = 100;
            data.status = "completed";
            this.store.put("dataJob", data.id, data);
          });
        }
      } catch (e) {
        if (
          !this.closed &&
          this.store.get<DataJob>("dataJob", data.id).status === "cancelled"
        )
          data.status = "cancelled";
        if (data.status !== "cancelled") {
          data.status = "failed";
          data.error = e instanceof Error ? e.message : String(e);
        }
      } finally {
        if (!this.closed && this.ensureWriter())
          this.store.put("dataJob", data.id, data);
        this.currentId = "";
        this.dataAbort = null;
        setImmediate(() => void this.pump());
      }
      return;
    }
    const run = this.store.withStatus<RunRecord>("run", ["queued"], 1)[0];
    if (!run) return;
    this.lastJobKind = "run";
    this.currentId = run.id;
    run.status = "running";
    this.store.put("run", run.id, run);
    try {
      const strategy = this.store.get<StrategyRecord>(
          "strategy",
          run.strategyId,
        ),
        bars = run.datasetIds.flatMap((d) =>
          this.bars(this.store.get<Dataset>("dataset", d)),
        );
      this.cancelBuffer = new SharedArrayBuffer(4);
      const worker = new Worker(
        new URL("../workers/backtest.js", import.meta.url),
        {
          workerData: {
            strategy: strategy.definition,
            config: run.config,
            bars,
            cancel: this.cancelBuffer,
          },
          resourceLimits: { maxOldGenerationSizeMb: 768 },
        },
      );
      this.worker = worker;
      let finished = false;
      const startedAt = Date.now();
      const timer = setTimeout(
        () => {
          if (!finished) {
            run.status = "failed";
            run.error = "任务超过计算时长预算";
            void worker.terminate();
          }
        },
        Math.min(300000, run.maxComputeMs ?? 300000),
      );
      const finish = () => {
        if (finished) return;
        finished = true;
        run.computeMs = Date.now() - startedAt;
        clearTimeout(timer);
        this.worker = null;
        this.cancelBuffer = null;
        this.currentId = "";
        if (!this.closed && this.ensureWriter()) {
          this.store.put("run", run.id, run);
          setImmediate(() => void this.pump());
        }
      };
      worker.on("message", (message) => {
        if (this.closed || !this.ensureWriter()) return;
        if (this.store.get<RunRecord>("run", run.id).status === "cancelled") {
          run.status = "cancelled";
          return;
        }
        if (message.type === "progress") {
          run.progress = message.progress;
          this.store.put("run", run.id, run);
        } else if (message.type === "result") {
          run.result = message.result as RunResult;
          run.progress = 100;
          run.status = "completed";
        } else {
          run.status = "failed";
          run.error = message.error;
        }
      });
      worker.on("error", (e) => {
        run.status = "failed";
        run.error = e.message;
      });
      worker.on("exit", (code) => {
        if (
          !this.closed &&
          this.store.get<RunRecord>("run", run.id).status === "cancelled"
        )
          run.status = "cancelled";
        if (run.status === "running") {
          run.status = "failed";
          run.error = `Worker 提前退出 (${code})`;
        }
        finish();
      });
    } catch (e) {
      run.status = "failed";
      run.error = e instanceof Error ? e.message : String(e);
      this.store.put("run", run.id, run);
      this.currentId = "";
      setImmediate(() => void this.pump());
    }
  }
  cancel(input: unknown) {
    const x = z
      .object({ submissionId: id, id, kind: z.enum(["run", "dataJob"]) })
      .strict()
      .parse(input);
    return this.store.submit(x.submissionId, "cancel", x, () => {
      const value = this.store.get<RunRecord | DataJob>(x.kind, x.id);
      if (!["queued", "running"].includes(value.status))
        fail("INVALID_STATE", "任务已经结束");
      value.status = "cancelled";
      this.store.put(x.kind, value.id, value);
      if (this.currentId === x.id) {
        this.dataAbort?.abort();
        if (this.cancelBuffer)
          Atomics.store(new Int32Array(this.cancelBuffer), 0, 1);
        if (this.worker) void this.worker.terminate();
      }
      return { id: value.id, status: value.status };
    });
  }
  accountCreate(input: unknown) {
    const x = z
      .object({
        submissionId: id,
        name: z.string().min(1).max(100),
        strategyId: id,
        config: configInput,
      })
      .strict()
      .parse(input);
    return this.store.submit(x.submissionId, "account", x, () => {
      const strategy = this.store.get<StrategyRecord>("strategy", x.strategyId);
      if (strategy.purpose === "research")
        fail("RESEARCH_ONLY", "研究版本不能绑定模拟账户，请从报告确认运行配置");
      if (
        strategy.approvedConfigHash &&
        strategy.approvedConfigHash !== hash(x.config)
      )
        fail("APPROVAL_MISMATCH", "运行配置与已确认的研究配置不一致");
      if (!strategy.published) fail("NOT_PUBLISHED", "请先发布策略");
      const config = this.makeConfig(
          { ...x.config, from: 0, to: 8640000000000000 },
          {},
        ),
        account: Account = {
          id: uid(),
          name: x.name,
          revision: 1,
          initialCash: config.initialCash,
          status: "created",
          strategyId: strategy.id,
          config,
          state: initialState(config.initialCash),
          seen: {},
          lastQuoteAt: {},
          lastEventAt: 0,
          error: "",
          generation: 0,
          createdAt: at(),
          ...(strategy.approvedConfigHash
            ? {
                approvalHash: hash({
                  strategy: strategy.definitionHash,
                  config: strategy.approvedConfigHash,
                }),
              }
            : {}),
        };
      this.store.put("account", account.id, account);
      return account;
    });
  }
  review(input: unknown, author: "user" | "ai") {
    const x = z
      .object({
        submissionId: id,
        runId: id,
        title: z.string().min(1).max(100),
        body: z.string().min(1).max(10000),
      })
      .strict()
      .parse(input);
    return this.store.submit(x.submissionId, `review-${author}`, x, () => {
      const run = this.store.get<RunRecord>("run", x.runId);
      if (run.status !== "completed")
        fail("RUN_NOT_READY", "只能引用已完成的回测");
      const value = {
        id: uid(),
        runId: run.id,
        manifestHash: run.manifestHash,
        resultHash: run.result!.hash,
        title: x.title,
        body: x.body,
        author,
        createdAt: at(),
      };
      this.store.put("review", value.id, value);
      return value;
    });
  }
  async close() {
    this.closed = true;
    this.dataAbort?.abort();
    await this.worker?.terminate();
    this.store.close();
  }
  private ensureWriter() {
    try {
      this.store.assertLease();
      return true;
    } catch {
      this.closed = true;
      this.dataAbort?.abort();
      void this.worker?.terminate();
      return false;
    }
  }
}
