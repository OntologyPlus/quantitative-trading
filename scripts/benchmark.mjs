import { backtest, ENGINE_VERSION } from "../src/engine/backtest.ts";
import { synthetic } from "../src/adapters/market.ts";
import { configInput, strategySchema } from "../src/domain/schemas.ts";
import { DEFAULT_RULES } from "../src/domain/contracts.ts";
import { expandGrid, sweep, toColumns } from "../src/engine/sweep.ts";
const count = Number(process.env.N ?? 100000),
  bars = synthetic("BTCUSDT", "1m", count),
  strategy = strategySchema.parse({
    template: "sma_cross",
    symbols: ["BTCUSDT"],
    interval: "1m",
  }),
  config = {
    ...configInput.parse({}),
    rules: { BTCUSDT: DEFAULT_RULES },
    engineVersion: ENGINE_VERSION,
  };
let start = performance.now();
const result = backtest(strategy, config, bars);
const exactMs = performance.now() - start;
const columns = toColumns(bars, "1m"),
  combos = expandGrid(strategy, {
    fast: [5, 10, 15, 20, 30, 40, 50, 60, 80, 100],
    slow: [60, 90, 120, 150, 180, 240, 300, 360, 480, 600],
  });
sweep(columns, "sma_cross", combos.slice(0, 2), config); // warm-up
start = performance.now();
const rows = sweep(columns, "sma_cross", combos, config);
const sweepMs = performance.now() - start;
console.log(
  JSON.stringify(
    {
      bars: count,
      exactMilliseconds: Math.round(exactMs),
      rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      fills: result.state.fills.length,
      decisions: result.state.decisions.length,
      resultHash: result.hash,
      screening: {
        combinations: rows.length,
        milliseconds: Math.round(sweepMs),
        perCombinationMs: +(sweepMs / rows.length).toFixed(2),
      },
    },
    null,
    2,
  ),
);
