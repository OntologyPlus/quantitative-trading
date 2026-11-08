import { useState, useRef, useEffect } from "react";
import type { Caller } from "./api.js";
import { call, download } from "./api.js";
import { LabResult } from "./lab-results.js";
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
  "parameter-sweep": {
    runId: "单标的回测Run身份",
    grid: { fast: [5, 10, 15, 20, 30], slow: [40, 60, 90, 120, 180] },
    sortBy: "sharpe",
    minClosedTrades: 10,
    top: 5,
    search: { mode: "grid", samples: 200, seed: 1 },
  },
  "walk-forward": {
    runId: "单标的回测Run身份",
    grid: { fast: [5, 10, 20, 30], slow: [40, 60, 90, 120] },
    mode: "rolling",
    trainBars: 2000,
    testBars: 500,
    sortBy: "sharpe",
    minClosedTrades: 5,
  },
  "performance-report": {
    runId: "回测Run身份",
    costMultipliers: [0, 1, 2, 3],
    rollingDays: 30,
  },
};
const labels = {
  "universe-asof": "历史时点候选池",
  "portfolio-backtest": "组合资金与逐笔回测",
  "research-quality": "样本与收益不确定性",
  "simulation-replay": "同区间成交对账",
  "portfolio-research": "组合净值情景",
  "data-audit": "来源与数据修订核验",
  "parameter-sweep": "参数扫描与过拟合检验",
  "walk-forward": "滚动前推验证",
  "performance-report": "绩效报告与成本敏感性",
};
const withRun = (value: unknown, runId?: string) =>
  runId && value && typeof value === "object" && "runId" in value
    ? { ...(value as Record<string, unknown>), runId }
    : value;
export function ResearchLab({
  rpc,
  sessionId,
  runId,
}: {
  rpc: Caller;
  sessionId: string;
  /** Currently selected run; prefilled into run-based tools. */
  runId?: string;
}) {
  const [action, setAction] =
      useState<keyof typeof examples>("research-quality"),
    [input, setInput] = useState(
      JSON.stringify(withRun(examples["research-quality"], runId), null, 2),
    ),
    [result, setResult] = useState<unknown>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setBusy(false);
    setError("");
    setResult(undefined);
    if (runId)
      setInput((current) => {
        try {
          return JSON.stringify(withRun(JSON.parse(current), runId), null, 2);
        } catch {
          return current;
        }
      });
    return () => {
      controller.current?.abort();
      controller.current = null;
    };
  }, [sessionId, runId]);
  return (
    <details className="card">
      <summary>研究增强实验室</summary>
      <p>
        核对完整实验与数据身份后分析。组合是净值序列情景，同区间对账保留成交模型和初始仓位差异；结果中列明假设与限制。
      </p>
      {(action === "parameter-sweep" || action === "walk-forward") && (
        <p className="hint">
          需使用当前引擎的单标的均线或突破回测与基础风控；表达式、轮动、附加条件及高级风控暂不支持扫描和前推。
          DSR/PBO
          在扫描结果中提供，至少需要两个参数组合及三十个日收益；实验室分析尚未接入研究委托的验收门槛。
        </p>
      )}
      {action === "performance-report" && (
        <p className="hint">
          支持表达式和轮动；需使用当前引擎的已完成回测，至少覆盖两个 UTC
          日。完整绩效指标位于此报告，普通回测指标不会自动扩展。
        </p>
      )}
      <label>
        研究工具
        <select
          value={action}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.value as keyof typeof examples;
            setAction(next);
            setInput(JSON.stringify(withRun(examples[next], runId), null, 2));
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
          <LabResult action={action} result={result} />
          <details>
            <summary>完整结果 JSON</summary>
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
          </details>
        </>
      )}
    </details>
  );
}
