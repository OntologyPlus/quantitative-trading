import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import Agents from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import Sessions, { type SessionId } from "@deepseek-ai/dsh-session";
import Projections from "@deepseek-ai/dsh-session-projection";
import * as Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import Llm, {
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
  type ToolCallId,
} from "@deepseek-ai/dsh-llm";
import Tools from "@deepseek-ai/dsh-tools";
import Prompt from "@deepseek-ai/dsh-system-prompt";
import QuantService from "../src/host/index.js";
import { HarnessBridge } from "../src/host/agent.js";
import { backtest } from "../src/engine/backtest.js";
import type { ResearchProject } from "../src/domain/project.js";
import type { RunRecord, StrategyRecord } from "../src/domain/contracts.js";
import { exportBackup, restoreBackup } from "../src/host/backup.js";
import { Research } from "../src/host/research.js";

test("real Harness agent factory, scoped tools, durable inbox, followup, request budget and usage complete an Agent project", async () => {
  const temp = mkdtempSync(join(tmpdir(), "quant-real-agent-")),
    root = new Context(),
    fibers: { dispose(): Promise<unknown> }[] = [];
  let bridge: HarnessBridge | undefined,
    source: { dispose(): Promise<void> } | undefined;
  try {
    for (const plugin of [Projections, Sessions, Agents, Llm, Tools, Prompt]) {
      const fiber = root.plugin(plugin as never, {} as never);
      await fiber;
      fibers.push(fiber);
    }
    const persistence = root.plugin(Persistence, {
      root: join(temp, "sessions"),
      compression: "none",
    } as never);
    await persistence;
    fibers.push(persistence);
    const loop = root.plugin(AgentLoop, {
      agents: [],
      maxParallelToolCalls: 1,
    } as never);
    await loop;
    fibers.push(loop);
    const quant = root.plugin(QuantService, {
      dataDirectory: join(temp, "data"),
    });
    await quant;
    fibers.push(quant);
    const q = root.quant;
    q.research.closed = true;
    let requests = 0;
    const contexts = new Set<string>();
    class Adapter extends LlmAdapter {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        options.signal?.throwIfAborted();
        requests++;
        assert.deepEqual(options.tools!.map((t) => t.name).sort(), [
          "qt_evidence_read",
          "qt_project_action",
          "qt_project_context",
        ]);
        assert.equal(options.maxTokens, 4096);
        const p = q.research.store
          .list<ResearchProject>("project")
          .find((p) => p.executionSessionId === options.sessionId)!;
        assert.ok(p);
        assert.equal(p.status, "waiting_agent");
        const context = q.projects.context(p.id);
        let name = "qt_project_action",
          args: Record<string, unknown>;
        if (!contexts.has(p.activeDispatchId!)) {
          contexts.add(p.activeDispatchId!);
          name = "qt_project_context";
          args = {};
        } else if (p.stage === "planning")
          args = {
            input: {
              action: "begin",
              reason: "受控目标可由均线与突破模板检验",
            },
          };
        else if (p.stage === "selection")
          args = {
            input: {
              action: "select",
              candidateId: p.candidates[0]!.id,
              reason: "受控适配器选择已验证候选",
              evidenceIds: [context.evidence[0]!.id],
            },
          };
        else if (!p.analyses.length)
          args = {
            input: {
              action: "analyze",
              kind: "interpretation",
              text: "样本与成本证据已关联，结论由协议评估。",
              evidenceIds: [context.evidence[0]!.id],
            },
          };
        else args = { input: { action: "finish" } };
        const id = `fixture-${requests}` as ToolCallId,
          argumentsText = JSON.stringify(args);
        yield { type: "block-start", index: 0, blockType: "tool-call" };
        yield {
          type: "tool-call-delta",
          index: 0,
          id,
          name,
          argumentsDelta: argumentsText,
        };
        yield {
          type: "block-end",
          index: 0,
          block: { type: "tool-call", id, name, arguments: argumentsText },
        };
        yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } };
        yield { type: "finish", reason: { kind: "tool-calls" } };
      }
    }
    const registration = root.llm.registerAdapter(
      ["quant-fixture"],
      new Adapter(),
    );
    source = await root.agents.create({
      sessionId: "source" as SessionId,
      agentOptions: { provider: "quant-fixture", model: "controlled" },
    });
    bridge = new HarnessBridge(root, q.projects);
    q.projects.attachBridge(bridge);
    const ds = q.research.demo({ submissionId: "demo" }),
      p = q.projects.create(
        {
          submissionId: "project",
          name: "真实宿主执行研究",
          objective: "检验后台会话能在计算事件后续跑并交付有引用的报告",
          symbols: [ds.symbol],
          interval: ds.interval,
          from: ds.from,
          to: ds.to,
          datasetIds: [ds.id],
          mode: "agent",
        },
        "source",
      );
    q.projects.control({
      submissionId: "start",
      id: p.id,
      expectedRevision: p.revision,
      action: "start",
    });
    const until = Date.now() + 12000;
    let actual = p;
    while (Date.now() < until) {
      for (const run of q.research.store.list<RunRecord>("run"))
        if (run.status === "queued") {
          const s = q.research.store.get<StrategyRecord>(
            "strategy",
            run.strategyId,
          );
          run.result = backtest(s.definition, run.config, q.research.bars(ds));
          run.status = "completed";
          run.computeMs = 1;
          run.progress = 100;
          q.research.store.put("run", run.id, run);
        }
      actual = q.research.store.get<ResearchProject>("project", p.id);
      if (["completed", "waiting_input", "failed"].includes(actual.status))
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(actual.status, "completed", actual.error || actual.reason);
    assert.equal(actual.experiments.length, 6);
    assert.equal(actual.analyses.length, 1);
    assert.equal(requests, 7);
    assert.equal(actual.budgetUsed.modelRequests, 7);
    assert.equal(actual.budgetUsed.inputTokens, 700);
    assert.equal(actual.budgetUsed.outputTokens, 140);
    assert.equal(actual.report!.facts.length, 48);
    await root.sessionPersistence.flush();
    const reader = await root.sessionPersistence.open(
      actual.executionSessionId as SessionId,
      "read",
    );
    const { events } = await reader.read();
    await reader.close();
    assert.equal(events.filter((e) => e.type === "user/message").length, 3);
    assert.equal(
      events.filter((e) => e.type === "assistant/message").length,
      7,
    );
    assert.equal(root.tools.schemas().length, 0);
    const backup = exportBackup(q.research),
      restored = new Research(join(temp, "restored"));
    restored.closed = true;
    try {
      restoreBackup(restored, { submissionId: "restore-agent", backup });
      assert.equal(
        restored.store.get<ResearchProject>("project", p.id).report!.hash,
        actual.report!.hash,
      );
    } finally {
      await restored.close();
    }
    registration();
  } finally {
    await bridge?.close();
    await source?.dispose();
    for (const fiber of fibers.reverse()) await fiber.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
});
