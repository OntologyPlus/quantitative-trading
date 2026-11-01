import { Decimal } from "decimal.js";
import { INTERVAL_MS, type Dataset } from "./contracts.js";
import type { ResearchProject } from "./project.js";
import {
  minimumExperiments,
  robustnessInput,
  type RobustnessProtocol,
} from "./robustness.js";

export const phaseNames: Record<string, string> = {
  planning: "目标与计划",
  data: "数据准备",
  candidates: "开发与验证",
  selection: "候选选择",
  final: "最终检验",
  report: "研究交付",
  development: "开发期",
  validation: "验证期",
  holdout: "最终保留区间",
  stress: "成本压力",
  cost_sensitivity: "成本敏感性",
  parameter_sensitivity: "参数稳定性",
  walk_train: "滚动训练",
  walk_test: "滚动验证",
};

export function costLabel(bps: string) {
  if (!/^\d+(\.\d+)?$/.test(bps)) return "待填写有效数值";
  return `${bps} bps（${new Decimal(bps).div(100).toFixed()}%）`;
}

export interface ResearchCondition {
  label: string;
  value: string;
  origin: "委托配置" | "数据快照" | "模型约定";
}

export function researchConditions(
  p: ResearchProject,
  datasets: Dataset[],
): ResearchCondition[] {
  const c = p.protocol,
    bound = p.datasetIds.map((id) => datasets.find((d) => d.id === id));
  const sources = bound.length
    ? bound.map((d, i) =>
        d
          ? `${d.symbol}：${d.synthetic ? "合成演示 / " : ""}${d.source}；快照 ${d.id}；数据 hash ${d.hash}`
          : `快照 ${p.datasetIds[i]} 的来源信息暂不可用`,
      )
    : ["尚未绑定快照；计划准备 Binance 公共历史行情，实际来源以绑定快照为准"];
  const conditions: ResearchCondition[] = [
    {
      label: "研究范围",
      value: `${c.symbols.join(" / ")} · ${c.interval} · 现货只做多`,
      origin: "委托配置",
    },
    {
      label: "研究时间（UTC）",
      value: `${new Date(c.from).toISOString()} — ${new Date(c.to).toISOString()}（K线开盘时间）`,
      origin: "委托配置",
    },
    { label: "数据来源", value: sources.join("；"), origin: "数据快照" },
    {
      label: "资金与仓位",
      value: `${c.config.initialCash} USDT；${c.config.risk.sizing === "weight" ? `每交易对目标权重 ${c.config.risk.weightPct}%` : `每笔风险预算 ${c.config.risk.riskPct}%`}；总敞口上限 ${c.config.risk.maxExposurePct}%`,
      origin: "委托配置",
    },
    {
      label: "手续费",
      value: `每次买入、卖出分别收取 ${costLabel(c.config.costs.feeBps)}，按成交金额计算`,
      origin: "委托配置",
    },
    {
      label: "滑点",
      value: `每次成交按不利方向调整 ${costLabel(c.config.costs.slippageBps)}，与手续费分开计入`,
      origin: "委托配置",
    },
    {
      label: "成本压力",
      value: `手续费和滑点均为基础配置的 ${c.thresholds.stressMultiplier} 倍`,
      origin: "委托配置",
    },
    {
      label: "样本划分",
      value: `按K线数量划分 60% 开发、20% 验证、其余最终保留；候选冻结后才揭示最终结果${p.priorExposures?.length ? "；本次与已揭示区间重叠，不属于新的盲测" : ""}`,
      origin: "模型约定",
    },
    {
      label: "成交近似",
      value: `收盘信号、最早下一根开盘成交；成交量参与率 ${c.config.costs.participationPct}%；根内路径未知时止损优先；未还原全部历史交易规则`,
      origin: "模型约定",
    },
  ];
  if (c.robustness)
    conditions.push({
      label: "稳健性协议",
      origin: "委托配置",
      value: `验证期成本情景 ${c.robustness.costMultipliers.join(" / ")} 倍；参数邻域 ±${c.robustness.parameterShiftPct}%；${c.robustness.walkForwardFolds} 个扩展训练窗口；每类诊断至少 ${c.robustness.minPassRatePct}% 满足门槛。滚动验证只使用初始冻结候选池，不占用最终保留区间。`,
    });
  return conditions;
}

export function reportChecks(p: ResearchProject) {
  return p.experiments
    .filter(
      (e) =>
        e.candidateId === p.selectedCandidateId &&
        ["validation", "holdout", "stress"].includes(e.phase),
    )
    .map((e) => ({
      experimentId: e.id,
      phase: phaseNames[e.phase]!,
      verdict: e.evaluation?.verdict ?? "pending",
      reasons: e.evaluation?.reasons.map((r) => r.message) ?? [],
      text:
        e.status !== "completed"
          ? "实验尚未完成"
          : !e.evaluation
            ? "尚无评估结论"
            : e.evaluation.verdict === "pass"
              ? "满足本协议的样本、回撤与相对基准门槛"
              : e.evaluation.reasons.map((r) => r.message).join("；"),
    }));
}

export function researchNextSteps(
  p: ResearchProject,
  synthetic = p.report?.synthetic ?? false,
): string[] {
  if (synthetic)
    return [
      "选用真实历史行情建立后续研究；合成结果只用于检查流程，不能推进市场有效性判断。",
    ];
  if (p.priorExposures?.length)
    return ["选择尚未揭示的新时间区间建立后续研究，保留本次区间复用记录。"];
  if (p.report?.diagnostics?.checks.some((c) => c.verdict !== "pass"))
    return [
      "先核对成本、参数邻域及滚动窗口中的失败或样本不足项，再为具体反证建立后续委托；不以降低已冻结门槛获得通过。",
    ];
  const checks = reportChecks(p),
    codes = p.experiments
      .filter(
        (e) =>
          e.candidateId === p.selectedCandidateId &&
          ["validation", "holdout", "stress"].includes(e.phase),
      )
      .flatMap((e) => e.evaluation?.reasons.map((r) => r.code) ?? []);
  const next: string[] = [];
  if (codes.includes("SAMPLE_INSUFFICIENT"))
    next.push(
      "补充更长且适用的真实样本，先核对交易频率；保留已揭示区间记录，不降低样本门槛来获得通过。",
    );
  if (checks.some((c) => c.phase === phaseNames.stress && c.verdict === "fail"))
    next.push("核查手续费、滑点和换手来源，再为降低成本依赖的假设建立新委托。");
  if (codes.includes("DRAWDOWN_LIMIT"))
    next.push(
      "定位回撤发生的时段和交易，在新委托中检验风险假设；本次风险门槛保持原样。",
    );
  if (codes.includes("BASELINE_UNDERPERFORMANCE"))
    next.push(
      "检查相对买入持有的差距，明确策略是否提供本协议之外尚未验证的价值。",
    );
  if (!next.length)
    next.push(
      p.report?.conclusion === "supported" ||
        (checks.length >= 3 && checks.every((c) => c.verdict === "pass"))
        ? "核对适用范围与完整资金、风险配置，由用户决定是否创建并启动模拟观察。通过本协议不代表未来收益。"
        : "先核查尚未完成的实验和证据，再决定是否建立后续研究。",
    );
  return next;
}

export function researchGuidance(p: ResearchProject, now = Date.now()) {
  const reason = `${p.reason} ${p.error}`;
  const blocked = ["paused", "waiting_input", "failed"].includes(p.status);
  if (
    blocked &&
    (/结果待核对|OUTCOME_UNKNOWN|无法核对/.test(reason) ||
      (p.status === "waiting_input" && p.activeDispatchId))
  )
    return {
      now: "上次执行结果尚未核对",
      next: "先核对已有实验和执行记录，避免重复派发。可将本项目带入对话诊断。",
      resume: false,
      answer: false,
    };
  if (
    blocked &&
    ((p.authorization && p.authorization.expiresAt <= now) ||
      /授权.*过期|预算.*(用尽|不足|超|上限)|额度.*(用尽|不足|上限)|请求次数.*上限|BUDGET/.test(
        reason,
      ))
  )
    return {
      now: "原委托的授权或预算需要调整",
      next: "新建后续研究并核对范围和预算；原研究的消耗、实验与区间使用记录会保留。",
      resume: false,
      answer: false,
    };
  if (blocked && /模型|MODEL|provider|凭据|认证/i.test(reason))
    return {
      now: "模型服务需要处理",
      next: "在宿主设置中检查模型、凭据和可用额度，修复后恢复研究；也可另建固定协议委托。",
      resume: p.status !== "failed",
      answer: false,
    };
  if (blocked && /数据|行情|下载|网络|连接/.test(reason))
    return {
      now: "数据准备或连接需要处理",
      next: "检查数据任务的具体错误及网络后恢复；更换来源或导入 CSV 时，新建后续研究并重新确认数据。",
      resume: p.status !== "failed",
      answer: false,
    };
  if (p.status === "completed")
    return {
      now: "研究已交付",
      next: "先阅读结论、反证和适用条件，再决定后续验证或模拟观察。",
      resume: false,
      answer: false,
    };
  if (p.status === "cancelled")
    return {
      now: "研究已取消",
      next: "已有结果保留。需要继续时可建立关联的后续研究。",
      resume: false,
      answer: false,
    };
  if (p.status === "failed")
    return {
      now: "研究执行失败",
      next: "查看具体错误并带入对话诊断，解决问题后建立后续研究。",
      resume: false,
      answer: false,
    };
  if (p.status === "waiting_input" && p.error)
    return {
      now: "执行问题需要处理",
      next: "核查下方错误和已完成实验，修复后按原协议恢复；需要改变条件时新建后续研究。",
      resume: true,
      answer: false,
    };
  if (p.status === "waiting_input")
    return {
      now: "需要补充研究信息",
      next: "回答下方问题后按原协议继续；改变范围或预算请建立后续研究。",
      resume: false,
      answer: true,
    };
  if (p.status === "paused")
    return {
      now: "研究已暂停",
      next: "核对原授权、预算和暂停原因后恢复，已经完成的实验会保留。",
      resume: true,
      answer: false,
    };
  if (p.status === "draft")
    return {
      now: "等待核对研究委托",
      next: "核对研究条件、评估门槛与预算后启动；这一步不会启动模拟盘。",
      resume: false,
      answer: false,
    };
  const actions: Record<string, string> = {
    planning: "核对目标是否在当前策略能力范围内",
    data: "准备连续且已收盘的行情，并核查覆盖区间",
    candidates: "比较候选的开发期与验证期结果，保留失败实验",
    selection: "依据允许的证据选择并冻结候选",
    final: "检验已冻结候选的最终区间与成本压力表现",
    report: "核对事实引用，整理结论、反证与限制",
  };
  return {
    now: actions[p.stage] ?? "按原委托执行研究",
    next: "当前步骤完成后自动推进；需要你决定时会明确提示。",
    resume: false,
    answer: false,
  };
}

export function eventDescription(
  type: string,
  facts: unknown,
  p: ResearchProject,
) {
  const f =
    facts && typeof facts === "object"
      ? (facts as Record<string, unknown>)
      : {};
  if (typeof f.reason === "string") return f.reason;
  if (typeof f.message === "string") return f.message;
  if (typeof f.question === "string") return f.question;
  const exp = p.experiments.find(
    (e) => e.id === f.experimentId || e.runId === f.runId,
  );
  if (
    exp &&
    [
      "experiment_complete",
      "experiment_failed",
      "experiment_submitted",
    ].includes(type)
  ) {
    const name =
      p.candidates.find((c) => c.id === exp.candidateId)?.name ?? "候选";
    return `${name} · ${phaseNames[exp.phase]}：${type === "experiment_submitted" ? "已交给后台计算" : type === "experiment_failed" ? exp.error || "计算失败，保留本次尝试" : exp.evaluation?.reasons.map((r) => r.message).join("；") || "计算完成，结果已纳入研究"}`;
  }
  const descriptions: Record<string, string> = {
    created: "已生成待确认的研究范围、门槛和预算。",
    start: "开始在已确认的协议与预算内自动研究。",
    data_ready: "数据连续性与覆盖范围已核对，接下来比较候选。",
    selection_frozen: "候选已选定，之后才允许揭示最终保留区间。",
    completed: p.report?.summary ?? "研究报告与证据已保存。",
    paper_approved:
      "已按用户确认的具体版本与配置创建模拟账户，启动仍由用户操作。",
    pause: "停止派发新动作；已开始的计算可结束并保留结果。",
    cancel: "停止推进研究，迟到结果不再触发后续步骤。",
    resume: "在原预算和授权范围内继续，保留已有实验。",
    model_request: "本次模型请求已计入项目预算。",
    model_usage: "按宿主实际报告结算用量，未报告的用量不记作零。",
    agent_failed:
      "本轮未完成有效推进动作；详情见事件消息（可能为输出上限、仅 analyze 或工具失败）。",
  };
  return descriptions[type] ?? "详细事实已保存在事件记录中，可展开核对。";
}

export interface DraftCheckInput {
  symbols: string[];
  interval: keyof typeof INTERVAL_MS;
  from: number;
  to: number;
  datasetIds: string[];
  experiments: number;
  minTrades: number;
  maxBars?: number;
  robustness?: RobustnessProtocol;
}
export function checkResearchDraft(
  input: DraftCheckInput,
  datasets: Dataset[],
  now = Date.now(),
) {
  const errors: string[] = [],
    warnings: string[] = [],
    step = INTERVAL_MS[input.interval];
  if (input.robustness && !robustnessInput.safeParse(input.robustness).success)
    errors.push("请核对成本倍率、参数邻域、滚动窗口和诊断通过率的有效范围。");
  const count = (input.to - input.from) / step + 1;
  if (
    !Number.isFinite(count) ||
    !Number.isInteger(count) ||
    count < 180 ||
    input.from < 0 ||
    input.from % step ||
    input.to % step ||
    input.to + step > now
  )
    errors.push(
      "日期须对齐已收盘K线，区间至少包含180根；输入时间按 UTC 解释。",
    );
  if (
    !input.symbols.length ||
    input.symbols.length > 5 ||
    new Set(input.symbols).size !== input.symbols.length ||
    input.symbols.some((s) => !/^[A-Z0-9]{2,20}USDT$/.test(s))
  )
    errors.push("请填写1至5个不重复的 USDT 现货交易对，例如 BTCUSDT。");
  if (
    !Number.isInteger(input.experiments) ||
    input.experiments < minimumExperiments(2, input.robustness) ||
    input.experiments > 48
  )
    errors.push(
      `当前默认候选与所选检验至少需要${minimumExperiments(2, input.robustness)}个实验，预算上限为48个。`,
    );
  if (count * input.symbols.length > (input.maxBars ?? 100000))
    errors.push(
      `数据量超过当前委托的 ${(input.maxBars ?? 100000).toLocaleString("zh-CN")} 根预算，请缩短区间或减少交易对。`,
    );
  if (input.datasetIds.length) {
    const chosen = input.datasetIds.map((id) =>
      datasets.find((d) => d.id === id),
    );
    if (
      chosen.some((d) => !d) ||
      chosen.length !== input.symbols.length ||
      input.symbols.some(
        (s) => chosen.filter((d) => d?.symbol === s).length !== 1,
      ) ||
      chosen.some(
        (d) =>
          d &&
          (d.interval !== input.interval ||
            d.from > input.from ||
            d.to < input.to ||
            !d.quality.valid),
      )
    )
      errors.push("每个交易对须选择一份同周期、覆盖完整区间且质量有效的快照。");
    if (chosen.some((d) => d?.synthetic))
      warnings.push(
        "选中合成演示数据：只能验证流程，报告不会支持市场有效性判断。",
      );
  }
  if (Number.isFinite(count) && count >= 180) {
    const finalBars = count - Math.floor(count * 0.6) - Math.floor(count * 0.2);
    if (finalBars * step < 31 * 86400000)
      warnings.push(
        "最终区间不足31天，可能无法计算需要至少30个日收益的 Sharpe；交易样本是否足够仍需实验验证。",
      );
    if (finalBars * input.symbols.length < input.minTrades)
      warnings.push(
        "最终区间K线数量相对平仓样本门槛偏少，请核对研究长度与交易频率。",
      );
  }
  return { errors, warnings, bars: Number.isFinite(count) ? count : 0 };
}
