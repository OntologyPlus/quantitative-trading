import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Research } from "../src/host/research.js";
import { exportBackup, restoreBackup } from "../src/host/backup.js";
import { backtest } from "../src/engine/backtest.js";
import { Paper } from "../src/host/paper.js";
import { configInput } from "../src/domain/schemas.js";
import type { Account, RunRecord } from "../src/domain/contracts.js";
const input = {
  submissionId: "strategy-1",
  expectedRevision: 0,
  name: "研究策略",
  definition: {
    template: "sma_cross",
    symbols: ["BTCUSDT"],
    interval: "1h",
    fast: 2,
    slow: 3,
  },
};
function fixture() {
  return new Research(mkdtempSync(join(tmpdir(), "quant-test-")));
}
async function clean(r: Research) {
  const dir = r.directory;
  await r.close();
  rmSync(dir, { recursive: true, force: true });
}
test("draft revisions, publication, idempotent data and immutable runs", async () => {
  const r = fixture();
  try {
    const a = r.draft(input, "ai");
    assert.equal(r.draft(input, "ai").id, a.id);
    assert.throws(
      () => r.draft({ ...input, name: "changed" }, "ai"),
      /提交身份/,
    );
    assert.throws(
      () =>
        r.draft(
          { ...input, submissionId: "other", id: a.id, expectedRevision: 0 },
          "ai",
        ),
      /版本/,
    );
    const published = r.publish({
      submissionId: "publish",
      id: a.id,
      expectedRevision: 1,
    });
    assert.equal(published.author, "user");
    assert.throws(
      () =>
        r.draft(
          {
            ...input,
            submissionId: "edit-published",
            id: a.id,
            expectedRevision: 2,
          },
          "ai",
        ),
      /不可修改/,
    );
    const d = r.demo({ submissionId: "demo" });
    assert.equal(r.demo({ submissionId: "demo" }).id, d.id);
    const run = r.submitRun({
      submissionId: "run",
      strategyId: a.id,
      datasetIds: [d.id],
      config: {},
    });
    assert.equal(run.status, "queued");
    assert.equal(
      r.submitRun({
        submissionId: "run",
        strategyId: a.id,
        datasetIds: [d.id],
        config: {},
      }).id,
      run.id,
    );
    r.cancel({ submissionId: "cancel", id: run.id, kind: "run" });
    assert.equal(r.store.get<RunRecord>("run", run.id).status, "cancelled");
    assert.throws(
      () => r.cancel({ submissionId: "again", id: run.id, kind: "run" }),
      /已经结束/,
    );
  } finally {
    await clean(r);
  }
});
test("one data directory has one writer, restart pauses accounts", async () => {
  const r = fixture(),
    dir = r.directory;
  assert.throws(() => new Research(dir), /已有运行实例/);
  const a = r.draft(input, "user");
  r.publish({ submissionId: "publish", id: a.id, expectedRevision: 1 });
  const account = r.accountCreate({
    submissionId: "account",
    name: "模拟",
    strategyId: a.id,
    config: {},
  });
  account.status = "running";
  r.store.put("account", account.id, account);
  await r.close();
  const next = new Research(dir);
  try {
    assert.equal(
      next.store.get<Account>("account", account.id).status,
      "paused",
    );
    assert.match(next.store.get<Account>("account", account.id).error, /重启/);
  } finally {
    await clean(next);
  }
});
test("backup hash, references, ledger and nonempty restore checks", async () => {
  const r = fixture(),
    other = fixture();
  try {
    const a = r.draft(input, "user");
    r.publish({ submissionId: "publish", id: a.id, expectedRevision: 1 });
    const d = r.demo({ submissionId: "demo" }),
      run = r.submitRun({
        submissionId: "run",
        strategyId: a.id,
        datasetIds: [d.id],
        config: {},
      });
    run.result = backtest(a.definition, run.config, r.bars(d));
    run.status = "completed";
    run.progress = 100;
    r.store.put("run", run.id, run);
    r.store.put("dataJob", "download-history", {
      id: "download-history",
      symbol: "BTCUSDT",
      interval: "1h",
      from: d.from,
      to: d.to,
      status: "completed",
      progress: 100,
      error: "",
      datasetId: d.id,
      createdAt: d.createdAt,
    });
    const backup = exportBackup(r);
    const damaged = structuredClone(backup);
    damaged.createdAt = "changed";
    assert.throws(
      () => restoreBackup(other, { submissionId: "bad", backup: damaged }),
      /完整性/,
    );
    const restored = restoreBackup(other, { submissionId: "restore", backup });
    assert.equal(restored.runs, 1);
    assert.equal(restored.dataJobs, 1);
    assert.equal(
      other.store.get<RunRecord>("run", run.id).result?.hash,
      run.result.hash,
    );
    assert.throws(
      () => restoreBackup(other, { submissionId: "restore-again", backup }),
      /空数据目录/,
    );
  } finally {
    await clean(r);
    await clean(other);
  }
});
test("paused controls retain inventory and stale revisions cannot change account", async () => {
  const r = fixture(),
    paper = new Paper(r);
  try {
    const s = r.draft(input, "user");
    r.publish({ submissionId: "pub", id: s.id, expectedRevision: 1 });
    const a = r.accountCreate({
      submissionId: "acc",
      name: "模拟",
      strategyId: s.id,
      config: configInput.parse({}),
    });
    await paper.control({
      submissionId: "stop",
      id: a.id,
      expectedRevision: a.revision,
      action: "stop",
    });
    const duplicate = await paper.control({
      submissionId: "stop",
      id: a.id,
      expectedRevision: a.revision,
      action: "stop",
    });
    assert.ok(duplicate);
    await assert.rejects(
      paper.control({
        submissionId: "stale",
        id: a.id,
        expectedRevision: 1,
        action: "pause",
      }),
      /已更新/,
    );
  } finally {
    paper.close();
    await clean(r);
  }
});
test("cancelling an in-flight download stays cancelled after its abort handler settles", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: any) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = options.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const r = fixture();
  try {
    const j = r.prepare({
      submissionId: "download",
      symbol: "BTCUSDT",
      interval: "1h",
      from: Date.UTC(2025, 0, 1),
      to: Date.UTC(2025, 0, 2),
    });
    for (let i = 0; i < 10; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    r.cancel({ submissionId: "cancel-download", id: j.id, kind: "dataJob" });
    for (let i = 0; i < 10; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      r.store.get<{
        status: string;
      }>("dataJob", j.id).status,
      "cancelled",
    );
  } finally {
    await clean(r);
  }
});
