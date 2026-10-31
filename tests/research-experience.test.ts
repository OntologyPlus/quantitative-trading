import test from "node:test";
import assert from "node:assert/strict";
import { projectInput, type ResearchProject } from "../src/domain/project.js";
import type { Dataset } from "../src/domain/contracts.js";
import {
  checkResearchDraft,
  costLabel,
  eventDescription,
  researchConditions,
  researchGuidance,
  researchNextSteps,
} from "../src/domain/research-view.js";
import { mount } from "./ui-harness.js";

const start = Date.UTC(2025, 0, 1),
  end = start + 1439 * 3600000;
function project(): ResearchProject {
  const { submissionId, name, objective, ...protocol } = projectInput.parse({
    submissionId: "view-test",
    name: "体验测试研究",
    objective: "比较趋势策略的成本与风险",
    symbols: ["BTCUSDT"],
    interval: "1h",
    from: start,
    to: end,
    mode: "protocol",
    config: {
      costs: { feeBps: "7.5", slippageBps: "1.25", participationPct: "7" },
      risk: { maxExposurePct: "34" },
    },
    budget: {
      outputTokens: 512,
      computeSeconds: 2300,
      hours: 48,
      maxBars: 500000,
    },
    thresholds: { stressMultiplier: 3 },
  });
  return {
    id: "p-view",
    revision: 1,
    generation: 0,
    name,
    objective,
    protocol,
    protocolHash: "protocol-hash",
    sourceSessionId: "test-session",
    executionSessionId: "exec-session",
    status: "draft",
    stage: "data",
    ranges: {
      development: { from: start, to: start + 863 * 3600000 },
      validation: { from: start + 864 * 3600000, to: start + 1151 * 3600000 },
      holdout: { from: start + 1152 * 3600000, to: end },
    },
    candidates: [],
    experiments: [],
    datasetIds: [],
    dataJobIds: [],
    budgetUsed: {
      experiments: 0,
      modelRequests: 0,
      computeMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      usageComplete: true,
    },
    selectedCandidateId: null,
    selectionHash: null,
    holdoutRevealedAt: null,
    analyses: [],
    activeDispatchId: null,
    reason: "等待确认",
    error: "",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };
}
const dataset: Dataset = {
  id: "ds-view",
  name: "导入样本",
  symbol: "BTCUSDT",
  interval: "1h",
  source: "csv-import",
  hash: "dataset-hash",
  file: "sample.json",
  count: 1440,
  from: start,
  to: end,
  createdAt: "2025-03-01T00:00:00Z",
  ruleAsOf: "2025-03-01T00:00:00Z",
  rules: {
    stepSize: "1",
    minQty: "1",
    maxQty: "100",
    minNotional: "5",
    tickSize: "0.01",
  },
  quality: { gaps: 0, duplicates: 0, valid: true },
  synthetic: false,
};

test("research conditions use exact confirmed costs and bound provenance rather than assumed exchange or defaults", () => {
  const p = project();
  p.datasetIds = [dataset.id];
  const text = researchConditions(p, [
    dataset,
    { ...dataset, id: "unrelated", source: "unrelated-exchange" },
  ])
    .map((c) => c.value)
    .join("\n");
  assert.match(text, /7\.5 bps（0\.075%）/);
  assert.match(text, /1\.25 bps（0\.0125%）/);
  assert.match(text, /csv-import/);
  assert.match(text, /dataset-hash/);
  assert.doesNotMatch(text, /Binance|unrelated-exchange/);
  assert.match(text, /3 倍/);
  assert.match(text, /34%/);
  assert.equal(costLabel("0"), "0 bps（0%）");
  assert.equal(costLabel(""), "待填写有效数值");
  assert.match(
    researchConditions(p, [])
      .map((c) => c.value)
      .join(""),
    /来源信息暂不可用/,
  );
});

test("draft precheck rejects incomplete cached coverage, misaligned dates and resource excess, while labelling synthetic and short samples", () => {
  const base = {
    symbols: ["BTCUSDT"],
    interval: "1h" as const,
    from: start,
    to: end,
    datasetIds: [dataset.id],
    experiments: 12,
    minTrades: 10,
  };
  assert.deepEqual(checkResearchDraft(base, [dataset]).errors, []);
  assert.ok(
    checkResearchDraft({ ...base, from: start + 1 }, [dataset]).errors.length,
  );
  assert.ok(
    checkResearchDraft({ ...base, symbols: ["BTCUSDT", "ETHUSDT"] }, [dataset])
      .errors.length,
  );
  assert.ok(
    checkResearchDraft(base, [{ ...dataset, to: end - 3600000 }]).errors.length,
  );
  assert.ok(
    checkResearchDraft({ ...base, maxBars: 1000 }, [dataset]).errors.length,
  );
  assert.ok(
    checkResearchDraft({ ...base, experiments: 5 }, [dataset]).errors.length,
  );
  const warnings = checkResearchDraft(base, [
    { ...dataset, synthetic: true },
  ]).warnings.join(" ");
  assert.match(warnings, /合成/);
  assert.match(warnings, /Sharpe/);
});

test("recovery distinguishes a real question from exhausted budget, transient faults and unknown execution", () => {
  const p = project();
  p.status = "waiting_input";
  p.reason = "请补充假设";
  assert.equal(researchGuidance(p).answer, true);
  p.error = "研究计算时长预算已用尽";
  assert.equal(researchGuidance(p).resume, false);
  assert.equal(researchGuidance(p).answer, false);
  p.error = "网络断开";
  assert.equal(researchGuidance(p).resume, true);
  assert.equal(researchGuidance(p).answer, false);
  p.error = "上次模型执行结果待核对";
  assert.equal(researchGuidance(p).resume, false);
  p.error = "";
  p.activeDispatchId = "unknown-dispatch";
  assert.equal(researchGuidance(p).answer, false);
  p.activeDispatchId = null;
  p.status = "paused";
  p.reason = "用户暂停，预算仍足够";
  assert.equal(researchGuidance(p).resume, true);
  p.authorization = {
    actor: "user",
    hash: "a",
    at: "2025-01-01T00:00:00Z",
    expiresAt: 1,
  };
  assert.equal(researchGuidance(p).resume, false);
});

test("next steps preserve synthetic and exposed-interval boundaries and explain actual counterevidence", () => {
  const p = project();
  p.selectedCandidateId = "candidate";
  p.experiments = [
    {
      id: "cost-check",
      candidateId: "candidate",
      phase: "stress",
      runId: "run",
      status: "completed",
      from: start,
      to: end,
      reason: "压力",
      createdAt: "2025-01-01T00:00:00Z",
      evaluation: {
        verdict: "fail",
        reasons: [{ code: "DRAWDOWN_LIMIT", message: "回撤超过协议上限" }],
      },
    },
  ];
  assert.match(researchNextSteps(p).join(""), /成本|换手/);
  assert.match(researchNextSteps(p).join(""), /回撤/);
  assert.match(researchNextSteps(p, true).join(""), /合成结果只用于检查流程/);
  p.priorExposures = ["old-project"];
  assert.match(researchNextSteps(p).join(""), /尚未揭示/);
  assert.match(
    eventDescription("experiment_complete", { experimentId: "cost-check" }, p),
    /成本压力.*回撤超过/,
  );
  assert.equal(
    eventDescription("question", { question: "需要哪个交易对？" }, p),
    "需要哪个交易对？",
  );
});

function workspace(p: ResearchProject) {
  const writes: any[] = [],
    questions: string[] = [];
  const rpc = {
    async call(_channel: string, action: string, payload: any) {
      let value: unknown;
      if (action === "quant/snapshot")
        value = {
          schemaVersion: 2,
          asOf: p.updatedAt,
          datasets: [],
          strategies: [],
          runs: [],
          dataJobs: [],
          accounts: [],
          reviews: [],
        };
      else if (action === "quant/project-list")
        value = {
          projects: [{ ...p, experimentCount: 0, completedExperiments: 0 }],
          total: 1,
        };
      else if (action === "quant/health")
        value = { agent: true, worker: true, storage: "ready" };
      else if (action === "quant/project-read")
        value = {
          project: p,
          events: [],
          evidence: [],
          dataJobs: [],
          datasets: [],
        };
      else if (action === "quant/project-create") {
        writes.push(payload.input);
        value = p;
      } else throw Error(`Unexpected action: ${action}`);
      return { ok: true as const, value };
    },
  };
  const ui = mount("Studio", {
    rpc,
    sessionId: "test-session",
    useTabInfo: () => ({ tab: { visible: false } }),
    bring: (s: string) => {
      questions.push(s);
      return "ok";
    },
  });
  return { ui, writes, questions };
}

test("followup UI retains confirmed risk, participation, stress and advanced budget instead of silently resetting hidden fields", async () => {
  const p = project();
  p.status = "cancelled";
  const { ui, writes } = workspace(p);
  try {
    await ui.flush();
    ui.find("button", p.name).props.onClick();
    await ui.flush();
    assert.match(ui.text(), /7\.5 bps（0\.075%）/);
    ui.find("button", "新建后续研究").props.onClick();
    await ui.flush();
    ui.find("form").props.onSubmit({ preventDefault() {} });
    await ui.flush();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].parentProjectId, p.id);
    assert.equal(writes[0].config.risk.maxExposurePct, "34");
    assert.equal(writes[0].config.costs.participationPct, "7");
    assert.equal(writes[0].budget.outputTokens, 512);
    assert.equal(writes[0].budget.maxBars, 500000);
    assert.equal(writes[0].thresholds.stressMultiplier, 3);
  } finally {
    ui.unmount();
  }
});

test("budget-blocked UI offers a followup and diagnostic context without a misleading resume or answer form", async () => {
  const p = project();
  p.status = "waiting_input";
  p.error = "研究计算时长预算已用尽";
  const { ui, questions } = workspace(p);
  try {
    await ui.flush();
    ui.find("button", p.name).props.onClick();
    await ui.flush();
    assert.match(ui.text(), /原委托的授权或预算需要调整/);
    assert.equal(
      ui.nodes().some((n) => n.type === "button" && ui.text(n) === "恢复研究"),
      false,
    );
    assert.equal(
      ui
        .nodes()
        .some((n) => n.type === "button" && ui.text(n) === "提交补充并继续"),
      false,
    );
    ui.find("button", "带入对话").props.onClick();
    await ui.flush();
    assert.match(questions[0]!, /p-view.*阻塞原因/);
    assert.ok(ui.find("button", "新建后续研究"));
  } finally {
    ui.unmount();
  }
});

test("robust research opt-in reserves the visible experiment budget and submits the exact reviewable protocol", async () => {
  const p = project();
  const { ui, writes } = workspace(p);
  try {
    await ui.flush();
    ui.find("button", "新建研究委托").props.onClick();
    await ui.flush();
    const label = ui.find("label", "启用稳健性研究");
    label.props.children[0].props.onChange({ target: { checked: true } });
    await ui.flush();
    assert.match(ui.text(), /至少需要 20 个实验/);
    ui.find("form").props.onSubmit({ preventDefault() {} });
    await ui.flush();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].budget.experiments, 20);
    assert.deepEqual(
      Array.from(writes[0].robustness.costMultipliers),
      [1.5, 2, 3],
    );
    assert.equal(writes[0].robustness.walkForwardFolds, 3);
    assert.equal(writes[0].robustness.minPassRatePct, 50);
  } finally {
    ui.unmount();
  }
});
