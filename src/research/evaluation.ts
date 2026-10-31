import { researchQuality } from "./quality.js";
import { INTERVAL_MS } from "../domain/contracts.js";
import { hash } from "../adapters/market.js";
import { D, assertLedger } from "../engine/core.js";
import { fail } from "../domain/schemas.js";
import type { Dataset, RunRecord } from "../domain/contracts.js";
import {
  researchConditions,
  reportChecks,
  researchNextSteps,
} from "../domain/research-view.js";
import type {
  Evaluation,
  EvidenceRef,
  ProjectExperiment,
  ProjectReport,
  ResearchProject,
} from "../domain/project.js";
import { attributionValues } from "../domain/attribution.js";
import { robustnessChecks } from "../domain/robustness.js";
import { buildDiagnostics, diagnosticsMarkdown } from "./diagnostics.js";

export function evaluate(project: ResearchProject, run: RunRecord): Evaluation {
  if (run.status !== "completed" || !run.result)
    return {
      verdict: "insufficient",
      reasons: [{ code: "RUN_NOT_READY", message: "实验没有完整结果" }],
    };
  const m = run.result.metrics,
    t = project.protocol.thresholds;
  const reasons: Evaluation["reasons"] = [];
  const acceptance = project.protocol.acceptance;
  if (acceptance) {
    const days =
      (run.config.to -
        run.config.from +
        INTERVAL_MS[project.protocol.interval]) /
      86400000;
    if (days < acceptance.minDays)
      reasons.push({
        code: "DURATION_INSUFFICIENT",
        message: "评估跨度低于冻结的最少天数",
      });
    if (
      acceptance.minReturnPct !== undefined &&
      D(m.returnPct).lt(acceptance.minReturnPct)
    )
      reasons.push({
        code: "ABSOLUTE_RETURN",
        message: "绝对收益未达到冻结目标",
      });
  }
  if (m.closedTrades < t.minClosedTrades)
    reasons.push({
      code: "SAMPLE_INSUFFICIENT",
      message: `平仓样本 ${m.closedTrades}，低于协议要求 ${t.minClosedTrades}`,
    });
  if (D(m.maxDrawdownPct).gt(t.maxDrawdownPct))
    reasons.push({
      code: "DRAWDOWN_LIMIT",
      message: `回撤超过协议上限 ${t.maxDrawdownPct}%`,
    });
  if (
    D(m.returnPct)
      .minus(
        acceptance?.benchmark === "cash"
          ? run.result.benchmarks.cashReturnPct
          : run.result.benchmarks.buyHoldReturnPct,
      )
      .lt(t.minExcessReturnPct)
  )
    reasons.push({
      code: "BASELINE_UNDERPERFORMANCE",
      message: `相对${acceptance?.benchmark === "cash" ? "现金" : "买入持有"}的超额收益低于协议要求 ${t.minExcessReturnPct}%`,
    });
  const hardFailure = reasons.some(
    (r) => !["SAMPLE_INSUFFICIENT", "DURATION_INSUFFICIENT"].includes(r.code),
  );
  return {
    verdict: hardFailure ? "fail" : reasons.length ? "insufficient" : "pass",
    reasons,
  };
}

const paths = [
  "metrics.returnPct",
  "metrics.maxDrawdownPct",
  "metrics.closedTrades",
  "metrics.fees",
  "metrics.slippage",
  "metrics.sharpe",
  "metrics.exposurePct",
  "benchmarks.buyHoldReturnPct",
] as const;
export function resolveValue(
  run: RunRecord,
  path: string,
): string | number | null {
  if (
    path.startsWith("uncertainty.") &&
    run.result &&
    run.status === "completed"
  ) {
    const quality = researchQuality(run, 1),
      range = quality.meanDailyReturnIntervalPct;
    const values: Record<string, number | null> = {
      "uncertainty.dailySamples": quality.dailySamples,
      "uncertainty.meanDailyReturnLowerPct": range?.[0] ?? null,
      "uncertainty.meanDailyReturnUpperPct": range?.[1] ?? null,
    };
    if (!Object.hasOwn(values, path))
      fail("EVIDENCE_PATH", "不确定性证据字段不存在");
    return values[path]!;
  }
  if (
    path.startsWith("attribution.") &&
    run.result &&
    run.status === "completed"
  ) {
    const values = attributionValues(run);
    if (!Object.hasOwn(values, path))
      fail("EVIDENCE_PATH", "归因证据字段不存在");
    return values[path]!;
  }
  if (!paths.includes(path as (typeof paths)[number]) || !run.result)
    fail("EVIDENCE_PATH", "证据字段不存在");
  const [group, key] = path.split(".") as ["metrics" | "benchmarks", string];
  return (
    (run.result[group] as unknown as Record<string, string | number | null>)[
      key
    ] ?? null
  );
}
export function evidence(
  project: ResearchProject,
  experiment: ProjectExperiment,
  run: RunRecord,
): EvidenceRef[] {
  if (!run.result || run.status !== "completed") return [];
  const derived =
    project.protocol.robustness && experiment.phase === "holdout"
      ? attributionValues(run)
      : {};
  const uncertainty =
    project.protocol.acceptance && experiment.phase === "holdout"
      ? [
          "uncertainty.dailySamples",
          "uncertainty.meanDailyReturnLowerPct",
          "uncertainty.meanDailyReturnUpperPct",
        ]
      : [];
  return [...paths, ...Object.keys(derived), ...uncertainty].map((path) => ({
    id: hash({ project: project.id, experiment: experiment.id, path }).slice(
      0,
      40,
    ),
    projectId: project.id,
    experimentId: experiment.id,
    runId: run.id,
    manifestHash: run.manifestHash,
    resultHash: run.result!.hash,
    path,
    value: Object.hasOwn(derived, path)
      ? derived[path]!
      : resolveValue(run, path),
    from: run.config.from,
    to: run.config.to,
  }));
}
export function verifyRun(run: RunRecord) {
  if (!run.result || run.status !== "completed")
    fail("EVIDENCE_NOT_READY", "证据所引实验未完成");
  const { hash: digest, ...body } = run.result;
  if (hash(body) !== digest)
    fail("EVIDENCE_HASH", "实验结果已改变，无法交付证据");
  assertLedger(run.result.state, run.config.initialCash);
}
export function verifyEvidence(
  ref: EvidenceRef,
  run: RunRecord,
  checkHash = true,
) {
  if (checkHash) verifyRun(run);
  if (
    ref.runId !== run.id ||
    ref.manifestHash !== run.manifestHash ||
    ref.resultHash !== run.result!.hash ||
    resolveValue(run, ref.path) !== ref.value ||
    ref.from !== run.config.from ||
    ref.to !== run.config.to
  )
    fail("EVIDENCE_MISMATCH", "证据身份、数值或区间不匹配");
}
export function renderAnalysis(
  text: string,
  facts: EvidenceRef[],
  evidenceIds: string[],
) {
  const refs = new Map(facts.map((f) => [f.id, f]));
  const withoutValues = text.replace(/\[\[e:([a-zA-Z0-9_-]{1,100})\]\]/g, "");
  if (
    /\d/.test(withoutValues) ||
    withoutValues.includes("[[") ||
    withoutValues.includes("]]")
  )
    fail(
      "NUMERIC_CLAIM",
      "解释中的数字须使用 [[e:证据ID]] 引用，由程序填入；其余文字请保持定性表述",
    );
  return text.replace(
    /\[\[e:([a-zA-Z0-9_-]{1,100})\]\]/g,
    (_all, id: string) => {
      const ref = refs.get(id);
      if (!ref || !evidenceIds.includes(id))
        fail("EVIDENCE_MISSING", "解释中的数值引用未关联有效证据");
      return ref.value === null ? "样本不足" : String(ref.value);
    },
  );
}
export function rankCandidates(p: ResearchProject) {
  return p.candidates
    .filter((c) =>
      p.experiments.some(
        (e) =>
          e.candidateId === c.id &&
          e.phase === "validation" &&
          e.status === "completed",
      ),
    )
    .sort((a, b) => {
      const ex = (id: string) =>
        p.experiments.find(
          (e) =>
            e.candidateId === id &&
            e.phase === "validation" &&
            e.status === "completed",
        )!;
      const x = ex(a.id),
        y = ex(b.id),
        score = (e: ProjectExperiment) =>
          e.evaluation?.verdict === "pass"
            ? 2
            : e.evaluation?.verdict === "insufficient"
              ? 1
              : 0;
      return (
        score(y) - score(x) ||
        Number(y.metrics!.returnPct) - Number(x.metrics!.returnPct) ||
        a.id.localeCompare(b.id)
      );
    });
}
const escape = (s: string) => s.replace(/[\r\n|]/g, " ");
export function researchConclusion(
  p: ResearchProject,
  synthetic: boolean,
): ProjectReport["conclusion"] {
  const selected = p.experiments.filter(
    (e) =>
      e.candidateId === p.selectedCandidateId &&
      ["validation", "holdout", "stress"].includes(e.phase),
  );
  const checks = robustnessChecks(p);
  if (synthetic) return "inconclusive";
  if (
    selected.some((e) => e.evaluation?.verdict === "fail") ||
    checks.some((c) => c.verdict === "fail")
  )
    return "rejected";
  if (p.priorExposures?.length) return "inconclusive";
  return ["validation", "holdout", "stress"].every((phase) =>
    selected.some((e) => e.phase === phase && e.evaluation?.verdict === "pass"),
  ) && checks.every((c) => c.verdict === "pass")
    ? "supported"
    : "inconclusive";
}
export function makeReport(
  p: ResearchProject,
  facts: EvidenceRef[],
  synthetic: boolean,
  datasets: Dataset[] = [],
  runs: RunRecord[] = [],
): ProjectReport {
  const conclusion = researchConclusion(p, synthetic);
  const summary = synthetic
    ? "合成数据仅用于检验研究流程，不能支持市场有效性结论。"
    : conclusion === "supported"
      ? `所选候选通过本协议的验证、最终保留区间和成本压力门槛${p.protocol.robustness ? "，且各类稳健性诊断满足冻结的通过率要求" : ""}，可提交用户决定是否模拟观察。`
      : conclusion === "rejected"
        ? "所选候选未通过预先约定的评估门槛，当前研究不支持推进模拟观察。"
        : "样本或已完成实验不足以支持研究假设，需要补充新的证据。";
  const diagnostics = p.protocol.robustness
    ? buildDiagnostics(p, runs, facts)
    : undefined;
  const limitations = [
    ...researchConditions(p, datasets)
      .filter((c) =>
        ["研究范围", "研究时间（UTC）", "数据来源", "手续费", "滑点"].includes(
          c.label,
        ),
      )
      .map((c) => `${c.label}：${c.value}。`),
    "固定现货交易对池、只做多、K线级成本与成交模型；不代表真实可成交收益。",
    datasets.some((d) => d.provenance?.ruleHistory?.length)
      ? "已提供规则档案的市场按生效和已知时间应用历史规则，其余仍按快照近似；来源真实性未独立认证；期末持仓按收盘估值。"
      : "交易规则取自当前快照，未还原全部历史规则；期末持仓按收盘估值。",
    "买入持有基准使用等权初始配置并计入建仓成本，期末按市值估值；不假设自动平仓。",
    "开发和验证区间用于候选选择，最终保留区间仅在选定候选后揭示；再次使用本区间不能称为新的盲测。",
    "多个候选、有限参数邻域和时间切分不能消除过拟合；没有通用盈利保证。",
    ...(p.protocol.acceptance
      ? [
          `明确验收目标：基准${p.protocol.acceptance.benchmark}；最低绝对收益${p.protocol.acceptance.minReturnPct ?? "未设"}%；每项评估最少${p.protocol.acceptance.minDays}天。`,
          `本项目尝试${p.candidates.length}个候选；最终区间日均收益区间采用固定种子的500次区块重采样，至少30个连续日收益；不是未来收益概率，未作多重筛选校正。`,
        ]
      : []),
    ...(diagnostics?.limitations ?? []),
    ...(synthetic ? ["所有结果包含合成演示数据，不是市场实绩。"] : []),
    ...(p.protocol.mode === "protocol"
      ? ["本次按固定研究协议自动执行，未使用模型规划或生成解释。"]
      : []),
    ...(!p.budgetUsed.usageComplete
      ? ["宿主未完整报告模型用量；缺失用量未记作零费用。"]
      : []),
    ...(p.priorExposures?.length
      ? [
          `最终区间与此前已揭示研究重叠，本次不能作为新的盲测：${p.priorExposures.join(", ")}`,
        ]
      : []),
  ];
  const body = {
    version: 1 as const,
    projectId: p.id,
    protocolHash: p.protocolHash,
    generatedAt: new Date().toISOString(),
    conclusion,
    summary,
    selectedCandidateId: p.selectedCandidateId,
    synthetic,
    facts,
    analyses: p.analyses,
    limitations,
    experiments: p.experiments.map((e) => ({
      id: e.id,
      phase: e.phase,
      candidateId: e.candidateId,
      runId: e.runId,
      status: e.status,
      ...(e.evaluation ? { evaluation: e.evaluation } : {}),
    })),
    ...(diagnostics ? { diagnostics } : {}),
  };
  const reading = `## 研究条件\n\n| 条件 | 本次实际口径 | 来源 |\n| --- | --- | --- |\n${researchConditions(
    p,
    datasets,
  )
    .map((c) => `| ${c.label} | ${escape(c.value)} | ${c.origin} |`)
    .join("\n")}\n\n## 关键依据与反证\n\n${reportChecks(p)
    .map((c) => `- ${c.phase}：${escape(c.text)}（实验 ${c.experimentId}）`)
    .join(
      "\n",
    )}\n\n通过仅表示满足本协议门槛，不等于证明未来收益。\n\n## 限制（引用时务必保留）\n\n${limitations.map((s) => `- ${escape(s)}`).join("\n")}\n\n## 下一步\n\n${researchNextSteps(
    p,
    synthetic,
  )
    .map((s) => `- ${s}`)
    .join("\n")}\n\n${diagnostics ? diagnosticsMarkdown(diagnostics) : ""}`;
  const markdown = `# ${escape(p.name)}\n\n${summary}\n\n研究目标：${escape(p.objective)}\n\n${reading}项目：${p.id}\n协议：${p.protocolHash}\n执行方式：${p.protocol.mode === "agent" ? "Harness Agent" : "固定研究协议"}\n\n## 冻结协议\n\n\`\`\`json\n${JSON.stringify(p.protocol, null, 2)}\n\`\`\`\n\n## 全部实验\n\n| 实验 | 阶段 | 候选 | 状态 | 评估 | Run |\n| --- | --- | --- | --- | --- | --- |\n${body.experiments.map((e) => `| ${e.id} | ${e.phase} | ${e.candidateId} | ${e.status} | ${e.evaluation?.verdict ?? "—"} | ${e.runId} |`).join("\n")}\n\n## 可核对事实\n\n| 证据 | 字段 | 值 | Run |\n| --- | --- | --- | --- |\n${facts.map((f) => `| ${f.id} | ${f.path} | ${f.value ?? "样本不足"} | ${f.runId} |`).join("\n")}\n\n## AI解释与待验证假设\n\n${p.analyses.length ? p.analyses.map((a) => `- ${a.kind}：${escape(a.text)}（证据：${a.evidenceIds.join(", ")}）`).join("\n") : "本报告没有额外的模型解释。"}\n`;
  return { ...body, hash: hash({ ...body, markdown }), markdown };
}
