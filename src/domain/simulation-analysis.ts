import { Decimal } from "decimal.js";
import {
  INTERVAL_MS,
  type Account,
  type RunConfig,
  type Strategy,
} from "./contracts.js";
import type {
  ConfigurationChange,
  ObservationRecord,
  SimulationCheckpoint,
  SimulationDiagnosis,
  SimulationHealth,
} from "./simulation.js";
const Precise = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_DOWN });
const d = (v: Decimal.Value) => new Precise(v);

export function observationHealth(
  account: Account,
  definition: Strategy,
  state: ObservationRecord | null,
  now = Date.now(),
): SimulationHealth {
  const stalePositions = Object.keys(account.state.positions).filter(
    (s) => !account.lastQuoteAt[s] || now - account.lastQuoteAt[s]! > 60000,
  );
  const base = {
    accountId: account.id,
    name: account.name,
    status: account.status,
    asOf: now,
    transport: state?.transport ?? ("unknown" as const),
    lastTransportAt: state?.lastTransportAt ?? 0,
    lastMarketAt: state?.lastMarketAt ?? 0,
    lastBarCloseAt: state?.lastBarCloseAt ?? 0,
    stalePositions,
    gapCount: state?.gapCount ?? null,
    gapMs: state
      ? state.gapMs +
        (state.gapOpenAt === null ? 0 : Math.max(0, now - state.gapOpenAt))
      : null,
    historyComplete: state?.historyComplete ?? false,
  };
  if (account.status !== "running")
    return {
      ...base,
      state: "paused",
      explanation:
        account.status === "created"
          ? "账户尚未启动观察"
          : "当前未运行；展示最后记录的估值，持仓不会自动平仓",
    };
  if (!state)
    return {
      ...base,
      state: "unknown",
      explanation: "缺少完整行情观察记录，不能据账本更新时间声称行情新鲜",
    };
  const sessionStartedAt = state.sessionStartedAt ?? state.trackedFrom;
  if (
    stalePositions.length ||
    now - Math.max(state.lastTransportAt, sessionStartedAt) > 120000 ||
    state.transport === "disconnected" ||
    now - Math.max(state.lastBarCloseAt, sessionStartedAt) >
      INTERVAL_MS[definition.interval] + 120000
  )
    return {
      ...base,
      state: "stale",
      explanation: stalePositions.length
        ? "存在超过一分钟没有有效报价的持仓，估值需要核查"
        : "行情连接或已收盘数据观察过期，不能视为连续在线",
    };
  if (
    !state.firstMarketAt ||
    state.lastMarketAt < sessionStartedAt ||
    state.transport !== "connected"
  )
    return {
      ...base,
      state: "waiting",
      explanation:
        "等待首个有效已收盘行情或持仓报价；连接状态与可用于交易的数据分开记录",
    };
  return {
    ...base,
    state: "current",
    explanation: "连接和已记录行情在当前检查范围内有效；历史暂停与缺口仍保留",
  };
}

export function configurationChanges(
  before: {
    definition: Strategy;
    config: Pick<RunConfig, "initialCash" | "risk" | "costs" | "engineVersion">;
  },
  after: typeof before,
): ConfigurationChange[] {
  const changes: ConfigurationChange[] = [];
  const add = (field: string, label: string, a: unknown, b: unknown) => {
    const str = (v: unknown) =>
      Array.isArray(v) ? [...v].sort().join(" / ") : String(v);
    if (str(a) !== str(b))
      changes.push({ field, label, before: str(a), after: str(b) });
  };
  add(
    "template",
    "策略模板",
    before.definition.template,
    after.definition.template,
  );
  add("symbols", "交易对", before.definition.symbols, after.definition.symbols);
  add(
    "interval",
    "K线周期",
    before.definition.interval,
    after.definition.interval,
  );
  const conditions = (definition: Strategy) =>
    definition.conditions
      ? JSON.stringify({
          version: definition.conditions.version,
          mode: definition.conditions.mode,
          entry: definition.conditions.entry.map(
            ({ indicator, period, factor, operator, value }) => ({
              indicator,
              period,
              factor,
              operator,
              value,
            }),
          ),
          exit: definition.conditions.exit.map(
            ({ indicator, period, factor, operator, value }) => ({
              indicator,
              period,
              factor,
              operator,
              value,
            }),
          ),
        })
      : "无组合条件";
  add(
    "conditions",
    "组合条件与高周期确认",
    conditions(before.definition),
    conditions(after.definition),
  );
  const labels = {
    fast: "快均线周期",
    slow: "慢均线周期",
    entryPeriod: "突破入场回看周期",
    exitPeriod: "突破退出回看周期",
  };
  for (const key of Object.keys(labels) as (keyof typeof labels)[])
    add(key, labels[key], before.definition[key], after.definition[key]);
  add(
    "initialCash",
    "独立账户初始资金 USDT",
    before.config.initialCash,
    after.config.initialCash,
  );
  const riskLabels = {
    sizing: "仓位方式",
    weightPct: "目标权重 %",
    riskPct: "每笔风险 %",
    stopLossPct: "止损 %",
    takeProfitPct: "止盈 %",
    maxSymbolPct: "单标的敞口上限 %",
    maxExposurePct: "总敞口上限 %",
    maxPositions: "持仓数量上限",
    dailyLossPct: "日内损失限额 %",
    maxDrawdownPct: "运行回撤限额 %",
  };
  for (const key of Object.keys(riskLabels) as (keyof typeof riskLabels)[])
    add(
      `risk.${key}`,
      riskLabels[key],
      before.config.risk[key],
      after.config.risk[key],
    );
  for (const [key, label] of [
    ["feeBps", "单边手续费 bps"],
    ["slippageBps", "不利滑点 bps"],
    ["participationPct", "成交量参与率 %"],
  ] as const)
    add(
      `costs.${key}`,
      label,
      before.config.costs[key],
      after.config.costs[key],
    );
  add(
    "engineVersion",
    "执行引擎版本",
    before.config.engineVersion,
    after.config.engineVersion,
  );
  return changes;
}

export function simulationDiagnosis(
  c: SimulationCheckpoint,
): SimulationDiagnosis {
  const account = { ...c.account, state: c.result.state },
    b = c.baseline,
    now = Date.parse(c.at);
  const observedDays =
    c.observation?.firstMarketAt &&
    c.observation.lastMarketAt > c.observation.firstMarketAt
      ? d(c.observation.lastMarketAt - c.observation.firstMarketAt)
          .div(86400000)
          .toFixed()
      : null;
  const baselineDays = b
    ? d(b.to - b.from + INTERVAL_MS[b.definition.interval])
        .div(86400000)
        .toFixed()
    : null;
  const frequencyPerDay =
    observedDays && d(observedDays).gt(0)
      ? d(c.metrics.closedTrades).div(observedDays).toFixed()
      : null;
  const baselineFrequencyPerDay =
    b && baselineDays
      ? d(b.metrics.closedTrades).div(baselineDays).toFixed()
      : null;
  const frequencyRatio =
    frequencyPerDay !== null &&
    baselineFrequencyPerDay &&
    d(baselineFrequencyPerDay).gt(0)
      ? d(frequencyPerDay).div(baselineFrequencyPerDay).toFixed()
      : null;
  const notional = c.result.state.fills.reduce(
    (sum, f) => sum.plus(d(f.quantity).mul(f.price)),
    d(0),
  );
  const feeBps = notional.gt(0)
    ? d(c.metrics.fees).div(notional).mul(10000).toFixed()
    : null;
  const policy = {
    minDays: 7,
    minClosedTrades: Math.max(10, b?.minClosedTrades ?? 10),
    frequencyRatioLow: 0.5,
    frequencyRatioHigh: 2,
  };
  const health = observationHealth(account, c.definition, c.observation, now),
    findings: SimulationDiagnosis["findings"] = [],
    basisWarnings: string[] = [];
  const add = (
    code: string,
    severity: "info" | "attention" | "insufficient",
    title: string,
    detail: string,
    paths: string[],
  ) => findings.push({ code, severity, title, detail, paths });
  if (!b)
    basisWarnings.push("此账户未关联可核查的研究批准，不能对照原研究作判断。");
  if (
    b &&
    configurationChanges(
      { definition: b.definition, config: b.config },
      { definition: c.definition, config: c.account.config },
    ).length
  )
    basisWarnings.push(
      "策略、资金、风险、成本或引擎版本与研究口径存在差异，历史数值仅供核对。",
    );
  basisWarnings.push(
    "模拟与历史回测处于不同时间区间；收益、回撤和频率只作描述性对照，不能据此判定策略失效或作显著性结论。",
    "模拟手续费和滑点来自固定配置，不是交易所实测费用；抽样保护退出与历史K线成交模型不同。",
  );
  if (!health.historyComplete || health.gapCount)
    add(
      "OBSERVATION_GAP",
      "attention",
      "观察历史存在缺口或记录不完整",
      "暂停、断线或升级前记录不足会影响对表现偏差的解释；不补记缺口成交。",
      ["diagnosis.health.gapCount", "diagnosis.health.gapMs"],
    );
  if (health.state !== "current")
    add(
      "VALUATION_STATUS",
      health.state === "stale" ? "attention" : "info",
      "先核对行情与估值状态",
      health.explanation,
      ["diagnosis.health.lastMarketAt", "diagnosis.health.stalePositionCount"],
    );
  const enough =
    observedDays !== null &&
    d(observedDays).gte(policy.minDays) &&
    c.metrics.closedTrades >= policy.minClosedTrades;
  if (!enough)
    add(
      "SAMPLE_INSUFFICIENT",
      "insufficient",
      "模拟样本尚不足以解释策略偏差",
      `复盘规则要求至少${policy.minDays}天行情跨度和${policy.minClosedTrades}笔平仓；先积累连续观察证据。`,
      ["diagnosis.observedDays", "metrics.closedTrades"],
    );
  const sameBasis =
    b &&
    configurationChanges(
      { definition: b.definition, config: b.config },
      { definition: c.definition, config: c.account.config },
    ).length === 0;
  if (
    enough &&
    sameBasis &&
    health.historyComplete &&
    !health.gapCount &&
    frequencyRatio !== null &&
    (d(frequencyRatio).lt(policy.frequencyRatioLow) ||
      d(frequencyRatio).gt(policy.frequencyRatioHigh))
  )
    add(
      "FREQUENCY_SHIFT",
      "attention",
      "交易频率与历史描述有明显差异",
      "已超过复盘规则的描述性频率比范围；应调查行情结构与执行拒绝原因，不直接归因于策略失效。",
      [
        "diagnosis.frequencyRatio",
        "diagnosis.frequencyPerDay",
        "diagnosis.baselineFrequencyPerDay",
      ],
    );
  if (b && d(c.metrics.maxDrawdownPct).gt(b.maxDrawdownPct))
    add(
      "RESEARCH_RISK_LIMIT",
      "attention",
      "累计回撤超过原研究约定上限",
      "这表示观察事实已触及原研究的风险假设，需要复核；不会自动修改风险配置或切换策略。",
      ["metrics.maxDrawdownPct", "diagnosis.maxDrawdownLimit"],
    );
  const researchQuestions = findings
    .filter((f) => ["FREQUENCY_SHIFT", "RESEARCH_RISK_LIMIT"].includes(f.code))
    .map((f) => ({
      code: f.code,
      objective: `针对模拟观察中的“${f.title}”，核对原研究条件与执行记录，设计新证据验证可能原因；保留反证，不把不同区间收益差当作策略失效证据。`,
    }));
  if (!researchQuestions.length)
    researchQuestions.push({
      code: "INVESTIGATE",
      objective:
        "结合本次模拟事实复盘，核对成本负担、交易频率和风险假设，在新的研究区间验证仍未解决的问题；明确样本与观察缺口的限制。",
    });
  return {
    version: 1,
    policy,
    health,
    observedDays,
    baselineDays,
    frequencyPerDay,
    baselineFrequencyPerDay,
    frequencyRatio,
    feeBps,
    baselineFeeBps: b?.config.costs.feeBps ?? null,
    basisWarnings,
    findings,
    researchQuestions,
    reference: b
      ? {
          projectId: b.projectId,
          reportHash: b.reportHash,
          runId: b.runId,
          from: b.from,
          to: b.to,
          metrics: b.metrics,
        }
      : null,
  };
}
