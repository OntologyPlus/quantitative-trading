import { backtest, ENGINE_VERSION } from "../src/engine/backtest.ts";
import { synthetic } from "../src/adapters/market.ts";
import { configInput, strategySchema } from "../src/domain/schemas.ts";
import { DEFAULT_RULES } from "../src/domain/contracts.ts";
const count = 100000,
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
const start = performance.now(),
  result = backtest(strategy, config, bars);
console.log(
  JSON.stringify(
    {
      bars: count,
      milliseconds: Math.round(performance.now() - start),
      rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      fills: result.state.fills.length,
      resultHash: result.hash,
    },
    null,
    2,
  ),
);
