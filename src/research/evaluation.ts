import { hash } from "../adapters/market.js";
import { D, assertLedger } from "../engine/core.js";
import { fail } from "../domain/schemas.js";
import type { RunRecord } from "../domain/contracts.js";
import type {
  Evaluation,
  EvidenceRef,
  ProjectExperiment,
  ProjectReport,
  ResearchProject,
} from "../domain/project.js";

export function evaluate(project: ResearchProject, run: RunRecord): Evaluation {
  if (run.status !== "completed" || !run.result)
    return {
      verdict: "insufficient",
      reasons: [{ code: "RUN_NOT_READY", message: "实验没有完整结果" }],
    };
  const m = run.result.metrics,
    t = project.protocol.thresholds;
  const reasons: Evaluation["reasons"] = [];
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
      .minus(run.result.benchmarks.buyHoldReturnPct)
      .lt(t.minExcessReturnPct)
  )
    reasons.push({
      code: "BASELINE_UNDERPERFORMANCE",
      message: `相对买入持有的超额收益低于协议要求 ${t.minExcessReturnPct}%`,
    });
  const hardFailure = reasons.some((r) => r.code !== "SAMPLE_INSUFFICIENT");
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
  return paths.map((path) => ({
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
    value: resolveValue(run, path),
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
export function makeReport(
  p: ResearchProject,
  facts: EvidenceRef[],
  synthetic: boolean,
): ProjectReport {
  const selected = p.experiments.filter(
    (e) =>
      e.candidateId === p.selectedCandidateId &&
      ["validation", "holdout", "stress"].includes(e.phase),
  );
  const failed = selected.some((e) => e.evaluation?.verdict === "fail");
  const full = ["validation", "holdout", "stress"].every((phase) =>
    selected.some((e) => e.phase === phase && e.evaluation?.verdict === "pass"),
  );
  const conclusion: ProjectReport["conclusion"] = synthetic
    ? "inconclusive"
    : failed
      ? "rejected"
      : p.priorExposures?.length
        ? "inconclusive"
        : full
          ? "supported"
          : "inconclusive";
  const summary = synthetic
    ? "合成数据仅用于检验研究流程，不能支持市场有效性结论。"
    : conclusion === "supported"
      ? "所选候选通过本协议的验证、最终保留区间和成本压力门槛，可提交用户决定是否模拟观察。"
      : conclusion === "rejected"
        ? "所选候选未通过预先约定的评估门槛，当前研究不支持推进模拟观察。"
        : "样本或已完成实验不足以支持研究假设，需要补充新的证据。";
  const limitations = [
    "固定现货交易对池、只做多、K线级成本与成交模型；不代表真实可成交收益。",
    "交易规则取自当前快照，未还原全部历史规则；期末持仓按收盘估值。",
    "买入持有基准使用等权初始配置并计入建仓成本，期末按市值估值；不假设自动平仓。",
    "开发和验证区间用于候选选择，最终保留区间仅在选定候选后揭示；再次使用本区间不能称为新的盲测。",
    "多个候选、有限参数邻域和时间切分不能消除过拟合；没有通用盈利保证。",
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
  };
  const markdown = `# ${escape(p.name)}\n\n${summary}\n\n研究目标：${escape(p.objective)}\n\n项目：${p.id}\n协议：${p.protocolHash}\n执行方式：${p.protocol.mode === "agent" ? "Harness Agent" : "固定研究协议"}\n\n## 冻结协议\n\n\`\`\`json\n${JSON.stringify(p.protocol, null, 2)}\n\`\`\`\n\n## 全部实验\n\n| 实验 | 阶段 | 候选 | 状态 | 评估 | Run |\n| --- | --- | --- | --- | --- | --- |\n${body.experiments.map((e) => `| ${e.id} | ${e.phase} | ${e.candidateId} | ${e.status} | ${e.evaluation?.verdict ?? "—"} | ${e.runId} |`).join("\n")}\n\n## 可核对事实\n\n| 证据 | 字段 | 值 | Run |\n| --- | --- | --- | --- |\n${facts.map((f) => `| ${f.id} | ${f.path} | ${f.value ?? "样本不足"} | ${f.runId} |`).join("\n")}\n\n## AI解释与待验证假设\n\n${p.analyses.length ? p.analyses.map((a) => `- ${a.kind}：${escape(a.text)}（证据：${a.evidenceIds.join(", ")}）`).join("\n") : "本报告没有额外的模型解释。"}\n\n## 限制\n\n${limitations.map((s) => `- ${s}`).join("\n")}\n`;
  return { ...body, hash: hash({ ...body, markdown }), markdown };
}
