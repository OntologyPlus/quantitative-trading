import { useCallback, useEffect, useRef, useState } from "react";
import type { UseSidebarRightTabInfo } from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type {
  Account,
  Dataset,
  Decision,
  Equity,
  Metrics,
  RunRecord,
  StrategyRecord,
} from "../domain/contracts.js";
import type { Caller } from "./api.js";
import { call, download } from "./api.js";
import { styles } from "./styles.js";
import { ResearchWorkspace } from "./research.js";
import { MonitoringPanel } from "./monitor.js";
export const STUDIO_ID = "@quant-assistant/harness-plugin/workbench",
  STUDIO_KIND = "quant-workbench";
type Tab = "overview" | "strategy" | "data" | "backtest" | "paper" | "logs";
interface RunSummary extends Omit<RunRecord, "result"> {
  metrics?: Metrics;
  benchmarks?: {
    cashReturnPct: string;
    buyHoldReturnPct: string;
  };
}
interface Snapshot {
  schemaVersion: number;
  asOf: string;
  datasets: Dataset[];
  strategies: StrategyRecord[];
  runs: RunSummary[];
  dataJobs: {
    id: string;
    symbol: string;
    status: string;
    progress: number;
    error: string;
    datasetId: string;
  }[];
  accounts: Account[];
  reviews: {
    id: string;
    title: string;
    body: string;
    author: string;
    runId: string;
  }[];
}
const fmt = (v: unknown, digits = 2) =>
  v === null || v === undefined
    ? "—"
    : Number(v).toLocaleString("zh-CN", { maximumFractionDigits: digits });
const date = (v: number | string) =>
  new Date(v).toLocaleString("zh-CN", { hour12: false });
const labels: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  created: "未启动",
  paused: "已暂停",
  stopped: "已停止",
};
const defaultRisk = {
  sizing: "weight",
  weightPct: "10",
  riskPct: "1",
  stopLossPct: "5",
  takeProfitPct: "10",
  maxSymbolPct: "20",
  maxExposurePct: "60",
  maxPositions: 3,
  dailyLossPct: "5",
  maxDrawdownPct: "20",
};
const defaultCosts = { feeBps: "10", slippageBps: "5", participationPct: "1" };
export function Curve({ values }: { values: Equity[] }) {
  if (values.length < 2) return <p className="empty">完成运行后显示净值曲线</p>;
  const nums = values.map((v) => Number(v.equity)),
    lo = Math.min(...nums),
    hi = Math.max(...nums),
    span = hi - lo || 1;
  const pts = nums
    .map(
      (n, i) =>
        `${((i / (nums.length - 1)) * 480).toFixed(2)},${(120 - ((n - lo) / span) * 100).toFixed(2)}`,
    )
    .join(" ");
  return (
    <div>
      <div className="row between">
        <small>账户净值 / USDT</small>
        <small>
          {fmt(lo)} — {fmt(hi)}
        </small>
      </div>
      <svg
        className="chart"
        viewBox="0 0 480 145"
        preserveAspectRatio="none"
        role="img"
        aria-label="账户净值曲线"
      >
        <path
          d="M0 20H480 M0 70H480 M0 120H480"
          stroke="#2b343f"
          strokeDasharray="3 5"
        />
        <polygon points={`0,140 ${pts} 480,140`} fill="#81e5ba0c" />
        <polyline
          points={pts}
          fill="none"
          stroke="#81e5ba"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="row between">
        <small>{date(values[0]!.at)}</small>
        <small>{date(values.at(-1)!.at)}</small>
      </div>
    </div>
  );
}
function MetricGrid({ m }: { m: Metrics }) {
  return (
    <div className="grid">
      {[
        ["区间收益", `${fmt(m.returnPct)}%`],
        ["最大回撤", `${fmt(m.maxDrawdownPct)}%`],
        ["成交 / 平仓", `${m.trades} / ${m.closedTrades}`],
        [
          "平仓胜率",
          m.winRatePct === null ? "样本不足" : `${fmt(m.winRatePct)}%`,
        ],
        ["手续费 / 滑点", `${fmt(m.fees)} / ${fmt(m.slippage)}`],
        ["Sharpe（365日）", fmt(m.sharpe)],
        ["已实现盈亏", fmt(m.realizedPnl)],
        ["未实现盈亏", fmt(m.unrealizedPnl)],
      ].map(([name, value]) => (
        <div className="stat" key={name}>
          <small>{name}</small>
          <div className="mono">{value}</div>
        </div>
      ))}
    </div>
  );
}
export function Studio({
  rpc,
  sessionId,
  useTabInfo,
  bring,
}: {
  rpc: Caller;
  sessionId: string;
  useTabInfo: UseSidebarRightTabInfo;
  bring: (text: string) => string;
}) {
  const visible = useTabInfo().tab.visible,
    [tab, setTab] = useState<Tab>("overview"),
    [snap, setSnap] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    request = useRef(0),
    lock = useRef(false),
    submissions = useRef(new Map<string, string>());
  const [strategyId, setStrategyId] = useState(""),
    [openProjectId, setOpenProjectId] = useState<string | undefined>(),
    [datasetIds, setDatasetIds] = useState<string[]>([]),
    [runId, setRunId] = useState(""),
    [detail, setDetail] = useState<RunRecord | null>(null),
    [fillOffset, setFillOffset] = useState(0),
    [comparison, setComparison] = useState<string[]>([]);
  const [name, setName] = useState("我的均线策略"),
    [template, setTemplate] = useState<"sma_cross" | "breakout">("sma_cross"),
    [symbolText, setSymbolText] = useState("BTCUSDT"),
    [timeframe, setTimeframe] = useState("1h"),
    [fast, setFast] = useState(20),
    [slow, setSlow] = useState(60),
    [entry, setEntry] = useState(20),
    [exit, setExit] = useState(10),
    [editing, setEditing] = useState<{
      id: string;
      revision: number;
    } | null>(null);
  const [cash, setCash] = useState("10000"),
    [risk, setRisk] = useState(defaultRisk),
    [costs, setCosts] = useState(defaultCosts),
    [from, setFrom] = useState(() =>
      new Date(Math.floor(Date.now() / 3600000) * 3600000 - 90 * 86400000)
        .toISOString()
        .slice(0, 16),
    ),
    [to, setTo] = useState(() =>
      new Date(Math.floor(Date.now() / 3600000) * 3600000 - 3600000)
        .toISOString()
        .slice(0, 16),
    ),
    [rangeFrom, setRangeFrom] = useState(""),
    [rangeTo, setRangeTo] = useState(""),
    [dataSymbol, setDataSymbol] = useState("BTCUSDT"),
    [dataInterval, setDataInterval] = useState("1h");
  const [logId, setLogId] = useState(""),
    [logKind, setLogKind] = useState<"run" | "account">("run"),
    [logOffset, setLogOffset] = useState(0),
    [logCode, setLogCode] = useState(""),
    [events, setEvents] = useState<{
      events: Decision[];
      total: number;
    } | null>(null);
  const selected = snap?.strategies.find((s) => s.id === strategyId),
    eligible =
      snap?.datasets.filter(
        (d) =>
          selected?.definition.symbols.includes(d.symbol) &&
          d.interval === selected.definition.interval,
      ) ?? [];
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const seq = ++request.current,
        g = generation.current;
      const value = await call<Snapshot>(
        rpc,
        sessionId,
        "snapshot",
        {},
        signal,
      );
      if (g === generation.current && seq === request.current) {
        setSnap(value);
        setError("");
      }
    },
    [rpc, sessionId],
  );
  useEffect(() => {
    generation.current++;
    setSnap(null);
    setDetail(null);
    setError("");
    const controller = new AbortController();
    void refresh(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => {
      controller.abort();
      generation.current++;
    };
  }, [refresh]);
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(
      () => void refresh().catch((e) => setError(e.message)),
      5000,
    );
    return () => clearInterval(timer);
  }, [visible, refresh]);
  useEffect(() => {
    if (!runId) {
      setDetail(null);
      return;
    }
    const c = new AbortController();
    void call<RunRecord>(
      rpc,
      sessionId,
      "run",
      { id: runId, offset: fillOffset, limit: 50 },
      c.signal,
    )
      .then((v) => {
        if (!c.signal.aborted) setDetail(v);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [runId, fillOffset, snap?.asOf, rpc, sessionId]);
  useEffect(() => {
    if (tab !== "logs" || !logId) return;
    const c = new AbortController();
    void call<{
      events: Decision[];
      total: number;
    }>(
      rpc,
      sessionId,
      "decisions",
      {
        id: logId,
        kind: logKind,
        offset: logOffset,
        limit: 50,
        ...(logCode ? { code: logCode } : {}),
      },
      c.signal,
    )
      .then((v) => {
        if (!c.signal.aborted) setEvents(v);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [tab, logId, logKind, logOffset, logCode, snap?.asOf, rpc, sessionId]);
  async function act<T>(
    action: string,
    input: Record<string, unknown> = {},
    onSaved?: (v: T) => void,
    write = true,
  ) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const g = generation.current,
      key = JSON.stringify({ action, input });
    let submissionId = submissions.current.get(key);
    if (!submissionId) {
      submissionId = crypto.randomUUID();
      submissions.current.set(key, submissionId);
    }
    let saved = false;
    try {
      const value = await call<T>(
        rpc,
        sessionId,
        action,
        write ? { ...input, submissionId } : input,
      );
      saved = true;
      if (g !== generation.current) return;
      onSaved?.(value);
      submissions.current.delete(key);
      setNotice("操作已完成。");
      try {
        await refresh();
      } catch {
        setNotice("操作已完成，但界面尚未同步。请重新连接，无需重复提交。");
      }
    } catch (e) {
      if (g === generation.current)
        setError(
          saved
            ? "已完成操作，但界面更新失败，请重新连接。"
            : e instanceof Error
              ? e.message
              : "操作失败",
        );
    } finally {
      lock.current = false;
      if (g === generation.current) setBusy(false);
    }
  }
  function edit(s: StrategyRecord) {
    setName(s.name);
    setTemplate(s.definition.template);
    setSymbolText(s.definition.symbols.join(","));
    setTimeframe(s.definition.interval);
    setFast(s.definition.fast);
    setSlow(s.definition.slow);
    setEntry(s.definition.entryPeriod);
    setExit(s.definition.exitPeriod);
    setEditing(s.published ? null : { id: s.id, revision: s.revision });
    setTab("strategy");
  }
  const config = () => ({
    initialCash: cash,
    risk,
    costs,
    ...(rangeFrom ? { from: new Date(rangeFrom).getTime() } : {}),
    ...(rangeTo ? { to: new Date(rangeTo).getTime() } : {}),
  });
  const chooseRun = (id: string) => {
    setRunId(id);
    setFillOffset(0);
  };
  const showLogs = (id: string, kind: "run" | "account") => {
    setLogId(id);
    setLogKind(kind);
    setLogOffset(0);
    setTab("logs");
  };
  async function exportRun(kind: "json" | "csv" | "md") {
    if (!runId) return;
    await act<RunRecord>(
      "export-run",
      { id: runId },
      (run) => {
        if (kind === "json")
          download(`run-${run.id}.json`, JSON.stringify(run, null, 2));
        if (kind === "csv") {
          const header = [
            "id",
            "symbol",
            "side",
            "quantity",
            "price",
            "fee",
            "slippage",
            "at",
            "signalAt",
            "reason",
            "realizedPnl",
          ];
          download(
            `trades-${run.id}.csv`,
            [
              header.join(","),
              ...(run.result?.state.fills ?? []).map((f) =>
                header
                  .map((k) =>
                    JSON.stringify(
                      (f as unknown as Record<string, unknown>)[k] ?? "",
                    ),
                  )
                  .join(","),
              ),
            ].join("\n"),
            "text/csv",
          );
        }
        if (kind === "md")
          download(
            `report-${run.id}.md`,
            `# 历史回测报告\n\nRun: ${run.id}\n\nManifest: ${run.manifestHash}\n\n状态: ${run.status}\n\n配置:\n\n\`\`\`json\n${JSON.stringify(run.config, null, 2)}\n\`\`\`\n\n指标:\n\n\`\`\`json\n${JSON.stringify(run.result?.metrics, null, 2)}\n\`\`\`\n\n固定交易对池；当前交易规则近似；K线级成本模型；不代表真实收益。\n`,
            "text/markdown",
          );
      },
      false,
    );
  }
  const configForm = (
    <details>
      <summary>实验资金、风控与成本（启动前请核对）</summary>
      <div className="grid" style={{ marginTop: 12 }}>
        <label>
          初始资金 / USDT
          <input
            value={cash}
            onChange={(e) => setCash(e.target.value)}
            inputMode="decimal"
          />
        </label>
        <label>
          仓位方式
          <select
            value={risk.sizing}
            onChange={(e) => setRisk({ ...risk, sizing: e.target.value })}
          >
            <option value="weight">目标权重</option>
            <option value="risk">风险预算</option>
          </select>
        </label>
        {Object.entries({
          weightPct: "目标权重 %",
          riskPct: "单笔风险 %",
          stopLossPct: "初始止损 %（0 关闭）",
          takeProfitPct: "止盈 %（0 关闭）",
          maxSymbolPct: "单标的上限 %",
          maxExposurePct: "总敞口上限 %",
          dailyLossPct: "UTC 日亏损限额 %",
          maxDrawdownPct: "累计回撤限额 %",
        }).map(([k, label]) => (
          <label key={k}>
            {label}
            <input
              value={risk[k as keyof typeof risk]}
              onChange={(e) => setRisk({ ...risk, [k]: e.target.value })}
              inputMode="decimal"
            />
          </label>
        ))}
        <label>
          最多持仓数
          <input
            type="number"
            min={1}
            max={10}
            value={risk.maxPositions}
            onChange={(e) =>
              setRisk({ ...risk, maxPositions: Number(e.target.value) })
            }
          />
        </label>
        {Object.entries({
          feeBps: "单边手续费 / bps",
          slippageBps: "单边不利滑点 / bps",
          participationPct: "历史成交量参与上限 %（0 关闭）",
        }).map(([k, label]) => (
          <label key={k}>
            {label}
            <input
              value={costs[k as keyof typeof costs]}
              onChange={(e) => setCosts({ ...costs, [k]: e.target.value })}
              inputMode="decimal"
            />
          </label>
        ))}
      </div>
      <p className="hint">
        以上是可修改的实验默认值。1 bps =
        0.01%。跳空可能超过止损预算。模拟成交不代表真实成交；模拟保护性退出不使用成交量参与约束。
      </p>
    </details>
  );
  return (
    <div className="qt">
      <style>{styles}</style>
      <header className="head">
        <div className="eyebrow">QUANT LAB / DEEPSEEK HARNESS</div>
        <div className="row between">
          <div className="row">
            <span className="titlemark">Q</span>
            <h1>量化工作台</h1>
          </div>
          <span className="badge">RESEARCH + PAPER</span>
        </div>
        <p className="tagline">把一个交易想法，变成可以核对的证据。</p>
      </header>
      <nav className="tabs" role="tablist" aria-label="量化工作台">
        {(
          [
            ["overview", "研究委托"],
            ["strategy", "策略"],
            ["data", "数据"],
            ["backtest", "回测"],
            ["paper", "模拟盘"],
            ["logs", "日志与复盘"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <div className="notice error" role="alert">
          {error}{" "}
          <button
            className="link"
            onClick={() => void refresh().catch((e) => setError(e.message))}
          >
            重新连接
          </button>
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}{" "}
          <button className="link" onClick={() => setNotice("")}>
            收起
          </button>
        </div>
      )}
      <main className="body">
        {!snap && <p className="empty">正在连接量化服务…</p>}
        {snap && tab === "overview" && (
          <>
            <ResearchWorkspace
              rpc={rpc}
              sessionId={sessionId}
              visible={visible}
              datasets={snap.datasets}
              {...(openProjectId ? { initialProjectId: openProjectId } : {})}
              onPaper={() => setTab("paper")}
              bring={bring}
              onRun={(id) => {
                chooseRun(id);
                setTab("backtest");
              }}
            />
            <details className="advanced-tools">
              <summary>高级研究工具、示例与数据管理</summary>
              <div className="card">
                <div className="card-title">
                  <h2>研究，从一个假设开始</h2>
                  <span className="badge">现货 · 只做多</span>
                </div>
                <p className="muted">
                  先用数据检验，再让规则持续模拟。每一次成交和放弃，都留下原因。
                </p>
                <div className="actions">
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void act("demo")}
                  >
                    加载合成示例
                  </button>
                  <button onClick={() => setTab("strategy")}>创建策略 →</button>
                  <button
                    onClick={() =>
                      setNotice(
                        bring(
                          "请先 qt_status，帮我把一个数字资产现货想法转化为可验证策略；先解释假设，再做回测。",
                        ) === "ok"
                          ? "已带入对话，请检查后发送。"
                          : "当前输入框不可用，请在左侧直接描述你的想法。",
                      )
                    }
                  >
                    和助手讨论 ↗
                  </button>
                </div>
                <small>示例仅用于验证流程，明确标注为合成行情。</small>
              </div>
              <div className="grid">
                {[
                  ["策略版本", snap.strategies.length],
                  ["数据快照", snap.datasets.length],
                  [
                    "已完成回测",
                    snap.runs.filter((r) => r.status === "completed").length,
                  ],
                  [
                    "运行中模拟盘",
                    snap.accounts.filter((a) => a.status === "running").length,
                  ],
                ].map(([title, n]) => (
                  <div className="stat" key={title}>
                    <small>{title}</small>
                    <div className="number">{n}</div>
                  </div>
                ))}
              </div>
              <section className="card">
                <h3>最近实验</h3>
                {snap.runs.slice(0, 3).map((r) => (
                  <div className="row between" key={r.id}>
                    <div>
                      <span className="badge">{labels[r.status]}</span>
                      <p className="mono">
                        {r.id.slice(0, 8)} · {date(r.createdAt)}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        chooseRun(r.id);
                        setTab("backtest");
                      }}
                    >
                      {r.metrics ? `${fmt(r.metrics.returnPct)}%` : "查看进度"}{" "}
                      →
                    </button>
                  </div>
                ))}
                {!snap.runs.length && (
                  <p className="hint">
                    加载数据、发布策略后，即可运行第一次历史回测。
                  </p>
                )}
              </section>
              <section className="card">
                <h3>本地数据管理</h3>
                <div className="actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(
                        "backup",
                        {},
                        (v) => download("quant-backup.json", JSON.stringify(v)),
                        false,
                      )
                    }
                  >
                    导出完整备份
                  </button>
                  <label>
                    恢复到空数据目录
                    <input
                      className="file"
                      type="file"
                      accept=".json"
                      disabled={busy}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        if (f.size > 64 * 1024 * 1024) {
                          setError("备份超过 64 MB");
                          return;
                        }
                        void f
                          .text()
                          .then((t) => {
                            let backup: unknown;
                            try {
                              backup = JSON.parse(t);
                            } catch {
                              setError("JSON 格式无效");
                              return;
                            }
                            void act("restore", { backup });
                          })
                          .catch((e) => setError(e.message));
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
                <p className="hint">
                  备份不含 Harness 登录与模型密钥；恢复不会自动启动模拟任务。
                </p>
              </section>
            </details>
          </>
        )}
        {snap && tab === "strategy" && (
          <>
            <section className="card">
              <div className="card-title">
                <h2>{editing ? "修订草稿" : "创建策略草稿"}</h2>
                <span className="badge">结构化模板</span>
              </div>
              <label>
                策略名称
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <div className="grid">
                <label>
                  策略模板
                  <select
                    value={template}
                    onChange={(e) =>
                      setTemplate(e.target.value as typeof template)
                    }
                  >
                    <option value="sma_cross">均线交叉</option>
                    <option value="breakout">区间突破</option>
                  </select>
                </label>
                <label>
                  K 线周期
                  <select
                    value={timeframe}
                    onChange={(e) => setTimeframe(e.target.value)}
                  >
                    {["1m", "15m", "1h", "1d"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                交易对（多个用英文逗号分隔，最多十个）
                <input
                  value={symbolText}
                  onChange={(e) => setSymbolText(e.target.value.toUpperCase())}
                />
              </label>
              <div className="grid">
                {(template === "sma_cross"
                  ? [
                      ["快均线周期", fast, setFast],
                      ["慢均线周期", slow, setSlow],
                    ]
                  : [
                      ["突破观察周期", entry, setEntry],
                      ["退出观察周期", exit, setExit],
                    ]
                ).map(([label, value, set]) => (
                  <label key={String(label)}>
                    {String(label)}
                    <input
                      type="number"
                      min={2}
                      value={Number(value)}
                      onChange={(e) =>
                        (set as (v: number) => void)(Number(e.target.value))
                      }
                    />
                  </label>
                ))}
              </div>
              <p className="hint">
                信号仅使用已收盘数据；回测最早下一根开盘成交。突破区间排除当前 K
                线。参数尚未经过有效性验证。
              </p>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void act<StrategyRecord>(
                    "draft",
                    {
                      ...(editing ? { id: editing.id } : {}),
                      expectedRevision: editing?.revision ?? 0,
                      name,
                      definition: {
                        template,
                        symbols: symbolText.split(",").map((x) => x.trim()),
                        interval: timeframe,
                        fast,
                        slow,
                        entryPeriod: entry,
                        exitPeriod: exit,
                      },
                    },
                    (s) => {
                      setEditing({ id: s.id, revision: s.revision });
                      setStrategyId(s.id);
                    },
                  )
                }
              >
                保存草稿
              </button>
            </section>
            <section className="card">
              <h3>策略版本</h3>
              {snap.strategies.map((s) => (
                <div className="card" key={s.id}>
                  <div className="row between">
                    <strong>{s.name}</strong>
                    <span className="badge">
                      {s.published ? "已发布" : "草稿"} · r{s.revision}
                    </span>
                  </div>
                  <small>
                    {s.definition.symbols.join(" / ")} · {s.definition.interval}{" "}
                    · {s.author === "ai" ? "AI 草拟" : "用户保存"}
                  </small>
                  <div className="actions">
                    <button onClick={() => edit(s)}>
                      {s.published ? "复制为新草稿" : "编辑"}
                    </button>
                    {!s.published && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act("publish", {
                            id: s.id,
                            expectedRevision: s.revision,
                          })
                        }
                      >
                        发布此版本
                      </button>
                    )}
                    {s.published && (
                      <button
                        onClick={() => {
                          setStrategyId(s.id);
                          setDatasetIds([]);
                          setTab("backtest");
                        }}
                      >
                        选择并回测 →
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </section>
          </>
        )}
        {snap && tab === "data" && (
          <>
            <section className="card">
              <h2>准备历史行情</h2>
              <p className="hint">
                公共行情无需交易密钥。时间输入按浏览器本地时区解释，内部统一
                UTC。每个快照只接受连续、已收盘的数据。
              </p>
              <div className="grid">
                <label>
                  交易对
                  <input
                    value={dataSymbol}
                    onChange={(e) =>
                      setDataSymbol(e.target.value.toUpperCase())
                    }
                  />
                </label>
                <label>
                  周期
                  <select
                    value={dataInterval}
                    onChange={(e) => setDataInterval(e.target.value)}
                  >
                    {["1m", "15m", "1h", "1d"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  开始时间
                  <input
                    type="datetime-local"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <label>
                  结束时间
                  <input
                    type="datetime-local"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
              </div>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void act("prepare", {
                    symbol: dataSymbol,
                    interval: dataInterval,
                    from: new Date(from).getTime(),
                    to: new Date(to).getTime(),
                  })
                }
              >
                提交公共行情下载
              </button>
              <div className="rule" />
              <label>
                或导入 CSV（最大 64 MB）
                <input
                  className="file"
                  type="file"
                  accept=".csv"
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    if (f.size > 64 * 1024 * 1024) {
                      setError("CSV 超过 64 MB");
                      return;
                    }
                    void f
                      .text()
                      .then((csv) =>
                        act("import", {
                          name: f.name,
                          symbol: dataSymbol,
                          interval: dataInterval,
                          csv,
                        }),
                      )
                      .catch((e) => setError(e.message));
                    e.target.value = "";
                  }}
                />
              </label>
              <p className="mono">time,open,high,low,close,volume</p>
              <small>
                time 为 K 线开盘的 UTC 毫秒；规则使用默认近似并明确记录来源。
              </small>
            </section>
            {snap.dataJobs.map((j) => (
              <section className="card" key={j.id}>
                <div className="row between">
                  <strong>{j.symbol}</strong>
                  <span className="badge">{labels[j.status]}</span>
                </div>
                <div className="progress">
                  <div style={{ width: `${j.progress}%` }} />
                </div>
                {j.error && <p className="down">{j.error}</p>}
                {["running", "queued"].includes(j.status) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act("cancel", { id: j.id, kind: "dataJob" })
                    }
                  >
                    取消下载
                  </button>
                )}
              </section>
            ))}
            {snap.datasets.map((d) => (
              <section className="card" key={d.id}>
                <div className="row between">
                  <h3>{d.name}</h3>
                  <span className="badge">
                    {d.synthetic ? "合成示例" : "历史数据"}
                  </span>
                </div>
                <p>
                  {d.symbol} · {d.interval} · {fmt(d.count, 0)} 根
                </p>
                <small>
                  {date(d.from)} — {date(d.to)}
                </small>
                <small>质量检查通过 · 无缺口 · 无重复</small>
                <details>
                  <summary>来源与数据身份</summary>
                  <p className="mono">
                    {d.source}
                    <br />
                    {d.hash}
                    <br />
                    规则快照：{d.ruleAsOf}
                  </p>
                  <pre>{JSON.stringify(d.rules, null, 2)}</pre>
                </details>
              </section>
            ))}
          </>
        )}
        {snap && tab === "backtest" && (
          <>
            <section className="card">
              <h2>运行历史实验</h2>
              <label>
                已发布策略
                <select
                  value={strategyId}
                  onChange={(e) => {
                    setStrategyId(e.target.value);
                    setDatasetIds([]);
                  }}
                >
                  <option value="">请选择</option>
                  {snap.strategies
                    .filter((s) => s.published)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {s.id.slice(0, 6)}
                      </option>
                    ))}
                </select>
              </label>
              <div>
                <small>每个策略交易对选择一份相同周期快照</small>
                {eligible.map((d) => (
                  <label className="choice" key={d.id}>
                    <input
                      type="checkbox"
                      checked={datasetIds.includes(d.id)}
                      onChange={(e) =>
                        setDatasetIds(
                          e.target.checked
                            ? [...datasetIds, d.id]
                            : datasetIds.filter((id) => id !== d.id),
                        )
                      }
                    />
                    {d.name} · {d.symbol}
                    {d.synthetic ? " · 合成" : ""}
                  </label>
                ))}
              </div>
              <div className="grid">
                <label>
                  评估起点（可选）
                  <input
                    type="datetime-local"
                    value={rangeFrom}
                    onChange={(e) => setRangeFrom(e.target.value)}
                  />
                </label>
                <label>
                  评估终点（可选）
                  <input
                    type="datetime-local"
                    value={rangeTo}
                    onChange={(e) => setRangeTo(e.target.value)}
                  />
                </label>
              </div>
              {configForm}
              <p className="hint">
                当前资金 {cash} USDT；权重 {risk.weightPct}%；单边费用{" "}
                {costs.feeBps} bps + 滑点 {costs.slippageBps}{" "}
                bps。完整默认值和修改入口见上方配置。划定评估起点可保留更早数据用于预热。
              </p>
              <button
                className="primary"
                disabled={busy || !strategyId || !datasetIds.length}
                onClick={() =>
                  void act<RunRecord>(
                    "backtest",
                    { strategyId, datasetIds, config: config() },
                    (r) => chooseRun(r.id),
                  )
                }
              >
                提交回测
              </button>
            </section>
            <section className="card">
              <h3>实验记录</h3>
              {snap.runs.map((r) => (
                <div key={r.id}>
                  <div className="row between">
                    <label className="row">
                      <input
                        style={{ width: "auto" }}
                        type="checkbox"
                        checked={comparison.includes(r.id)}
                        onChange={(e) =>
                          setComparison(
                            e.target.checked
                              ? [...comparison, r.id].slice(-5)
                              : comparison.filter((id) => id !== r.id),
                          )
                        }
                      />
                      <span className="mono">{r.id.slice(0, 8)}</span>
                    </label>
                    <span className="badge">{labels[r.status]}</span>
                    <button onClick={() => chooseRun(r.id)}>查看 →</button>
                  </div>
                  <div className="progress">
                    <div style={{ width: `${r.progress}%` }} />
                  </div>
                  {r.error && <p className="down">{r.error}</p>}
                  {["queued", "running"].includes(r.status) && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act("cancel", { id: r.id, kind: "run" })
                      }
                    >
                      取消任务
                    </button>
                  )}
                </div>
              ))}
            </section>
            {comparison.length > 1 && (
              <section className="card">
                <h3>实验对照</h3>
                <p className="hint">
                  比较前请核对下方各自区间、资金、数据与成本；不同口径不能用于优劣判断。
                </p>
                <div className="compare">
                  {snap.runs
                    .filter((r) => comparison.includes(r.id))
                    .map((r) => (
                      <div className="stat" key={r.id}>
                        <strong className="mono">{r.id.slice(0, 8)}</strong>
                        <p>{fmt(r.metrics?.returnPct)}%</p>
                        <small>
                          {date(r.config.from)}
                          <br />
                          {date(r.config.to)}
                          <br />
                          资金 {r.config.initialCash}
                          <br />
                          费/滑 {r.config.costs.feeBps}/
                          {r.config.costs.slippageBps} bps
                          <br />
                          数据{" "}
                          {r.datasetIds.map((v) => v.slice(0, 6)).join(", ")}
                        </small>
                      </div>
                    ))}
                </div>
              </section>
            )}
            {detail && (
              <section className="card">
                <div className="row between">
                  <h3>回测详情</h3>
                  <span className="badge">{labels[detail.status]}</span>
                </div>
                <p className="mono">{detail.id}</p>
                {detail.result && (
                  <>
                    <Curve values={detail.result.state.curve} />
                    <MetricGrid m={detail.result.metrics} />
                    <p className="hint">
                      等权买入持有：
                      {fmt(detail.result.benchmarks.buyHoldReturnPct)}
                      %；报价现金：0%。固定交易对池；交易规则为快照近似；未平仓按期末价格估值。Sharpe
                      少于 30 个日收益时不计算。
                    </p>
                    <div className="scroll">
                      <table>
                        <thead>
                          <tr>
                            {["方向", "数量", "成交价", "费用", "原因"].map(
                              (v) => (
                                <th key={v}>{v}</th>
                              ),
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {detail.result.state.fills.map((f) => (
                            <tr key={f.id}>
                              <td className={f.side === "BUY" ? "up" : "down"}>
                                {f.side}
                              </td>
                              <td>{fmt(f.quantity, 6)}</td>
                              <td>{fmt(f.price)}</td>
                              <td>{fmt(f.fee, 4)}</td>
                              <td>{f.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="actions">
                      <button
                        disabled={fillOffset === 0}
                        onClick={() =>
                          setFillOffset(Math.max(0, fillOffset - 50))
                        }
                      >
                        上一页
                      </button>
                      <button
                        disabled={detail.result.state.fills.length < 50}
                        onClick={() => setFillOffset(fillOffset + 50)}
                      >
                        下一页
                      </button>
                      <button onClick={() => showLogs(detail.id, "run")}>
                        决策日志
                      </button>
                    </div>
                    <div className="actions">
                      {(["json", "csv", "md"] as const).map((v) => (
                        <button
                          disabled={busy}
                          key={v}
                          onClick={() => void exportRun(v)}
                        >
                          导出 {v.toUpperCase()}
                        </button>
                      ))}
                      <button
                        onClick={() =>
                          setNotice(
                            bring(
                              `请 qt_run_read，读取 runId=${detail.id}，解释收益、回撤、成本和未验证假设。请引用真实指标，不把回测当作实际收益。`,
                            ) === "ok"
                              ? "已带入对话，请检查后发送。"
                              : "请在对话中提供回测 ID。",
                          )
                        }
                      >
                        请助手复盘 ↗
                      </button>
                    </div>
                  </>
                )}
                <details>
                  <summary>完整运行配置与证据身份</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        manifestHash: detail.manifestHash,
                        config: detail.config,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </section>
            )}
          </>
        )}
        {snap && tab === "paper" && (
          <>
            <MonitoringPanel
              rpc={rpc}
              sessionId={sessionId}
              visible={visible}
              bring={bring}
              onProject={(id) => {
                setOpenProjectId(id);
                setTab("overview");
              }}
            />
            <section className="card">
              <h2>创建模拟账户</h2>
              <label>
                已发布策略
                <select
                  value={strategyId}
                  onChange={(e) => setStrategyId(e.target.value)}
                >
                  <option value="">请选择</option>
                  {snap.strategies
                    .filter((s) => s.published)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {s.id.slice(0, 6)}
                      </option>
                    ))}
                </select>
              </label>
              {configForm}
              <p className="hint">
                初始资金 {cash}{" "}
                USDT，使用公共行情和本地虚拟账本。应用必须持续运行。真实下单不可用。
              </p>
              <button
                className="primary"
                disabled={busy || !strategyId}
                onClick={() =>
                  void act("account", {
                    name: `模拟账户 ${snap.accounts.length + 1}`,
                    strategyId,
                    config: config(),
                  })
                }
              >
                创建模拟账户
              </button>
            </section>
            {snap.accounts.map((a) => (
              <section className="card" key={a.id}>
                <div className="row between">
                  <h3>{a.name}</h3>
                  <span className="badge">{labels[a.status]}</span>
                </div>
                <div>
                  <small>最后有效估值权益 / USDT</small>
                  <div className="balance">
                    {fmt(a.state.curve.at(-1)?.equity ?? a.initialCash)}
                  </div>
                  <small>
                    可用现金 {fmt(a.state.cash)} ·{" "}
                    {a.lastEventAt ? date(a.lastEventAt) : "尚未开始观察"}
                  </small>
                </div>
                {a.error && <p className="down">{a.error}</p>}
                <Curve values={a.state.curve} />
                <div className="actions">
                  {a.status !== "running" && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void act("control", {
                          id: a.id,
                          expectedRevision: a.revision,
                          action: a.status === "created" ? "start" : "resume",
                        })
                      }
                    >
                      {a.status === "created" ? "启动模拟盘" : "恢复模拟盘"}
                    </button>
                  )}
                  {a.status === "running" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act("control", {
                          id: a.id,
                          expectedRevision: a.revision,
                          action: "pause",
                        })
                      }
                    >
                      暂停新观察
                    </button>
                  )}
                  {a.status !== "stopped" && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act("control", {
                          id: a.id,
                          expectedRevision: a.revision,
                          action: "stop",
                        })
                      }
                    >
                      停止并撤销意图
                    </button>
                  )}
                  {a.status !== "running" &&
                    Object.keys(a.state.positions).length > 0 && (
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() =>
                          void act("control", {
                            id: a.id,
                            expectedRevision: a.revision,
                            action: "flatten",
                          })
                        }
                      >
                        按当前行情模拟平仓
                      </button>
                    )}
                  <button onClick={() => showLogs(a.id, "account")}>
                    决策日志
                  </button>
                </div>
                <p className="hint">
                  暂停/停止会保留持仓并停止监控。恢复不补记缺口成交。保护退出每
                  10
                  秒检查报价，属于近似模拟。启动使用策略固定版本，并抓取当前交易规则。
                </p>
                {Object.entries(a.state.positions).map(([sym, p]) => (
                  <div className="row between" key={sym}>
                    <strong>{sym}</strong>
                    <span className="mono">
                      {fmt(p.quantity, 6)} · 成本 {fmt(p.cost)}
                    </span>
                  </div>
                ))}
                <details>
                  <summary>冻结配置</summary>
                  <pre>{JSON.stringify(a.config, null, 2)}</pre>
                </details>
              </section>
            ))}
          </>
        )}
        {snap && tab === "logs" && (
          <>
            <section className="card">
              <h2>每个决定，都有依据</h2>
              <div className="grid">
                <label>
                  对象类型
                  <select
                    value={logKind}
                    onChange={(e) => {
                      setLogKind(e.target.value as typeof logKind);
                      setLogId("");
                      setLogOffset(0);
                      setEvents(null);
                    }}
                  >
                    <option value="run">历史回测</option>
                    <option value="account">模拟账户</option>
                  </select>
                </label>
                <label>
                  对象
                  <select
                    value={logId}
                    onChange={(e) => {
                      setLogId(e.target.value);
                      setLogOffset(0);
                    }}
                  >
                    <option value="">请选择</option>
                    {(logKind === "run" ? snap.runs : snap.accounts).map(
                      (v) => (
                        <option key={v.id} value={v.id}>
                          {v.id.slice(0, 8)}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              </div>
              <label>
                原因码筛选（留空查看全部）
                <input
                  value={logCode}
                  onChange={(e) => {
                    setLogCode(e.target.value);
                    setLogOffset(0);
                  }}
                  placeholder="FILLED / NO_SIGNAL / LOSS_LIMIT"
                />
              </label>
              {events && (
                <>
                  <small>
                    {events.total} 条事件 · 从 {logOffset + 1} 开始
                  </small>
                  <div className="timeline">
                    {events.events.map((v) => (
                      <div className="event" key={v.id}>
                        <div className="row between">
                          <span className="badge">{v.code}</span>
                          <small>{date(v.at)}</small>
                        </div>
                        <strong>
                          {v.symbol} · {v.reason}
                        </strong>
                        <small className="mono">
                          {v.id}
                          {v.orderId ? ` / ${v.orderId}` : ""}
                        </small>
                        {v.facts && (
                          <details>
                            <summary>计算证据</summary>
                            <pre>{JSON.stringify(v.facts, null, 2)}</pre>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="actions">
                    <button
                      disabled={!logOffset}
                      onClick={() => setLogOffset(Math.max(0, logOffset - 50))}
                    >
                      上一页
                    </button>
                    <button
                      disabled={logOffset + 50 >= events.total}
                      onClick={() => setLogOffset(logOffset + 50)}
                    >
                      下一页
                    </button>
                  </div>
                </>
              )}
            </section>
            <section className="card">
              <h3>复盘记录</h3>
              {snap.reviews.map((v) => (
                <article key={v.id}>
                  <div className="row between">
                    <strong>{v.title}</strong>
                    <span className="badge">
                      {v.author === "ai" ? "AI 解释" : "用户记录"}
                    </span>
                  </div>
                  <small className="mono">run / {v.runId}</small>
                  <p className="review">{v.body}</p>
                </article>
              ))}
              {!snap.reviews.length && (
                <p className="hint">
                  在对话中请助手基于已完成回测保存复盘，事实和解释分别标识。
                </p>
              )}
            </section>
          </>
        )}
      </main>
      <footer className="foot">
        LOCAL-FIRST · SPOT ONLY · NO LIVE ORDERS
        <br />
        {snap ? `服务快照 ${date(snap.asOf)}` : "等待连接"} · 界面可见时每 5
        秒同步
      </footer>
    </div>
  );
}
