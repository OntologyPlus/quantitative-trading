import { claimTemplate } from "../research/claims.js";
import { z } from "zod";
import { hash } from "../adapters/market.js";
import { D } from "../engine/core.js";
import { ENGINE_VERSION } from "../engine/backtest.js";
import {
  INTERVAL_MS,
  type Dataset,
  type RunRecord,
  type Strategy,
  type StrategyRecord,
} from "../domain/contracts.js";
import {
  configInput,
  fail,
  id,
  parseError,
  strategySchema,
} from "../domain/schemas.js";
import {
  defaultCandidates,
  nextAction,
  projectControl,
  projectInput,
  terminal,
  type EvidenceRef,
  type ModelDispatch,
  type Phase,
  type ProjectExperiment,
  type ResearchProject,
} from "../domain/project.js";
import {
  evidence,
  evaluate,
  makeReport,
  rankCandidates,
  verifyEvidence,
  verifyRun,
  renderAnalysis,
  researchConclusion,
} from "../research/evaluation.js";
import { Research, uid, type DataJob } from "../host/research.js";
import {
  diagnosticPlan,
  diagnosticConfig,
  diagnosticsFinished,
  minimumExperiments,
  successfulDiagnostic,
  type DiagnosticPlan,
} from "../domain/robustness.js";
import {
  buildDiagnostics,
  verifyDiagnosticRuns,
} from "../research/diagnostics.js";
import { isDeepStrictEqual } from "node:util";
import type { Account } from "../domain/contracts.js";
import type { SimulationTransition } from "../domain/simulation.js";
import { loadSimulationReview } from "../host/simulation-review.js";
import { makePromotionPreview } from "../research/promotion.js";
import { observationEvent } from "../host/observation.js";

export interface AgentBridge {
  deliver(dispatch: ModelDispatch): Promise<void>;
  cancel(projectId: string): void;
  close(): Promise<void>;
  assertActive?(project: ResearchProject): void;
  cancelAll?(): void;
}
const at = () => new Date().toISOString();
export class ProjectService {
  private bridge: AgentBridge | null = null;
  private scheduled = false;
  private closed = false;
  private ticking = false;
  private timer: ReturnType<typeof setInterval>;
  private unsubscribe: () => void;
  private deliveries = new Set<string>();
  private fault = "";
  constructor(readonly research: Research) {
    this.unsubscribe = research.store.onChange(() => this.schedule());
    for (const p of this.store.withStatus<ResearchProject>("project", [
      "ready",
      "running",
      "waiting_job",
      "waiting_agent",
    ])) {
      if (
        ["ready", "running", "waiting_job", "waiting_agent"].includes(p.status)
      ) {
        if (!p.protocol.resumeOnRestart) {
          p.status = "paused";
          p.reason = "宿主已重启，请检查后恢复研究";
          if (p.activeDispatchId) {
            const d = this.store.get<ModelDispatch>(
              "dispatch",
              p.activeDispatchId,
            );
            if (d.status === "delivered") {
              d.status = "outcome_unknown";
              this.store.put("dispatch", d.id, d);
            }
          }
        } else p.status = p.activeDispatchId ? "waiting_agent" : "ready";
        this.save(p, "restart", {
          resumeAutomatically: p.protocol.resumeOnRestart,
        });
      }
    }
    this.timer = setInterval(() => this.schedule(), 1000);
    this.timer.unref();
    this.schedule();
  }
  get store() {
    return this.research.store;
  }
  attachBridge(bridge: AgentBridge) {
    this.bridge = bridge;
    this.schedule();
  }
  detachBridge(bridge: AgentBridge) {
    if (this.bridge !== bridge) return;
    for (const p of this.store
      .withStatus<ResearchProject>("project", [
        "ready",
        "running",
        "waiting_job",
        "waiting_agent",
      ])
      .filter((p) => p.protocol.mode === "agent"))
      this.control({
        submissionId: `unload-${p.id}-${p.revision}`,
        id: p.id,
        expectedRevision: p.revision,
        action: "pause",
      });
    this.bridge = null;
  }
  activeForSession(sessionId: string) {
    return this.store
      .withStatus<ResearchProject>("project", [
        "ready",
        "running",
        "waiting_job",
        "waiting_agent",
        "waiting_input",
      ])
      .filter(
        (p) =>
          p.sourceSessionId === sessionId || p.executionSessionId === sessionId,
      );
  }
  pauseForSession(sessionId: string) {
    for (const p of this.activeForSession(sessionId))
      this.control({
        submissionId: `archive-${p.id}-${p.revision}`,
        id: p.id,
        expectedRevision: p.revision,
        action: "pause",
      });
  }
  agentAvailable() {
    return this.bridge !== null;
  }
  answer(input: unknown) {
    const x = z
      .object({
        submissionId: id,
        id,
        expectedRevision: z.number().int().positive(),
        text: z.string().min(1).max(3000),
      })
      .strict()
      .parse(input);
    return this.store.submit(x.submissionId, "project-answer", x, () => {
      const p = this.store.get<ResearchProject>("project", x.id);
      if (p.revision !== x.expectedRevision)
        fail("REVISION_CONFLICT", "研究状态已更新");
      if (p.status !== "waiting_input")
        fail("INVALID_STATE", "当前研究没有等待回答");
      this.assertBudget(p);
      p.answers ??= [];
      p.answers.push({ text: x.text, at: at() });
      if (p.answers.length > 20)
        fail("ANSWER_LIMIT", "问题回答已达到项目上限，请建立后续委托");
      if (p.activeDispatchId)
        fail("OUTCOME_UNKNOWN", "上次执行结果待核对，不能通过回答重新派发");
      p.status = "ready";
      p.error = "";
      p.reason = "已收到补充信息，继续按原协议执行";
      this.save(p, "answer_received");
      return p;
    });
  }
  private schedule() {
    if (this.closed || this.scheduled || this.fault) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (!this.closed) this.tick();
    });
  }
  private save(p: ResearchProject, type: string, facts: unknown = {}) {
    p.revision++;
    p.updatedAt = at();
    this.store.transaction(() => {
      this.store.put("project", p.id, p);
      this.store.event(p.id, p.revision, type, facts);
    });
  }
  create(
    input: unknown,
    sourceSessionId: string,
    author: "user" | "ai" = "user",
  ) {
    const x = projectInput.parse(input);
    if (x.simulationSource) {
      const source = loadSimulationReview(
        this.research,
        x.simulationSource.reviewId,
      ).review;
      if (
        source.accountId !== x.simulationSource.accountId ||
        source.hash !== x.simulationSource.reviewHash
      )
        fail("SIMULATION_SOURCE", "后续研究的模拟复盘来源不一致");
    }
    if (x.parentProjectId)
      this.store.get<ResearchProject>("project", x.parentProjectId);
    return this.store.submit(
      x.submissionId,
      `project-create-${author}`,
      { x, sourceSessionId },
      () => {
        const { submissionId, name, objective, ...protocol } = x;
        const step = INTERVAL_MS[x.interval],
          n = Math.round((x.to - x.from) / step) + 1;
        const dev = Math.floor(n * 0.6),
          val = Math.floor(n * 0.2);
        const p: ResearchProject = {
          id: uid(),
          revision: 0,
          generation: 0,
          name,
          objective,
          sourceSessionId,
          executionSessionId: `qr-${uid()}`,
          status: "draft",
          stage: x.mode === "agent" ? "planning" : "data",
          protocol,
          protocolHash: hash(protocol),
          ranges: {
            development: { from: x.from, to: x.from + (dev - 1) * step },
            validation: {
              from: x.from + dev * step,
              to: x.from + (dev + val - 1) * step,
            },
            holdout: { from: x.from + (dev + val) * step, to: x.to },
          },
          candidates: [],
          experiments: [],
          datasetIds: [...x.datasetIds],
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
          error: "",
          reason: "请核对研究协议与资源预算后启动",
          createdAt: at(),
          updatedAt: at(),
        };
        for (const [i, definition] of (
          x.candidates ?? defaultCandidates(x)
        ).entries())
          this.freeze(
            p,
            definition,
            `${definition.template} · ${i + 1}`,
            "委托初始候选",
            author,
          );
        this.validateDatasets(p, false);
        this.save(p, "created", { author });
        return p;
      },
    );
  }
  private freeze(
    p: ResearchProject,
    definition: Strategy,
    name: string,
    reason: string,
    author: "user" | "ai",
    parentId?: string,
  ) {
    const definitionHash = hash(definition);
    if (p.candidates.some((c) => c.definitionHash === definitionHash))
      fail("DUPLICATE_CANDIDATE", "该候选已存在，请读取已有实验");
    const s: StrategyRecord = {
      id: uid(),
      name,
      revision: 1,
      definition,
      published: false,
      author,
      createdBy: author,
      createdAt: at(),
      purpose: "research",
      projectId: p.id,
      definitionHash,
    };
    this.store.put("strategy", s.id, s);
    const c = {
      id: uid(),
      strategyId: s.id,
      definitionHash,
      name,
      reason,
      ...(parentId ? { parentId } : {}),
    };
    p.candidates.push(c);
    return c;
  }
  private validateDatasets(p: ResearchProject, complete: boolean) {
    const ds = p.datasetIds.map((id) => this.store.get<Dataset>("dataset", id));
    if (
      new Set(ds.map((d) => d.symbol)).size !== ds.length ||
      ds.some(
        (d) =>
          !p.protocol.symbols.includes(d.symbol) ||
          d.interval !== p.protocol.interval ||
          d.from > p.protocol.from ||
          d.to < p.protocol.to ||
          !d.quality.valid,
      )
    )
      fail(
        "DATASET_MISMATCH",
        "快照须覆盖协议完整区间，每个交易对一份且周期一致",
      );
    if (complete && ds.length !== p.protocol.symbols.length)
      fail("DATASET_MISMATCH", "每个交易对都需要完整数据");
    return ds;
  }
  control(input: unknown) {
    const x = projectControl.parse(input);
    const result = this.store.submit(
      x.submissionId,
      "project-control",
      x,
      () => {
        const p = this.store.get<ResearchProject>("project", x.id);
        if (
          p.revision !== x.expectedRevision &&
          ["start", "resume"].includes(x.action)
        )
          fail("REVISION_CONFLICT", "研究状态已更新，请刷新后操作");
        if (terminal(p.status))
          fail("INVALID_STATE", "研究已经结束，请创建后续委托");
        if (x.action === "start") {
          if (p.status !== "draft")
            fail("INVALID_STATE", "只有草稿可以授权启动");
          p.authorization = {
            hash: hash({
              protocol: p.protocolHash,
              objective: p.objective,
              candidates: p.candidates.map((c) => c.definitionHash),
            }),
            at: at(),
            expiresAt: Date.now() + p.protocol.budget.hours * 3600000,
            actor: "user",
          };
          p.status = "ready";
          p.reason = "研究委托已授权，等待执行";
        } else if (x.action === "resume") {
          if (
            !["paused", "waiting_input", "failed"].includes(p.status) ||
            !p.authorization
          )
            fail("INVALID_STATE", "当前状态不能恢复");
          this.assertBudget(p);
          if (p.activeDispatchId) {
            const d = this.store.get<ModelDispatch>(
              "dispatch",
              p.activeDispatchId,
            );
            if (d.status === "outcome_unknown")
              fail(
                "OUTCOME_UNKNOWN",
                "上次模型执行结果待核对，不能直接重发；请使用核对操作",
              );
            d.status = "cancelled";
            this.store.put("dispatch", d.id, d);
            p.activeDispatchId = null;
          }
          p.status = "ready";
          p.error = "";
          p.reason = "继续已授权的研究";
        } else {
          p.generation++;
          p.status = x.action === "pause" ? "paused" : "cancelled";
          p.reason =
            x.action === "pause"
              ? "研究已暂停；已开始的计算可结束并保留结果，不派发后续动作"
              : "研究已取消，不再推进后续步骤";
          if (p.activeDispatchId) {
            const d = this.store.get<ModelDispatch>(
              "dispatch",
              p.activeDispatchId,
            );
            if (d.status !== "completed") d.status = "cancelled";
            this.store.put("dispatch", d.id, d);
            p.activeDispatchId = null;
          }
          if (x.action === "cancel") this.cancelJobs(p);
        }
        this.save(p, x.action);
        return p;
      },
    );
    if (["pause", "cancel"].includes(x.action)) this.bridge?.cancel(x.id);
    this.schedule();
    return result;
  }
  private cancelJobs(p: ResearchProject) {
    for (const [kind, ids] of [
      ["run", p.experiments.map((e) => e.runId).filter(Boolean)],
      ["dataJob", p.dataJobIds],
    ] as const)
      for (const taskId of ids) {
        const job = this.store.get<RunRecord | DataJob>(kind, taskId);
        if (["queued", "running"].includes(job.status))
          this.research.cancel({
            submissionId: `cancel-${p.generation}-${taskId}`,
            id: taskId,
            kind,
          });
      }
  }
  private assertBudget(p: ResearchProject) {
    if (!p.authorization || p.authorization.expiresAt <= Date.now())
      fail("AUTHORIZATION_EXPIRED", "研究授权已过期，请创建新的委托");
    if (p.budgetUsed.computeMs >= p.protocol.budget.computeSeconds * 1000)
      fail("COMPUTE_BUDGET", "研究计算时长预算已用尽");
    this.store.assertLease();
  }
  private tick() {
    if (this.ticking || this.closed) return;
    if (!this.leaseValid()) return;
    this.ticking = true;
    try {
      // Durable outbox cursor is advisory: replaying the same change is harmless;
      // all transitions reconcile persisted task identities, not transient events.
      const changes = this.store.changes(this.store.cursor("projects"));
      if (changes.length)
        this.store.consume("projects", changes.at(-1)!.sequence);
      for (const p of this.store.withStatus<ResearchProject>("project", [
        "ready",
        "running",
        "waiting_job",
        "waiting_agent",
      ])) {
        if (
          !["ready", "running", "waiting_job", "waiting_agent"].includes(
            p.status,
          )
        )
          continue;
        try {
          this.advance(p);
        } catch (e) {
          if (!this.leaseValid()) break;
          const fresh = this.store.get<ResearchProject>("project", p.id);
          if (terminal(fresh.status)) continue;
          fresh.status = "waiting_input";
          fresh.error = parseError(e).message;
          fresh.reason = fresh.error;
          this.save(fresh, "attention", parseError(e));
          this.bridge?.cancel(fresh.id);
        }
      }
    } catch (e) {
      this.fault = parseError(e).message;
      this.bridge?.cancelAll?.();
    } finally {
      this.ticking = false;
    }
  }
  private advance(p: ResearchProject) {
    if (this.reconcile(p)) return;
    this.bridge?.assertActive?.(p);
    this.assertBudget(p);
    if (p.activeDispatchId) {
      const d = this.store.get<ModelDispatch>("dispatch", p.activeDispatchId);
      if (
        !this.deliveries.has(d.id) &&
        ["pending", "delivered", "outcome_unknown"].includes(d.status)
      )
        this.deliver(d);
      return;
    }
    if (p.stage === "planning") {
      this.dispatch(p, "planning");
      return;
    }
    if (p.stage === "data") {
      if (this.prepareData(p)) {
        p.stage = "candidates";
        p.status = "ready";
        p.reason = "数据已核对，开始候选开发与验证";
        this.save(p, "data_ready");
      }
      return;
    }
    if (p.stage === "candidates") {
      for (const candidate of p.candidates)
        for (const phase of ["development", "validation"] as const)
          if (
            !p.experiments.some(
              (e) =>
                e.candidateId === candidate.id &&
                e.phase === phase &&
                !["failed", "cancelled"].includes(e.status),
            )
          ) {
            this.submitExperiment(p, candidate.id, phase);
            return;
          }
      p.stage = "selection";
      p.status = "ready";
      this.save(p, "candidates_complete");
      return;
    }
    if (p.stage === "selection") {
      if (p.protocol.mode === "protocol") {
        const best = rankCandidates(p)[0];
        if (!best) fail("NO_CANDIDATE", "没有可核对的候选实验");
        this.select(p, best.id, "按冻结规则排序：验证门槛、验证收益、候选身份");
      } else this.dispatch(p, "selection");
      return;
    }
    if (p.stage === "final") {
      if (p.protocol.robustness) {
        const selected = p.candidates.find(
          (c) => c.id === p.selectedCandidateId,
        )!;
        const definition = this.store.get<StrategyRecord>(
          "strategy",
          selected.strategyId,
        ).definition;
        const next = diagnosticPlan(p, definition).find(
          (plan) => !successfulDiagnostic(p, plan.diagnostic.key),
        );
        if (next) {
          this.submitExperiment(p, next.candidateId, next.phase, next);
          return;
        }
        if (!diagnosticsFinished(p, definition))
          fail("DIAGNOSTIC_INCOMPLETE", "滚动训练或验证尚未完成");
      }
      for (const phase of ["holdout", "stress"] as const)
        if (
          !p.experiments.some(
            (e) =>
              e.candidateId === p.selectedCandidateId &&
              e.phase === phase &&
              !["failed", "cancelled"].includes(e.status),
          )
        ) {
          this.submitExperiment(p, p.selectedCandidateId!, phase);
          return;
        }
      p.stage = "report";
      p.status = "ready";
      this.save(p, "final_complete");
      return;
    }
    if (p.stage === "report") {
      if (p.protocol.mode === "protocol") this.complete(p);
      else this.dispatch(p, "report");
    }
  }
  private prepareData(p: ResearchProject) {
    const ds = this.validateDatasets(p, false);
    for (const sym of p.protocol.symbols) {
      if (ds.some((d) => d.symbol === sym)) continue;
      const jobs = p.dataJobIds
        .map((id) => this.store.get<DataJob>("dataJob", id))
        .filter((j) => j.symbol === sym);
      const job = jobs.at(-1);
      if (job?.status === "completed") {
        if (!p.datasetIds.includes(job.datasetId)) {
          p.datasetIds.push(job.datasetId);
          this.save(p, "dataset_bound", { datasetId: job.datasetId });
        }
        return false;
      }
      if (job && ["queued", "running"].includes(job.status)) {
        if (p.status !== "waiting_job") {
          p.status = "waiting_job";
          p.reason = `准备 ${sym} 公共行情`;
          this.save(p, "waiting_data", { jobId: job.id });
        }
        return false;
      }
      if (job && p.status !== "ready")
        fail(
          "DATA_UNAVAILABLE",
          job.error || "行情任务未完成，可导入覆盖相同区间的数据后重新委托",
        );
      if (jobs.length >= 3)
        fail(
          "DATA_RETRY_LIMIT",
          "该交易对已用尽三次下载尝试，请检查数据源或改用CSV",
        );
      const next = this.research.prepare({
        submissionId: `pd-${p.id}-${sym}-${jobs.length}`,
        symbol: sym,
        interval: p.protocol.interval,
        from: p.protocol.from,
        to: p.protocol.to,
      });
      p.dataJobIds.push(next.id);
      p.status = "waiting_job";
      p.reason = `准备 ${sym} 公共行情`;
      this.save(p, "data_submitted", { jobId: next.id });
      return false;
    }
    this.validateDatasets(p, true);
    return true;
  }
  private reconcile(p: ResearchProject) {
    const pending = p.experiments.find((e) =>
      ["queued", "running"].includes(e.status),
    );
    if (!pending) return false;
    const run = this.store.get<RunRecord>("run", pending.runId);
    if (["queued", "running"].includes(run.status)) return true;
    pending.status = run.status as ProjectExperiment["status"];
    pending.computeMs = run.computeMs ?? 0;
    p.budgetUsed.computeMs += pending.computeMs;
    if (run.status === "completed" && run.result) {
      pending.metrics = run.result.metrics;
      pending.manifestHash = run.manifestHash;
      pending.resultHash = run.result.hash;
      pending.evaluation = evaluate(p, run);
      p.status = "ready";
      p.reason = `${pending.phase} 实验已完成，继续研究`;
      this.save(p, "experiment_complete", {
        experimentId: pending.id,
        runId: run.id,
        evaluation: pending.evaluation,
      });
    } else {
      pending.error = run.error ?? "计算任务未完成";
      p.status = "waiting_input";
      p.error = pending.error;
      p.reason = "实验执行失败；检查错误后恢复可继续其余计划，失败记录会保留";
      this.save(p, "experiment_failed", {
        experimentId: pending.id,
        error: pending.error,
      });
    }
    return true;
  }
  private submitExperiment(
    p: ResearchProject,
    candidateId: string,
    phase: Phase,
    plan?: DiagnosticPlan,
  ) {
    const c = p.candidates.find((c) => c.id === candidateId)!;
    const range = plan
      ? { from: plan.from, to: plan.to }
      : p.ranges[
          phase === "stress"
            ? "holdout"
            : (phase as "development" | "validation" | "holdout")
        ];
    const config = plan
      ? diagnosticConfig(p, plan)
      : {
          ...p.protocol.config,
          ...range,
          costs: { ...p.protocol.config.costs },
        };
    if (phase === "stress") {
      config.costs.feeBps = D(config.costs.feeBps)
        .mul(p.protocol.thresholds.stressMultiplier)
        .toFixed();
      config.costs.slippageBps = D(config.costs.slippageBps)
        .mul(p.protocol.thresholds.stressMultiplier)
        .toFixed();
    }
    this.store.transaction(() => {
      this.assertBudget(p);
      if (p.budgetUsed.experiments >= p.protocol.budget.experiments)
        fail("EXPERIMENT_BUDGET", "实验预算已用尽");
      if (
        p.experiments.filter(
          (e) =>
            e.candidateId === candidateId &&
            e.phase === phase &&
            e.diagnostic?.key === plan?.diagnostic.key,
        ).length >= 3
      )
        fail(
          "EXPERIMENT_RETRY_LIMIT",
          "同一实验已尝试三次，请检查执行环境后建立后续委托",
        );
      const e: ProjectExperiment = {
        id: uid(),
        candidateId,
        phase,
        runId: "",
        status: "planned",
        ...range,
        reason:
          phase === "stress"
            ? "检验保留区间成本放大后的表现"
            : "按冻结研究协议执行",
        createdAt: at(),
        ...(plan ? { diagnostic: { ...plan.diagnostic } } : {}),
      };
      let strategyId = c.strategyId;
      if (plan?.diagnostic.definition) {
        const original = this.store.get<StrategyRecord>(
          "strategy",
          c.strategyId,
        );
        const definition = strategySchema.parse(plan.diagnostic.definition);
        const version: StrategyRecord = {
          ...original,
          id: uid(),
          revision: 1,
          createdAt: at(),
          name: `${c.name} · 参数邻域`,
          definition,
          definitionHash: hash(definition),
        };
        this.store.put("strategy", version.id, version);
        strategyId = version.id;
        e.diagnostic!.strategyId = version.id;
      }
      const run = this.research.submitRun(
        {
          submissionId: `pe-${e.id}`,
          strategyId,
          datasetIds: p.datasetIds,
          config,
        },
        {
          projectId: p.id,
          experimentId: e.id,
          maxComputeMs: Math.max(
            1,
            p.protocol.budget.computeSeconds * 1000 - p.budgetUsed.computeMs,
          ),
        },
      );
      e.runId = run.id;
      e.status = "queued";
      p.experiments.push(e);
      p.budgetUsed.experiments++;
      if (phase === "holdout") {
        p.priorExposures = [
          ...new Set([...(p.priorExposures ?? []), ...this.priorExposures(p)]),
        ];
        p.holdoutRevealedAt = at();
      }
      p.status = "waiting_job";
      p.reason = `执行 ${c.name} 的 ${phase} 实验`;
      this.save(p, "experiment_submitted", {
        experimentId: e.id,
        runId: run.id,
        phase,
      });
    });
  }
  private select(p: ResearchProject, candidateId: string, reason: string) {
    if (p.selectionHash || p.holdoutRevealedAt)
      fail("SELECTION_FROZEN", "最终候选已冻结，不能根据保留区间反复选择");
    const c = p.candidates.find((c) => c.id === candidateId);
    p.priorExposures = this.priorExposures(p);
    if (
      !c ||
      !["development", "validation"].every((phase) =>
        p.experiments.some(
          (e) =>
            e.candidateId === c.id &&
            e.phase === phase &&
            e.status === "completed",
        ),
      )
    )
      fail("CANDIDATE_NOT_READY", "候选需要完整开发和验证结果");
    p.selectedCandidateId = c.id;
    p.selectionHash = hash({
      protocol: p.protocolHash,
      candidate: c.definitionHash,
      experiments: p.experiments.map((e) => [e.id, e.resultHash ?? e.status]),
    });
    p.stage = "final";
    p.status = "ready";
    p.reason = "最终候选已冻结，开始保留区间和成本检验";
    this.save(p, "selection_frozen", {
      candidateId,
      selectionHash: p.selectionHash,
      reason,
    });
  }
  private dispatch(
    p: ResearchProject,
    stage: "planning" | "selection" | "report",
  ) {
    if (!this.bridge)
      fail(
        "AGENT_UNAVAILABLE",
        "研究执行服务未加载；请检查宿主配置，或新建固定协议研究",
      );
    if (p.budgetUsed.modelRequests >= p.protocol.budget.modelRequests)
      fail("MODEL_BUDGET", "模型请求预算已用尽");
    const d: ModelDispatch = {
      id: uid(),
      projectId: p.id,
      generation: p.generation,
      stage,
      status: "pending",
      sessionId: p.executionSessionId,
      messageId: uid(),
      createdAt: at(),
      requestKeys: [],
      usageKeys: [],
      error: "",
    };
    p.activeDispatchId = d.id;
    p.status = "waiting_agent";
    p.reason =
      stage === "planning"
        ? "Agent 正在核对目标与研究能力范围"
        : stage === "selection"
          ? "Agent 正在比较证据并选择下一步"
          : "Agent 正在整理有证据引用的解释";
    this.store.transaction(() => {
      this.store.put("dispatch", d.id, d);
      this.save(p, "agent_dispatched", { dispatchId: d.id, stage });
    });
    this.deliver(d);
  }
  private deliver(d: ModelDispatch) {
    if (!this.bridge || this.deliveries.has(d.id)) return;
    this.deliveries.add(d.id);
    void this.bridge
      .deliver(d)
      .catch((e) => {
        if (!this.closed) this.agentError(d.id, parseError(e).message);
      })
      .finally(() => {
        this.deliveries.delete(d.id);
      });
  }
  dispatchState(dispatchId: string) {
    const d = this.store.get<ModelDispatch>("dispatch", dispatchId),
      p = this.store.get<ResearchProject>("project", d.projectId);
    if (
      p.activeDispatchId !== d.id ||
      d.generation !== p.generation ||
      p.status !== "waiting_agent" ||
      terminal(p.status)
    )
      fail("STALE_DISPATCH", "执行已取消、暂停或过期");
    this.assertBudget(p);
    return { p, d };
  }
  markDelivered(dispatchId: string) {
    const { d } = this.dispatchState(dispatchId);
    d.status = "delivered";
    this.store.put("dispatch", d.id, d);
  }
  reserveModelRequest(dispatchId: string, key: string) {
    return this.store.transaction(() => {
      const { p, d } = this.dispatchState(dispatchId);
      if (d.requestKeys.includes(key)) return;
      if (p.budgetUsed.modelRequests >= p.protocol.budget.modelRequests)
        fail("MODEL_BUDGET", "模型请求次数已达到委托上限");
      d.requestKeys.push(key);
      p.budgetUsed.modelRequests++;
      this.store.put("dispatch", d.id, d);
      this.save(p, "model_request", { dispatchId, key });
    });
  }
  recordUsage(
    dispatchId: string,
    key: string,
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    },
  ) {
    if (!this.leaseValid()) return;
    this.store.transaction(() => {
      const d = this.store.get<ModelDispatch>("dispatch", dispatchId);
      if (d.usageKeys.includes(key)) return;
      const p = this.store.get<ResearchProject>("project", d.projectId);
      d.usageKeys.push(key);
      if (usage) {
        p.budgetUsed.inputTokens +=
          usage.inputTokens +
          (usage.cacheReadTokens ?? 0) +
          (usage.cacheWriteTokens ?? 0);
        p.budgetUsed.outputTokens += usage.outputTokens;
      } else p.budgetUsed.usageComplete = false;
      this.store.put("dispatch", d.id, d);
      this.save(p, "model_usage", {
        dispatchId,
        key,
        reported: Boolean(usage),
      });
    });
  }
  agentError(dispatchId: string, message: string, unknown = false) {
    if (!this.leaseValid()) return;
    const d = this.store.get<ModelDispatch>("dispatch", dispatchId),
      p = this.store.get<ResearchProject>("project", d.projectId);
    if (
      p.activeDispatchId !== d.id ||
      terminal(p.status) ||
      p.status === "paused"
    )
      return;
    d.error = message;
    d.status = unknown ? "outcome_unknown" : "cancelled";
    if (d.requestKeys.length > d.usageKeys.length)
      p.budgetUsed.usageComplete = false;
    p.status = "waiting_input";
    p.error = message;
    p.reason = message;
    if (!unknown) p.activeDispatchId = null;
    this.store.transaction(() => {
      this.store.put("dispatch", d.id, d);
      this.save(p, unknown ? "outcome_unknown" : "agent_failed", {
        dispatchId,
        message,
      });
    });
  }
  action(dispatchId: string, input: unknown) {
    const action = nextAction.parse(input);
    return this.store.submit(
      `pa-${dispatchId}-${hash(action).slice(0, 32)}`,
      "project-action",
      { dispatchId, action },
      () => {
        const { p, d } = this.dispatchState(dispatchId);
        if (
          action.action === "analyze" ||
          action.action === "select" ||
          action.action === "propose"
        ) {
          const available = new Map(this.facts(p).map((e) => [e.id, e]));
          for (const ref of action.evidenceIds)
            if (!available.has(ref))
              fail("EVIDENCE_MISSING", "引用证据不属于当前项目或尚未揭示");
        }
        if (action.action === "analyze") {
          if (p.analyses.length >= 20)
            fail("ANALYSIS_LIMIT", "本项目最多保存20项解释或假设");
          if (
            p.protocol.acceptance &&
            action.kind === "interpretation" &&
            !action.claims
          )
            fail(
              "CLAIM_MISSING",
              "此协议的事实解释需要claims结构化比较；未经验证的解释请标为hypothesis",
            );
          const template = action.claims
            ? claimTemplate(action.claims, this.facts(p), action.evidenceIds)
            : action.text;
          p.analyses.push({
            ...(action.claims ? { claims: action.claims } : {}),
            kind: action.kind,
            text: renderAnalysis(template, this.facts(p), action.evidenceIds),
            template,
            evidenceIds: action.evidenceIds,
            author: "ai",
            at: at(),
          });
          this.save(p, "analysis_saved");
          return this.context(p.id);
        }
        if (action.action === "begin") {
          if (p.stage !== "planning")
            fail("INVALID_STAGE", "研究计划已经开始执行");
          p.stage = "data";
          p.status = "ready";
          p.reason = "Agent 已核对目标，开始按授权协议准备数据";
          this.save(p, "plan_accepted", { reason: action.reason });
        } else if (action.action === "request_input") {
          p.status = "waiting_input";
          p.reason = action.question;
          this.save(p, "question", { question: action.question });
        } else if (action.action === "select") {
          if (p.stage !== "selection")
            fail("INVALID_STAGE", "当前阶段不接受候选选择");
          this.select(p, action.candidateId, action.reason);
        } else if (action.action === "propose") {
          if (p.stage !== "selection" || p.selectionHash)
            fail("INVALID_STAGE", "最终候选冻结后不能追加寻参");
          if (
            p.candidates.length >= 6 ||
            p.budgetUsed.experiments +
              4 +
              (minimumExperiments(
                p.candidates.length + 1,
                p.protocol.robustness,
                p.protocol.candidates?.length ?? 2,
              ) -
                (p.candidates.length + 1) * 2 -
                2) >
              p.protocol.budget.experiments
          )
            fail(
              "EXPERIMENT_BUDGET",
              "追加候选后需保留开发、验证、稳健性研究及最终检验预算",
            );
          if (
            action.parentId &&
            !p.candidates.some((c) => c.id === action.parentId)
          )
            fail("NOT_FOUND", "父候选不属于本项目");
          const definition = strategySchema.parse(action.definition);
          if (
            definition.interval !== p.protocol.interval ||
            JSON.stringify([...definition.symbols].sort()) !==
              JSON.stringify([...p.protocol.symbols].sort())
          )
            fail("CONTRACT_CHANGE", "新候选不能改变已授权市场或周期");
          this.freeze(
            p,
            definition,
            `${definition.template} · 追加${p.candidates.length + 1}`,
            action.reason,
            "ai",
            action.parentId,
          );
          p.stage = "candidates";
          p.status = "ready";
          p.reason = "按证据追加一个候选，保留原有实验";
          this.save(p, "candidate_added", { reason: action.reason });
        } else {
          if (p.stage !== "report")
            fail(
              "DELIVERABLE_INCOMPLETE",
              "必须完成开发、验证、保留区间及成本检验才能交付",
            );
          this.complete(p);
        }
        d.status = "completed";
        this.store.put("dispatch", d.id, d);
        const fresh = this.store.get<ResearchProject>("project", p.id);
        fresh.activeDispatchId = null;
        this.save(fresh, "agent_action_complete", {
          dispatchId,
          action: action.action,
        });
        return this.context(p.id);
      },
    );
  }
  private facts(p: ResearchProject) {
    return p.experiments.flatMap((e) => {
      if (["holdout", "stress"].includes(e.phase) && !p.selectionHash)
        return [];
      return evidence(p, e, this.store.get<RunRecord>("run", e.runId));
    });
  }
  context(projectId: string) {
    const p = this.store.get<ResearchProject>("project", projectId);
    return {
      id: p.id,
      name: p.name,
      objective: p.objective,
      status: p.status,
      stage: p.stage,
      protocol: p.protocol,
      ...(p.protocol.simulationSource
        ? {
            sourceSimulationReview: loadSimulationReview(
              this.research,
              p.protocol.simulationSource.reviewId,
            ).review,
          }
        : {}),
      ranges: p.ranges,
      protocolHash: p.protocolHash,
      candidates: p.candidates,
      experiments: p.experiments,
      budgetUsed: p.budgetUsed,
      reason: p.reason,
      error: p.error,
      selectionHash: p.selectionHash,
      selectedCandidateId: p.selectedCandidateId,
      analyses: p.analyses,
      answers: p.answers ?? [],
      priorExposures: p.priorExposures ?? [],
      evidence: this.facts(p),
    };
  }
  readEvidence(projectId: string, evidenceId: string) {
    const p = this.store.get<ResearchProject>("project", projectId),
      ref = this.facts(p).find((r) => r.id === evidenceId);
    if (!ref) fail("EVIDENCE_MISSING", "找不到当前项目可读取的证据");
    verifyEvidence(ref, this.store.get<RunRecord>("run", ref.runId));
    return ref;
  }
  verifyReport(projectId: string) {
    const p = this.store.get<ResearchProject>("project", projectId);
    if (!p.report) fail("REPORT_NOT_READY", "研究报告尚未交付");
    const { hash: digest, markdown, ...body } = p.report;
    if (hash({ ...body, markdown }) !== digest)
      fail("REPORT_HASH", "研究报告完整性校验失败");
    for (const experiment of p.experiments.filter(
      (e) => e.status === "completed",
    )) {
      const run = this.store.get<RunRecord>("run", experiment.runId);
      verifyRun(run);
      if (
        (p.protocol.robustness || p.protocol.acceptance) &&
        (!isDeepStrictEqual(experiment.metrics, run.result!.metrics) ||
          !isDeepStrictEqual(experiment.evaluation, evaluate(p, run)))
      )
        fail("DIAGNOSTIC_EVIDENCE", "稳健性研究的评估摘要与真实结果不一致");
      for (const ref of p.report.facts.filter((f) => f.runId === run.id))
        verifyEvidence(ref, run, false);
    }
    if (p.protocol.acceptance) {
      const facts = this.facts(p),
        synthetic = this.validateDatasets(p, true).some((d) => d.synthetic);
      if (
        hash(p.protocol) !== p.protocolHash ||
        !isDeepStrictEqual(p.report.facts, facts) ||
        !isDeepStrictEqual(p.report.analyses, p.analyses) ||
        p.report.conclusion !== researchConclusion(p, synthetic) ||
        p.report.synthetic !== synthetic
      )
        fail("ACCEPTANCE_REPORT", "明确目标报告与协议或事实不一致");
      for (const a of p.analyses) {
        if (a.kind === "interpretation" && !a.claims)
          fail("CLAIM_MISSING", "事实解释缺少可核对判断");
        const template = a.claims
          ? claimTemplate(a.claims, facts, a.evidenceIds)
          : (a.template ?? a.text);
        if (renderAnalysis(template, facts, a.evidenceIds) !== a.text)
          fail("CLAIM_FALSE", "报告解释与证据不一致");
      }
    }
    if (p.protocol.robustness) {
      const synthetic = this.validateDatasets(p, true).some((d) => d.synthetic);
      if (
        p.report.synthetic !== synthetic ||
        p.report.conclusion !== researchConclusion(p, synthetic) ||
        p.report.selectedCandidateId !== p.selectedCandidateId ||
        !isDeepStrictEqual(p.report.facts, this.facts(p))
      )
        fail(
          "DIAGNOSTIC_REPORT",
          "稳健性报告的结论、候选或事实与冻结协议不一致",
        );
      const runs = p.experiments.map((e) =>
        this.store.get<RunRecord>("run", e.runId),
      );
      verifyDiagnosticRuns(
        p,
        runs,
        this.store.list<StrategyRecord>("strategy"),
        true,
      );
      if (
        !isDeepStrictEqual(
          p.report.diagnostics,
          buildDiagnostics(p, runs, p.report.facts),
        )
      )
        fail("DIAGNOSTIC_REPORT", "报告稳健性结果与真实实验不一致");
    }
    return p;
  }
  private complete(p: ResearchProject) {
    if (
      !p.selectionHash ||
      !["holdout", "stress"].every((phase) =>
        p.experiments.some(
          (e) => e.phase === phase && e.status === "completed",
        ),
      )
    )
      fail("DELIVERABLE_INCOMPLETE", "最终验证未完成，不能交付研究");
    const runs = p.experiments.map((e) =>
      this.store.get<RunRecord>("run", e.runId),
    );
    verifyDiagnosticRuns(
      p,
      runs,
      this.store.list<StrategyRecord>("strategy"),
      true,
    );
    const facts = this.facts(p);
    for (const exp of p.experiments.filter((e) => e.status === "completed")) {
      const run = this.store.get<RunRecord>("run", exp.runId);
      verifyRun(run);
      for (const f of facts.filter((f) => f.runId === run.id))
        verifyEvidence(f, run, false);
    }
    const datasets = this.validateDatasets(p, true);
    const synthetic = datasets.some((d) => d.synthetic);
    p.report = makeReport(p, facts, synthetic, datasets, runs);
    p.status = "completed";
    p.reason = p.report.summary;
    p.error = "";
    this.save(p, "completed", {
      reportHash: p.report.hash,
      conclusion: p.report.conclusion,
    });
  }
  private priorExposures(p: ResearchProject) {
    const end = p.ranges.holdout.to + INTERVAL_MS[p.protocol.interval];
    const exposures = new Set<string>();
    for (const other of this.store.page<ResearchProject>("project", 0, 100000, [
      "report",
      "analyses",
    ])) {
      if (
        other.id === p.id ||
        !other.protocol.symbols.some((s) => p.protocol.symbols.includes(s))
      )
        continue;
      for (const e of other.experiments) {
        if (e.status !== "completed") continue;
        if (
          e.from < end &&
          e.to + INTERVAL_MS[other.protocol.interval] > p.ranges.holdout.from
        )
          exposures.add(other.id);
      }
      if (
        other.holdoutRevealedAt &&
        other.ranges.holdout.from < end &&
        other.ranges.holdout.to + INTERVAL_MS[other.protocol.interval] >
          p.ranges.holdout.from
      )
        exposures.add(other.id);
    }
    for (const run of this.store.page<RunRecord>("run", 0, 100000, [
      "result",
    ])) {
      if (run.projectId || run.status !== "completed") continue;
      const strategy = this.store.get<StrategyRecord>(
        "strategy",
        run.strategyId,
      ).definition;
      if (
        strategy.symbols.some((s) => p.protocol.symbols.includes(s)) &&
        run.config.from < end &&
        run.config.to + INTERVAL_MS[strategy.interval] > p.ranges.holdout.from
      )
        exposures.add(run.id);
    }
    return [...exposures].sort();
  }

  list(input: unknown = {}) {
    this.leaseValid();
    const x = z
      .object({
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(100).default(20),
      })
      .strict()
      .parse(input);
    return {
      projects: this.store
        .page<ResearchProject>("project", x.offset, x.limit, [
          "report",
          "analyses",
        ])
        .map(({ experiments, ...p }) => ({
          ...p,
          ...(this.fault
            ? {
                status: "failed" as const,
                reason: this.fault,
                error: this.fault,
              }
            : {}),
          experimentCount: experiments.length,
          completedExperiments: experiments.filter(
            (e) => e.status === "completed",
          ).length,
        })),
      total: this.store.count("project"),
      offset: x.offset,
    };
  }
  read(input: unknown) {
    this.leaseValid();
    const x = z
        .object({ id, after: z.number().int().nonnegative().default(0) })
        .strict()
        .parse(input),
      p = this.store.get<ResearchProject>("project", x.id);
    return {
      project: this.fault
        ? {
            ...p,
            status: "failed" as const,
            reason: this.fault,
            error: this.fault,
          }
        : p,
      events: this.store.events(p.id, x.after),
      evidence: this.facts(p),
      datasets: p.datasetIds.map((id) =>
        this.store.get<Dataset>("dataset", id),
      ),
      dataJobs: p.dataJobIds.map((id) =>
        this.store.get<DataJob>("dataJob", id),
      ),
      asOf: at(),
    };
  }
  promotionPreview(input: unknown) {
    const x = z
      .object({ id, config: configInput, replacementAccountId: id.optional() })
      .strict()
      .parse(input);
    const p = this.verifyReport(x.id),
      candidate = p.candidates.find((c) => c.id === p.selectedCandidateId)!;
    const target = this.store.get<StrategyRecord>(
      "strategy",
      candidate.strategyId,
    );
    const source = x.replacementAccountId
      ? this.store.get<Account>("account", x.replacementAccountId)
      : null;
    const sourceVersion = source
      ? this.store.get<StrategyRecord>("strategy", source.strategyId)
      : null;
    return makePromotionPreview(
      p,
      target,
      x.config,
      ENGINE_VERSION,
      source,
      sourceVersion,
      !!(source && this.store.maybe("simulationTransition", source.id)),
      p.experiments
        .filter((e) => e.status === "completed")
        .every(
          (e) =>
            this.store.get<RunRecord>("run", e.runId).config.engineVersion ===
            ENGINE_VERSION,
        ),
      this.store.list<Account>("account"),
    );
  }
  approve(input: unknown) {
    const x = z
      .object({
        submissionId: id,
        id,
        expectedRevision: z.number().int().positive(),
        reportHash: z.string(),
        config: configInput,
        name: z.string().min(1).max(100),
        replacementAccountId: id.optional(),
        previewHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .parse(input);
    return this.store.submit(x.submissionId, "project-approve", x, () => {
      const p = this.store.get<ResearchProject>("project", x.id);
      if (p.revision !== x.expectedRevision)
        fail("REVISION_CONFLICT", "研究状态已改变，请刷新后确认");
      if (
        p.status !== "completed" ||
        !p.report ||
        p.report.hash !== x.reportHash
      )
        fail("REPORT_NOT_READY", "需确认当前完整研究报告");
      this.verifyReport(p.id);
      if (p.report.conclusion !== "supported" || p.report.synthetic)
        fail(
          "EVALUATION_GATE",
          "本研究尚未满足模拟观察门槛，不能从报告推进运行",
        );
      const preview = this.promotionPreview({
        id: p.id,
        config: x.config,
        ...(x.replacementAccountId
          ? { replacementAccountId: x.replacementAccountId }
          : {}),
      });
      if (x.replacementAccountId && !x.previewHash)
        fail("PROMOTION_PREVIEW", "替换账户前必须核对具体版本与配置差异");
      if (x.previewHash && x.previewHash !== preview.hash)
        fail("PROMOTION_PREVIEW", "账户或配置已变化，请重新核对变更预览");
      if (!preview.canApprove)
        fail("PROMOTION_BLOCKED", preview.blockers.join("；"));
      const c = p.candidates.find((c) => c.id === p.selectedCandidateId)!,
        original = this.store.get<StrategyRecord>("strategy", c.strategyId);
      if (hash(original.definition) !== c.definitionHash)
        fail("STRATEGY_HASH", "研究策略定义与证据版本不一致");
      const { purpose, ...rest } = original;
      const version: StrategyRecord = {
        ...rest,
        id: uid(),
        name: x.name,
        published: true,
        revision: 1,
        approvedBy: "user",
        approvedAt: at(),
        approvedConfigHash: hash(x.config),
      };
      this.store.put("strategy", version.id, version);
      const account = this.research.accountCreate({
        submissionId: `account-${x.submissionId}`,
        name: x.name,
        strategyId: version.id,
        config: x.config,
      });
      this.store.put("approval", account.id, {
        id: account.id,
        projectId: p.id,
        strategyId: version.id,
        definitionHash: c.definitionHash,
        configHash: hash(x.config),
        reportHash: p.report.hash,
        actor: "user",
        at: at(),
        ...(x.replacementAccountId
          ? {
              replacementAccountId: x.replacementAccountId,
              previewHash: preview.hash,
            }
          : {}),
      });
      if (x.replacementAccountId) {
        const source = this.store.get<Account>(
          "account",
          x.replacementAccountId,
        );
        source.status = "stopped";
        source.generation++;
        source.revision++;
        source.error = "已由用户确认的新版本接替；新账户尚未启动";
        observationEvent(this.store, source, "replaced", source.error);
        this.store.put("account", source.id, source);
        const transitionBody = {
          id: source.id,
          version: 1 as const,
          fromAccountId: source.id,
          toAccountId: account.id,
          projectId: p.id,
          reportHash: p.report.hash,
          preview,
          approvedBy: "user" as const,
          approvedAt: at(),
        };
        const transition: SimulationTransition = {
          ...transitionBody,
          hash: hash(transitionBody),
        };
        this.store.put("simulationTransition", transition.id, transition);
      }
      this.save(p, "paper_approved", {
        accountId: account.id,
        strategyId: version.id,
      });
      return account;
    });
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe();
    await this.bridge?.close();
  }
  private leaseValid() {
    if (this.fault) return false;
    try {
      this.store.assertLease();
      return true;
    } catch (e) {
      this.fault = parseError(e).message;
      this.bridge?.cancelAll?.();
      return false;
    }
  }
  health() {
    return {
      storage: this.leaseValid() ? "ready" : "lease_lost",
      error: this.fault,
    };
  }
}
