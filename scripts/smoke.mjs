import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import Service from "../dist/host/index.js";
const require = createRequire(import.meta.url);
let definition;
runInNewContext(readFileSync("dist/client.js", "utf8"), {
  window: {
    __ModuleLoader__: {
      load(v) {
        definition = v;
      },
    },
  },
});
assert.equal(definition.id, "@quant-assistant/harness-plugin");
const client = definition.factory(require),
  views = new Map(),
  disposers = [],
  tabs = [];
client.apply({
  connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
  effect(fn) {
    const d = fn();
    disposers.push(d);
    return d;
  },
  sidebarRight: { openTab() {} },
  sidebarRightTabs: {
    register(v) {
      tabs.push(v);
      return () => {};
    },
  },
  slots: {
    inject(name, fn) {
      const d = fn();
      disposers.push(d);
      return d;
    },
    register(slot, view) {
      views.set(slot.key, view);
      return () => views.delete(slot.key);
    },
  },
});
assert.equal(views.size, 13);
assert.equal(tabs[0].kind, "quant-workbench");
const view = views.get("@quant-assistant/harness-plugin/workbench")({
  sessionId: "s",
  useTabInfo: () => ({ tab: { visible: false } }),
  inputActions: undefined,
});
assert.match(renderToStaticMarkup(view), /量化工作台/);
assert.match(
  renderToStaticMarkup(
    views.get("qt_run_read")({
      toolName: "qt_run_read",
      phase: "result",
      block: { isError: true },
    }),
  ),
  /未完成/,
);
disposers.reverse().forEach((d) => d?.());
assert.equal(views.size, 0);
const dir = mkdtempSync(join(tmpdir(), "quant-bundle-")),
  root = new Context(),
  service = root.plugin(Service, { dataDirectory: dir });
await service;
try {
  const q = root.quant,
    d = q.research.demo({ submissionId: "d" }),
    s = q.research.draft(
      {
        submissionId: "s",
        expectedRevision: 0,
        name: "集成回测",
        definition: {
          template: "sma_cross",
          symbols: ["BTCUSDT"],
          interval: "1h",
          fast: 5,
          slow: 20,
        },
      },
      "user",
    );
  q.research.publish({ submissionId: "p", id: s.id, expectedRevision: 1 });
  const run = q.research.submitRun({
    submissionId: "r",
    strategyId: s.id,
    datasetIds: [d.id],
    config: {},
  });
  const deadline = Date.now() + 15000;
  let result;
  while (Date.now() < deadline) {
    result = q.research.store.get("run", run.id);
    if (["completed", "failed"].includes(result.status)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(result.status, "completed", result.error);
  assert.ok(result.result.state.fills.length > 0);
  assert.ok(result.result.hash);
  console.log(
    `Bundled plugin, client slots/disposal and real background worker: PASS (${result.result.state.fills.length} fills)`,
  );
} finally {
  await service.dispose();
  rmSync(dir, { recursive: true, force: true });
}
