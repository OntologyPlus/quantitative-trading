import { parentPort, workerData } from "node:worker_threads";
import { backtest } from "../engine/backtest.js";
const cancelled = new Int32Array(workerData.cancel);
try {
  parentPort!.postMessage({
    type: "result",
    result: backtest(
      workerData.strategy,
      workerData.config,
      workerData.bars,
      (n) => parentPort!.postMessage({ type: "progress", progress: n }),
      () => Atomics.load(cancelled, 0) === 1,
    ),
  });
} catch (e) {
  parentPort!.postMessage({
    type: "error",
    error: e instanceof Error ? e.message : String(e),
  });
}
