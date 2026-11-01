import { useState, useRef, useEffect } from "react";
import type { Caller } from "./api.js";
import { call, download } from "./api.js";
const examples = {
  "portfolio-backtest": {
    legs: [
      { runId: "实验一", weightPct: 50 },
      { runId: "实验二", weightPct: 50 },
    ],
    initialCash: "10000",
    rebalance: "monthly",
  },
  "research-quality": { runId: "实验Run身份" },
  "simulation-replay": {
    accountId: "模拟账户身份",
    datasetIds: ["同区间数据身份"],
    from: 0,
    to: 1,
  },
  "portfolio-research": {
    legs: [
      { runId: "实验一", weightPct: 50 },
      { runId: "实验二", weightPct: 50 },
    ],
    rebalance: "monthly",
    rebalanceCostBps: 10,
  },
  "universe-asof": { datasetIds: ["历史数据身份"], asOf: 0 },
  "data-audit": { datasetIds: ["数据身份一", "数据身份二"] },
};
const labels = {
  "universe-asof": "历史时点候选池",
  "portfolio-backtest": "组合资金与逐笔回测",
  "research-quality": "样本与收益不确定性",
  "simulation-replay": "同区间成交对账",
  "portfolio-research": "组合净值情景",
  "data-audit": "来源与数据修订核验",
};
export function ResearchLab({
  rpc,
  sessionId,
}: {
  rpc: Caller;
  sessionId: string;
}) {
  const [action, setAction] =
      useState<keyof typeof examples>("research-quality"),
    [input, setInput] = useState(
      JSON.stringify(examples["research-quality"], null, 2),
    ),
    [result, setResult] = useState<unknown>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setBusy(false);
    setError("");
    setResult(undefined);
    return () => {
      controller.current?.abort();
      controller.current = null;
    };
  }, [sessionId]);
  return (
    <details className="card">
      <summary>研究增强实验室</summary>
      <p>
        核对完整实验与数据身份后分析。组合是净值序列情景，同区间对账保留成交模型和初始仓位差异；结果中列明假设与限制。
      </p>
      <label>
        研究工具
        <select
          value={action}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value as keyof typeof examples;
            setAction(next);
            setInput(JSON.stringify(examples[next], null, 2));
            setResult(undefined);
            setError("");
          }}
        >
          {Object.entries(labels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        分析条件（JSON，时间使用 UTC 毫秒）
        <textarea
          aria-label="研究增强分析条件"
          rows={9}
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
        />
      </label>
      <button
        disabled={busy}
        onClick={async () => {
          const pending = new AbortController();
          controller.current = pending;
          setBusy(true);
          setError("");
          setResult(undefined);
          try {
            const value = await call(
              rpc,
              sessionId,
              action,
              JSON.parse(input),
              pending.signal,
            );
            if (controller.current === pending && !pending.signal.aborted)
              setResult(value);
          } catch (e) {
            if (controller.current === pending)
              setError(
                pending.signal.aborted
                  ? "分析已取消"
                  : e instanceof Error
                    ? e.message
                    : String(e),
              );
          } finally {
            if (controller.current === pending) {
              controller.current = null;
              setBusy(false);
            }
          }
        }}
      >
        {busy ? "正在分析…" : "生成分析"}
      </button>
      {busy && (
        <button onClick={() => controller.current?.abort()}>取消分析</button>
      )}
      {error && <p role="alert">{error}</p>}
      {result !== undefined && (
        <>
          <button
            onClick={() =>
              download(`${action}.json`, JSON.stringify(result, null, 2))
            }
          >
            导出冻结分析 JSON
          </button>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: 500,
              overflow: "auto",
            }}
          >
            {JSON.stringify(result, null, 2)}
          </pre>
        </>
      )}
    </details>
  );
}
