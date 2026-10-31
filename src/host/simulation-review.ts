import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { hash } from "../adapters/market.js";
import { assertLedger, metrics } from "../engine/core.js";
import { verifyRun } from "../research/evaluation.js";
import {
  configInput,
  id,
  fail,
  stateSchema,
  strategySchema,
  rulesSchema,
} from "../domain/schemas.js";
import { simulationDiagnosis } from "../domain/simulation-analysis.js";
import type {
  Account,
  RunRecord,
  StrategyRecord,
  Strategy,
} from "../domain/contracts.js";
import type { ResearchProject } from "../domain/project.js";
import type {
  ObservationEvent,
  ObservationRecord,
  SimulationApproval,
  SimulationBaseline,
  SimulationCheckpoint,
  SimulationEvidence,
  SimulationReview,
} from "../domain/simulation.js";
import type { Research } from "./research.js";
import { accountObservationEvents } from "./observation.js";

const timestamp = z.number().int().nonnegative();
export const observationSchema = z
  .object({
    id,
    trackedFrom: timestamp,
    historyComplete: z.boolean(),
    firstMarketAt: timestamp,
    lastMarketAt: timestamp,
    lastTransportAt: timestamp,
    lastBarCloseAt: timestamp,
    transport: z.enum(["connected", "disconnected", "unknown"]),
    gapCount: timestamp,
    gapOpenAt: timestamp.nullable(),
    gapMs: timestamp,
    sessionStartedAt: timestamp.optional(),
  })
  .strict();
export const observationEventSchema = z
  .object({
    id,
    accountId: id,
    at: timestamp,
    generation: timestamp,
    kind: z.enum([
      "start",
      "resume",
      "connected",
      "disconnected",
      "pause",
      "stop",
      "fault",
      "restart",
      "closed",
      "replaced",
    ]),
    reason: z.string(),
  })
  .strict();
const fullConfig = configInput.extend({
  rules: z.record(z.string(), rulesSchema),
  engineVersion: z.string(),
});
const checkpointShape = z
  .object({
    id,
    version: z.literal(1),
    at: z.string(),
    hash: z.string(),
    account: z
      .object({
        id,
        name: z.string(),
        revision: z.number().int().positive(),
        initialCash: z.string(),
        status: z.enum(["created", "running", "paused", "stopped", "failed"]),
        strategyId: id,
        config: fullConfig,
        seen: z.record(z.string(), timestamp),
        lastQuoteAt: z.record(z.string(), timestamp),
        lastEventAt: timestamp,
        error: z.string(),
        generation: timestamp,
        createdAt: z.string(),
        approvalHash: z.string().optional(),
      })
      .strict(),
    definition: strategySchema,
    definitionHash: z.string(),
    result: z.object({ state: stateSchema }).strict(),
    metrics: z.unknown(),
    observation: observationSchema.nullable(),
    events: z.array(observationEventSchema),
    baseline: z.unknown().nullable(),
  })
  .strict();

export function simulationBaseline(
  account: Pick<Account, "id">,
  approvals: SimulationApproval[],
  projects: ResearchProject[],
  runs: RunRecord[],
  definition: Strategy,
): SimulationBaseline | null {
  const approval = approvals.find((a) => a.id === account.id);
  if (!approval) return null;
  const p = projects.find((p) => p.id === approval.projectId),
    report = p?.report;
  if (
    !p ||
    !report ||
    report.hash !== approval.reportHash ||
    report.conclusion !== "supported" ||
    report.synthetic
  )
    fail("SIMULATION_SOURCE", "模拟账户的研究批准来源无法核对");
  const { hash: reportHash, ...reportBody } = report;
  if (hash(reportBody) !== reportHash)
    fail("SIMULATION_SOURCE", "原研究报告完整性校验失败");
  const candidate = p.candidates.find((c) => c.id === p.selectedCandidateId);
  const exp = p.experiments.find(
    (e) =>
      e.candidateId === candidate?.id &&
      e.phase === "holdout" &&
      e.status === "completed",
  );
  const run = runs.find((r) => r.id === exp?.runId);
  if (
    !run?.result ||
    candidate?.definitionHash !== approval.definitionHash ||
    hash(definition) !== approval.definitionHash
  )
    fail("SIMULATION_SOURCE", "缺少原研究最终区间的确切版本与结果");
  verifyRun(run);
  return {
    projectId: p.id,
    reportHash: report.hash,
    runId: run.id,
    manifestHash: run.manifestHash,
    resultHash: run.result.hash,
    config: run.config,
    definition,
    metrics: run.result.metrics,
    from: run.config.from,
    to: run.config.to,
    minClosedTrades: p.protocol.thresholds.minClosedTrades,
    maxDrawdownPct: p.protocol.thresholds.maxDrawdownPct,
  };
}
export function captureSimulation(
  r: Research,
  account: Account,
  now = Date.now(),
): SimulationCheckpoint {
  const strategy = r.store.get<StrategyRecord>("strategy", account.strategyId);
  assertLedger(account.state, account.initialCash);
  const approval = r.store.maybe<SimulationApproval>("approval", account.id);
  const p = approval
    ? r.store.get<ResearchProject>("project", approval.projectId)
    : null;
  const baseline = simulationBaseline(
    account,
    approval ? [approval] : [],
    p ? [p] : [],
    p
      ? p.experiments
          .filter(
            (e) =>
              e.phase === "holdout" &&
              e.candidateId === p.selectedCandidateId &&
              e.status === "completed",
          )
          .map((e) => r.store.get<RunRecord>("run", e.runId))
      : [],
    strategy.definition,
  );
  if (baseline) {
    if (hash(strategy.definition) !== approval!.definitionHash)
      fail("SIMULATION_SOURCE", "模拟策略与批准的研究版本不一致");
    baseline.definition = strategy.definition;
  }
  const { state, ...metadata } = account;
  const body = {
    version: 1 as const,
    at: new Date(now).toISOString(),
    account: metadata,
    definition: strategy.definition,
    definitionHash: hash(strategy.definition),
    result: { state },
    metrics: metrics(state, account.config),
    observation: r.store.maybe<ObservationRecord>("observation", account.id),
    events: accountObservationEvents(r.store, account.id),
    baseline,
  };
  const digest = hash(body);
  return structuredClone({ ...body, id: digest, hash: digest });
}
export function makeSimulationReview(
  c: SimulationCheckpoint,
  reviewId: string,
): SimulationReview {
  const diagnosis = simulationDiagnosis(c);
  const from = c.result.state.curve[0]?.at ?? Date.parse(c.account.createdAt);
  const to = Math.max(
    from,
    c.result.state.curve.at(-1)?.at ?? c.account.lastEventAt,
  );
  const body = {
    id: reviewId,
    accountId: c.account.id,
    at: c.at,
    from,
    to,
    metrics: c.metrics,
    observationGap:
      !diagnosis.health.historyComplete ||
      Boolean(diagnosis.health.gapCount) ||
      c.account.status !== "running" ||
      diagnosis.health.state === "stale",
    status: c.account.status,
    reason:
      "累计账本事实与冻结观察记录；与不同时间区间的历史研究仅作描述性对照。",
    kind: "deterministic" as const,
    version: 2 as const,
    checkpointId: c.id,
    checkpointHash: c.hash,
    diagnosis,
  };
  return { ...body, hash: hash(body) };
}
export function verifySimulationCheckpoint(
  value: unknown,
  accounts: Account[],
  strategies: StrategyRecord[],
  approvals: SimulationApproval[],
  projects: ResearchProject[],
  runs: RunRecord[],
  events: ObservationEvent[],
): SimulationCheckpoint {
  const c = checkpointShape.parse(value) as SimulationCheckpoint;
  const { id: checkpointId, hash: digest, ...body } = c;
  if (
    checkpointId !== digest ||
    hash(body) !== digest ||
    !Number.isFinite(Date.parse(c.at))
  )
    fail("CHECKPOINT_HASH", "模拟复盘快照完整性校验失败");
  if (
    !accounts.some(
      (a) => a.id === c.account.id && a.strategyId === c.account.strategyId,
    ) ||
    c.definitionHash !== hash(c.definition) ||
    !strategies.some(
      (s) =>
        s.id === c.account.strategyId &&
        hash(s.definition) === c.definitionHash,
    )
  )
    fail("CHECKPOINT_REFERENCE", "模拟快照的账户或策略引用无效");
  assertLedger(c.result.state, c.account.initialCash);
  if (
    c.account.initialCash !== c.account.config.initialCash ||
    !isDeepStrictEqual(c.metrics, metrics(c.result.state, c.account.config))
  )
    fail("CHECKPOINT_METRICS", "模拟快照指标与冻结账本不一致");
  if (c.observation && c.observation.id !== c.account.id)
    fail("CHECKPOINT_REFERENCE", "行情观察记录属于其他账户");
  for (const event of c.events)
    if (
      event.accountId !== c.account.id ||
      event.at > Date.parse(c.at) ||
      !events.some((e) => e.id === event.id && isDeepStrictEqual(e, event))
    )
      fail("CHECKPOINT_REFERENCE", "模拟快照的观察事件无法核对");
  const baseline = simulationBaseline(
    c.account,
    approvals,
    projects,
    runs,
    c.definition,
  );
  if (baseline) baseline.definition = c.definition;
  if (!isDeepStrictEqual(c.baseline, baseline))
    fail("CHECKPOINT_BASELINE", "模拟快照的历史研究依据不一致");
  return c;
}
export function verifySimulationReview(
  review: SimulationReview,
  c: SimulationCheckpoint,
) {
  if (!isDeepStrictEqual(review, makeSimulationReview(c, review.id)))
    fail("SIMULATION_REVIEW", "模拟复盘的数值、解释或来源与冻结快照不一致");
}
export function loadSimulationReview(r: Research, reviewId: string) {
  const review = r.store.get<SimulationReview>("simulationReview", reviewId);
  if (review.version !== 2 || !review.checkpointId)
    fail("LEGACY_REVIEW", "历史复盘缺少冻结快照，请先生成当前事实复盘");
  const raw = r.store.get<SimulationCheckpoint>(
    "simulationCheckpoint",
    review.checkpointId,
  );
  const p = raw.baseline
    ? r.store.get<ResearchProject>("project", raw.baseline.projectId)
    : null;
  const checkpoint = verifySimulationCheckpoint(
    raw,
    [r.store.get<Account>("account", review.accountId)],
    [r.store.get<StrategyRecord>("strategy", raw.account.strategyId)],
    r.store.maybe<SimulationApproval>("approval", review.accountId)
      ? [r.store.get<SimulationApproval>("approval", review.accountId)]
      : [],
    p ? [p] : [],
    p
      ? p.experiments
          .filter(
            (e) =>
              e.phase === "holdout" &&
              e.candidateId === p.selectedCandidateId &&
              e.status === "completed",
          )
          .map((e) => r.store.get<RunRecord>("run", e.runId))
      : [],
    accountObservationEvents(r.store, review.accountId),
  );
  verifySimulationReview(review, checkpoint);
  return { review, checkpoint };
}
export function simulationEvidenceValues(
  c: SimulationCheckpoint,
): Record<string, string | number | null> {
  const diagnosis = simulationDiagnosis(c);
  return {
    ...Object.fromEntries(
      Object.entries(c.metrics).map(([key, value]) => [
        `metrics.${key}`,
        value,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(c.baseline?.metrics ?? {}).map(([key, value]) => [
        `baseline.metrics.${key}`,
        value,
      ]),
    ),
    "diagnosis.observedDays": diagnosis.observedDays,
    "diagnosis.baselineDays": diagnosis.baselineDays,
    "diagnosis.frequencyPerDay": diagnosis.frequencyPerDay,
    "diagnosis.baselineFrequencyPerDay": diagnosis.baselineFrequencyPerDay,
    "diagnosis.frequencyRatio": diagnosis.frequencyRatio,
    "diagnosis.feeBps": diagnosis.feeBps,
    "diagnosis.baselineFeeBps": diagnosis.baselineFeeBps,
    "diagnosis.maxDrawdownLimit": c.baseline?.maxDrawdownPct ?? null,
    "diagnosis.health.gapCount": diagnosis.health.gapCount,
    "diagnosis.health.gapMs": diagnosis.health.gapMs,
    "diagnosis.health.lastMarketAt": diagnosis.health.lastMarketAt || null,
    "diagnosis.health.stalePositionCount":
      diagnosis.health.stalePositions.length,
  };
}
export function simulationEvidence(
  r: Research,
  reviewId: string,
  path: string,
): SimulationEvidence {
  const { review, checkpoint } = loadSimulationReview(r, reviewId),
    values = simulationEvidenceValues(checkpoint);
  if (!Object.hasOwn(values, path))
    fail("SIMULATION_EVIDENCE", "复盘证据字段不存在");
  return {
    reviewId,
    reviewHash: review.hash!,
    checkpointId: checkpoint.id,
    checkpointHash: checkpoint.hash,
    path,
    value: values[path]!,
    asOf: checkpoint.at,
  };
}
