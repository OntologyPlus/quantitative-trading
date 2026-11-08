import { parentPort, workerData } from "node:worker_threads";
import { sweep, type SweepColumns } from "../engine/sweep.js";

// Columns arrive as SharedArrayBuffer-backed views: no copy per worker.
const d = workerData as {
  columns: SweepColumns;
  template: "sma_cross" | "breakout";
  combos: Parameters<typeof sweep>[2];
  config: Parameters<typeof sweep>[3];
  cancel: SharedArrayBuffer;
  withDaily?: boolean;
};
const cancelled = new Int32Array(d.cancel);
try {
  parentPort!.postMessage({
    type: "result",
    rows: sweep(d.columns, d.template, d.combos, d.config, () => Atomics.load(cancelled, 0) === 1, !!d.withDaily),
  });
} catch (e) {
  parentPort!.postMessage({ type: "error", error: e instanceof Error ? e.message : String(e) });
}
