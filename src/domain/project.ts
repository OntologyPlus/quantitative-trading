import { z } from "zod";
import {
  configInput,
  decimal,
  id,
  interval,
  strategySchema,
  symbol,
} from "./schemas.js";
import { INTERVAL_MS, type Metrics } from "./contracts.js";
import {
  robustnessInput,
  minimumExperiments,
  type DiagnosticMeta,
} from "./robustness.js";
import type { ResearchDiagnostics } from "../research/diagnostics.js";

export const projectStatus = z.enum([
  "draft",
  "ready",
  "running",
  "waiting_job",
  "waiting_agent",
  "waiting_input",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
export const terminal = (s: string) =>
  ["completed", "failed", "cancelled"].includes(s);
export const projectInput = z
  .object({
    submissionId: id,
    name: z.string().trim().min(1).max(100),
    objective: z.string().trim().min(5).max(4000),
    parentProjectId: id.optional(),
    simulationSource: z
      .object({
        accountId: id,
        reviewId: id,
        reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    symbols: z
      .array(symbol)
      .min(1)
      .max(5)
      .refine((a) => new Set(a).size === a.length),
    interval,
    from: z.number().int().nonnegative(),
    to: z.number().int().positive(),
    datasetIds: z.array(id).max(5).default([]),
    candidates: z.array(strategySchema).min(1).max(6).optional(),
    mode: z.enum(["agent", "protocol"]).default("agent"),
    robustness: robustnessInput.optional(),
    budget: z
      .object({
        experiments: z.number().int().min(6).max(48).default(12),
        modelRequests: z.number().int().min(1).max(100).default(20),
        outputTokens: z.number().int().min(256).max(8192).default(2048),
        maxBars: z.number().int().min(180).max(1000000).default(100000),
        computeSeconds: z.number().int().min(10).max(3600).default(600),
        hours: z.number().int().min(1).max(168).default(24),
      })
      .strict()
      .default(() => ({
        experiments: 12,
        modelRequests: 20,
        outputTokens: 2048,
        maxBars: 100000,
        computeSeconds: 600,
        hours: 24,
      })),
    thresholds: z
      .object({
        minClosedTrades: z.number().int().min(1).max(10000).default(10),
        maxDrawdownPct: decimal.refine((v) => Number(v) <= 100).default("20"),
        minExcessReturnPct: z
          .string()
          .regex(/^-?\d+(\.\d+)?$/)
          .default("0"),
        stressMultiplier: z.number().min(1).max(10).default(2),
      })
      .strict()
      .default(() => ({
        minClosedTrades: 10,
        maxDrawdownPct: "20",
        minExcessReturnPct: "0",
        stressMultiplier: 2,
      })),
    config: configInput.default(() => configInput.parse({})),
    resumeOnRestart: z.boolean().default(false),
  })
  .strict()
  .superRefine((p, ctx) => {
    const step = INTERVAL_MS[p.interval],
      count = (p.to - p.from) / step + 1;
    if (p.from % step || p.to % step || count < 180 || p.to + step > Date.now())
      ctx.addIssue({
        code: "custom",
        message: "研究区间须对齐已收盘K线，并至少包含180根",
      });
    if (count * p.symbols.length > p.budget.maxBars)
      ctx.addIssue({ code: "custom", message: "研究数据量超过委托预算" });
    if (p.config.from !== 0 || p.config.to !== 8640000000000000)
      ctx.addIssue({
        code: "custom",
        message: "研究区间由协议统一设置，请勿在资金配置中覆盖",
      });
    if (
      p.candidates?.some(
        (c) =>
          c.interval !== p.interval ||
          JSON.stringify([...c.symbols].sort()) !==
            JSON.stringify([...p.symbols].sort()),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "候选的市场与周期必须与研究协议一致",
      });
    if (
      p.budget.experiments <
      minimumExperiments(p.candidates?.length ?? 2, p.robustness)
    )
      ctx.addIssue({
        code: "custom",
        message: `实验预算不足，当前协议至少需要 ${minimumExperiments(p.candidates?.length ?? 2, p.robustness)} 个实验（含最终检验与所选稳健性研究）`,
      });
    if (
      p.robustness &&
      p.robustness.costMultipliers.some(
        (m) =>
          Number(p.config.costs.feeBps) * m > 1000 ||
          Number(p.config.costs.slippageBps) * m > 1000,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "成本情景放大后的手续费或滑点超过引擎1000bps上限",
      });
  });

export type ProjectInput = z.infer<typeof projectInput>;
export type Phase =
  | "development"
  | "validation"
  | "holdout"
  | "stress"
  | "cost_sensitivity"
  | "parameter_sensitivity"
  | "walk_train"
  | "walk_test";
export interface ResearchCandidate {
  id: string;
  strategyId: string;
  definitionHash: string;
  name: string;
  reason: string;
  parentId?: string;
}
export interface ProjectExperiment {
  id: string;
  candidateId: string;
  phase: Phase;
  runId: string;
  status:
    | "planned"
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";
  from: number;
  to: number;
  reason: string;
  createdAt: string;
  error?: string;
  metrics?: Metrics;
  manifestHash?: string;
  resultHash?: string;
  evaluation?: Evaluation;
  computeMs?: number;
  diagnostic?: DiagnosticMeta;
}
export interface EvidenceRef {
  id: string;
  projectId: string;
  experimentId: string;
  runId: string;
  manifestHash: string;
  resultHash: string;
  path: string;
  value: string | number | null;
  from: number;
  to: number;
}
export interface Evaluation {
  verdict: "pass" | "fail" | "insufficient";
  reasons: { code: string; message: string }[];
}
export interface Analysis {
  kind: "interpretation" | "hypothesis";
  text: string;
  evidenceIds: string[];
  author: "ai";
  at: string;
  template?: string;
}
export interface ProjectReport {
  version: 1;
  projectId: string;
  protocolHash: string;
  generatedAt: string;
  conclusion: "supported" | "rejected" | "inconclusive";
  summary: string;
  selectedCandidateId: string | null;
  synthetic: boolean;
  facts: EvidenceRef[];
  analyses: Analysis[];
  limitations: string[];
  experiments: {
    id: string;
    phase: Phase;
    candidateId: string;
    runId: string;
    status: string;
    evaluation?: Evaluation;
  }[];
  hash: string;
  markdown: string;
  diagnostics?: ResearchDiagnostics;
}
export interface ResearchProject {
  id: string;
  revision: number;
  generation: number;
  name: string;
  objective: string;
  sourceSessionId: string;
  executionSessionId: string;
  status: z.infer<typeof projectStatus>;
  stage: "planning" | "data" | "candidates" | "selection" | "final" | "report";
  protocol: Omit<ProjectInput, "submissionId" | "name" | "objective">;
  protocolHash: string;
  authorization?: {
    hash: string;
    at: string;
    expiresAt: number;
    actor: "user";
  };
  ranges: Record<
    "development" | "validation" | "holdout",
    { from: number; to: number }
  >;
  candidates: ResearchCandidate[];
  experiments: ProjectExperiment[];
  datasetIds: string[];
  dataJobIds: string[];
  budgetUsed: {
    experiments: number;
    modelRequests: number;
    computeMs: number;
    inputTokens: number;
    outputTokens: number;
    usageComplete: boolean;
  };
  selectedCandidateId: string | null;
  selectionHash: string | null;
  holdoutRevealedAt: string | null;
  analyses: Analysis[];
  report?: ProjectReport;
  answers?: { text: string; at: string }[];
  priorExposures?: string[];
  activeDispatchId: string | null;
  error: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
}
export interface ModelDispatch {
  id: string;
  projectId: string;
  generation: number;
  stage: "planning" | "selection" | "report";
  status:
    | "pending"
    | "delivered"
    | "completed"
    | "cancelled"
    | "outcome_unknown";
  sessionId: string;
  messageId: string;
  createdAt: string;
  requestKeys: string[];
  usageKeys: string[];
  error: string;
}
export const projectControl = z
  .object({
    submissionId: id,
    id,
    expectedRevision: z.number().int().positive(),
    action: z.enum(["start", "pause", "resume", "cancel"]),
  })
  .strict();
export const nextAction = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("begin"), reason: z.string().min(1).max(2000) })
    .strict(),
  z
    .object({
      action: z.literal("select"),
      candidateId: id,
      reason: z.string().min(1).max(2000),
      evidenceIds: z.array(id).min(1).max(30),
    })
    .strict(),
  z
    .object({
      action: z.literal("propose"),
      definition: strategySchema,
      parentId: id.optional(),
      reason: z.string().min(1).max(2000),
      evidenceIds: z.array(id).min(1).max(30),
    })
    .strict(),
  z
    .object({
      action: z.literal("analyze"),
      kind: z.enum(["interpretation", "hypothesis"]),
      text: z.string().min(1).max(3000),
      evidenceIds: z.array(id).min(1).max(30),
    })
    .strict(),
  z.object({ action: z.literal("finish") }).strict(),
  z
    .object({
      action: z.literal("request_input"),
      question: z.string().min(1).max(2000),
    })
    .strict(),
]);
export function defaultCandidates(
  p: Pick<ProjectInput, "symbols" | "interval">,
) {
  const base = { symbols: p.symbols, interval: p.interval };
  return [
    strategySchema.parse({
      ...base,
      template: "sma_cross",
      fast: 20,
      slow: 60,
    }),
    strategySchema.parse({
      ...base,
      template: "breakout",
      entryPeriod: 20,
      exitPeriod: 10,
    }),
  ];
}

export const PROJECT_TOOL_TITLES: Record<string, string> = {
  qt_project_create: "提出研究委托",
  qt_project_read: "研究项目",
  qt_project_action: "研究下一步",
  qt_evidence_read: "核对研究证据",
};
