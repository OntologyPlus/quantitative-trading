import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { sweep, type SweepColumns } from "../engine/sweep.js";
import type { Screener } from "../research/sweep.js";

function shared(columns: SweepColumns): SweepColumns {
  const copy = (a: Float64Array) => {
    const v = new Float64Array(new SharedArrayBuffer(a.byteLength));
    v.set(a);
    return v;
  };
  return {
    ...columns,
    time: copy(columns.time),
    open: copy(columns.open),
    high: copy(columns.high),
    low: copy(columns.low),
    close: copy(columns.close),
    volume: copy(columns.volume),
  };
}

/**
 * Fans screening out over worker threads sharing one read-only copy of the
 * columns. Falls back to the calling thread when the worker is not built or
 * the job is small. Row order matches the combination order.
 */
export function poolScreener(
  options: {
    workerURL?: URL;
    threads?: number;
    signal?: AbortSignal;
    minPerThread?: number;
  } = {},
): Screener {
  const url = options.workerURL ?? new URL("../workers/sweep.js", import.meta.url);
  return async (columns, template, combos, config, withDaily = false) => {
    const threads = Math.max(
      1,
      Math.min(
        options.threads ?? availableParallelism() - 1,
        Math.floor(combos.length / (options.minPerThread ?? 16)),
      ),
    );
    if (threads <= 1 || !existsSync(fileURLToPath(url)))
      return sweep(columns, template, combos, config, () => !!options.signal?.aborted, withDaily);
    const cols = shared(columns),
      cancel = new SharedArrayBuffer(4),
      flag = new Int32Array(cancel),
      size = Math.ceil(combos.length / threads),
      workers: Worker[] = [];
    const onAbort = () => Atomics.store(flag, 0, 1);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const parts = await Promise.all(
        Array.from({ length: threads }, (_, i) =>
          new Promise<ReturnType<typeof sweep>>((resolve, reject) => {
            const w = new Worker(url, {
              workerData: { columns: cols, template, combos: combos.slice(i * size, (i + 1) * size), config, cancel, withDaily },
              resourceLimits: { maxOldGenerationSizeMb: 256 },
            });
            workers.push(w);
            w.once("message", (m) => (m.type === "result" ? resolve(m.rows) : reject(new Error(m.error))));
            w.once("error", reject);
            w.once("exit", (code) => code && reject(new Error(`扫描线程异常退出 ${code}`)));
          }),
        ),
      );
      return parts.flat();
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      await Promise.all(workers.map((w) => w.terminate()));
    }
  };
}
