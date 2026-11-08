import test from "node:test";
import assert from "node:assert/strict";
import { mount } from "./ui-harness.js";
import { backtest, ENGINE_VERSION } from "../src/engine/backtest.js";
import { synthetic } from "../src/adapters/market.js";
import { configInput, strategySchema } from "../src/domain/schemas.js";
import { DEFAULT_RULES } from "../src/domain/contracts.js";
const snapshot = {
  schemaVersion: 1,
  asOf: "2025-01-01T00:00:00Z",
  datasets: [],
  strategies: [],
  runs: [],
  dataJobs: [],
  accounts: [],
  reviews: [],
};
test("failed request retry reuses submission identity and does not show a false success", async () => {
  const writes: any[] = [];
  let fail = true;
  const rpc = {
    async call(_channel: string, action: string, payload: any) {
      assert.equal(_channel, "/api");
      if (action === "quant/snapshot") return { ok: true, value: snapshot };
      if (action === "quant/project-list")
        return { ok: true, value: { projects: [], total: 0 } };
      if (action === "quant/health")
        return {
          ok: true,
          value: { agent: false, worker: true, storage: "ready" },
        };
      writes.push(payload.input);
      if (fail) {
        fail = false;
        throw Error("断开连接");
      }
      return { ok: true, value: { id: "demo" } };
    },
  };
  const ui = mount("Studio", {
    rpc,
    sessionId: "test-session",
    useTabInfo: () => ({ tab: { visible: false } }),
    bring: () => "ok",
  });
  try {
    await ui.flush();
    ui.find("button", "加载合成示例").props.onClick();
    await ui.flush();
    assert.match(ui.text(), /断开连接/);
    assert.doesNotMatch(ui.text(), /操作已完成/);
    ui.find("button", "加载合成示例").props.onClick();
    await ui.flush();
    assert.equal(writes.length, 2);
    assert.equal(writes[0].submissionId, writes[1].submissionId);
    assert.match(ui.text(), /操作已完成/);
  } finally {
    ui.unmount();
  }
});
test("saving a strategy preserves edits typed while its request is in flight", async () => {
  let resolve: (v: any) => void = () => {};
  const rpc = {
    call: async (_channel: string, action: string) =>
      ["quant/snapshot", "quant/project-list", "quant/health"].includes(action)
        ? {
            ok: true,
            value:
              action === "quant/snapshot"
                ? snapshot
                : action === "quant/project-list"
                  ? { projects: [], total: 0 }
                  : { agent: false, worker: true, storage: "ready" },
          }
        : new Promise((r) => {
            resolve = r;
          }),
  };
  const ui = mount("Studio", {
    rpc,
    sessionId: "test-session",
    useTabInfo: () => ({ tab: { visible: false } }),
    bring: () => "ok",
  });
  try {
    await ui.flush();
    ui.find("button", "策略").props.onClick();
    await ui.flush();
    ui.find("button", "保存草稿").props.onClick();
    await ui.flush();
    const input = ui
      .nodes()
      .find((n) => n.type === "input" && n.props.value === "我的均线策略")!;
    input.props.onChange({ target: { value: "保存中继续修改的名字" } });
    await ui.flush();
    resolve({ ok: true, value: { id: "saved", revision: 1 } });
    await ui.flush();
    assert.ok(
      ui
        .nodes()
        .some(
          (n) => n.type === "input" && n.props.value === "保存中继续修改的名字",
        ),
    );
  } finally {
    ui.unmount();
  }
});

test("changing the selected run updates analysis input, cancels the prior analysis and displays engine evidence", async () => {
  const bars = synthetic("BTCUSDT", "1h", 100),
    strategy = strategySchema.parse({
      template: "sma_cross",
      symbols: ["BTCUSDT"],
      interval: "1h",
    }),
    config = {
      ...configInput.parse({}),
      from: bars[0]!.time,
      to: bars.at(-1)!.time,
      engineVersion: "quant-engine-0.1.0+legacy",
      rules: { BTCUSDT: DEFAULT_RULES },
    },
    result = backtest(strategy, config, bars),
    runs = ["run-a", "run-b"].map((id) => ({
      id,
      strategyId: "s",
      datasetIds: [],
      config,
      status: "completed",
      progress: 100,
      createdAt: "2026-11-08T00:00:00Z",
      computeMs: 12,
      manifestHash: "m",
      result,
    }));
  let resolve!: (value: unknown) => void,
    analysisSignal: AbortSignal | undefined;
  const rpc = {
    async call(
      _channel: string,
      action: string,
      payload: any,
      signal?: AbortSignal,
    ) {
      if (action === "quant/snapshot")
        return {
          ok: true,
          value: { ...snapshot, engineVersion: ENGINE_VERSION, runs },
        };
      if (action === "quant/project-list")
        return { ok: true, value: { projects: [], total: 0 } };
      if (action === "quant/health")
        return {
          ok: true,
          value: { agent: false, worker: true, storage: "ready" },
        };
      if (action === "quant/run")
        return { ok: true, value: runs.find((r) => r.id === payload.input.id) };
      assert.equal(action, "quant/performance-report");
      analysisSignal = signal;
      return new Promise<any>((done) => {
        resolve = done;
      });
    },
  };
  const ui = mount("Studio", {
    rpc,
    sessionId: "switch-runs",
    useTabInfo: () => ({ tab: { visible: false } }),
    bring: () => "ok",
  });
  try {
    await ui.flush();
    ui.find("button", "回测").props.onClick();
    await ui.flush();
    const choose = (i: number) =>
      ui
        .nodes()
        .filter((n) => n.type === "button" && ui.text(n) === "查看 →")
        [i]!.props.onClick();
    choose(0);
    await ui.flush();
    assert.match(ui.text(), /历史引擎产物/);
    assert.match(ui.text(), /已省略空闲决策/);
    ui.find("button", "研究委托").props.onClick();
    await ui.flush();
    const selector = ui
      .nodes()
      .find(
        (n) => n.type === "select" && n.props.value === "research-quality",
      )!;
    selector.props.onChange({ target: { value: "performance-report" } });
    await ui.flush();
    const input = () =>
      ui
        .nodes()
        .find(
          (n) =>
            n.type === "textarea" &&
            n.props["aria-label"] === "研究增强分析条件",
        )!;
    assert.equal(JSON.parse(input().props.value).runId, "run-a");
    ui.find("button", "生成分析").props.onClick();
    await ui.flush();
    assert.equal(analysisSignal?.aborted, false);
    ui.find("button", "回测").props.onClick();
    await ui.flush();
    choose(1);
    await ui.flush();
    ui.find("button", "研究委托").props.onClick();
    await ui.flush();
    assert.equal(analysisSignal?.aborted, true);
    assert.equal(JSON.parse(input().props.value).runId, "run-b");
    resolve({ ok: true, value: { staleMarker: "old-analysis" } });
    await ui.flush();
    assert.doesNotMatch(ui.text(), /old-analysis/);
  } finally {
    ui.unmount();
  }
});
