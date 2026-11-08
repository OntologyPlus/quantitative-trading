import test from "node:test";
import assert from "node:assert/strict";
import { createSymbolDirectory } from "../src/adapters/symbol-directory.js";
import { DEFAULT_RULES } from "../src/domain/contracts.js";

const rows = [{ symbol: "BTCUSDT", rules: DEFAULT_RULES }];

test("directory shares refreshes, caches fresh rules and protects cached values from mutation", async () => {
  let calls = 0,
    now = 1000;
  const cache = createSymbolDirectory(
    async () => {
      calls++;
      return rows;
    },
    { now: () => now, ttlMs: 100 },
  );
  const [a, b] = await Promise.all([cache.read(), cache.read()]);
  assert.equal(calls, 1);
  assert.equal(a.asOf, b.asOf);
  a.symbols[0]!.rules.minQty = "999";
  const c = await cache.read();
  assert.equal(c.source, "cache");
  assert.equal(c.symbols[0]!.rules.minQty, DEFAULT_RULES.minQty);
  now += 100;
  await cache.read();
  assert.equal(calls, 2);
});

test("cancelling one caller does not abort the shared refresh or return stale data", async () => {
  let complete!: (value: typeof rows) => void;
  const cache = createSymbolDirectory(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const controller = new AbortController();
  const cancelled = cache.read(controller.signal),
    other = cache.read();
  const check = assert.rejects(cancelled, /abort/i);
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  complete(rows);
  await check;
  assert.equal((await other).symbols.length, 1);
  await assert.rejects(cache.read(AbortSignal.abort(), true), /abort/i);
});

test("outages allow dated inspection fallback but never stale execution rules", async () => {
  let now = 1000,
    offline = false;
  const cache = createSymbolDirectory(
    async () => {
      if (offline) throw Error("network down");
      return rows;
    },
    { now: () => now, ttlMs: 100, maxStaleMs: 500 },
  );
  const fresh = await cache.read();
  now += 101;
  offline = true;
  const stale = await cache.read(undefined, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.source, "cache");
  assert.equal(stale.asOf, fresh.asOf);
  assert.ok(stale.refreshError);
  await assert.rejects(cache.read(), /目录暂不可用/);
  now += 500;
  await assert.rejects(cache.read(undefined, true), /目录暂不可用/);
});

test("cold failures and timeouts are actionable, failed refreshes can retry", async () => {
  let calls = 0;
  const cache = createSymbolDirectory(async () => {
    if (++calls === 1) throw Error("offline");
    return rows;
  });
  await assert.rejects(cache.read(undefined, true), /导入 CSV/);
  assert.equal((await cache.read()).stale, false);
  const hanging = createSymbolDirectory(() => new Promise(() => {}), {
    timeoutMs: 10,
  });
  // AbortSignal.timeout does not itself keep Node alive.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(hanging.read(), /查询超时/);
  } finally {
    clearTimeout(keepAlive);
  }
});
