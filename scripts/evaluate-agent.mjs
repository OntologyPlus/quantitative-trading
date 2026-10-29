import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { withHarness } from "./harness-fixture.mjs";
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const provider = arg("--provider", process.env.QUANT_EVAL_PROVIDER),
  model = arg("--model", process.env.QUANT_EVAL_MODEL);
assert.ok(
  provider && model,
  "Specify --provider and --model from your Harness configuration. Credentials remain in the provider's environment; never pass keys on the command line.",
);
const limit = Number(arg("--limit", 1)),
  repeat = Number(arg("--repeat", 1));
assert.ok(
  Number.isInteger(limit) &&
    limit >= 1 &&
    limit <= 20 &&
    Number.isInteger(repeat) &&
    repeat >= 1 &&
    repeat <= 3,
);
const cases = JSON.parse(
  readFileSync(new URL("./evaluation-cases.json", import.meta.url), "utf8"),
).slice(0, limit);
const directory = resolve(".runtime/evaluations");
mkdirSync(directory, { recursive: true });
const output = join(directory, `model-${Date.now()}.json`),
  results = [];
for (const task of cases)
  for (let trial = 1; trial <= repeat; trial++) {
    const result = {
      case: task.id,
      trial,
      provider,
      model,
      startedAt: new Date().toISOString(),
      expected: task.expected,
      finishedAt: null,
      automatedPass: false,
      qualityGraded: false,
    };
    try {
      await withHarness(
        async ({ rpc }) => {
          const to = Math.floor(Date.now() / 3600000) * 3600000 - 3600000,
            from = to - 90 * 86400000;
          const input = {
            submissionId: `eval-${task.id}-${trial}`,
            name: `评测 ${task.id}`,
            objective: task.objective,
            symbols: ["BTCUSDT"],
            interval: "1h",
            from,
            to,
            mode: "agent",
            budget: {
              experiments: 8,
              modelRequests: 20,
              outputTokens: 1024,
              maxBars: 5000,
              computeSeconds: 180,
              hours: 1,
              ...task.budget,
            },
            thresholds: task.thresholds ?? {},
          };
          if (task.singleCandidate)
            input.candidates = [
              {
                template: "sma_cross",
                symbols: ["BTCUSDT"],
                interval: "1h",
                fast: 20,
                slow: 60,
              },
            ];
          const p = await rpc("project-create", input);
          await rpc("project-control", {
            submissionId: `start-${p.id}`,
            id: p.id,
            expectedRevision: p.revision,
            action: "start",
          });
          const deadline = Date.now() + 300000;
          let actual;
          while (Date.now() < deadline) {
            actual = (await rpc("project-read", { id: p.id })).project;
            if (
              ["completed", "waiting_input", "failed", "cancelled"].includes(
                actual.status,
              )
            )
              break;
            await new Promise((r) => setTimeout(r, 500));
          }
          result.project = actual;
          result.automatedPass =
            actual?.status === task.expected &&
            actual.budgetUsed.experiments <=
              actual.protocol.budget.experiments &&
            actual.budgetUsed.modelRequests <=
              actual.protocol.budget.modelRequests &&
            (task.expected !== "waiting_input" ||
              actual.experiments.length === 0);
          if (actual?.status === "completed")
            for (const ref of actual.report.facts)
              await rpc("project-evidence", { id: p.id, evidenceId: ref.id });
        },
        { modelSelection: { provider, model, maxTokens: 1024 } },
      );
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
    }
    result.finishedAt = new Date().toISOString();
    results.push(result);
    writeFileSync(
      output,
      JSON.stringify({ results, qualityGraded: false }, null, 2),
    );
    console.log(
      `${task.id} trial ${trial}: ${result.automatedPass ? "workflow PASS" : "REVIEW REQUIRED"}; semantic quality requires review`,
    );
  }
console.log(`Evaluation records: ${output}`);
if (results.some((r) => !r.automatedPass)) process.exitCode = 1;
