import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { QuantError, fail } from "../domain/schemas.js";
import type { Research } from "./research.js";

/** One bounded read-only job per application; no task can occupy the host thread. */
export class LabExecutor {
  private active: {
    stop: (code: string, message: string) => Promise<void>;
  } | null = null;
  private closed = false;
  constructor(
    private workerURL = new URL("../workers/lab.js", import.meta.url),
    private timeoutMs = 120000,
  ) {}
  run(
    research: Research,
    action: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.closed || research.closed)
      fail("LAB_CLOSED", "研究计算服务已关闭");
    research.store.assertLease();
    signal?.throwIfAborted();
    if (this.active)
      fail("LAB_BUSY", "已有研究分析正在计算，请等待或取消后重试");
    if (!existsSync(this.workerURL))
      fail("LAB_WORKER_UNAVAILABLE", "研究计算组件未构建，请重新构建后启动");
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerURL, {
        workerData: { directory: research.directory, action, input },
        resourceLimits: { maxOldGenerationSizeMb: 768, stackSizeMb: 8 },
      });
      let settled = false;
      let finishing: Promise<void> | null = null;
      const finish = (error?: Error, value?: unknown): Promise<void> => {
        if (finishing) return finishing;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        finishing = (async () => {
          try {
            await worker.terminate();
          } catch (e) {
            error ??= e instanceof Error ? e : new Error(String(e));
          }
          this.active = null;
          if (error) reject(error);
          else resolve(value);
        })();
        return finishing;
      };
      const abort = () => {
        void finish(new QuantError("LAB_CANCELLED", "研究分析已取消"));
      };
      const timer = setTimeout(() => {
        void finish(new QuantError("LAB_TIMEOUT", "研究分析超过计算时长上限"));
      }, this.timeoutMs);
      this.active = {
        stop: (code, message) => finish(new QuantError(code, message)),
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      worker.on("message", (message) => {
        if (message.type === "result") {
          try {
            research.store.assertLease();
            void finish(undefined, message.value);
          } catch (e) {
            void finish(e instanceof Error ? e : new Error(String(e)));
          }
        } else
          void finish(
            new QuantError(
              message.code ?? "LAB_FAILED",
              message.message ?? "研究分析失败",
            ),
          );
      });
      worker.on("error", (error) => {
        void finish(new QuantError("LAB_FAILED", error.message));
      });
      worker.on("exit", (code) => {
        if (!settled)
          void finish(
            new QuantError(
              "LAB_WORKER_EXIT",
              `研究计算进程提前退出（${code}）`,
            ),
          );
      });
    });
  }
  async close() {
    this.closed = true;
    await this.active?.stop("LAB_CLOSED", "研究计算服务已关闭");
  }
}
