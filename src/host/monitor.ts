import { z } from "zod";
import { hash } from "../adapters/market.js";
import { metrics } from "../engine/core.js";
import { id, fail } from "../domain/schemas.js";
import type { Account, Metrics } from "../domain/contracts.js";
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
export interface SimulationReview {
  id: string;
  accountId: string;
  at: string;
  from: number;
  to: number;
  metrics: Metrics;
  observationGap: boolean;
  status: string;
  reason: string;
  kind: "deterministic";
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
      const stale =
        a.status === "running" &&
        a.lastEventAt > 0 &&
        now - a.lastEventAt > 120000;
      const fault = a.error || (stale ? "超过两分钟没有有效行情观察" : "");
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
        const review: SimulationReview = {
          id: hash({ account: a.id, period: m.nextReviewAt }),
          accountId: a.id,
          at: new Date(now).toISOString(),
          from: a.state.curve[0]?.at ?? now,
          to: a.lastEventAt,
          metrics: metrics(a.state, a.config),
          observationGap: Boolean(fault) || a.status !== "running",
          status: a.status,
          reason:
            fault ||
            "按固定规则运行；本次为累计观察事实复盘，与历史回测区间不直接比较。",
          kind: "deterministic",
        };
        s.transaction(() => {
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
