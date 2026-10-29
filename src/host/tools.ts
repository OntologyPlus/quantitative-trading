import type { Context } from "@deepseek-ai/cordis";
import {
  defineTool,
  type ParameterSchemaSpec,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "./index.js";
import { z } from "zod";
import {
  TOOL_TITLES,
  type Dataset,
  type RunRecord,
  type StrategyRecord,
} from "../domain/contracts.js";
import { id } from "../domain/schemas.js";
import { symbols } from "../adapters/market.js";
import { POLICY } from "../domain/policy.js";
import { fail } from "../domain/schemas.js";
import type { ResearchProject } from "../domain/project.js";
import { hash } from "../adapters/market.js";
export const inject = ["tools", "systemPrompt", "quant"];
const string = { type: "string", required: true } as const;
const json = { type: "json", required: true } as const;
export function apply(ctx: Context) {
  const q = ctx.quant,
    r = q.research;
  ctx.tools.presentAs("native");
  ctx.tools.guard((exec) =>
    !Object.hasOwn(TOOL_TITLES, exec.name)
      ? "量化预设仅允许 qt_* 工具"
      : !exec.agent
        ? "请在量化研究会话中调用"
        : undefined,
  );
  ctx.systemPrompt.section({
    name: "quant:research",
    order: 100,
    text: POLICY,
  });
  const register = (
    name: string,
    description: string,
    parameters: ParameterSchemaSpec,
    fn: (args: unknown, exec: ToolRunContext) => unknown,
    write = false,
  ) =>
    ctx.tools.register(
      defineTool({
        name,
        description,
        parameters,
        output: {
          schema: {
            type: "object",
            properties: { data: { type: "json", required: true } },
            additionalProperties: false,
          },
          render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
        },
        isConcurrencySafe: () => !write,
        execute: async (args, exec) => {
          exec.signal.throwIfAborted();
          const active = r.store
            .list<ResearchProject>("project")
            .find(
              (p) =>
                p.sourceSessionId === exec.agent?.session.id &&
                p.authorization &&
                !["completed", "cancelled", "failed"].includes(p.status),
            );
          if (
            active &&
            [
              "qt_backtest_submit",
              "qt_dataset_prepare",
              "qt_strategy_draft",
            ].includes(name)
          )
            fail(
              "PROJECT_SCOPE",
              "当前有研究委托，请通过项目动作推进，不能绕过项目预算提交独立实验",
            );
          return { data: JSON.parse(JSON.stringify(await fn(args, exec))) };
        },
      }),
    );
  register(
    "qt_project_create",
    "根据已讨论的目标提出研究草稿，input含name,objective,symbols,interval,from,to,budget等；不授权启动，用户在工作台核对",
    { input: json },
    (args, exec) =>
      q.projects.create(
        z.object({ input: z.unknown() }).strict().parse(args).input,
        exec.agent!.session.id,
        "ai",
      ),
    true,
  );
  register(
    "qt_project_read",
    "读取研究项目进度、实验、证据与报告；不传id返回分页项目摘要",
    { id: { type: "string" } },
    (args) => {
      const x = z.object({ id: id.optional() }).strict().parse(args);
      return x.id ? q.projects.read({ id: x.id }) : q.projects.list();
    },
  );
  register(
    "qt_project_action",
    "下一步动作只能由受授权的专属研究执行会话提交；普通聊天请先提出研究委托",
    { input: json },
    () =>
      fail(
        "EXECUTION_SCOPE",
        "请在工作台启动研究，后台执行会话会按委托提交动作",
      ),
    true,
  );
  register(
    "qt_evidence_read",
    "核对当前研究证据，需projectId和evidenceId",
    { projectId: string, evidenceId: string },
    (args) => {
      const x = z
        .object({ projectId: id, evidenceId: id })
        .strict()
        .parse(args);
      return q.projects.readEvidence(x.projectId, x.evidenceId);
    },
  );
  register(
    "qt_monitor_read",
    "读取模拟运行健康、异常通知与确定性事实复盘",
    {},
    () => q.monitor.list(),
  );
  register(
    "qt_status",
    "每轮先读取研究状态、策略、数据、回测和模拟账户摘要",
    {},
    () => q.snapshot(),
  );
  register(
    "qt_symbols",
    "查询支持的 USDT 现货交易对和当前交易规则",
    { query: { type: "string" } },
    async (args, exec) => {
      const x = z
        .object({ query: z.string().max(30).default("BTC") })
        .strict()
        .parse(args);
      return (await symbols(exec.signal))
        .filter((v) => v.symbol.includes(x.query.toUpperCase()))
        .slice(0, 30);
    },
  );
  register(
    "qt_dataset_inspect",
    "检查已缓存数据快照与质量，不隐含联网下载",
    {
      id: { type: "string" },
      from: { type: "integer" },
      limit: { type: "integer" },
    },
    (args, exec) => {
      const x = z
        .object({
          id: id.optional(),
          from: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(100).default(20),
        })
        .strict()
        .parse(args);
      if (!x.id) return r.store.list("dataset");
      const dataset = r.store.get<Dataset>("dataset", x.id);
      const active = r.store
        .list<ResearchProject>("project")
        .find(
          (p) =>
            p.sourceSessionId === exec.agent?.session.id &&
            p.datasetIds.includes(dataset.id) &&
            !p.holdoutRevealedAt,
        );
      return {
        ...dataset,
        bars: r
          .bars(dataset)
          .filter((b) => b.time >= x.from)
          .filter((b) => !active || b.time <= active.ranges.validation.to)
          .slice(0, x.limit),
      };
    },
  );
  register(
    "qt_dataset_prepare",
    "提交公共行情下载任务。input 包含 submissionId,symbol,interval,from,to，UTC毫秒。返回任务ID",
    { input: json },
    (args) => {
      const x = z.object({ input: z.unknown() }).strict().parse(args);
      return r.prepare(x.input);
    },
    true,
  );
  register(
    "qt_strategy_read",
    "读取模板说明与策略版本",
    { id: { type: "string" } },
    (args) => {
      const x = z.object({ id: id.optional() }).strict().parse(args);
      return x.id
        ? r.store.get<StrategyRecord>("strategy", x.id)
        : {
            templates: ["sma_cross", "breakout"],
            defaults: { fast: 20, slow: 60, entryPeriod: 20, exitPeriod: 10 },
            strategies: r.store.list("strategy"),
          };
    },
  );
  register(
    "qt_strategy_draft",
    "保存草稿。input含submissionId,expectedRevision,name,definition；definition含template,symbols,interval,fast,slow,entryPeriod,exitPeriod；不可发布",
    { input: json },
    (args) =>
      r.draft(
        z.object({ input: z.unknown() }).strict().parse(args).input,
        "ai",
      ),
    true,
  );
  register(
    "qt_backtest_submit",
    "提交有界回测。input含submissionId,strategyId,datasetIds,config；config至少initialCash，其余风险/成本省略用已披露实验默认值。需用户已发布策略",
    { input: json },
    (args) =>
      r.submitRun(z.object({ input: z.unknown() }).strict().parse(args).input),
    true,
  );
  register(
    "qt_run_read",
    "读取回测状态与真实指标、分页成交、摘要净值",
    { id: string, offset: { type: "integer" }, limit: { type: "integer" } },
    (args) => q.readRun(args),
  );
  register(
    "qt_runs_compare",
    "比较已完成回测；返回口径是否相同以及真实指标",
    { ids: { type: "array", items: { type: "string" }, required: true } },
    (args) => {
      const x = z
          .object({ ids: z.array(id).min(2).max(5) })
          .strict()
          .parse(args),
        runs = x.ids.map((i) => r.store.get<RunRecord>("run", i));
      return {
        sameBasis: runs.every(
          (a) =>
            hash({
              config: {
                ...a.config,
                rules: Object.fromEntries(
                  Object.entries(a.config.rules).sort(),
                ),
              },
              datasets: [...a.datasetIds].sort(),
            }) ===
            hash({
              config: {
                ...runs[0]!.config,
                rules: Object.fromEntries(
                  Object.entries(runs[0]!.config.rules).sort(),
                ),
              },
              datasets: [...runs[0]!.datasetIds].sort(),
            }),
        ),
        engineVersions: [...new Set(runs.map((r) => r.config.engineVersion))],
        runs: runs.map((a) => ({
          id: a.id,
          manifestHash: a.manifestHash,
          status: a.status,
          metrics: a.result?.metrics,
        })),
      };
    },
  );
  register(
    "qt_portfolio_read",
    "读取模拟账户，不允许修改资金或控制运行",
    { id: { type: "string" } },
    (args) => {
      const x = z.object({ id: id.optional() }).strict().parse(args);
      return q.snapshot().accounts.filter((a) => !x.id || a.id === x.id);
    },
  );
  register(
    "qt_decisions_read",
    "按 run/account 对象身份分页读取真实决策理由",
    {
      id: string,
      kind: { type: "string", enum: ["run", "account"], required: true },
      offset: { type: "integer" },
      limit: { type: "integer" },
      code: { type: "string" },
    },
    (args) => q.decisions(args),
  );
  register(
    "qt_review_save",
    "保存带真实回测身份的 AI 复盘。input含submissionId,runId,title,body；事实引用需在正文注明",
    { input: json },
    (args) =>
      r.review(
        z.object({ input: z.unknown() }).strict().parse(args).input,
        "ai",
      ),
    true,
  );
}
