import test from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseIdleFailure,
  dispatchCompactRetryPrompt,
  dispatchUserPrompt,
} from "../src/agent/dispatch-diagnosis.js";

test("selection prompt demands a compact select or propose", () => {
  const text = dispatchUserPrompt("selection", "比较均线候选");
  assert.match(text, /只提交一个 select 或 propose/);
  assert.match(text, /不要长篇分析/);
  assert.match(text, /不要调用 analyze/);
  assert.match(text, /比较均线候选/);
  assert.match(
    dispatchCompactRetryPrompt("selection", "比较均线候选"),
    /禁止任何分析正文/,
  );
});

test("idle diagnosis separates prior consumption, truncation, analyze-only and billed no-action", () => {
  assert.equal(
    diagnoseIdleFailure(
      { requestKeys: ["a"], usageKeys: ["a"] },
      2048,
      { accepted: true, pending: false },
    ).kind,
    "prior_consumed",
  );
  assert.equal(
    diagnoseIdleFailure(
      { requestKeys: [], usageKeys: [] },
      2048,
      { accepted: false, pending: false },
    ).kind,
    "no_model_call",
  );
  const truncated = diagnoseIdleFailure(
    {
      requestKeys: ["a"],
      usageKeys: ["a"],
      trace: {
        outputTokens: 2048,
        finishKinds: ["max-tokens"],
        tools: [],
      },
    },
    2048,
    { accepted: false, pending: false },
  );
  assert.equal(truncated.kind, "output_budget");
  assert.match(truncated.message, /max-tokens/);
  assert.doesNotMatch(truncated.message, /模型配置/);

  const analyzeOnly = diagnoseIdleFailure(
    {
      requestKeys: ["a"],
      usageKeys: ["a"],
      trace: {
        outputTokens: 200,
        finishKinds: ["tool-calls"],
        tools: [
          { name: "qt_project_action", action: "analyze", ok: true },
        ],
      },
    },
    2048,
    { accepted: false, pending: false },
  );
  assert.equal(analyzeOnly.kind, "analyze_only");

  const toolError = diagnoseIdleFailure(
    {
      requestKeys: ["a"],
      usageKeys: ["a"],
      trace: {
        outputTokens: 120,
        finishKinds: ["tool-calls"],
        tools: [
          {
            name: "qt_project_action",
            action: "propose",
            ok: false,
            error: "追加候选后需保留预算",
          },
        ],
      },
    },
    2048,
    { accepted: false, pending: false },
  );
  assert.equal(toolError.kind, "tool_error");
  assert.match(toolError.message, /追加候选后需保留预算/);

  const billed = diagnoseIdleFailure(
    {
      requestKeys: ["a"],
      usageKeys: ["a"],
      trace: { outputTokens: 400, finishKinds: ["stop"], tools: [] },
    },
    2048,
    { accepted: false, pending: false },
  );
  assert.equal(billed.kind, "no_advancing_action");
  assert.match(billed.message, /不是模型配置问题/);
});
