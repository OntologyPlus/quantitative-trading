import type { Rules } from "../domain/contracts.js";
import { fail } from "../domain/schemas.js";

export interface MarketSymbol {
  symbol: string;
  rules: Rules;
}
export interface SymbolDirectorySnapshot {
  symbols: MarketSymbol[];
  asOf: string;
  stale: boolean;
  source: "network" | "cache";
  refreshError?: string;
}

/** A caller's cancellation must not cancel a refresh shared by other callers. */
export function createSymbolDirectory(
  load: (signal: AbortSignal) => Promise<MarketSymbol[]>,
  options: {
    now?: () => number;
    ttlMs?: number;
    maxStaleMs?: number;
    timeoutMs?: number;
  } = {},
) {
  const now = options.now ?? Date.now,
    ttl = options.ttlMs ?? 5 * 60000,
    maxStale = options.maxStaleMs ?? 24 * 3600000;
  let cached: { symbols: MarketSymbol[]; at: number } | undefined,
    pending: Promise<void> | undefined;

  const refresh = () => {
    if (!pending) {
      const signal = AbortSignal.timeout(options.timeoutMs ?? 8000);
      pending = (async () => {
        // Race also bounds a loader which does not honour cancellation.
        const symbols = await new Promise<MarketSymbol[]>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          Promise.resolve()
            .then(() => load(signal))
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
        });
        if (!symbols.length) throw Error("交易对目录为空");
        cached = { symbols: structuredClone(symbols), at: now() };
      })().finally(() => {
        pending = undefined;
      });
    }
    return pending;
  };

  return {
    async read(
      signal?: AbortSignal,
      allowStale = false,
    ): Promise<SymbolDirectorySnapshot> {
      signal?.throwIfAborted();
      if (cached && now() - cached.at < ttl)
        return {
          symbols: structuredClone(cached.symbols),
          asOf: new Date(cached.at).toISOString(),
          stale: false,
          source: "cache",
        };
      const job = refresh();
      let abort: (() => void) | undefined;
      try {
        await (signal
          ? Promise.race([
              job,
              new Promise<never>((_resolve, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener("abort", abort, { once: true });
              }),
            ])
          : job);
        signal?.throwIfAborted();
        return {
          symbols: structuredClone(cached!.symbols),
          asOf: new Date(cached!.at).toISOString(),
          stale: false,
          source: "network",
        };
      } catch (error) {
        signal?.throwIfAborted();
        if (allowStale && cached && now() - cached.at <= maxStale)
          return {
            symbols: structuredClone(cached.symbols),
            asOf: new Date(cached.at).toISOString(),
            stale: true,
            source: "cache",
            refreshError:
              "公共行情暂不可用；仅供池子核对，不能作为当前成交规则",
          };
        fail(
          "MARKET_UNAVAILABLE",
          "交易对目录暂不可用或查询超时，请稍后重试；也可用已有快照研究或导入 CSV",
        );
      } finally {
        if (abort) signal?.removeEventListener("abort", abort);
      }
    },
  };
}
