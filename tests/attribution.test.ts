import test from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/engine/core.js";
import { configInput } from "../src/domain/schemas.js";
import { DEFAULT_RULES, type RunRecord } from "../src/domain/contracts.js";
import { attributeRun, attributionValues } from "../src/domain/attribution.js";
import { resolveValue } from "../src/research/evaluation.js";

test("attribution reconciles fees, closing profits and marked holdings and includes the final close in its UTC month", () => {
  const state = initialState("1000");
  state.cash = "967.5";
  state.positions.ETHUSDT = {
    quantity: "1",
    cost: "50.5",
    stop: "0",
    take: "0",
  };
  state.prices = { BTCUSDT: "120", ETHUSDT: "60" };
  const common = {
    quantity: "1",
    slippage: "0",
    signalAt: Date.UTC(2025, 0, 1),
    reason: "test",
  };
  state.fills = [
    {
      ...common,
      id: "f1",
      orderId: "o1",
      symbol: "BTCUSDT",
      side: "BUY",
      price: "100",
      fee: "1",
      at: Date.UTC(2025, 0, 1),
      realizedPnl: null,
    },
    {
      ...common,
      id: "f2",
      orderId: "o2",
      symbol: "BTCUSDT",
      side: "SELL",
      price: "120",
      fee: "1",
      at: Date.UTC(2025, 0, 31),
      realizedPnl: "18",
    },
    {
      ...common,
      id: "f3",
      orderId: "o3",
      symbol: "ETHUSDT",
      side: "BUY",
      price: "50",
      fee: "0.5",
      at: Date.UTC(2025, 1, 1),
      realizedPnl: null,
    },
  ];
  state.curve = [
    {
      at: Date.UTC(2025, 0, 1),
      cash: "1000",
      equity: "1000",
      drawdownPct: "0",
    },
    {
      at: Date.UTC(2025, 1, 1),
      cash: "1018",
      equity: "1018",
      drawdownPct: "0",
    },
    {
      at: Date.UTC(2025, 2, 1),
      cash: "967.5",
      equity: "1027.5",
      drawdownPct: "0",
    },
  ];
  const run: RunRecord = {
    id: "r1",
    strategyId: "s1",
    datasetIds: [],
    status: "completed",
    progress: 100,
    createdAt: "2025-03-01T00:00:00Z",
    manifestHash: "manifest",
    config: {
      ...configInput.parse({ initialCash: "1000" }),
      from: Date.UTC(2025, 0, 1),
      to: Date.UTC(2025, 1, 28, 23),
      rules: { BTCUSDT: DEFAULT_RULES, ETHUSDT: DEFAULT_RULES },
      engineVersion: "test",
    },
    result: {
      state,
      metrics: {} as any,
      benchmarks: { cashReturnPct: "0", buyHoldReturnPct: "0" },
      hash: "result",
    },
  };
  const a = attributeRun(run);
  assert.deepEqual(
    a.months.map((m) => [m.month, m.pnl]),
    [
      ["2025-01", "18"],
      ["2025-02", "9.5"],
    ],
  );
  assert.deepEqual(
    a.symbols.map((s) => [s.symbol, s.pnl, s.fees, s.closedTrades]),
    [
      ["BTCUSDT", "18", "2", 1],
      ["ETHUSDT", "9.5", "0.5", 0],
    ],
  );
  assert.equal(a.topTradeSharePct, "100");
  assert.equal(resolveValue(run, "attribution.months.1.endEquity"), "1027.5");
  assert.equal(attributionValues(run)["attribution.symbols.1.pnl"], "9.5");
  assert.throws(
    () => resolveValue(run, "attribution.months.99.pnl"),
    /字段不存在/,
  );
  state.fills[1]!.realizedPnl = "0";
  assert.equal(attributeRun(run).topTradeSharePct, null);
  assert.equal(attributeRun(run).positiveClosedTrades, 0);
});
