import { useEffect, useRef, useState } from "react";
import { call, type Caller } from "./api.js";
import type {
  MonitorRecord,
  Notice,
  SimulationReview,
} from "../host/monitor.js";
import type {
  SimulationHealth,
  SimulationTransition,
} from "../domain/simulation.js";
import type { ResearchProject } from "../domain/project.js";
import { SimulationReviewCard } from "./simulation-review-card.js";
interface Snapshot {
  monitors: MonitorRecord[];
  notices: Notice[];
  reviews: SimulationReview[];
  asOf: string;
  error?: string;
  accounts?: SimulationHealth[];
  transitions?: SimulationTransition[];
}
export function MonitoringPanel({
  rpc,
  sessionId,
  visible,
  bring,
  onProject,
}: {
  rpc: Caller;
  sessionId: string;
  visible: boolean;
  bring: (text: string) => string;
  onProject: (id: string) => void;
}) {
  const [snap, setSnap] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const lock = useRef(false),
    submission = useRef(new Map<string, string>());
  useEffect(() => {
    const c = new AbortController();
    const refresh = () =>
      void call<Snapshot>(rpc, sessionId, "monitor-list", {}, c.signal)
        .then((v) => {
          if (!c.signal.aborted) {
            setSnap(v);
            setError("");
          }
        })
        .catch((e) => {
          if (!c.signal.aborted) setError(e.message);
        });
    refresh();
    const timer = visible ? setInterval(refresh, 10000) : null;
    return () => {
      c.abort();
      if (timer) clearInterval(timer);
    };
  }, [rpc, sessionId, visible]);
  async function update<T = unknown>(
    action: string,
    input: Record<string, unknown>,
    done?: (v: T) => void,
  ) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const key = JSON.stringify({ action, input });
    let id = submission.current.get(key);
    if (!id) {
      id = crypto.randomUUID();
      submission.current.set(key, id);
    }
    try {
      const value = await call<T>(rpc, sessionId, action, {
        ...input,
        submissionId: id,
      });
      submission.current.delete(key);
      setSnap(await call<Snapshot>(rpc, sessionId, "monitor-list"));
      done?.(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新失败");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-label="运行观察与复盘">
      <style>{`.qt .simulation-review{display:grid;gap:12px;min-width:0}.qt .simulation-review p,.qt .simulation-review h4{margin:0}.qt .simulation-review li{line-height:1.8;overflow-wrap:anywhere}.qt .simulation-review td{white-space:normal;min-width:90px}`}</style>
      <div className="row between">
        <h3>运行观察与复盘</h3>
        <span className="badge">本地观察</span>
      </div>
      <p className="hint">
        记录有效行情时间、异常与恢复；按约定周期生成累计事实复盘。电脑或宿主离线期间无法监测。
      </p>
      {(error || snap?.error) && (
        <p className="down" role="alert">
          {error || snap?.error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {snap?.accounts?.map((a) => (
        <div className="stat" key={a.accountId}>
          <strong>
            {a.name} ·{" "}
            {
              {
                waiting: "等待行情",
                current: "当前记录有效",
                stale: "行情或估值过期",
                paused: "未运行",
                unknown: "历史记录不完整",
              }[a.state]
            }
          </strong>
          <p>{a.explanation}</p>
          <p className="hint">
            最后连接事件：
            {a.lastTransportAt
              ? new Date(a.lastTransportAt).toLocaleString("zh-CN")
              : "未记录"}
            ；最后有效行情：
            {a.lastMarketAt
              ? new Date(a.lastMarketAt).toLocaleString("zh-CN")
              : "尚未观察"}
            。
          </p>
          <p className="hint">
            累计中断 {a.gapCount ?? "未知"} 次 ·{" "}
            {a.gapMs === null
              ? "时长未知"
              : `${(a.gapMs / 60000).toFixed(1)} 分钟`}
            ；
            {a.historyComplete
              ? "已记录观察生命周期"
              : "升级前或启动前历史不完整"}
            。
            {a.stalePositions.length
              ? `待核对估值：${a.stalePositions.join(" / ")}`
              : ""}
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void update("monitor-review", { id: a.accountId }, () =>
                setNotice("当前账本与观察记录已冻结，可在下方核对事实复盘。"),
              )
            }
          >
            生成当前事实复盘
          </button>
        </div>
      ))}
      {snap?.notices
        .filter((n) => !n.acknowledged)
        .map((n) => (
          <div
            className={
              n.kind === "fault" && !n.resolvedAt ? "notice error" : "notice"
            }
            key={n.id}
          >
            <strong>
              {n.resolvedAt ? "已恢复 · " : ""}
              {n.message}
            </strong>
            <p className="hint">
              账户 {n.accountId.slice(0, 8)} ·{" "}
              {new Date(n.at).toLocaleString("zh-CN")}
            </p>
            <button
              disabled={busy}
              onClick={() => void update("notice-ack", { id: n.id })}
            >
              已知晓
            </button>
          </div>
        ))}
      {snap && !snap.notices.some((n) => !n.acknowledged) && (
        <p className="muted">当前没有需要处理的新事件。</p>
      )}
      {snap?.monitors.map((m) => (
        <div className="row between" key={m.id}>
          <small>
            账户 {m.id.slice(0, 8)} · 每 {m.reviewHours} 小时复盘
          </small>
          <button
            disabled={busy}
            onClick={() =>
              void update("monitor-config", {
                id: m.id,
                enabled: !m.enabled,
                reviewHours: m.reviewHours,
              })
            }
          >
            {m.enabled ? "暂停观察复盘" : "启用观察复盘"}
          </button>
        </div>
      ))}
      {snap?.reviews.slice(0, 5).map((review) => (
        <SimulationReviewCard
          key={review.id}
          review={review}
          rpc={rpc}
          sessionId={sessionId}
          busy={busy}
          bring={bring}
          onProject={onProject}
          onFollowup={(review, code) =>
            void update<ResearchProject>(
              "monitor-followup",
              { id: review.id, reviewHash: review.hash!, questionCode: code },
              (project) => onProject(project.id),
            )
          }
        />
      ))}
      {!!snap?.transitions?.length && (
        <details>
          <summary>已批准的运行版本变更</summary>
          {snap.transitions.map((t) => (
            <div className="stat" key={t.id}>
              <strong>
                {t.preview.source?.name ?? t.fromAccountId.slice(0, 8)} → 新账户{" "}
                {t.toAccountId.slice(0, 8)}
              </strong>
              <p>
                {new Date(t.approvedAt).toLocaleString("zh-CN")} · 用户已确认 ·
                原账户记录保留
              </p>
              <button onClick={() => onProject(t.projectId)}>
                核对研究与批准依据
              </button>
              <details>
                <summary>变更明细与身份</summary>
                <pre>{JSON.stringify(t, null, 2)}</pre>
              </details>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
