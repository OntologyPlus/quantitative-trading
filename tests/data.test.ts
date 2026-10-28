import test from "node:test";
import assert from "node:assert/strict";
import { parseCSV, synthetic, validateBars } from "../src/adapters/market.js";
test("CSV and snapshots reject gaps, duplicates, unfinished bars, invalid OHLC and column shape", () => {
  const bars = synthetic("BTCUSDT", "1h", 10);
  assert.equal(validateBars(bars, "BTCUSDT", "1h").length, 10);
  const duplicate = structuredClone(bars);
  duplicate[2]!.time = duplicate[1]!.time;
  assert.throws(() => validateBars(duplicate, "BTCUSDT", "1h"), /缺口/);
  const gap = structuredClone(bars);
  gap.splice(2, 1);
  assert.throws(() => validateBars(gap, "BTCUSDT", "1h"), /缺口/);
  const bad = structuredClone(bars);
  bad[0]!.high = "1";
  assert.throws(() => validateBars(bad, "BTCUSDT", "1h"), /OHLC/);
  assert.throws(
    () => validateBars(bars, "BTCUSDT", "1h", bars[1]!.time),
    /尚未收盘/,
  );
  assert.throws(() => parseCSV("date,open\n1,2", "BTCUSDT"), /表头/);
  const csv =
    "time,open,high,low,close,volume\n" +
    bars
      .map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume].join(","))
      .join("\n");
  assert.deepEqual(
    validateBars(parseCSV(csv, "BTCUSDT"), "BTCUSDT", "1h"),
    bars,
  );
});
