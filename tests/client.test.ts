import test from "node:test";
import assert from "node:assert/strict";
import { mount } from "./ui-harness.js";
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
