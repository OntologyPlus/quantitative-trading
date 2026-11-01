import { z } from "zod";
import { hash } from "../adapters/market.js";
import { metrics } from "../engine/core.js";
import { id, fail } from "../domain/schemas.js";
import {
  INTERVAL_MS,
  type Account,
  type StrategyRecord,
} from "../domain/contracts.js";
import type { ResearchProject } from "../domain/project.js";
import type {
  ObservationRecord,
  SimulationReview,
} from "../domain/simulation.js";
export type { SimulationReview } from "../domain/simulation.js";
import { observationHealth } from "../domain/simulation-analysis.js";
import {
  captureSimulation,
  makeSimulationReview,
  loadSimulationReview,
  simulationEvidence,
  simulationEvidenceValues,
} from "./simulation-review.js";
import type { Research } from "./research.js";
export interface MonitorRecord {
  id: string;
  enabled: boolean;
  reviewHours: number;
  nextReviewAt: number;
  activeFault: string;
  lastCheckedAt: number;
  lastAccountStatus: string;
}
export interface Notice {
  id: string;
  accountId: string;
  kind: "fault" | "recovered" | "review";
  message: string;
  at: string;
  resolvedAt: string | null;
  acknowledged: boolean;
}
export class MonitorService {
  private closed = false;
  private pending = false;
  private fault = "";
  private timer: ReturnType<typeof setInterval>;
  private unsubscribe: () => void;
  constructor(readonly research: Research) {
    const schedule = () => {
      if (this.closed || this.pending) return;
      this.pending = true;
      setImmediate(() => {
        this.pending = false;
        if (!this.closed) {
          try {
            this.tick();
          } catch (e) {
            this.fault = e instanceof Error ? e.message : "运行观察持久化失败";
          }
        }
      });
    };
    this.unsubscribe = research.store.onChange(schedule);
    this.timer = setInterval(schedule, 10000);
    this.timer.unref();
    schedule();
  }
  config(input: unknown) {
    const x = z
      .object({
        submissionId: id,
        id,
        enabled: z.boolean(),
        reviewHours: z.number().int().min(1).max(168),
      })
      .strict()
      .parse(input);
    return this.research.store.submit(
      x.submissionId,
      "monitor-config",
      x,
      () => {
        this.research.store.get<Account>("account", x.id);
        const old = this.research.store.maybe<MonitorRecord>("monitor", x.id);
        const m: MonitorRecord = {
          id: x.id,
          enabled: x.enabled,
          reviewHours: x.reviewHours,
          nextReviewAt: Date.now() + x.reviewHours * 3600000,
          activeFault: old?.activeFault ?? "",
          lastCheckedAt: Date.now(),
          lastAccountStatus: old?.lastAccountStatus ?? "created",
        };
        this.research.store.put("monitor", m.id, m);
        return m;
      },
    );
  }
  acknowledge(input: unknown) {
    const x = z.object({ submissionId: id, id }).strict().parse(input);
    return this.research.store.submit(x.submissionId, "notice-ack", x, () => {
      const n = this.research.store.get<Notice>("notice", x.id);
      n.acknowledged = true;
      this.research.store.put("notice", n.id, n);
      return n;
    });
  }
  review(input: unknown) {
    const x = z.object({ submissionId: id, id }).strict().parse(input);
    return this.research.store.submit(
      x.submissionId,
      "simulation-review",
      x,
      () => {
        const checkpoint = captureSimulation(
          this.research,
          this.research.store.get<Account>("account", x.id),
        );
        const review = makeSimulationReview(
          checkpoint,
          hash({ account: x.id, submission: x.submissionId }),
        );
        this.research.store.put(
          "simulationCheckpoint",
          checkpoint.id,
          checkpoint,
        );
        this.research.store.put("simulationReview", review.id, review);
        return review;
      },
    );
  }
  read(input: unknown) {
    const x = z
      .object({ id, path: z.string().max(200).optional() })
      .strict()
      .parse(input);
    if (x.path) return simulationEvidence(this.research, x.id, x.path);
    const { review, checkpoint } = loadSimulationReview(this.research, x.id);
    return {
      review,
      source: {
        account: checkpoint.account,
        definition: checkpoint.definition,
        definitionHash: checkpoint.definitionHash,
        baseline: checkpoint.baseline,
        observation: checkpoint.observation,
        events: checkpoint.events,
      },
      evidencePaths: Object.keys(simulationEvidenceValues(checkpoint)),
    };
  }
  followupInput(input: unknown) {
    const x = z
      .object({
        reviewId: id,
        reviewHash: z.string(),
        questionCode: z.string().max(100),
      })
      .strict()
      .parse(input);
    const { review, checkpoint } = loadSimulationReview(
      this.research,
      x.reviewId,
    );
    if (review.hash !== x.reviewHash)
      fail("SIMULATION_REVIEW", "事实复盘已变化，请重新核对");
    const question = review.diagnosis!.researchQuestions.find(
      (q) => q.code === x.questionCode,
    );
    if (!question)
      fail("SIMULATION_QUESTION", "请选择本次复盘中保留的研究问题");
    const parent = checkpoint.baseline
      ? this.research.store.get<ResearchProject>(
          "project",
          checkpoint.baseline.projectId,
        )
      : null;
    const step = INTERVAL_MS[checkpoint.definition.interval],
      to = Math.floor(Date.now() / step) * step - step;
    const budget = parent?.protocol.budget ?? {
      experiments: 12,
      modelRequests: 20,
      outputTokens: 4096,
      maxBars: 100000,
      computeSeconds: 600,
      hours: 24,
    };
    const count = Math.min(
      Math.floor((180 * 86400000) / step),
      Math.floor(budget.maxBars / checkpoint.definition.symbols.length),
    );
    return {
      name: `${checkpoint.account.name} · 观察后续研究`.slice(0, 100),
      objective: question.objective,
      symbols: checkpoint.definition.symbols,
      interval: checkpoint.definition.interval,
      from: to - (Math.max(180, count) - 1) * step,
      to,
      budget,
      mode: parent?.protocol.mode ?? "protocol",
      ...(parent
        ? {
            parentProjectId: parent.id,
            thresholds: parent.protocol.thresholds,
            ...(parent.protocol.robustness
              ? { robustness: parent.protocol.robustness }
              : {}),
          }
        : {}),
      config: {
        initialCash: checkpoint.account.config.initialCash,
        risk: checkpoint.account.config.risk,
        costs: checkpoint.account.config.costs,
        from: 0,
        to: 8640000000000000,
      },
      simulationSource: {
        accountId: review.accountId,
        reviewId: review.id,
        reviewHash: review.hash!,
      },
    };
  }
  private tick() {
    try {
      this.research.store.assertLease();
    } catch (e) {
      this.fault = e instanceof Error ? e.message : "运行观察租约失效";
      return;
    }
    const s = this.research.store,
      now = Date.now();
    for (const a of s.list<Account>("account")) {
      let m = s.maybe<MonitorRecord>("monitor", a.id);
      if (!m) {
        m = {
          id: a.id,
          enabled: true,
          reviewHours: 24,
          nextReviewAt: now + 86400000,
          activeFault: "",
          lastCheckedAt: now,
          lastAccountStatus: a.status,
        };
        s.put("monitor", m.id, m);
      }
      if (!m.enabled) continue;
      if (now - m.lastCheckedAt >= 10000) {
        m.lastCheckedAt = now;
        m.lastAccountStatus = a.status;
        s.put("monitor", m.id, m);
      }
      const definition = s.get<StrategyRecord>(
        "strategy",
        a.strategyId,
      ).definition;
      const health = observationHealth(
        a,
        definition,
        s.maybe<ObservationRecord>("observation", a.id),
        now,
      );
      const stale =
        a.status === "running" &&
        a.lastEventAt > 0 &&
        now - a.lastEventAt > 120000;
      const fault =
        a.error ||
        (health.state === "stale"
          ? health.explanation
          : stale
            ? "超过两分钟没有有效行情观察"
            : "");
      if (fault !== m.activeFault) {
        s.transaction(() => {
          if (m!.activeFault) {
            const old = s.maybe<Notice>(
              "notice",
              hash({ account: a.id, fault: m!.activeFault }),
            );
            if (old) {
              old.resolvedAt = new Date(now).toISOString();
              old.acknowledged = false;
              s.put("notice", old.id, old);
            }
          }
          if (fault) {
            const noticeId = hash({ account: a.id, fault });
            const n: Notice = {
              id: noticeId,
              accountId: a.id,
              kind: "fault",
              message: fault,
              at: new Date(now).toISOString(),
              resolvedAt: null,
              acknowledged: false,
            };
            s.put("notice", n.id, n);
          }
          m!.activeFault = fault;
          m!.lastCheckedAt = now;
          m!.lastAccountStatus = a.status;
          s.put("monitor", m!.id, m);
        });
      }
      if (now >= m.nextReviewAt && a.status !== "created") {
        const checkpoint = captureSimulation(this.research, a, now);
        const review = makeSimulationReview(
          checkpoint,
          hash({ account: a.id, period: m.nextReviewAt }),
        );
        s.transaction(() => {
          s.put("simulationCheckpoint", checkpoint.id, checkpoint);
          s.put("simulationReview", review.id, review);
          const n: Notice = {
            id: review.id,
            accountId: a.id,
            kind: "review",
            message: "模拟观察事实复盘已生成，可带入对话分析",
            at: review.at,
            resolvedAt: null,
            acknowledged: false,
          };
          s.put("notice", n.id, n);
          m!.nextReviewAt = now + m!.reviewHours * 3600000;
          m!.lastCheckedAt = now;
          s.put("monitor", m!.id, m);
        });
      }
    }
  }
  list(input: unknown = {}) {
    const x = z
        .object({
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(100).default(20),
        })
        .strict()
        .parse(input),
      s = this.research.store;
    return {
      monitors: s.page<MonitorRecord>("monitor", 0, 100),
      notices: s.page<Notice>("notice", x.offset, x.limit),
      total: s.count("notice"),
      reviews: s.page<SimulationReview>("simulationReview", 0, 20),
      accounts: s
        .list<Account>("account")
        .map((a) =>
          observationHealth(
            a,
            s.get<StrategyRecord>("strategy", a.strategyId).definition,
            s.maybe<ObservationRecord>("observation", a.id),
          ),
        ),
      transitions: s.page("simulationTransition", 0, 10),
      asOf: new Date().toISOString(),
      mode: "local-process",
      error: this.fault,
    };
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe();
  }
}
