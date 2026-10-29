import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Research } from "../src/host/research.js";
import {
  MonitorService,
  type MonitorRecord,
  type Notice,
} from "../src/host/monitor.js";
import type { Account } from "../src/domain/contracts.js";
const flush = () => new Promise<void>((r) => setImmediate(r));
test("monitor deduplicates unchanged faults, records recovery, emits a due factual review and respects disabling", async () => {
  const r = new Research(mkdtempSync(join(tmpdir(), "quant-monitor-"))),
    monitor = new MonitorService(r);
  r.closed = true;
  try {
    const s = r.draft(
      {
        submissionId: "s",
        expectedRevision: 0,
        name: "观察策略",
        definition: {
          template: "sma_cross",
          symbols: ["BTCUSDT"],
          interval: "1h",
        },
      },
      "user",
    );
    r.publish({ submissionId: "pub", id: s.id, expectedRevision: 1 });
    let a = r.accountCreate({
      submissionId: "account",
      name: "观察",
      strategyId: s.id,
      config: {},
    });
    await flush();
    a.status = "paused";
    a.error = "公共行情观察缺口";
    r.store.put("account", a.id, a);
    await flush();
    await flush();
    assert.equal(r.store.count("notice"), 1);
    for (let i = 0; i < 4; i++) {
      r.store.put("account", a.id, a);
      await flush();
    }
    assert.equal(r.store.count("notice"), 1);
    const n = r.store.list<Notice>("notice")[0]!;
    monitor.acknowledge({ submissionId: "ack", id: n.id });
    assert.equal(r.store.get<Notice>("notice", n.id).acknowledged, true);
    a.error = "";
    r.store.put("account", a.id, a);
    await flush();
    await flush();
    assert.ok(r.store.get<Notice>("notice", n.id).resolvedAt);
    const m = r.store.get<MonitorRecord>("monitor", a.id);
    m.nextReviewAt = Date.now() - 1;
    r.store.put("monitor", m.id, m);
    await flush();
    await flush();
    assert.equal(r.store.count("simulationReview"), 1);
    assert.equal(r.store.count("notice"), 2);
    monitor.config({
      submissionId: "disable",
      id: a.id,
      enabled: false,
      reviewHours: 24,
    });
    a.error = "另一个故障";
    r.store.put("account", a.id, a);
    await flush();
    await flush();
    assert.equal(r.store.count("notice"), 2);
  } finally {
    monitor.close();
    await r.close();
    rmSync(r.directory, { recursive: true, force: true });
  }
});
