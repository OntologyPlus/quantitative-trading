import { isDeepStrictEqual } from "node:util";
import { hash } from "../adapters/market.js";
import { fail } from "../domain/schemas.js";
import { attributeRun, type RunAttribution } from "../domain/attribution.js";
import {
  diagnosticPlan,
  diagnosticConfig,
  diagnosticsFinished,
  robustnessChecks,
} from "../domain/robustness.js";
import type { RunRecord, StrategyRecord } from "../domain/contracts.js";
import type { EvidenceRef, Phase, ResearchProject } from "../domain/project.js";

export interface ResearchDiagnostics {
  version: 1;
  checks: ReturnType<typeof robustnessChecks>;
  rows: {
    experimentId: string;
    candidateName: string;
    phase: Phase;
    from: number;
    to: number;
    multiplier?: number;
    fold?: number;
    parameter?: string;
    returnPct: string;
    maxDrawdownPct: string;
    closedTrades: number;
    fees: string;
    slippage: string;
    verdict: string;
    reasons: string[];
    evidenceIds: string[];
  }[];
  attribution: { runId: string; resultHash: string; data: RunAttribution };
  limitations: string[];
}

export function verifyDiagnosticRuns(
  p: ResearchProject,
  runs: RunRecord[],
  strategies: StrategyRecord[],
  requireComplete = false,
) {
  const diagnosticPhases = [
    "cost_sensitivity",
    "parameter_sensitivity",
    "walk_train",
    "walk_test",
  ];
  const extras = p.experiments.filter(
    (e) => e.diagnostic || diagnosticPhases.includes(e.phase),
  );
  if (!p.protocol.robustness) {
    if (extras.length) fail("DIAGNOSTIC_PROTOCOL", "稳健性实验缺少冻结协议");
    return;
  }
  if (!p.selectedCandidateId) {
    if (extras.length || requireComplete)
      fail("DIAGNOSTIC_SELECTION", "稳健性实验需要先冻结候选");
    return;
  }
  const candidate = p.candidates.find((c) => c.id === p.selectedCandidateId)!;
  const selected = strategies.find((s) => s.id === candidate?.strategyId);
  if (!selected || hash(selected.definition) !== candidate.definitionHash)
    fail("DIAGNOSTIC_STRATEGY", "稳健性研究的原始候选身份无效");
  const plans = diagnosticPlan(p, selected.definition);
  for (const e of extras) {
    const plan = plans.find(
      (plan) => plan.diagnostic.key === e.diagnostic?.key,
    );
    if (!plan || !e.diagnostic || !p.selectionHash)
      fail("DIAGNOSTIC_PLAN", "实验不属于已冻结的稳健性研究计划");
    const { strategyId, ...meta } = e.diagnostic;
    if (
      e.phase !== plan.phase ||
      e.candidateId !== plan.candidateId ||
      e.from !== plan.from ||
      e.to !== plan.to ||
      !isDeepStrictEqual(meta, plan.diagnostic)
    )
      fail("DIAGNOSTIC_PLAN", "稳健性实验的窗口、候选或训练依据与协议不一致");
    const run = runs.find((r) => r.id === e.runId),
      config = diagnosticConfig(p, plan);
    if (
      !run ||
      run.projectId !== p.id ||
      run.experimentId !== e.id ||
      !isDeepStrictEqual(
        {
          initialCash: run.config.initialCash,
          risk: run.config.risk,
          costs: run.config.costs,
          from: run.config.from,
          to: run.config.to,
        },
        config,
      )
    )
      fail("DIAGNOSTIC_CONFIG", "稳健性实验的实际成本、资金或窗口与协议不一致");
    if (plan.diagnostic.definition) {
      const version = strategies.find((s) => s.id === strategyId);
      if (
        !version ||
        version.id !== run.strategyId ||
        version.projectId !== p.id ||
        version.purpose !== "research" ||
        version.definitionHash !== hash(plan.diagnostic.definition) ||
        !isDeepStrictEqual(version.definition, plan.diagnostic.definition)
      )
        fail("DIAGNOSTIC_STRATEGY", "参数邻域未绑定确切的不可变研究版本");
    } else if (
      strategyId ||
      run.strategyId !==
        p.candidates.find((c) => c.id === e.candidateId)?.strategyId
    )
      fail("DIAGNOSTIC_STRATEGY", "稳健性实验引用了错误策略");
  }
  if (requireComplete && !diagnosticsFinished(p, selected.definition))
    fail("DIAGNOSTIC_INCOMPLETE", "稳健性协议尚未完成，不能交付或批准模拟");
}

export function buildDiagnostics(
  p: ResearchProject,
  runs: RunRecord[],
  facts: EvidenceRef[],
): ResearchDiagnostics {
  const holdout = p.experiments.find(
    (e) =>
      e.phase === "holdout" &&
      e.candidateId === p.selectedCandidateId &&
      e.status === "completed",
  );
  const run = runs.find((r) => r.id === holdout?.runId);
  if (!run?.result)
    fail("DIAGNOSTIC_INCOMPLETE", "缺少可核查的最终区间归因结果");
  const baseDefinition = p.experiments.find(
    (e) => e.phase === "parameter_sensitivity",
  )?.diagnostic?.baseDefinition;
  const rows = p.experiments
    .filter(
      (e) =>
        e.status === "completed" &&
        (e.diagnostic ||
          (e.candidateId === p.selectedCandidateId &&
            e.phase === "validation")),
    )
    .map((e) => {
      const m = e.metrics!,
        definition =
          e.diagnostic?.definition ??
          (e.phase === "validation" ? baseDefinition : undefined);
      return {
        experimentId: e.id,
        candidateName: p.candidates.find((c) => c.id === e.candidateId)!.name,
        phase: e.phase,
        from: e.from,
        to: e.to,
        ...(e.diagnostic?.multiplier
          ? { multiplier: e.diagnostic.multiplier }
          : e.phase === "validation"
            ? { multiplier: 1 }
            : {}),
        ...(e.diagnostic?.fold !== undefined
          ? { fold: e.diagnostic.fold }
          : {}),
        ...(definition
          ? {
              parameter:
                definition.template === "sma_cross"
                  ? `slow=${definition.slow}`
                  : `entryPeriod=${definition.entryPeriod}`,
            }
          : {}),
        returnPct: m.returnPct,
        maxDrawdownPct: m.maxDrawdownPct,
        closedTrades: m.closedTrades,
        fees: m.fees,
        slippage: m.slippage,
        verdict: e.evaluation?.verdict ?? "insufficient",
        reasons: e.evaluation?.reasons.map((r) => r.message) ?? [],
        evidenceIds: facts
          .filter((f) => f.experimentId === e.id)
          .map((f) => f.id),
      };
    });
  return {
    version: 1,
    checks: robustnessChecks(p),
    rows,
    attribution: {
      runId: run.id,
      resultHash: run.result.hash,
      data: attributeRun(run),
    },
    limitations: [
      "成本与参数邻域在已用于选择的验证区间上检验，属于敏感性诊断，不能当作新增盲测。",
      "滚动验证只比较研究开始前冻结的初始候选池；每窗按训练门槛、训练收益、候选身份排序后验证，不使用后续窗口选策略。",
      "滚动窗口均位于最终保留区间之前；每窗独立以初始资金开始，不拼接为可交易组合净值。",
      "各类诊断按协议通过率门槛评估；这不是统计显著性、盈利概率或未来收益保证。",
      "参数扰动按协议百分比取整且至少一单位，随后裁剪到合法边界并去重；实际测试值以表格为准。",
      "成本情景可能因仓位和风险触发而呈非单调结果；仅报告已测情景，不插值推断连续盈亏平衡费率。",
      "月度归因按UTC月末权益差计算，包含未实现盈亏；交易对归因计入成交现金流、费用和期末持仓市值，滑点已反映在成交价中。",
      "最大盈利交易占比以已平仓盈利交易的净收益总和为分母，不等于占账户总利润的比例；没有盈利平仓时为空。",
    ],
  };
}

const safe = (s: string) => s.replace(/[\r\n|]/g, " ");
export function diagnosticsMarkdown(d: ResearchDiagnostics) {
  return `## 稳健性研究\n\n${d.checks.map((c) => `- ${c.name}：${c.pass}/${c.total} 满足协议门槛，评估 ${c.verdict}`).join("\n")}\n\n| 实验 | 类型 / 情景 | 收益 % | 回撤 % | 平仓样本 | 手续费 | 滑点 | 评估 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${d.rows.map((r) => `| ${r.experimentId} | ${safe(`${r.phase} ${r.multiplier ? `${r.multiplier}倍成本` : ""} ${r.parameter ?? ""} ${r.fold !== undefined ? `窗口${r.fold + 1}` : ""}`)} | ${r.returnPct} | ${r.maxDrawdownPct} | ${r.closedTrades} | ${r.fees} | ${r.slippage} | ${r.verdict} |`).join("\n")}\n\n## 最终区间收益归因\n\n来源 Run：${d.attribution.runId}\n结果 hash：${d.attribution.resultHash}\n\n| UTC月份 | 期初权益 | 期末权益 | 盈亏 | 月收益 % |\n| --- | --- | --- | --- | --- |\n${d.attribution.data.months.map((m) => `| ${m.month} | ${m.startEquity} | ${m.endEquity} | ${m.pnl} | ${m.returnPct ?? "样本不足"} |`).join("\n")}\n\n| 交易对 | 含期末市值盈亏 | 手续费 | 平仓样本 |\n| --- | --- | --- | --- |\n${d.attribution.data.symbols.map((s) => `| ${s.symbol} | ${s.pnl} | ${s.fees} | ${s.closedTrades} |`).join("\n")}\n\n最大盈利交易占已平仓盈利净收益：${d.attribution.data.topTradeSharePct ?? "无盈利平仓样本"}%\n\n`;
}
