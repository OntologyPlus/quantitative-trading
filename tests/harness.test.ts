import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import Tools, { type ToolExecutionInput } from "@deepseek-ai/dsh-tools";
import Prompt from "@deepseek-ai/dsh-system-prompt";
import { createScope } from "@deepseek-ai/dsh-scope";
import type { Agent } from "@deepseek-ai/dsh-agent";
import QuantService from "../src/host/index.js";
import RPC from "../src/host/rpc.js";
import * as plugin from "../src/host/tools.js";
import { TOOL_TITLES } from "../src/domain/contracts.js";
import { HostConnectionService } from "@deepseek-ai/dsh-client-connection";
test("real Harness scope exposes only research tools and rejects unknown writes, malformed or cancelled calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quant-harness-")),
    root = new Context();
  const prompt = root.plugin(Prompt);
  await prompt;
  const tools = root.plugin(Tools);
  await tools;
  const service = root.plugin(QuantService, { dataDirectory: dir });
  await service;
  const agent = {
    id: "agent-a",
    session: { id: "session-a" },
    options: {},
    ctx: root,
  } as unknown as Agent;
  const scope = createScope(root, agent);
  Object.assign(agent, { ctx: scope.ctx });
  const fiber = scope.ctx.plugin(plugin);
  await fiber;
  let n = 0;
  const call = (
    name: string,
    args: unknown = {},
    signal = new AbortController().signal,
  ) =>
    root.tools.execute({
      name,
      arguments: args,
      callId: `q${++n}` as ToolExecutionInput["callId"],
      agent,
      signal,
    });
  try {
    assert.deepEqual(
      root.tools.schemas().map((x) => x.name),
      [],
    );
    assert.deepEqual(
      root.tools
        .schemas(agent)
        .map((x) => x.name)
        .sort(),
      Object.keys(TOOL_TITLES).sort(),
    );
    assert.equal((await call("qt_status")).isError, false);
    assert.equal((await call("qt_publish", { id: "a" })).isError, true);
    assert.equal((await call("bash", { command: "whoami" })).isError, true);
    assert.equal(
      (await call("qt_status", {}, AbortSignal.abort())).isError,
      true,
    );
    assert.equal(
      (
        await call("qt_strategy_draft", {
          input: {
            submissionId: "ai-draft",
            expectedRevision: 0,
            name: "AI策略",
            definition: {
              template: "sma_cross",
              symbols: ["BTCUSDT"],
              interval: "1h",
            },
          },
        })
      ).isError,
      false,
    );
    assert.equal(root.quant.snapshot().strategies[0]?.author, "ai");
    assert.equal(root.quant.snapshot().strategies[0]?.published, false);
    assert.equal(
      (await call("qt_strategy_draft", { input: { author: "user" } })).isError,
      true,
    );
  } finally {
    await fiber.dispose();
    await scope.dispose();
    await service.dispose();
    await tools.dispose();
    await prompt.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("authenticated Connection exact routes reject non-owner peers, spoofing and duplicates", async () => {
  const root = new Context(),
    dir = mkdtempSync(join(tmpdir(), "quant-rpc-"));
  const connection = root.plugin({
    name: "test-connection",
    apply(ctx: Context) {
      new HostConnectionService(ctx, [], {} as never);
    },
  });
  await connection;
  const service = root.plugin(QuantService, { dataDirectory: dir });
  await service;
  const rpc = root.plugin(RPC);
  await rpc;
  const bridge = root.connection.createSharedFetchHandler("/api");
  const request = (input: unknown, peer = root.connection.browserPeer) =>
    bridge.fetch(
      new Request("http://localhost/api/quant/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId: "test",
          method: "quant/demo",
          payload: { sessionId: "s", input },
        }),
      }),
      peer,
    );
  try {
    assert.equal(
      (
        await request({ submissionId: "a" }, {
          principal: { kind: "agent" },
        } as never)
      ).status,
      403,
    );
    assert.equal(
      (await (await request({ submissionId: "a", actor: "user" })).json())
        .result.ok,
      false,
    );
    assert.equal(
      (await (await request({ submissionId: "a" })).json()).result.ok,
      true,
    );
    assert.equal(
      (await (await request({ submissionId: "a" })).json()).result.ok,
      true,
    );
    assert.equal(root.quant.snapshot().datasets.length, 1);
  } finally {
    await rpc.dispose();
    assert.equal((await request({ submissionId: "b" })).status, 404);
    await service.dispose();
    await connection.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
