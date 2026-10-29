export type Interval = "1m" | "15m" | "1h" | "1d";
export const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60000,
  "15m": 900000,
  "1h": 3600000,
  "1d": 86400000,
};
export interface Bar {
  symbol: string;
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}
export interface Strategy {
  template: "sma_cross" | "breakout";
  symbols: string[];
  interval: Interval;
  fast: number;
  slow: number;
  entryPeriod: number;
  exitPeriod: number;
}
export interface Risk {
  sizing: "weight" | "risk";
  weightPct: string;
  riskPct: string;
  stopLossPct: string;
  takeProfitPct: string;
  maxSymbolPct: string;
  maxExposurePct: string;
  maxPositions: number;
  dailyLossPct: string;
  maxDrawdownPct: string;
}
export interface Costs {
  feeBps: string;
  slippageBps: string;
  participationPct: string;
}
export interface Rules {
  stepSize: string;
  minQty: string;
  maxQty: string;
  minNotional: string;
  tickSize: string;
}
export const DEFAULT_RULES: Rules = {
  stepSize: "0.000001",
  minQty: "0.000001",
  maxQty: "1000000",
  minNotional: "5",
  tickSize: "0.01",
};
export interface RunConfig {
  initialCash: string;
  risk: Risk;
  costs: Costs;
  rules: Record<string, Rules>;
  from: number;
  to: number;
  engineVersion: string;
}
export interface Position {
  quantity: string;
  cost: string;
  stop: string;
  take: string;
}
export interface Intent {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  signalAt: number;
  reason: string;
}
export interface Fill {
  id: string;
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: string;
  price: string;
  fee: string;
  slippage: string;
  at: number;
  signalAt: number;
  reason: string;
  realizedPnl: string | null;
}
export interface Decision {
  id: string;
  at: number;
  symbol: string;
  code: string;
  reason: string;
  orderId?: string;
  facts?: Record<string, string>;
}
export interface Ledger {
  id: string;
  fillId: string;
  asset: string;
  delta: string;
  kind: "trade" | "fee";
}
export interface Equity {
  at: number;
  cash: string;
  equity: string;
  drawdownPct: string;
}
export interface EngineState {
  cash: string;
  positions: Record<string, Position>;
  prices: Record<string, string>;
  history: Record<string, Bar[]>;
  pending: Record<string, Intent>;
  fills: Fill[];
  decisions: Decision[];
  ledger: Ledger[];
  curve: Equity[];
  peak: string;
  day: string;
  dayStart: string;
  sequence: number;
  lastTime: Record<string, number>;
  stoppedOpening: boolean;
}
export interface Metrics {
  returnPct: string;
  maxDrawdownPct: string;
  fees: string;
  slippage: string;
  trades: number;
  closedTrades: number;
  winRatePct: string | null;
  profitFactor: string | null;
  payoffRatio: string | null;
  sharpe: string | null;
  annualVolatilityPct: string | null;
  turnover: string;
  exposurePct: string;
  realizedPnl: string;
  unrealizedPnl: string;
}
export interface RunResult {
  state: EngineState;
  metrics: Metrics;
  benchmarks: {
    cashReturnPct: string;
    buyHoldReturnPct: string;
  };
  hash: string;
}
export interface Dataset {
  id: string;
  name: string;
  symbol: string;
  interval: Interval;
  source: string;
  hash: string;
  file: string;
  count: number;
  from: number;
  to: number;
  createdAt: string;
  rules: Rules;
  ruleAsOf: string;
  quality: {
    gaps: number;
    duplicates: number;
    valid: boolean;
  };
  synthetic: boolean;
}
export interface StrategyRecord {
  id: string;
  name: string;
  revision: number;
  definition: Strategy;
  published: boolean;
  author: "user" | "ai";
  createdAt: string;
  purpose?: "research";
  projectId?: string;
  definitionHash?: string;
  createdBy?: "user" | "ai";
  approvedBy?: "user";
  approvedAt?: string;
  approvedConfigHash?: string;
}
export interface RunRecord {
  id: string;
  strategyId: string;
  datasetIds: string[];
  config: RunConfig;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  createdAt: string;
  error?: string;
  result?: RunResult;
  manifestHash: string;
  projectId?: string;
  experimentId?: string;
  computeMs?: number;
  maxComputeMs?: number;
}
export interface Account {
  id: string;
  name: string;
  revision: number;
  initialCash: string;
  status: "created" | "running" | "paused" | "stopped" | "failed";
  strategyId: string;
  config: RunConfig;
  state: EngineState;
  seen: Record<string, number>;
  lastQuoteAt: Record<string, number>;
  lastEventAt: number;
  error: string;
  generation: number;
  createdAt: string;
  approvalHash?: string;
}
export const TOOL_TITLES: Record<string, string> = {
  qt_project_create: "提出研究委托",
  qt_project_read: "研究项目",
  qt_project_action: "研究下一步",
  qt_evidence_read: "核对研究证据",
  qt_monitor_read: "运行观察与复盘",
  qt_status: "研究状态",
  qt_symbols: "交易对目录",
  qt_dataset_inspect: "数据检查",
  qt_dataset_prepare: "准备行情",
  qt_strategy_read: "读取策略",
  qt_strategy_draft: "策略草稿",
  qt_backtest_submit: "提交回测",
  qt_run_read: "回测结果",
  qt_runs_compare: "比较实验",
  qt_portfolio_read: "模拟账户",
  qt_decisions_read: "决策日志",
  qt_review_save: "保存复盘",
};
