import { synthetic, hash } from "../src/adapters/market.js";
import { backtest, ENGINE_VERSION } from "../src/engine/backtest.js";
import { configInput, strategySchema } from "../src/domain/schemas.js";
import { DEFAULT_RULES, type Bar, type RunResult } from "../src/domain/contracts.js";

const QUIET = new Set(["WARMUP", "NO_SIGNAL"]);
/** Digest of everything a run produces except per-bar idle decisions. */
export function engineDigest(r: RunResult) {
  const s = r.state;
  return hash({
    fills: s.fills,
    ledger: s.ledger,
    curve: s.curve,
    positions: s.positions,
    cash: s.cash,
    sequence: s.sequence,
    decisions: s.decisions.filter((d) => !QUIET.has(d.code)),
    metrics: r.metrics,
    benchmarks: r.benchmarks,
  });
}
function noisy(symbol: string, count: number, seed: number): Bar[] {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  let p = 100 + seed;
  const start = Date.UTC(2024, 0, 1);
  return Array.from({ length: count }, (_, i) => {
    const open = p;
    p = Math.max(1, p * (1 + (rnd() - 0.5) * 0.04));
    const hi = Math.max(open, p) * (1 + rnd() * 0.01),
      lo = Math.min(open, p) * (1 - rnd() * 0.01);
    return {
      symbol,
      time: start + i * 3600000,
      open: open.toFixed(4),
      high: hi.toFixed(4),
      low: lo.toFixed(4),
      close: p.toFixed(4),
      volume: (1000 + rnd() * 5000).toFixed(2),
    };
  });
}
const rules = (syms: string[]) =>
  Object.fromEntries(syms.map((s) => [s, DEFAULT_RULES]));
const base = (risk: object = {}, costs: object = {}) =>
  configInput.parse({
    initialCash: "10000",
    risk: { weightPct: "30", maxSymbolPct: "40", maxExposurePct: "90", ...risk },
    costs,
  });
export function engineCases() {
  const btc = noisy("BTCUSDT", 3000, 7),
    eth = noisy("ETHUSDT", 3000, 11),
    syn = synthetic("BTCUSDT", "1h", 3000);
  const cases: { name: string; run: () => RunResult }[] = [];
  const add = (name: string, strat: object, bars: Bar[], cfg: object = {}) => {
    const strategy = strategySchema.parse({ interval: "1h", ...strat }) as any;
    const config = {
      ...base(),
      ...cfg,
      rules: rules(strategy.symbols),
      from: bars[0]!.time + 100 * 3600000,
      to: bars.at(-1)!.time,
      engineVersion: ENGINE_VERSION,
    } as any;
    cases.push({ name, run: () => backtest(strategy, config, bars) });
  };
  add("sma-noisy", { template: "sma_cross", symbols: ["BTCUSDT"], fast: 5, slow: 30 }, btc);
  add("sma-synthetic", { template: "sma_cross", symbols: ["BTCUSDT"] }, syn);
  add("breakout-noisy", { template: "breakout", symbols: ["BTCUSDT"], entryPeriod: 24, exitPeriod: 12 }, btc);
  add("breakout-risk", { template: "breakout", symbols: ["BTCUSDT"] }, btc, base({ sizing: "risk", stopLossPct: "3", takeProfitPct: "6" }));
  add("multi-symbol", { template: "sma_cross", symbols: ["BTCUSDT", "ETHUSDT"], fast: 8, slow: 40 }, [...btc, ...eth]);
  add("conditions-filter", {
    template: "sma_cross", symbols: ["BTCUSDT"], fast: 5, slow: 20,
    conditions: { version: 1, mode: "filter",
      entry: [{ indicator: "close_sma", period: 10, factor: 4, operator: "gt", value: "1" }],
      exit: [{ indicator: "return_pct", period: 6, factor: 1, operator: "lt", value: "-3" }] },
  }, btc);
  add("conditions-replace", {
    template: "breakout", symbols: ["ETHUSDT"],
    conditions: { version: 1, mode: "replace",
      entry: [{ indicator: "volume_ratio", period: 12, factor: 2, operator: "gt", value: "1.1" }],
      exit: [{ indicator: "close_sma", period: 24, factor: 1, operator: "lt", value: "0.98" }] },
  }, eth);
  add("tight-limits", { template: "sma_cross", symbols: ["BTCUSDT"], fast: 3, slow: 12 }, btc,
    base({ dailyLossPct: "1", maxDrawdownPct: "5" }, { participationPct: "0.01" }));
  return cases;
}
