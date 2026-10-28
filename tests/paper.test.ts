import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Research } from "../src/host/research.js";
import { Paper } from "../src/host/paper.js";
import {
  DEFAULT_RULES,
  type Account,
  type Bar,
} from "../src/domain/contracts.js";
import { assertLedger } from "../src/engine/core.js";
test("paper stream executes after signal, de-duplicates bars and pauses on observation gaps", async (t) => {
  let now = Date.UTC(2026, 0, 1, 12);
  t.mock.method(Date, "now", () => now);
  const r = new Research(mkdtempSync(join(tmpdir(), "quant-paper-")));
  const warm: Bar[] = [10, 10, 10, 9, 8].map((p, i) => ({
    symbol: "BTCUSDT",
    time: now - (5 - i) * 3600000,
    open: String(p),
    high: String(p + 1),
    low: String(p - 1),
    close: String(p),
    volume: "10000",
  }));
  let socket: FakeSocket;
  class FakeSocket {
    listeners = new Map<string, (e: any) => void>();
    constructor(_url: string) {
      socket = this;
    }
    addEventListener(name: string, fn: any) {
      this.listeners.set(name, fn);
    }
    close() {}
    emit(k: any) {
      this.listeners.get("message")?.({
        data: JSON.stringify({ data: { k } }),
      });
    }
  }
  const paper = new Paper(r, {
    symbols: async () => [{ symbol: "BTCUSDT", rules: DEFAULT_RULES }],
    download: async () => warm,
    quote: async () => ({ price: "12", volume: "1", observedAt: now }),
    WebSocket: FakeSocket as unknown as typeof WebSocket,
  });
  try {
    const s = r.draft(
      {
        submissionId: "draft",
        expectedRevision: 0,
        name: "流测试",
        definition: {
          template: "sma_cross",
          symbols: ["BTCUSDT"],
          interval: "1h",
          fast: 2,
          slow: 3,
        },
      },
      "user",
    );
    r.publish({ submissionId: "pub", id: s.id, expectedRevision: 1 });
    const a = r.accountCreate({
      submissionId: "acc",
      name: "模拟",
      strategyId: s.id,
      config: { costs: { participationPct: "0" } },
    });
    await paper.control({
      submissionId: "start",
      id: a.id,
      expectedRevision: 1,
      action: "start",
    });
    now += 3600000;
    r.store.db.prepare("UPDATE lease SET expires=?").run(now + 120000);
    const k = {
      s: "BTCUSDT",
      t: now - 3600000,
      o: "8",
      h: "13",
      l: "7",
      c: "12",
      v: "10000",
      x: true,
    };
    socket!.emit(k);
    for (let i = 0; i < 10; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    let state = r.store.get<Account>("account", a.id);
    assert.equal(state.state.fills.length, 1);
    assert.ok(state.state.fills[0]!.at >= state.state.fills[0]!.signalAt);
    socket!.emit(k);
    for (let i = 0; i < 5; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    state = r.store.get<Account>("account", a.id);
    assert.equal(state.state.fills.length, 1);
    assertLedger(state.state, state.initialCash);
    now += 7200000;
    r.store.db.prepare("UPDATE lease SET expires=?").run(now + 120000);
    socket!.emit({ ...k, t: now - 3600000 });
    for (let i = 0; i < 5; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    state = r.store.get<Account>("account", a.id);
    assert.equal(state.status, "paused");
    assert.match(state.error, /缺口/);
    assert.equal(state.state.fills.length, 1);
  } finally {
    paper.close();
    const dir = r.directory;
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent duplicate starts keep one runtime and two accounts cannot both acquire execution", async () => {
  const r = new Research(mkdtempSync(join(tmpdir(), "quant-concurrent-")));
  let sockets = 0;
  class Socket {
    constructor(_url: string) {
      sockets++;
    }
    addEventListener() {}
    close() {}
  }
  const now = Math.floor(Date.now() / 3600000) * 3600000;
  const warm: Bar[] = [10, 9, 8].map((p, i) => ({
    symbol: "BTCUSDT",
    time: now - (3 - i) * 3600000,
    open: String(p),
    high: String(p + 1),
    low: String(p - 1),
    close: String(p),
    volume: "10000",
  }));
  const paper = new Paper(r, {
    symbols: async () => [{ symbol: "BTCUSDT", rules: DEFAULT_RULES }],
    download: async () => warm,
    quote: async () => ({ price: "12", volume: "1", observedAt: Date.now() }),
    WebSocket: Socket as unknown as typeof WebSocket,
  });
  try {
    const s = r.draft(
      {
        submissionId: "s",
        expectedRevision: 0,
        name: "并发验证",
        definition: {
          template: "sma_cross",
          symbols: ["BTCUSDT"],
          interval: "1h",
          fast: 2,
          slow: 3,
        },
      },
      "user",
    );
    r.publish({ submissionId: "p", id: s.id, expectedRevision: 1 });
    const a = r.accountCreate({
        submissionId: "a",
        name: "A",
        strategyId: s.id,
        config: {},
      }),
      b = r.accountCreate({
        submissionId: "b",
        name: "B",
        strategyId: s.id,
        config: {},
      }),
      start = {
        submissionId: "start",
        id: a.id,
        expectedRevision: 1,
        action: "start",
      };
    await Promise.all([paper.control(start), paper.control(start)]);
    assert.equal(sockets, 1);
    await paper.control({
      submissionId: "stop",
      id: a.id,
      expectedRevision: 2,
      action: "stop",
    });
    const results = await Promise.allSettled([
      paper.control({ ...start, submissionId: "again", expectedRevision: 3 }),
      paper.control({ ...start, submissionId: "other-account", id: b.id }),
    ]);
    assert.equal(results.filter((v) => v.status === "fulfilled").length, 1);
    assert.equal(
      r.store.list<Account>("account").filter((a) => a.status === "running")
        .length,
      1,
    );
  } finally {
    paper.close();
    const dir = r.directory;
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
