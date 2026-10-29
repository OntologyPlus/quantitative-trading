import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
export async function withHarness(run, options = {}) {
  const temp = mkdtempSync(join(tmpdir(), "quant-product-")),
    root = resolve("."),
    patch = join(temp, "patch.yml");
  let logs = "",
    exited = false,
    child;
  const clean = (s) => s.replace(/([?&]token=)[^\s"<>]+/g, "$1[redacted]");
  try {
    let extra = "";
    if (options.modelSelection) {
      const source = join(temp, "evaluation-source.mjs");
      writeFileSync(
        source,
        `export const inject=['agents','agentLoop'];export async function apply(ctx){const h=await ctx.agents.create({sessionId:'product-fixture',agentOptions:${JSON.stringify(options.modelSelection)}});ctx.effect(()=>async()=>{await h.dispose();});}`,
      );
      extra = `    - id: evaluation-source\n      name: ${JSON.stringify(source)}\n`;
    }
    writeFileSync(
      patch,
      `- insert:\n${["index", "rpc", "agent"].map((name) => `    - id: quant-${name}\n      name: ${JSON.stringify(join(root, `dist/host/${name}.js`))}${name === "index" ? `\n      config:\n        dataDirectory: ${JSON.stringify(join(temp, "data"))}` : ""}`).join("\n")}\n${extra}`,
    );
    child = spawn(
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
    const deadline = Date.now() + 30000;
    let match;
    while (Date.now() < deadline && !exited) {
      match = logs.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/);
      if (match) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(match, `Harness startup failed: ${clean(logs).slice(-5000)}`);
    const authUrl = match[1],
      base = new URL(authUrl).origin,
      login = await fetch(authUrl, { redirect: "manual" }),
      cookie = login.headers
        .getSetCookie()
        .map((s) => s.split(";")[0])
        .join("; ");
    assert.ok(cookie);
    let n = 0;
    async function rpc(action, input = {}) {
      const response = await fetch(`${base}/api/quant/${action}`, {
        method: "POST",
        headers: { cookie, origin: base, "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId: `fixture-${++n}`,
          method: `quant/${action}`,
          payload: { sessionId: "product-fixture", input },
        }),
      });
      assert.equal(response.status, 200);
      const result = (await response.json()).result;
      if (!result.ok)
        throw Error(`${result.error.code}: ${result.error.message}`);
      return result.value;
    }
    const readyDeadline = Date.now() + 10000;
    while (true) {
      try {
        await rpc("health");
        break;
      } catch (e) {
        if (Date.now() >= readyDeadline) throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    return await run({ base, cookie, authUrl, rpc, temp, root });
  } finally {
    child?.kill("SIGTERM");
    const deadline = Date.now() + 3000;
    while (!exited && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    if (!exited) child?.kill("SIGKILL");
    rmSync(temp, { recursive: true, force: true });
  }
}
