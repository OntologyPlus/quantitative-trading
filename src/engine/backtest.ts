import { hash } from "../adapters/market.js";
import type {
  Bar,
  RunConfig,
  RunResult,
  Strategy,
} from "../domain/contracts.js";
import { D, initialState, ingestBatch, metrics, assertLedger } from "./core.js";
declare const __ENGINE_BUILD_HASH__: string;
export const ENGINE_VERSION = `quant-engine-0.1.0+${typeof __ENGINE_BUILD_HASH__ === "string" ? __ENGINE_BUILD_HASH__ : "source"}`;
export function backtest(
  strategy: Strategy,
  config: RunConfig,
  bars: Bar[],
  progress?: (n: number) => void,
  cancel?: () => boolean,
): RunResult {
  const st = initialState(config.initialCash),
    sorted = [...bars].sort(
      (a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol),
    );
  for (let i = 0; i < sorted.length; ) {
    if (cancel?.()) throw Error("任务已取消");
    if (i % 1000 < strategy.symbols.length)
      progress?.(Math.floor((i / sorted.length) * 100));
    const time = sorted[i]!.time,
      group: Bar[] = [];
    while (i < sorted.length && sorted[i]!.time === time)
      group.push(sorted[i++]!);
    if (time <= config.to) ingestBatch(st, strategy, config, group);
  }
  // The final close may create an intent, but there is no subsequent observation to fill it.
  for (const order of Object.values(st.pending))
    st.decisions.push({
      id: `d${++st.sequence}`,
      at: order.signalAt,
      symbol: order.symbol,
      code: "END_OF_DATA",
      reason: "期末无后续可成交数据",
      orderId: order.id,
    });
  st.pending = {};
  let baseline = D(0);
  for (const symbol of strategy.symbols) {
    const data = sorted.filter(
        (b) =>
          b.symbol === symbol && b.time >= config.from && b.time <= config.to,
      ),
      first = data[0],
      last = data.at(-1);
    if (first && last) {
      const slip = D(config.costs.slippageBps).div(10000),
        fee = D(config.costs.feeBps).div(10000);
      baseline = baseline.plus(
        D(last.close).div(
          D(first.open).mul(D(1).plus(slip)).mul(D(1).plus(fee)),
        ),
      );
    } else baseline = baseline.plus(1);
  }
  assertLedger(st, config.initialCash);
  const body = {
    state: st,
    metrics: metrics(st, config),
    benchmarks: {
      cashReturnPct: "0",
      buyHoldReturnPct: baseline
        .div(strategy.symbols.length)
        .minus(1)
        .mul(100)
        .toFixed(),
    },
  };
  return { ...body, hash: hash(body) };
}
