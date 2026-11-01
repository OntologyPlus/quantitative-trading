import type {
  Account,
  EngineState,
  Metrics,
  RunConfig,
  Strategy,
} from "./contracts.js";

export interface ObservationRecord {
  id: string;
  trackedFrom: number;
  historyComplete: boolean;
  firstMarketAt: number;
  lastMarketAt: number;
  lastTransportAt: number;
  lastBarCloseAt: number;
  transport: "connected" | "disconnected" | "unknown";
  gapCount: number;
  gapOpenAt: number | null;
  gapMs: number;
  sessionStartedAt?: number;
}
export interface ObservationEvent {
  id: string;
  accountId: string;
  at: number;
  generation: number;
  kind:
    | "start"
    | "resume"
    | "connected"
    | "disconnected"
    | "pause"
    | "stop"
    | "fault"
    | "restart"
    | "closed"
    | "replaced";
  reason: string;
}
export interface SimulationApproval {
  id: string;
  projectId: string;
  strategyId: string;
  definitionHash: string;
  configHash: string;
  reportHash: string;
  actor: "user";
  at: string;
  replacementAccountId?: string;
  previewHash?: string;
}
export interface SimulationBaseline {
  projectId: string;
  reportHash: string;
  runId: string;
  manifestHash: string;
  resultHash: string;
  config: RunConfig;
  definition: Strategy;
  metrics: Metrics;
  from: number;
  to: number;
  minClosedTrades: number;
  maxDrawdownPct: string;
}
export interface SimulationCheckpoint {
  id: string;
  version: 1;
  at: string;
  hash: string;
  account: Omit<Account, "state">;
  definition: Strategy;
  definitionHash: string;
  result: { state: EngineState };
  metrics: Metrics;
  observation: ObservationRecord | null;
  events: ObservationEvent[];
  baseline: SimulationBaseline | null;
}
export interface SimulationHealth {
  accountId: string;
  name: string;
  status: string;
  asOf: number;
  transport: ObservationRecord["transport"];
  lastTransportAt: number;
  lastMarketAt: number;
  lastBarCloseAt: number;
  stalePositions: string[];
  gapCount: number | null;
  gapMs: number | null;
  historyComplete: boolean;
  state: "waiting" | "current" | "stale" | "paused" | "unknown";
  explanation: string;
}
export interface SimulationDiagnosis {
  version: 1;
  policy: {
    minDays: number;
    minClosedTrades: number;
    frequencyRatioLow: number;
    frequencyRatioHigh: number;
  };
  health: SimulationHealth;
  observedDays: string | null;
  baselineDays: string | null;
  frequencyPerDay: string | null;
  baselineFrequencyPerDay: string | null;
  frequencyRatio: string | null;
  feeBps: string | null;
  baselineFeeBps: string | null;
  basisWarnings: string[];
  reference: {
    projectId: string;
    reportHash: string;
    runId: string;
    from: number;
    to: number;
    metrics: Metrics;
  } | null;
  findings: {
    code: string;
    severity: "info" | "attention" | "insufficient";
    title: string;
    detail: string;
    paths: string[];
  }[];
  researchQuestions: { code: string; objective: string }[];
}
export interface SimulationReview {
  id: string;
  accountId: string;
  at: string;
  from: number;
  to: number;
  metrics: Metrics;
  observationGap: boolean;
  status: string;
  reason: string;
  kind: "deterministic";
  version?: 2;
  checkpointId?: string;
  checkpointHash?: string;
  diagnosis?: SimulationDiagnosis;
  hash?: string;
}
export interface SimulationEvidence {
  reviewId: string;
  reviewHash: string;
  checkpointId: string;
  checkpointHash: string;
  path: string;
  value: string | number | null;
  asOf: string;
}
export interface ConfigurationChange {
  field: string;
  label: string;
  before: string;
  after: string;
}
export interface PromotionPreview {
  version: 1;
  comparisonVersion?: 2;
  hash: string;
  projectId: string;
  reportHash: string;
  targetDefinitionHash: string;
  targetConfigHash: string;
  targetEngineVersion: string;
  source: {
    id: string;
    name: string;
    revision: number;
    generation: number;
    status: string;
    definitionHash: string;
    configHash: string;
    engineVersion: string;
  } | null;
  changes: ConfigurationChange[];
  canApprove: boolean;
  blockers: string[];
  accounts: { id: string; name: string; status: string }[];
}
export interface SimulationTransition {
  id: string;
  version: 1;
  fromAccountId: string;
  toAccountId: string;
  projectId: string;
  reportHash: string;
  preview: PromotionPreview;
  approvedBy: "user";
  approvedAt: string;
  hash: string;
}
