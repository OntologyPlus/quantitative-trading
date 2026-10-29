import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { withHarness } from "./harness-fixture.mjs";
const position = process.argv.indexOf("--seconds"),
  seconds = position < 0 ? 60 : Number(process.argv[position + 1]);
assert.ok(
  Number.isInteger(seconds) && seconds >= 10 && seconds <= 604800,
  "Use --seconds 10..604800; seven days is 604800 seconds",
);
const report = {
  startedAt: new Date().toISOString(),
  requestedSeconds: seconds,
  finishedAt: null,
  samples: [],
  errors: [],
  completed: false,
};
const directory = resolve(".runtime/soak");
mkdirSync(directory, { recursive: true });
const output = join(directory, `observation-${Date.now()}.json`);
try {
  await withHarness(async ({ rpc }) => {
    const strategy = await rpc("draft", {
      submissionId: "soak-draft",
      expectedRevision: 0,
      name: "公共行情观察验证",
      definition: {
        template: "sma_cross",
        symbols: ["BTCUSDT"],
        interval: "1m",
        fast: 2,
        slow: 3,
      },
    });
    const published = await rpc("publish", {
      submissionId: "soak-publish",
      id: strategy.id,
      expectedRevision: strategy.revision,
    });
    let account = await rpc("account", {
      submissionId: "soak-account",
      name: "只读公共行情模拟观察",
      strategyId: published.id,
      config: { initialCash: "10000" },
    });
    await rpc("control", {
      submissionId: "soak-start",
      id: account.id,
      expectedRevision: account.revision,
      action: "start",
    });
    const connectDeadline = Date.now() + 30000;
    while (true) {
      const snapshot = await rpc("snapshot");
      account = snapshot.accounts.find((a) => a.id === account.id);
      if (account.status === "running" && !account.error) break;
      if (Date.now() >= connectDeadline || account.status !== "running")
        throw Error(account.error || "Public stream did not become ready");
      await new Promise((r) => setTimeout(r, 250));
    }
    const end = Date.now() + seconds * 1000;
    try {
      while (Date.now() < end) {
        const snapshot = await rpc("snapshot"),
          health = await rpc("health");
        account = snapshot.accounts.find((a) => a.id === account.id);
        assert.ok(account);
        report.samples.push({
          at: snapshot.asOf,
          status: account.status,
          lastEventAt: account.lastEventAt,
          error: account.error,
          cash: account.state?.cash,
          health,
        });
        if (account.status !== "running" || account.error)
          report.errors.push({
            at: snapshot.asOf,
            message: account.error || account.status,
          });
        writeFileSync(output, JSON.stringify(report, null, 2));
        await new Promise((r) =>
          setTimeout(r, Math.min(10000, Math.max(0, end - Date.now()))),
        );
      }
    } finally {
      const snapshot = await rpc("snapshot");
      account = snapshot.accounts.find((a) => a.id === account.id);
      if (account?.status === "running")
        await rpc("control", {
          submissionId: "soak-stop",
          id: account.id,
          expectedRevision: account.revision,
          action: "stop",
        });
    }
    report.completed = true;
  });
} catch (e) {
  report.errors.push({
    at: new Date().toISOString(),
    message: e instanceof Error ? e.message : String(e),
  });
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(
    `Public-market paper observation: ${report.completed && report.errors.length === 0 ? "PASS" : "REVIEW REQUIRED"}; ${report.samples.length} samples; report ${output}`,
  );
  if (report.errors.length) process.exitCode = 1;
}
