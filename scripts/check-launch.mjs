import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const temp = mkdtempSync(join(tmpdir(), "quant-launch-")),
  root = resolve("."),
  patch = join(temp, "quant.patch.yml"),
  q = JSON.stringify;
writeFileSync(
  patch,
  `- insert:
    - id: quant-service
      name: ${q(join(root, "dist/host/index.js"))}
      config:
        dataDirectory: ${q(join(temp, "data"))}
    - id: quant-rpc
      name: ${q(join(root, "dist/host/rpc.js"))}
    - id: preset-quant
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: quant-research
        name: 量化研究助手
        plugins:
          - id: quant-tools
            name: ${q(join(root, "dist/host/tools.js"))}
`,
);
let logs = "",
  exited = false;
const child = spawn(
  process.execPath,
  [
    join(root, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
    "--profile",
    "web",
    "--patch",
    patch,
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--no-open",
  ],
  {
    cwd: root,
    env: { ...process.env, DSH_HOME: join(temp, "home") },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", (b) => {
  logs += String(b);
});
child.stderr.on("data", (b) => {
  logs += String(b);
});
child.on("exit", () => {
  exited = true;
});
const clean = (s) => s.replace(/([?&]token=)[^\s"<>]+/g, "$1[redacted]");
try {
  const deadline = Date.now() + 30000;
  let match;
  while (Date.now() < deadline && !exited) {
    match = logs.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/);
    if (match) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(match, `Harness did not become ready: ${clean(logs).slice(-6000)}`);
  const authUrl = match[1],
    base = new URL(authUrl).origin;
  let anonymous;
  const routeDeadline = Date.now() + 10000;
  while (Date.now() < routeDeadline) {
    anonymous = await fetch(base + "/api/quant/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (anonymous.status !== 405) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(anonymous.status, 401, clean(logs).slice(-4000));
  const login = await fetch(authUrl, { redirect: "manual" });
  assert.ok([302, 303].includes(login.status));
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.ok(cookie);
  const index = await fetch(base + "/", { headers: { cookie } });
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.match(html, /<html/);
  assert.ok(
    /quant-assistant|quantitative-trading/.test(html),
    "Quant client must be present in the real boot manifest",
  );
  async function rpc(action, input = {}) {
    const response = await fetch(`${base}/api/quant/${action}`, {
      method: "POST",
      headers: { cookie, origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "launch-smoke",
        method: `quant/${action}`,
        payload: { sessionId: "launch-session", input },
      }),
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.result.ok, true, JSON.stringify(value.result));
    return value.result.value;
  }
  assert.equal((await rpc("snapshot")).schemaVersion, 1);
  const blocked = await fetch(base + "/api/quant/snapshot", {
    method: "POST",
    headers: {
      cookie,
      origin: "https://evil.invalid",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(blocked.status, 403);
  const dataset = await rpc("demo", { submissionId: "demo" }),
    strategy = await rpc("draft", {
      submissionId: "draft",
      expectedRevision: 0,
      name: "HTTP闭环",
      definition: {
        template: "sma_cross",
        symbols: ["BTCUSDT"],
        interval: "1h",
        fast: 5,
        slow: 20,
      },
    });
  await rpc("publish", {
    submissionId: "publish",
    id: strategy.id,
    expectedRevision: 1,
  });
  const run = await rpc("backtest", {
    submissionId: "run",
    strategyId: strategy.id,
    datasetIds: [dataset.id],
    config: {},
  });
  let result;
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    result = await rpc("run", { id: run.id });
    if (["completed", "failed"].includes(result.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(result.status, "completed", result.error);
  assert.ok(result.result.metrics.trades > 0);
  console.log(
    `Full Harness launch, authenticated HTTP RPC, origin fence and research workflow: PASS (${result.result.metrics.trades} fills)`,
  );
} finally {
  child.kill("SIGTERM");
  const deadline = Date.now() + 3000;
  while (!exited && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  if (!exited) child.kill("SIGKILL");
  rmSync(temp, { recursive: true, force: true });
}
