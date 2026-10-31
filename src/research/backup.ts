import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { hash } from "../adapters/market.js";
import { id, fail } from "../domain/schemas.js";
import {
  projectInput,
  projectStatus,
  type ResearchProject,
  type ModelDispatch,
  type ProjectReport,
} from "../domain/project.js";
import type {
  Dataset,
  RunRecord,
  StrategyRecord,
} from "../domain/contracts.js";
import {
  evidence,
  evaluate,
  verifyEvidence,
  renderAnalysis,
  researchConclusion,
} from "./evaluation.js";
import { diagnosticMeta } from "../domain/robustness.js";
import { verifyDiagnosticRuns, buildDiagnostics } from "./diagnostics.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative();
const candidate = z
  .object({
    id,
    strategyId: id,
    definitionHash: digest,
    name: z.string().max(100),
    reason: z.string().max(2000),
    parentId: id.optional(),
  })
  .strict();
const exp = z
  .object({
    id,
    candidateId: id,
    phase: z.enum([
      "development",
      "validation",
      "holdout",
      "stress",
      "cost_sensitivity",
      "parameter_sensitivity",
      "walk_train",
      "walk_test",
    ]),
    runId: id,
    status: z.enum([
      "planned",
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
    ]),
    from: integer,
    to: integer,
    reason: z.string(),
    createdAt: z.string(),
    error: z.string().optional(),
    metrics: z.unknown().optional(),
    manifestHash: digest.optional(),
    resultHash: digest.optional(),
    evaluation: z.unknown().optional(),
    computeMs: integer.optional(),
    diagnostic: diagnosticMeta.optional(),
  })
  .strict();
const projectShape = z
  .object({
    id,
    revision: integer,
    generation: integer,
    name: z.string().min(1).max(100),
    objective: z.string().max(4000),
    sourceSessionId: id,
    executionSessionId: id,
    status: projectStatus,
    stage: z.enum([
      "planning",
      "data",
      "candidates",
      "selection",
      "final",
      "report",
    ]),
    protocol: z.unknown(),
    protocolHash: digest,
    authorization: z
      .object({
        hash: digest,
        at: z.string(),
        expiresAt: integer,
        actor: z.literal("user"),
      })
      .strict()
      .optional(),
    ranges: z
      .object({
        development: z.object({ from: integer, to: integer }),
        validation: z.object({ from: integer, to: integer }),
        holdout: z.object({ from: integer, to: integer }),
      })
      .strict(),
    candidates: z.array(candidate).max(6),
    experiments: z.array(exp).max(48),
    datasetIds: z.array(id).max(5),
    dataJobIds: z.array(id).max(15),
    budgetUsed: z
      .object({
        experiments: integer,
        modelRequests: integer,
        computeMs: integer,
        inputTokens: integer,
        outputTokens: integer,
        usageComplete: z.boolean(),
      })
      .strict(),
    selectedCandidateId: id.nullable(),
    selectionHash: digest.nullable(),
    holdoutRevealedAt: z.string().nullable(),
    analyses: z
      .array(
        z
          .object({
            kind: z.enum(["interpretation", "hypothesis"]),
            text: z.string().max(3000),
            evidenceIds: z.array(id).max(30),
            author: z.literal("ai"),
            at: z.string(),
            template: z.string().max(3000).optional(),
          })
          .strict(),
      )
      .max(20),
    answers: z
      .array(z.object({ text: z.string().max(3000), at: z.string() }).strict())
      .max(20)
      .optional(),
    priorExposures: z.array(id).optional(),
    report: z.unknown().optional(),
    activeDispatchId: id.nullable(),
    error: z.string(),
    reason: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
const dispatchShape = z
  .object({
    id,
    projectId: id,
    generation: integer,
    stage: z.enum(["planning", "selection", "report"]),
    status: z.enum([
      "pending",
      "delivered",
      "completed",
      "cancelled",
      "outcome_unknown",
    ]),
    sessionId: id,
    messageId: id,
    createdAt: z.string(),
    requestKeys: z.array(z.string()).max(100),
    usageKeys: z.array(z.string()).max(200),
    error: z.string(),
  })
  .strict();
export function validateProjects(
  input: unknown,
  runs: RunRecord[],
  datasets: Dataset[],
  strategies: StrategyRecord[],
) {
  const raw = z.array(z.unknown()).max(10000).parse(input),
    projects: ResearchProject[] = [];
  for (const item of raw) {
    const v = projectShape.parse(item),
      rawProtocol = z.record(z.string(), z.unknown()).parse(v.protocol);
    const parsed = projectInput.parse({
      ...rawProtocol,
      submissionId: "restore-validation",
      name: v.name,
      objective: v.objective,
    });
    const { submissionId, name, objective, ...protocol } = parsed;
    if (hash(protocol) !== v.protocolHash)
      fail("PROJECT_HASH", "研究协议校验失败");
    const p = { ...v, protocol } as ResearchProject;
    if (
      p.budgetUsed.experiments !== p.experiments.length ||
      p.budgetUsed.experiments > p.protocol.budget.experiments ||
      p.budgetUsed.modelRequests > p.protocol.budget.modelRequests
    )
      fail("PROJECT_BUDGET", "研究预算或实验记录不一致");
    for (const d of p.datasetIds)
      if (!datasets.some((v) => v.id === d))
        fail("BROKEN_REFERENCE", "研究数据引用无效");
    for (const c of p.candidates) {
      const strategy = strategies.find(
        (s) =>
          s.id === c.strategyId &&
          s.projectId === p.id &&
          s.purpose === "research",
      );
      if (
        !strategy ||
        hash(strategy.definition) !== c.definitionHash ||
        strategy.definitionHash !== c.definitionHash
      )
        fail("BROKEN_REFERENCE", "研究候选引用无效");
    }
    const facts = [];
    for (const e of p.experiments) {
      const run = runs.find(
        (r) =>
          r.id === e.runId && r.projectId === p.id && r.experimentId === e.id,
      );
      if (
        !run ||
        !p.candidates.some(
          (c) =>
            c.id === e.candidateId &&
            (e.diagnostic?.strategyId ?? c.strategyId) === run.strategyId,
        )
      )
        fail("BROKEN_REFERENCE", "研究实验引用无效");
      if (e.status === "completed") {
        if (
          run.status !== "completed" ||
          !run.result ||
          e.resultHash !== run.result.hash ||
          e.manifestHash !== run.manifestHash ||
          JSON.stringify(e.metrics) !== JSON.stringify(run.result.metrics) ||
          JSON.stringify(e.evaluation) !== JSON.stringify(evaluate(p, run))
        )
          fail("PROJECT_EVIDENCE", "研究实验摘要与结果不一致");
        facts.push(...evidence(p, e, run));
      }
    }
    for (const a of p.analyses)
      for (const ref of a.evidenceIds)
        if (!facts.some((e) => e.id === ref))
          fail("BROKEN_REFERENCE", "研究解释的证据引用无效");
    for (const a of p.analyses)
      if (renderAnalysis(a.template ?? a.text, facts, a.evidenceIds) !== a.text)
        fail("PROJECT_EVIDENCE", "解释中的数值与证据不一致");
    verifyDiagnosticRuns(p, runs, strategies, p.status === "completed");
    if (v.report) {
      const report = z
        .object({
          version: z.literal(1),
          projectId: id,
          protocolHash: digest,
          generatedAt: z.string(),
          conclusion: z.enum(["supported", "rejected", "inconclusive"]),
          summary: z.string(),
          selectedCandidateId: id.nullable(),
          synthetic: z.boolean(),
          facts: z.array(z.unknown()),
          analyses: z.array(z.unknown()),
          limitations: z.array(z.string()),
          experiments: z.array(z.unknown()),
          hash: digest,
          markdown: z.string(),
          diagnostics: z.unknown().optional(),
        })
        .strict()
        .parse(v.report) as ProjectReport;
      const { hash: reportHash, markdown, ...body } = report;
      if (
        hash({ ...body, markdown }) !== reportHash ||
        report.projectId !== p.id ||
        report.protocolHash !== p.protocolHash ||
        p.status !== "completed"
      )
        fail("PROJECT_REPORT", "研究报告校验失败");
      if (
        report.facts.length !== facts.length ||
        !isDeepStrictEqual(report.analyses, p.analyses)
      )
        fail("PROJECT_REPORT", "报告事实或解释存在遗漏");
      for (const ref of report.facts) {
        const actual = facts.find((f) => f.id === ref.id);
        if (!actual || JSON.stringify(actual) !== JSON.stringify(ref))
          fail("PROJECT_EVIDENCE", "报告事实与实验不一致");
        verifyEvidence(ref, runs.find((r) => r.id === ref.runId)!);
      }
      if (
        p.protocol.robustness &&
        !isDeepStrictEqual(report.diagnostics, buildDiagnostics(p, runs, facts))
      )
        fail("DIAGNOSTIC_REPORT", "报告稳健性结果与真实实验不一致");
      if (p.protocol.robustness) {
        const synthetic = datasets.some(
          (d) => p.datasetIds.includes(d.id) && d.synthetic,
        );
        if (
          report.synthetic !== synthetic ||
          report.conclusion !== researchConclusion(p, synthetic) ||
          report.selectedCandidateId !== p.selectedCandidateId
        )
          fail("DIAGNOSTIC_REPORT", "稳健性报告结论与冻结协议不一致");
      }
      if (!p.protocol.robustness && report.diagnostics)
        fail("DIAGNOSTIC_PROTOCOL", "报告包含未授权的稳健性结果");
      p.report = report;
    } else if (p.status === "completed")
      fail("PROJECT_REPORT", "已交付研究缺少报告");
    if (!["completed", "cancelled"].includes(p.status)) {
      p.status = "paused";
      p.reason = "从备份恢复，请检查研究协议后手动继续";
      p.revision++;
      p.generation++;
    }
    p.activeDispatchId = null;
    projects.push(p);
  }
  return projects;
}
export function validateDispatches(
  input: unknown,
  projects: ResearchProject[],
) {
  return z
    .array(dispatchShape)
    .max(100000)
    .parse(input)
    .map((d) => {
      if (
        !projects.some(
          (p) => p.id === d.projectId && p.executionSessionId === d.sessionId,
        )
      )
        fail("BROKEN_REFERENCE", "研究派发引用无效");
      if (!["completed", "cancelled"].includes(d.status))
        d.status = "cancelled";
      return d as ModelDispatch;
    });
}
