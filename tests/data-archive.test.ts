import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import {
  archiveMonths,
  assertGapPolicy,
  download,
  gapReport,
  parseArchiveCSV,
  synthetic,
  unzipSingle,
  validateBars,
} from "../src/adapters/market.js";
import { backtest, ENGINE_VERSION } from "../src/engine/backtest.js";
import { sweep, toColumns } from "../src/engine/sweep.js";
import { configInput, strategySchema } from "../src/domain/schemas.js";
import { DEFAULT_RULES, type Strategy } from "../src/domain/contracts.js";

/** Minimal single-entry zip, as Binance publishes. */
function zip(name: string, text: string) {
  const data = deflateRawSync(Buffer.from(text)),
    n = Buffer.from(name),
    local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(text.length, 22);
  local.writeUInt16LE(n.length, 26);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(text.length, 24);
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const centralAt = local.length + n.length + data.length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + n.length, 12);
  end.writeUInt32LE(centralAt, 16);
  return new Uint8Array(Buffer.concat([local, n, data, central, n, end]));
}

test("gaps are reported and bounded instead of rejecting the snapshot", () => {
  const bars = synthetic("BTCUSDT", "1h", 500);
  const holed = bars.filter((_, i) => i !== 100 && i !== 101 && i !== 300);
  assert.throws(() => validateBars(holed, "BTCUSDT", "1h"), /缺口/);
  assert.equal(validateBars(holed, "BTCUSDT", "1h", Date.now(), { allowGaps: true }).length, 497);
  assert.deepEqual(gapReport(holed, "1h"), { gaps: 2, missing: 3, longestMs: 2 * 3600000 });
  assert.equal(assertGapPolicy(holed, "1h").gaps, 2);
  const many = bars.filter((_, i) => i % 50 !== 7);
  assert.throws(() => assertGapPolicy(many, "1h"), /1% 上限/);
  const long = synthetic("BTCUSDT", "1h", 10000).filter((_, i) => i < 200 || i > 280);
  assert.throws(() => assertGapPolicy(long, "1h"), /72 小时/);
  const dup = structuredClone(bars);
  dup[3]!.time = dup[2]!.time;
  assert.throws(() => validateBars(dup, "BTCUSDT", "1h", Date.now(), { allowGaps: true }), /重复或乱序/);
});

test("a signal whose next open falls in a data hole is voided, in both engines", () => {
  const bars = synthetic("BTCUSDT", "1h", 1200);
  const strategy = strategySchema.parse({ template: "sma_cross", symbols: ["BTCUSDT"], interval: "1h", fast: 5, slow: 20 }) as Strategy;
  const config = {
    ...configInput.parse({ risk: { weightPct: "30", maxSymbolPct: "40" } }),
    rules: { BTCUSDT: DEFAULT_RULES },
    from: bars[0]!.time,
    to: bars.at(-1)!.time,
    engineVersion: ENGINE_VERSION,
  };
  const full = backtest(strategy, config, bars),
    fill = full.state.fills[2]!,
    holed = bars.filter((b) => b.time !== fill.at);
  const r = backtest(strategy, config, holed);
  const gap = r.state.decisions.find((d) => d.code === "DATA_GAP");
  assert.ok(gap);
  assert.ok(!r.state.fills.some((f) => f.orderId === gap.orderId));
  const [row] = sweep(toColumns(holed, "1h"), "sma_cross", [strategy], config);
  assert.equal(row!.trades, r.metrics.trades);
  assert.ok(Math.abs(row!.returnPct - Number(r.metrics.returnPct)) < 1e-6);
});

test("monthly archives: zip, checksum, microsecond timestamps and REST fallback", async () => {
  assert.equal(unzipSingle(zip("a.csv", "hello")), "hello");
  const us = parseArchiveCSV("1735689600000000,1,2,0.5,1.5,10,1735689659999999,0,0,0,0,0\n", "BTCUSDT");
  assert.equal(us[0]!.time, 1735689600000);
  assert.deepEqual(
    archiveMonths(Date.UTC(2024, 0, 15), Date.UTC(2024, 4, 10), Date.UTC(2024, 5, 2)).map((m) => m.label),
    ["2024-02", "2024-03", "2024-04"],
  );
  // Archive for 2024-02 only; 2024-03 missing (404) must fall back to REST.
  const from = Date.UTC(2024, 1, 1),
    to = Date.UTC(2024, 2, 31, 23),
    feb = synthetic("BTCUSDT", "1h", 29 * 24).map((b, i) => ({ ...b, time: from + i * 3600000 }));
  const csv = feb.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume, b.time + 3599999, 0, 0, 0, 0, 0].join(",")).join("\n");
  const archive = zip("BTCUSDT-1h-2024-02.csv", csv),
    checksum = createHash("sha256").update(archive).digest("hex") + "  BTCUSDT-1h-2024-02.zip\n";
  const requested: string[] = [];
  const fetchBinary = async (url: string) => {
    requested.push(url);
    if (url.endsWith("2024-02.zip")) return archive;
    if (url.endsWith("2024-02.zip.CHECKSUM")) return new Uint8Array(Buffer.from(checksum));
    return null;
  };
  const restCalls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    restCalls.push(url);
    const u = new URL(url),
      start = Number(u.searchParams.get("startTime")),
      end = Number(u.searchParams.get("endTime")),
      out = [];
    for (let t = start; t <= end && out.length < 1000; t += 3600000)
      out.push([t, "1", "2", "0.5", "1.5", "10", t + 3599999]);
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  try {
    const bars = await download("BTCUSDT", "1h", from, to, undefined, undefined, {
      fetchBinary,
      now: Date.UTC(2024, 5, 1),
    });
    assert.equal(bars.length, (29 + 31) * 24);
    assert.deepEqual(bars.slice(0, feb.length), feb);
    assert.equal(validateBars(bars, "BTCUSDT", "1h").length, bars.length);
    assert.ok(restCalls.every((u) => Number(new URL(u).searchParams.get("startTime")) >= Date.UTC(2024, 2, 1)));
    const bad = await download("BTCUSDT", "1h", from, to, undefined, undefined, {
      fetchBinary: async (url) => (url.endsWith("CHECKSUM") ? new Uint8Array(Buffer.from("0".repeat(64))) : fetchBinary(url)),
      now: Date.UTC(2024, 5, 1),
    }).catch((e) => e);
    assert.match(String(bad), /校验失败/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
