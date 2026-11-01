import { LabExecutor } from "./lab-executor.js";
import { Service, type Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { Research } from "./research.js";
import { Paper } from "./paper.js";
import { exportBackup, restoreBackup } from "./backup.js";
import { id } from "../domain/schemas.js";
import type {
  Account,
  Dataset,
  RunRecord,
  StrategyRecord,
} from "../domain/contracts.js";
import { metrics } from "../engine/core.js";
import { ProjectService } from "../agent/project-service.js";
import type { ResearchProject } from "../domain/project.js";
import { existsSync } from "node:fs";
import { ENGINE_VERSION } from "../engine/backtest.js";
import { MonitorService } from "./monitor.js";
export interface Config {
  dataDirectory: string;
}
export const Config: Schema<Config> = Schema.object({
  dataDirectory: Schema.string().default(""),
});
declare module "@deepseek-ai/cordis" {
  interface Context {
    quant: QuantService;
  }
}
export default class QuantService extends Service {
  static Config = Config;
  readonly research: Research;
  readonly paper: Paper;
  readonly projects: ProjectService;
  readonly monitor: MonitorService;
  readonly lab = new LabExecutor();
  constructor(ctx: Context, config: Config) {
    super(ctx, "quant");
    const directory =
      config.dataDirectory ||
      join(resolveDshHome(), "plugins-data", "quant-assistant");
    if (!isAbsolute(directory)) throw Error("数据目录必须是绝对路径");
    this.research = new Research(directory);
    this.paper = new Paper(this.research);
    this.projects = new ProjectService(this.research);
    this.monitor = new MonitorService(this.research);
    ctx.effect(() => async () => {
      await this.lab.close();
      this.monitor.close();
      await this.projects.close();
      this.paper.close();
      await this.research.close();
    });
  }
  snapshot() {
    const r = this.research,
      s = r.store;
    return {
      schemaVersion: 1,
      mode: "research-paper-only",
      datasets: s.page<Dataset>("dataset", 0, 100),
      strategies: s
        .page<StrategyRecord>("strategy", 0, 100)
        .filter((v) => v.purpose !== "research"),
      runs: s
        .page<RunRecord>("run", 0, 100)
        .filter((v) => !v.projectId)
        .map(({ result, ...run }) => ({
          ...run,
          metrics: result?.metrics,
          benchmarks: result?.benchmarks,
        })),
      dataJobs: s.page("dataJob", 0, 100),
      accounts: s.list<Account>("account").map((a) => ({
        ...this.paper.summary(a),
        metrics: metrics(a.state, a.config),
      })),
      reviews: s.page("review", 0, 100),
      projects: this.projects.list({ limit: 5 }).projects,
      capabilities: {
        liveTrading: false,
        syntheticData: true,
        publicData: true,
        maxBars: 1000000,
      },
      asOf: new Date().toISOString(),
    };
  }
  readRun(input: unknown) {
    const x = z
        .object({
          id,
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(200).default(50),
        })
        .strict()
        .parse(input),
      run = this.research.store.get<RunRecord>("run", x.id);
    if (!run.result) return run;
    const { state, ...result } = run.result;
    return {
      ...run,
      result: {
        ...result,
        state: {
          cash: state.cash,
          positions: state.positions,
          curve: state.curve
            .filter(
              (_, i) =>
                i % Math.max(1, Math.floor(state.curve.length / 1000)) === 0,
            )
            .slice(-1001),
          fills: state.fills.slice(x.offset, x.offset + x.limit),
          decisions: state.decisions.slice(x.offset, x.offset + x.limit),
        },
        totalFills: state.fills.length,
        totalDecisions: state.decisions.length,
        offset: x.offset,
      },
    };
  }
  decisions(input: unknown) {
    const x = z
      .object({
        id,
        kind: z.enum(["run", "account"]),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(200).default(50),
        code: z.string().max(100).optional(),
      })
      .strict()
      .parse(input);
    const st =
      x.kind === "account"
        ? this.research.store.get<Account>("account", x.id).state
        : this.research.store.get<RunRecord>("run", x.id).result?.state;
    const list = (st?.decisions ?? []).filter(
      (d) => !x.code || d.code === x.code,
    );
    return {
      events: list.slice(x.offset, x.offset + x.limit),
      total: list.length,
      offset: x.offset,
    };
  }
  async user(
    action: string,
    input: unknown,
    sessionId = "local-user",
    signal?: AbortSignal,
  ): Promise<unknown> {
    const r = this.research;
    switch (action) {
      case "research-quality":
      case "portfolio-research":
      case "portfolio-backtest":
      case "data-audit":
      case "universe-asof":
      case "simulation-replay":
        return this.lab.run(r, action, input, signal);
      case "project-create":
        return this.projects.create(input, sessionId);
      case "project-list":
        return this.projects.list(input);
      case "project-read":
        return this.projects.read(input);
      case "project-control":
        return this.projects.control(input);
      case "project-approve":
        return this.projects.approve(input);
      case "project-promotion-preview":
        return this.projects.promotionPreview(input);
      case "project-answer":
        return this.projects.answer(input);
      case "monitor-list":
        return this.monitor.list(input);
      case "monitor-config":
        return this.monitor.config(input);
      case "monitor-review":
        return this.monitor.review(input);
      case "monitor-read":
        return this.monitor.read(input);
      case "monitor-followup": {
        const x = z
          .object({
            submissionId: id,
            id,
            reviewHash: z.string(),
            questionCode: z.string().max(100),
          })
          .strict()
          .parse(input);
        return r.store.submit(
          x.submissionId,
          "monitor-followup",
          { x, sessionId },
          () =>
            this.projects.create(
              {
                submissionId: `followup-${x.submissionId}`,
                ...this.monitor.followupInput({
                  reviewId: x.id,
                  reviewHash: x.reviewHash,
                  questionCode: x.questionCode,
                }),
              },
              sessionId,
            ),
        );
      }
      case "notice-ack":
        return this.monitor.acknowledge(input);
      case "project-export": {
        const x = z.object({ id }).strict().parse(input),
          p = this.projects.verifyReport(x.id);
        if (!p.report) throw Error("研究尚未形成报告");
        return {
          project: p,
          report: p.report,
          events: r.store.events(p.id, 0, 10000),
        };
      }
      case "project-evidence": {
        const x = z.object({ id, evidenceId: id }).strict().parse(input);
        return this.projects.readEvidence(x.id, x.evidenceId);
      }
      case "health":
        return {
          asOf: new Date().toISOString(),
          node: process.version,
          engine: ENGINE_VERSION,
          uptimeSeconds: Math.floor(process.uptime()),
          rssMiB: Math.round(process.memoryUsage().rss / 1048576),
          heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576),
          ...this.projects.health(),
          worker: existsSync(
            new URL("../workers/backtest.js", import.meta.url),
          ),
          agent: this.projects.agentAvailable(),
          mode: "local-process",
          capabilities: ["research", "paper"],
          liveTrading: false,
        };
      case "snapshot":
        return this.snapshot();
      case "demo":
        return r.demo(input);
      case "import":
        return r.importDataset(input);
      case "prepare":
        return r.prepare(input);
      case "draft":
        return r.draft(input, "user");
      case "publish":
        return r.publish(input);
      case "backtest":
        return r.submitRun(input);
      case "run":
        return this.readRun(input);
      case "decisions":
        return this.decisions(input);
      case "cancel":
        return r.cancel(input);
      case "account":
        return r.accountCreate(input);
      case "control":
        return this.paper.control(input);
      case "review":
        return r.review(input, "user");
      case "backup":
        return exportBackup(r);
      case "restore":
        return restoreBackup(r, input);
      case "export-run": {
        const x = z.object({ id }).strict().parse(input);
        return r.store.get<RunRecord>("run", x.id);
      }
      default:
        throw Error("未知操作");
    }
  }
}
