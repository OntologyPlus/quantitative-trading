import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
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
export interface GapReport {
  /** Number of separate holes in the series. */
  gaps: number;
  /** Bars missing inside [first, last]. */
  missing: number;
  longestMs: number;
}
/** Tolerance for snapshots: at most 1% of bars missing, no hole longer than 72 h. */
export const GAP_POLICY = { maxMissingRatio: 0.01, maxGapMs: 72 * 3600000 };
export function gapReport(bars: Bar[], interval: Interval): GapReport {
  const step = INTERVAL_MS[interval];
  let gaps = 0,
    missing = 0,
    longestMs = 0;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i]!.time - bars[i - 1]!.time;
    if (d > step) {
      gaps++;
      missing += d / step - 1;
      longestMs = Math.max(longestMs, d - step);
    }
  }
  return { gaps, missing, longestMs };
}
/**
 * Validates a snapshot. Duplicates, disorder, misalignment, unclosed bars and
 * invalid OHLC always fail. Holes fail unless `allowGaps`; callers that accept
 * them apply GAP_POLICY when the snapshot is created (see `assertGapPolicy`).
 */
export function validateBars(
  input: unknown,
  symbol: string,
  interval: Interval,
  now = Date.now(),
  options: { allowGaps?: boolean } = {},
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
    if (i) {
      const d = b.time - rows[i - 1]!.time;
      if (d <= 0) fail("DATA_ORDER", "行情存在缺口、重复或乱序：时间重复或乱序");
      if (d !== step && !options.allowGaps)
        fail("DATA_GAP", "行情存在缺口、重复或乱序，请补齐或缩小范围");
    }
  }
  return rows;
}
export function assertGapPolicy(bars: Bar[], interval: Interval) {
  const r = gapReport(bars, interval),
    expected = r.missing + bars.length;
  if (r.missing / expected > GAP_POLICY.maxMissingRatio)
    fail(
      "DATA_GAP",
      `行情缺失 ${r.missing} 根（${((r.missing / expected) * 100).toFixed(2)}%），超过 1% 上限，请缩小范围`,
    );
  if (r.longestMs > GAP_POLICY.maxGapMs)
    fail(
      "DATA_GAP",
      `行情存在 ${(r.longestMs / 3600000).toFixed(1)} 小时的连续缺口，超过 72 小时上限，请缩小范围`,
    );
  return r;
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
async function restRange(
  symbol: string,
  interval: Interval,
  from: number,
  last: number,
  rows: Bar[],
  signal?: AbortSignal,
  onAdvance?: (cursor: number) => void,
) {
  const step = INTERVAL_MS[interval];
  let cursor = from;
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
    onAdvance?.(cursor);
  }
}

// ---- Monthly archives (data.binance.vision) -------------------------------
const ARCHIVE = "https://data.binance.vision";
/** Fetches a URL as bytes; null on 404 (no archive for that month). */
export type BinaryFetch = (
  url: string,
  signal?: AbortSignal,
) => Promise<Uint8Array | null>;
const fetchBinary: BinaryFetch = async (url, signal) => {
  const response = await fetch(url, {
    signal: AbortSignal.any([
      AbortSignal.timeout(60000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (response.status === 404) return null;
  if (!response.ok)
    fail("MARKET_UNAVAILABLE", `行情归档返回 HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};
/** Reads the single CSV entry of a Binance archive zip. */
export function unzipSingle(zip: Uint8Array): string {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) fail("ARCHIVE_INVALID", "行情归档不是有效 zip");
  const central = v.getUint32(eocd + 16, true);
  if (v.getUint32(central, true) !== 0x02014b50)
    fail("ARCHIVE_INVALID", "行情归档目录无效");
  const method = v.getUint16(central + 10, true),
    size = v.getUint32(central + 20, true),
    local = v.getUint32(central + 42, true);
  if (v.getUint32(local, true) !== 0x04034b50)
    fail("ARCHIVE_INVALID", "行情归档条目无效");
  const start =
      local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true),
    body = zip.subarray(start, start + size);
  if (method === 0) return Buffer.from(body).toString("utf8");
  if (method !== 8) fail("ARCHIVE_INVALID", "行情归档压缩格式不支持");
  return inflateRawSync(body).toString("utf8");
}
/** Parses Binance kline CSV; open times after 2025 are in microseconds. */
export function parseArchiveCSV(text: string, symbol: string): Bar[] {
  const out: Bar[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || !/^\d/.test(line)) continue; // header lines, if any
    const v = line.split(",");
    if (v.length < 6) fail("ARCHIVE_ROW", "行情归档行格式无效");
    let time = Number(v[0]);
    if (time > 1e14) time = Math.floor(time / 1000);
    out.push({
      symbol,
      time,
      open: v[1]!,
      high: v[2]!,
      low: v[3]!,
      close: v[4]!,
      volume: v[5]!,
    });
  }
  return out;
}
const monthStart = (y: number, m: number) => Date.UTC(y, m, 1);
/** Complete UTC months inside [from, last] that are older than the current month. */
export function archiveMonths(from: number, last: number, now = Date.now()) {
  const d = new Date(from),
    current = new Date(now),
    limit = monthStart(current.getUTCFullYear(), current.getUTCMonth());
  const months: { start: number; end: number; label: string }[] = [];
  let y = d.getUTCFullYear(),
    m = d.getUTCMonth();
  if (monthStart(y, m) < from) m++;
  for (;;) {
    const start = monthStart(y, m),
      end = monthStart(y, m + 1);
    if (end > limit || end - 1 > last) break;
    const s = new Date(start);
    months.push({
      start,
      end,
      label: `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, "0")}`,
    });
    m++;
  }
  return months;
}
async function archiveMonth(
  symbol: string,
  interval: Interval,
  label: string,
  signal: AbortSignal | undefined,
  get: BinaryFetch,
): Promise<Bar[] | null> {
  const name = `${symbol}-${interval}-${label}.zip`,
    url = `${ARCHIVE}/data/spot/monthly/klines/${symbol}/${interval}/${name}`;
  const zip = await get(url, signal);
  if (!zip) return null;
  const sum = await get(`${url}.CHECKSUM`, signal);
  if (sum) {
    const expected = Buffer.from(sum).toString("utf8").trim().split(/\s+/)[0];
    if (createHash("sha256").update(zip).digest("hex") !== expected)
      fail("ARCHIVE_CHECKSUM", `行情归档 ${name} 校验失败`);
  }
  return parseArchiveCSV(unzipSingle(zip), symbol);
}

/**
 * Closed klines in [from, to]. Whole months older than the current month come
 * from checksummed monthly archives (one request per month instead of up to
 * 44 640 REST pages for 1m); everything else, and any month without an
 * archive, comes from the REST API.
 */
export async function download(
  symbol: string,
  interval: Interval,
  from: number,
  to: number,
  signal?: AbortSignal,
  onProgress?: (n: number) => void,
  options: { archives?: boolean; fetchBinary?: BinaryFetch; now?: number } = {},
): Promise<Bar[]> {
  const rows: Bar[] = [],
    step = INTERVAL_MS[interval],
    now = options.now ?? Date.now(),
    last = Math.min(to, Math.floor(now / step) * step - step),
    span = last - from + step,
    progress = (cursor: number) =>
      onProgress?.(Math.min(99, Math.round(((cursor - from) / span) * 100)));
  if (last < from) return rows;
  const months =
    options.archives === false ? [] : archiveMonths(from, last, now);
  let cursor = from;
  for (const month of months) {
    signal?.throwIfAborted();
    const bars = await archiveMonth(
      symbol,
      interval,
      month.label,
      signal,
      options.fetchBinary ?? fetchBinary,
    );
    if (!bars) continue; // no archive (e.g. before listing): REST covers it
    if (cursor < month.start)
      await restRange(symbol, interval, cursor, month.start - step, rows, signal, progress);
    for (const b of bars) if (b.time >= month.start && b.time < month.end) rows.push(b);
    if (rows.length > 1000000) fail("TOO_LARGE", "数据超过一百万根上限");
    cursor = month.end;
    progress(cursor);
  }
  if (cursor <= last)
    await restRange(symbol, interval, cursor, last, rows, signal, progress);
  return rows.filter((b) => b.time >= from && b.time <= last);
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
