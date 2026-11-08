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
import { symbolDirectory, gapReport, GAP_POLICY } from "../adapters/market.js";
import { labToolInput, labToolView } from "./lab-tool.js";
import { POLICY } from "../domain/policy.js";
import { FUNCTIONS } from "../domain/dsl.js";
import { STRATEGY_CATALOG } from "../domain/strategy-catalog.js";
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
    concurrencySafe = !write,
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
        isConcurrencySafe: () => concurrencySafe,
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
              "qt_lab_analyze",
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
    "读取模拟运行健康与事实复盘；id指定冻结复盘，path核对其数值证据。只读，不改变策略或运行状态",
    { id: { type: "string" }, path: { type: "string" } },
    (args) => {
      const x = z
        .object({ id: id.optional(), path: z.string().max(200).optional() })
        .strict()
        .parse(args);
      if (x.path && !x.id)
        fail("SIMULATION_EVIDENCE", "核对复盘证据时需要复盘id");
      return x.id ? q.monitor.read(x) : q.monitor.list();
    },
  );
  register(
    "qt_status",
    "每轮先读取研究状态、策略、数据、回测和模拟账户摘要",
    {},
    () => q.snapshot(),
  );
  register(
    "qt_symbols",
    "查询 USDT 现货交易对目录，返回symbols及asOf/stale/source。空query列出全部候选的分页；过期缓存仅供池子核对，不作为当前成交规则",
    {
      query: { type: "string" },
      offset: { type: "integer" },
      limit: { type: "integer" },
    },
    async (args, exec) => {
      const x = z
        .object({
          query: z.string().max(30).default("BTC"),
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(100).default(30),
        })
        .strict()
        .parse(args);
      const { symbols, ...directory } = await symbolDirectory(exec.signal),
        matches = symbols.filter((v) =>
          v.symbol.includes(x.query.trim().toUpperCase()),
        );
      return {
        ...directory,
        symbols: matches.slice(x.offset, x.offset + x.limit),
        total: matches.length,
        offset: x.offset,
        limit: x.limit,
        hasMore: x.offset + x.limit < matches.length,
      };
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
      const bars = r.bars(dataset),
        gaps = gapReport(bars, dataset.interval);
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
        quality: {
          ...dataset.quality,
          missingBars: gaps.missing,
          longestGapMs: gaps.longestMs,
          missingRatio: gaps.missing / (bars.length + gaps.missing),
          policy: GAP_POLICY,
          handling: "缺失的预定开盘不成交，信号作废并记 DATA_GAP；不补造 K 线",
        },
        storage: "json",
        bars: bars
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
            templates: ["sma_cross", "breakout", "expr", "rotation"],
            limits: {
              maxSymbols: 10,
              rotationPaperTrading: false,
              symbolValidation:
                "草稿只校验语法；交易对、数据覆盖和规则在运行准备时核验",
            },
            defaults: { fast: 20, slow: 60, entryPeriod: 20, exitPeriod: 10 },
            expression: {
              fields: ["open", "high", "low", "close", "volume"],
              operators: ["+ - * /", "< > <= >=", "and or not", "( )"],
              functions: Object.fromEntries(
                Object.entries(FUNCTIONS).map(([k, v]) => [k, v.doc]),
              ),
              notes:
                "指标只用已收盘K线，float64 计算；成交、资金和账本仍为十进制精确计算。cross_above/below 比较上一根与本根。",
            },
            riskOptions: {
              stopAtr: "ATR 倍数止损（atrPeriod 默认 14）",
              trailingStopPct: "按最高价回撤百分比移动止损",
              trailingAtr: "吊灯止损：持仓以来最高价 − 倍数 × ATR",
              maxHoldBars: "持有满 N 根后下一开盘退出",
              "sizing=volatility":
                "按 targetVolPct 年化目标波动率定仓（volPeriod 默认 20）",
            },
            catalog: STRATEGY_CATALOG,
            strategies: r.store.list("strategy"),
          };
    },
  );
  register(
    "qt_strategy_draft",
    "保存草稿。input含submissionId,expectedRevision,name,definition；definition含template,symbols,interval；均线/突破用fast,slow,entryPeriod,exitPeriod；template=expr时用rules:{version:1,entry,exit}表达式；template=rotation时用rotation:{version:1,score,filter?,top,every}。先用qt_strategy_read查看函数与策略库；不可发布",
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
    "qt_lab_analyze",
    "分析当前引擎的独立已完成回测。action为performance-report（所有模板）、parameter-sweep或walk-forward（仅单标的均线/突破、基础风控）。input含runId；扫描含grid:{fast:[],slow:[]}、top、search:{mode:'grid'|'random',samples,seed}；前推另含trainBars/testBars/mode:'rolling'|'anchored'；绩效可含costMultipliers/rollingDays。返回源身份、完整分析hash与有界结果；offset/limit分页扫描行，曲线采样不改变统计。不会发布策略、更改资金或将结果写入项目门槛",
    {
      action: {
        type: "string",
        enum: ["parameter-sweep", "walk-forward", "performance-report"],
        required: true,
      },
      input: json,
      offset: { type: "integer" },
      limit: { type: "integer" },
    },
    async (args, exec) => {
      const x = labToolInput.parse(args),
        run = r.store.get<RunRecord>("run", x.input.runId);
      if (run.projectId)
        fail(
          "PROJECT_SCOPE",
          "委托实验请通过项目工具读取冻结证据；实验室工具仅分析独立回测",
        );
      const result = await q.lab.run(r, x.action, x.input, exec.signal);
      return {
        action: x.action,
        source: {
          runId: run.id,
          engineVersion: run.config.engineVersion,
          manifestHash: run.manifestHash,
          resultHash: run.result?.hash,
          from: run.config.from,
          to: run.config.to,
          datasets: run.datasetIds.map((id) => {
            const d = r.store.get<Dataset>("dataset", id);
            return {
              id,
              hash: d.hash,
              symbol: d.symbol,
              synthetic: d.synthetic,
            };
          }),
        },
        ...labToolView(x.action, result, x.offset, x.limit),
      };
    },
    false,
    false,
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
