import test from "node:test";
import assert from "node:assert/strict";
import { backtest, ENGINE_VERSION } from "../src/engine/backtest.js";
import {
  assertLedger,
  D,
  execute,
  initialState,
  intent,
} from "../src/engine/core.js";
import { configInput, strategySchema } from "../src/domain/schemas.js";
import {
  DEFAULT_RULES,
  type Bar,
  type RunConfig,
} from "../src/domain/contracts.js";
const strategy = strategySchema.parse({
  template: "sma_cross",
  symbols: ["BTCUSDT"],
  interval: "1h",
  fast: 2,
  slow: 3,
});
const config: RunConfig = {
  ...configInput.parse({
    initialCash: "1000",
    risk: {
      weightPct: "50",
      maxSymbolPct: "100",
      maxExposurePct: "100",
      dailyLossPct: "100",
      maxDrawdownPct: "100",
      stopLossPct: "0",
      takeProfitPct: "0",
    },
    costs: { feeBps: "10", slippageBps: "0", participationPct: "0" },
  }),
  rules: {
    BTCUSDT: {
      ...DEFAULT_RULES,
      stepSize: "0.01",
      minQty: "0.01",
      minNotional: "0",
    },
  },
  engineVersion: ENGINE_VERSION,
};
const values = [10, 9, 8, 9, 12, 13, 8, 7, 10, 12];
const bars: Bar[] = values.map((close, i) => ({
  symbol: "BTCUSDT",
  time: Date.UTC(2025, 0, 1) + i * 3600000,
  open: String(values[Math.max(0, i - 1)]),
  close: String(close),
  high: String(Math.max(values[Math.max(0, i - 1)]!, close) + 1),
  low: String(Math.min(values[Math.max(0, i - 1)]!, close) - 1),
  volume: "10000",
}));
test("next-bar fills, fees and moving-average cost reconcile to hand-calculated cash", () => {
  const result = backtest(strategy, config, bars);
  const [buy, sell] = result.state.fills;
  assert.equal(buy?.side, "BUY");
  assert.equal(buy.price, "12");
  assert.equal(buy.quantity, "41.66");
  assert.equal(buy.fee, "0.49992");
  assert.equal(buy.at, bars[5]!.time);
  assert.equal(buy.signalAt, bars[5]!.time);
  assert.equal(sell?.side, "SELL");
  assert.equal(sell.price, "8");
  assert.equal(sell.realizedPnl, "-167.4732");
  assertLedger(result.state, "1000");
  assert.equal(
    D(result.state.cash)
      .plus(result.state.positions.BTCUSDT?.cost ?? 0)
      .toFixed(),
    "832.5268",
  );
  assert.equal(result.metrics.sharpe, null);
});
test("replay has stable result hash and future prices/volume do not alter earlier fills", () => {
  const original = backtest(strategy, config, bars),
    repeat = backtest(strategy, config, bars);
  assert.equal(original.hash, repeat.hash);
  const changed = structuredClone(bars);
  for (const b of changed.slice(8)) {
    b.open = "100";
    b.high = "200";
    b.low = "50";
    b.close = "150";
    b.volume = "1";
  }
  const future = backtest(strategy, config, changed);
  assert.deepEqual(
    original.state.fills.filter((f) => f.at < bars[8]!.time),
    future.state.fills.filter((f) => f.at < bars[8]!.time),
  );
  const liquidityConfig = {
    ...config,
    costs: { ...config.costs, participationPct: "1" },
  };
  const lowVolume = structuredClone(bars);
  lowVolume[5]!.volume = "0";
  assert.equal(
    backtest(strategy, liquidityConfig, lowVolume).state.fills[0]?.at,
    bars[5]!.time,
  );
});
test("risk, quantity, liquidity and duplicate position rejection preserve balances", () => {
  const st = initialState("1000"),
    bar = bars[0]!,
    i = intent(st, bar, "BUY", "fixture", bar.time);
  execute(
    st,
    { ...config, costs: { ...config.costs, participationPct: "1" } },
    i,
    "10",
    "1",
    bar.time,
  );
  assert.equal(st.cash, "1000");
  assert.equal(st.decisions.at(-1)?.code, "LIQUIDITY_LIMIT");
  const next = intent(st, bar, "BUY", "fixture", bar.time);
  execute(st, config, next, "10", "10000", bar.time);
  const cash = st.cash;
  execute(st, config, next, "10", "10000", bar.time);
  assert.equal(st.cash, cash);
  assert.equal(st.fills.length, 1);
  assert.equal(st.decisions.at(-1)?.code, "DUPLICATE_POSITION");
  assertLedger(st, "1000");
  st.cash = "999";
  assert.throws(() => assertLedger(st, "1000"), /账本不一致/);
});
test("gap stop executes at worse opening price; stop wins ambiguous same-bar take", () => {
  const c = {
      ...config,
      risk: { ...config.risk, stopLossPct: "5", takeProfitPct: "10" },
    },
    data = structuredClone(bars);
  data[5]!.low = "12";
  data[5]!.high = "13";
  data[6]!.open = "8";
  data[6]!.low = "7";
  data[6]!.high = "20";
  const result = backtest(strategy, c, data);
  const stop = result.state.fills.find((f) => f.reason === "STOP_LOSS");
  assert.ok(stop);
  assert.equal(stop.price, "8");
});
test("no trades returns null ratios and cancellation interrupts deterministic calculation", () => {
  const r = backtest(strategy, config, bars.slice(0, 3));
  assert.equal(r.metrics.trades, 0);
  assert.equal(r.metrics.winRatePct, null);
  assert.equal(r.metrics.profitFactor, null);
  assert.throws(
    () => backtest(strategy, config, bars, undefined, () => true),
    /取消/,
  );
});
test("multi-symbol open fills cannot use another symbol's later close", () => {
  const multi = { ...strategy, symbols: ["BTCUSDT", "ETHUSDT"] },
    cfg = {
      ...config,
      rules: { ...config.rules, ETHUSDT: config.rules.BTCUSDT! },
    },
    data = bars.flatMap((b) => [b, { ...b, symbol: "ETHUSDT" }]);
  const original = backtest(multi, cfg, data),
    changed = structuredClone(data);
  const bar = changed.find(
    (b) => b.symbol === "BTCUSDT" && b.time === bars[5]!.time,
  )!;
  bar.close = "10000";
  bar.high = "10001";
  const altered = backtest(multi, cfg, changed);
  assert.deepEqual(
    original.state.fills.filter((f) => f.at === bars[5]!.time),
    altered.state.fills.filter((f) => f.at === bars[5]!.time),
  );
});
