import { useEffect, useRef, useState } from "react";
import { call, type Caller } from "./api.js";
import type {
  MonitorRecord,
  Notice,
  SimulationReview,
} from "../host/monitor.js";
interface Snapshot {
  monitors: MonitorRecord[];
  notices: Notice[];
  reviews: SimulationReview[];
  asOf: string;
  error?: string;
}
export function MonitoringPanel({
  rpc,
  sessionId,
  visible,
  bring,
}: {
  rpc: Caller;
  sessionId: string;
  visible: boolean;
  bring: (text: string) => string;
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
          if (!c.signal.aborted) setSnap(v);
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
  async function update(action: string, input: Record<string, unknown>) {
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
      await call(rpc, sessionId, action, { ...input, submissionId: id });
      submission.current.delete(key);
      setSnap(await call<Snapshot>(rpc, sessionId, "monitor-list"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新失败");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="card" aria-label="运行观察与复盘">
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
        <div key={review.id} className="stat">
          <small>
            {new Date(review.at).toLocaleString("zh-CN")} · 累计事实复盘
          </small>
          <p>
            累计收益 {Number(review.metrics.returnPct).toFixed(2)}% · 最大回撤{" "}
            {Number(review.metrics.maxDrawdownPct).toFixed(2)}% ·{" "}
            {review.metrics.closedTrades} 笔平仓
          </p>
          <p className="hint">
            {review.reason}
            {review.observationGap ? " 期间存在暂停或观察缺口。" : ""}
          </p>
          <button
            onClick={() =>
              setNotice(
                bring(
                  `请用 qt_monitor_read 读取事实复盘 ${review.id}，并读取模拟账户 ${review.accountId} 与其决策日志进行解释，结合实际观察区间，不直接与不同区间回测收益比较。`,
                ) === "ok"
                  ? "已带入对话，请检查后发送。"
                  : "请在聊天中引用账户身份。",
              )
            }
          >
            带入对话分析
          </button>
        </div>
      ))}
    </section>
  );
}
