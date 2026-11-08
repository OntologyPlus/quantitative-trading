import { parse as parseDsl, print as printDsl, scalePeriods } from "./dsl.js";
import { z } from "zod";
/** 32-bit FNV-1a, enough to tell expression variants apart in a key. */
const fnv1a = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
};
import { Decimal } from "decimal.js";
import { INTERVAL_MS, type Strategy } from "./contracts.js";
import { id, strategySchema } from "./schemas.js";
import type {
  Evaluation,
  Phase,
  ProjectExperiment,
  ResearchProject,
} from "./project.js";

export const robustnessInput = z
  .object({
    version: z.literal(1).default(1),
    parameterVersion: z.literal(2).optional(),
    costMultipliers: z
      .array(z.number().gt(1).max(10))
      .min(1)
      .max(4)
      .refine((a) => new Set(a).size === a.length, "成本情景不能重复")
      .default([1.5, 2, 3]),
    parameterShiftPct: z.number().int().min(10).max(50).default(20),
    walkForwardFolds: z.number().int().min(2).max(4).default(3),
    minPassRatePct: z.number().min(1).max(100).default(50),
  })
  .strict();
export type RobustnessProtocol = z.infer<typeof robustnessInput>;
export const diagnosticMeta = z
  .object({
    key: z.string().min(1).max(200),
    multiplier: z.number().gt(1).max(10).optional(),
    fold: z.number().int().min(0).max(3).optional(),
    definition: strategySchema.optional(),
    baseDefinition: strategySchema.optional(),
    strategyId: id.optional(),
    trainingExperimentIds: z.array(id).max(6).optional(),
  })
  .strict();
export type DiagnosticMeta = z.infer<typeof diagnosticMeta>;
export interface DiagnosticPlan {
  candidateId: string;
  phase: Phase;
  from: number;
  to: number;
  diagnostic: DiagnosticMeta;
}
export function minimumExperiments(
  candidateCount: number,
  r?: RobustnessProtocol,
  initialCount = candidateCount,
) {
  return (
    candidateCount * 2 +
    2 +
    (r
      ? r.costMultipliers.length + 2 + r.walkForwardFolds * (initialCount + 1)
      : 0)
  );
}
export function parameterNeighbors(
  strategy: Strategy,
  shiftPct: number,
  parameterVersion: 1 | 2 = 2,
) {
  if (strategy.conditions && parameterVersion === 2) {
    const first = strategy.conditions.entry[0]!;
    const upper = Math.min(1000, Math.floor(2003 / first.factor) - 2);
    const delta = Math.max(1, Math.round((first.period * shiftPct) / 100));
    return [
      ...new Set(
        [-1, 1].map((sign) =>
          Math.max(2, Math.min(upper, first.period + sign * delta)),
        ),
      ),
    ]
      .filter((period) => period !== first.period)
      .map((period) => ({
        ...strategy,
        conditions: {
          ...strategy.conditions!,
          entry: strategy.conditions!.entry.map((c, i) =>
            i === 0 ? { ...c, period } : { ...c },
          ),
          exit: strategy.conditions!.exit.map((c) => ({ ...c })),
        },
      }));
  }
  if (strategy.template === "expr" || strategy.template === "rotation") {
    // Shift every indicator period in the expressions by ±shiftPct.
    const scale = (f: number) => (text: string, kind: "bool" | "series") =>
      printDsl(scalePeriods(parseDsl(text, kind), f));
    return [1 - shiftPct / 100, 1 + shiftPct / 100]
      .map((f) =>
        strategy.template === "expr"
          ? {
              ...strategy,
              rules: {
                ...strategy.rules!,
                entry: scale(f)(strategy.rules!.entry, "bool"),
                exit: scale(f)(strategy.rules!.exit, "bool"),
              },
            }
          : {
              ...strategy,
              rotation: {
                ...strategy.rotation!,
                score: scale(f)(strategy.rotation!.score, "series"),
                ...(strategy.rotation!.filter
                  ? { filter: scale(f)(strategy.rotation!.filter, "bool") }
                  : {}),
              },
            },
      )
      .filter(
        (x, i, all) =>
          JSON.stringify(x) !== JSON.stringify(strategy) &&
          all.findIndex((y) => JSON.stringify(y) === JSON.stringify(x)) === i,
      );
  }
  const key = strategy.template === "sma_cross" ? "slow" : "entryPeriod";
  const lower = key === "slow" ? strategy.fast + 1 : 2;
  const upper = key === "slow" ? 2000 : 1000;
  const delta = Math.max(1, Math.round((strategy[key] * shiftPct) / 100));
  return [
    ...new Set(
      [-1, 1].map((sign) =>
        Math.max(lower, Math.min(upper, strategy[key] + sign * delta)),
      ),
    ),
  ]
    .filter((value) => value !== strategy[key])
    .map((value) => ({ ...strategy, [key]: value }));
}
export function successfulDiagnostic(p: ResearchProject, key: string) {
  return p.experiments.find(
    (e) => e.diagnostic?.key === key && e.status === "completed",
  );
}
function trainingRank(a: ProjectExperiment, b: ProjectExperiment) {
  const score = (e: ProjectExperiment) =>
    e.evaluation?.verdict === "pass"
      ? 2
      : e.evaluation?.verdict === "insufficient"
        ? 1
        : 0;
  return (
    score(b) - score(a) ||
    new Decimal(b.metrics!.returnPct).cmp(a.metrics!.returnPct) ||
    a.candidateId.localeCompare(b.candidateId)
  );
}
export function diagnosticPlan(
  p: ResearchProject,
  selected: Strategy,
): DiagnosticPlan[] {
  const r = p.protocol.robustness;
  if (!r || !p.selectedCandidateId) return [];
  const plans: DiagnosticPlan[] = [],
    candidateId = p.selectedCandidateId;
  for (const multiplier of [...r.costMultipliers].sort((a, b) => a - b))
    plans.push({
      candidateId,
      phase: "cost_sensitivity",
      ...p.ranges.validation,
      diagnostic: { key: `cost:${multiplier}`, multiplier },
    });
  for (const definition of parameterNeighbors(
    selected,
    r.parameterShiftPct,
    r.parameterVersion ?? 1,
  ))
    plans.push({
      candidateId,
      phase: "parameter_sensitivity",
      ...p.ranges.validation,
      diagnostic: {
        key:
          definition.conditions && r.parameterVersion === 2
            ? `parameter:conditions:entry:0:period:${definition.conditions.entry[0]!.period}`
            : definition.rules || definition.rotation
              ? `parameter:${definition.template}:${fnv1a(JSON.stringify(definition.rules ?? definition.rotation))}`
              : `parameter:${definition.slow}:${definition.entryPeriod}`,
        definition,
        baseDefinition: selected,
      },
    });
  // Only the pool fixed before any research is eligible for historical rolling selection.
  // Agent proposals may have used validation evidence from later than a rolling fold.
  const initial = p.candidates.slice(0, p.protocol.candidates?.length ?? 2);
  const step = INTERVAL_MS[p.protocol.interval],
    from = p.protocol.from;
  const count = Math.round((p.ranges.validation.to - from) / step) + 1;
  const training = Math.floor(count / 2),
    testSize = Math.floor((count - training) / r.walkForwardFolds);
  for (let fold = 0; fold < r.walkForwardFolds; fold++) {
    const testFrom = from + (training + fold * testSize) * step;
    const testTo =
      fold === r.walkForwardFolds - 1
        ? p.ranges.validation.to
        : testFrom + (testSize - 1) * step;
    const trained: ProjectExperiment[] = [];
    for (const c of initial) {
      const key = `walk:${fold}:train:${c.id}`;
      plans.push({
        candidateId: c.id,
        phase: "walk_train",
        from,
        to: testFrom - step,
        diagnostic: { key, fold },
      });
      const result = successfulDiagnostic(p, key);
      if (result) trained.push(result);
    }
    if (trained.length === initial.length && trained.length) {
      const best = [...trained].sort(trainingRank)[0]!;
      plans.push({
        candidateId: best.candidateId,
        phase: "walk_test",
        from: testFrom,
        to: testTo,
        diagnostic: {
          key: `walk:${fold}:test`,
          fold,
          trainingExperimentIds: trained.map((e) => e.id),
        },
      });
    }
  }
  return plans;
}
export function diagnosticConfig(p: ResearchProject, plan: DiagnosticPlan) {
  const costs = { ...p.protocol.config.costs };
  if (plan.diagnostic.multiplier) {
    costs.feeBps = new Decimal(costs.feeBps)
      .mul(plan.diagnostic.multiplier)
      .toFixed();
    costs.slippageBps = new Decimal(costs.slippageBps)
      .mul(plan.diagnostic.multiplier)
      .toFixed();
  }
  return { ...p.protocol.config, from: plan.from, to: plan.to, costs };
}
export function diagnosticsFinished(p: ResearchProject, selected: Strategy) {
  if (!p.protocol.robustness) return true;
  const plans = diagnosticPlan(p, selected),
    r = p.protocol.robustness;
  const initial = p.protocol.candidates?.length ?? 2;
  return (
    plans.length ===
      r.costMultipliers.length +
        parameterNeighbors(
          selected,
          r.parameterShiftPct,
          r.parameterVersion ?? 1,
        ).length +
        r.walkForwardFolds * (initial + 1) &&
    plans.every((plan) => successfulDiagnostic(p, plan.diagnostic.key))
  );
}
export function robustnessChecks(p: ResearchProject): {
  name: string;
  phase: Phase;
  pass: number;
  total: number;
  verdict: Evaluation["verdict"];
}[] {
  if (!p.protocol.robustness) return [];
  return (
    [
      ["成本情景", "cost_sensitivity"],
      ["参数邻域", "parameter_sensitivity"],
      ["滚动样本外窗口", "walk_test"],
    ] as const
  ).map(([name, phase]) => {
    const keys = [
      ...new Set(
        p.experiments
          .filter((e) => e.phase === phase)
          .map((e) => e.diagnostic?.key)
          .filter(Boolean),
      ),
    ];
    const rows = keys.map((key) => successfulDiagnostic(p, key!));
    const pass = rows.filter((e) => e?.evaluation?.verdict === "pass").length;
    const insufficient = rows.filter(
      (e) => !e || e.evaluation?.verdict === "insufficient" || !e.evaluation,
    ).length;
    const threshold = p.protocol.robustness!.minPassRatePct;
    const verdict = !rows.length
      ? "insufficient"
      : pass * 100 >= rows.length * threshold
        ? "pass"
        : (pass + insufficient) * 100 >= rows.length * threshold
          ? "insufficient"
          : "fail";
    return { name, phase, pass, total: rows.length, verdict };
  });
}
