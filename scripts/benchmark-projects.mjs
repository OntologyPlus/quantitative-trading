import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import Service from "../dist/host/index.js";
const directory = mkdtempSync(join(tmpdir(), "quant-list-benchmark-")),
  root = new Context(),
  fiber = root.plugin(Service, { dataDirectory: directory });
await fiber;
try {
  const q = root.quant,
    d = q.research.demo({ submissionId: "dataset" });
  const p = q.projects.create(
    {
      submissionId: "seed",
      name: "元数据查询基准",
      objective: "测试包含大报告字段时分页摘要的查询成本",
      symbols: [d.symbol],
      interval: d.interval,
      from: d.from,
      to: d.to,
      datasetIds: [d.id],
      mode: "protocol",
    },
    "benchmark",
  );
  q.research.store.transaction(() => {
    for (let i = 1; i < 1000; i++)
      q.research.store.put("project", `benchmark-${i}`, {
        ...p,
        id: `benchmark-${i}`,
        report: { syntheticPayload: "x".repeat(32768) },
      });
  });
  const times = [];
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    const page = q.projects.list({ offset: (i % 50) * 20, limit: 20 });
    assert.equal(page.projects.length, 20);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const p95 = times[94];
  assert.ok(p95 < 500, `Summary query P95 ${p95}ms exceeds 500ms`);
  console.log(
    JSON.stringify({
      fixture: "1000 metadata rows with 32 KiB synthetic report fields",
      samples: 100,
      pageSize: 20,
      p95Ms: Math.round(p95 * 100) / 100,
      rssMiB: Math.round(process.memoryUsage().rss / 1048576),
      node: process.version,
    }),
  );
} finally {
  await fiber.dispose();
  rmSync(directory, { recursive: true, force: true });
}
