import { createHash } from "node:crypto";
import { z } from "zod";
import { D } from "../engine/core.js";
import { barSchema, fail, rulesSchema } from "../domain/schemas.js";
import {
  INTERVAL_MS,
  type Bar,
  type Interval,
  type Rules,
} from "../domain/contracts.js";
export const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export function validateBars(
  input: unknown,
  symbol: string,
  interval: Interval,
  now = Date.now(),
): Bar[] {
  const rows = z.array(barSchema).min(2).max(1000000).parse(input),
    step = INTERVAL_MS[interval];
  for (let i = 0; i < rows.length; i++) {
    const b = rows[i]!;
    if (b.symbol !== symbol) fail("SYMBOL_MISMATCH", "数据交易对不一致");
    if (b.time % step !== 0 || b.time + step > now)
      fail("UNCLOSED_BAR", "K 线时间不对齐或尚未收盘");
    if (
      D(b.high).lt(D(b.open)) ||
      D(b.high).lt(b.close) ||
      D(b.low).gt(b.open) ||
      D(b.low).gt(b.close) ||
      D(b.high).lt(b.low)
    )
      fail("INVALID_OHLC", "OHLC 关系无效");
    if (i && b.time - rows[i - 1]!.time !== step)
      fail("DATA_GAP", "行情存在缺口、重复或乱序，请补齐或缩小范围");
  }
  return rows;
}
export function parseCSV(text: string, symbol: string): Bar[] {
  if (Buffer.byteLength(text) > 64 * 1024 * 1024)
    fail("TOO_LARGE", "CSV 超过 64 MB");
  const lines = text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/);
  const header = lines
    .shift()
    ?.split(",")
    .map((s) => s.trim());
  const expected = ["time", "open", "high", "low", "close", "volume"];
  if (!header || header.join(",") !== expected.join(","))
    fail(
      "CSV_HEADER",
      "CSV 表头必须为 time,open,high,low,close,volume，time 为 UTC 毫秒",
    );
  return lines.map((line, i) => {
    const v = line.split(",").map((s) => s.trim());
    if (v.length !== 6) fail("CSV_ROW", `第 ${i + 2} 行应有六列`);
    return {
      symbol,
      time: Number(v[0]),
      open: v[1]!,
      high: v[2]!,
      low: v[3]!,
      close: v[4]!,
      volume: v[5]!,
    };
  });
}
export function synthetic(
  symbol: string,
  interval: Interval,
  count = 720,
): Bar[] {
  const step = INTERVAL_MS[interval],
    start = Date.UTC(2025, 0, 1);
  return Array.from({ length: count }, (_, i) => {
    const open = D(20000 + Math.sin((i - 1) / 16) * 2500 + (i - 1) * 4).toFixed(
        8,
      ),
      close = D(20000 + Math.sin(i / 16) * 2500 + i * 4).toFixed(8);
    return {
      symbol,
      time: start + i * step,
      open,
      high: D(open).gt(close)
        ? D(open).mul("1.003").toFixed(8)
        : D(close).mul("1.003").toFixed(8),
      low: D(open).lt(close)
        ? D(open).mul("0.997").toFixed(8)
        : D(close).mul("0.997").toFixed(8),
      close,
      volume: "10000",
    };
  });
}
const ROOT = "https://data-api.binance.vision";
let nextRequest = 0;
async function request(path: string, signal?: AbortSignal): Promise<any> {
  const wait = Math.max(0, nextRequest - Date.now());
  nextRequest = Math.max(nextRequest, Date.now()) + 250;
  if (wait)
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        },
        timer = setTimeout(finish, wait),
        abort = () => {
          clearTimeout(timer);
          reject(signal?.reason);
        };
      signal?.addEventListener("abort", abort, { once: true });
    });
  signal?.throwIfAborted();
  const response = await fetch(ROOT + path, {
    signal: AbortSignal.any([
      AbortSignal.timeout(15000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok)
    fail(
      response.status === 429 ? "RATE_LIMIT" : "MARKET_UNAVAILABLE",
      `公共行情返回 HTTP ${response.status}，可稍后重试或导入 CSV`,
    );
  return response.json();
}
export async function symbols(signal?: AbortSignal): Promise<
  {
    symbol: string;
    rules: Rules;
  }[]
> {
  const data = await request("/api/v3/exchangeInfo", signal);
  return data.symbols
    .filter(
      (x: any) =>
        x.status === "TRADING" &&
        x.quoteAsset === "USDT" &&
        x.isSpotTradingAllowed,
    )
    .map((x: any) => {
      const lot = x.filters.find((f: any) => f.filterType === "LOT_SIZE"),
        notional = x.filters.find(
          (f: any) =>
            f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL",
        ),
        price = x.filters.find((f: any) => f.filterType === "PRICE_FILTER");
      return {
        symbol: x.symbol,
        rules: rulesSchema.parse({
          stepSize: lot.stepSize,
          minQty: lot.minQty,
          maxQty: lot.maxQty,
          minNotional: notional?.minNotional ?? "0",
          tickSize: price.tickSize,
        }),
      };
    });
}
export async function download(
  symbol: string,
  interval: Interval,
  from: number,
  to: number,
  signal?: AbortSignal,
  onProgress?: (n: number) => void,
): Promise<Bar[]> {
  const rows: Bar[] = [],
    step = INTERVAL_MS[interval];
  let cursor = from;
  const last = Math.min(to, Math.floor(Date.now() / step) * step - step);
  while (cursor <= last) {
    signal?.throwIfAborted();
    const chunk = await request(
      `/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${last}&limit=1000`,
      signal,
    );
    if (!Array.isArray(chunk) || !chunk.length) break;
    for (const k of chunk) {
      if (Number(k[6]) >= Date.now()) continue;
      rows.push({
        symbol,
        time: Number(k[0]),
        open: k[1],
        high: k[2],
        low: k[3],
        close: k[4],
        volume: k[5],
      });
    }
    if (rows.length > 1000000) fail("TOO_LARGE", "数据超过一百万根上限");
    const next = Number(chunk.at(-1)[0]) + step;
    if (next <= cursor) fail("BAD_CURSOR", "行情分页未推进");
    cursor = next;
    onProgress?.(
      Math.min(99, Math.round(((cursor - from) / (last - from + step)) * 100)),
    );
  }
  return rows;
}
export async function quote(
  symbol: string,
  signal?: AbortSignal,
): Promise<{
  price: string;
  volume: string;
  observedAt: number;
}> {
  const q = await request(`/api/v3/trades?symbol=${symbol}&limit=1`, signal);
  if (!q[0]) fail("QUOTE_MISSING", "无有效成交报价");
  const at = Number(q[0].time);
  if (Math.abs(Date.now() - at) > 60000)
    fail("QUOTE_STALE", "成交报价超过 60 秒");
  return { price: q[0].price, volume: q[0].qty, observedAt: at };
}
