import { useCallback, useEffect, useRef, useState } from "react";
import {
  INTERVAL_MS,
  type Dataset,
  type Interval,
} from "../domain/contracts.js";
import type { EvidenceRef, ResearchProject } from "../domain/project.js";
import { call, download, type Caller } from "./api.js";
import { researchStyles } from "./research-styles.js";
import { ResearchConditionsCard, ReportReading } from "./research-cards.js";
import { PromotionPanel } from "./promotion-panel.js";
import { RobustnessResults } from "./robustness-results.js";
import {
  minimumExperiments,
  type RobustnessProtocol,
} from "../domain/robustness.js";
import {
  checkResearchDraft,
  costLabel,
  eventDescription,
  researchGuidance,
} from "../domain/research-view.js";

type Summary = Omit<ResearchProject, "experiments"> & {
  experimentCount: number;
  completedExperiments: number;
};
type Event = { sequence: number; type: string; at: string; facts: unknown };
type Detail = {
  project: ResearchProject;
  events: Event[];
  evidence: EvidenceRef[];
  datasets?: Dataset[];
  dataJobs: {
    id: string;
    symbol: string;
    status: string;
    progress: number;
    error: string;
  }[];
};
const stateLabels: Record<string, string> = {
  draft: "待确认委托",
  ready: "待执行",
  running: "执行中",
  waiting_job: "计算与数据处理中",
  waiting_agent: "Agent 正在研究",
  waiting_input: "需要处理",
  paused: "已暂停",
  completed: "已交付",
  failed: "执行失败",
  cancelled: "已取消",
};
const phases: Record<string, string> = {
  planning: "目标与计划",
  data: "数据准备",
  candidates: "开发与验证",
  selection: "候选选择",
  final: "最终检验",
  report: "研究交付",
  development: "开发期",
  validation: "验证期",
  holdout: "最终保留区间",
  stress: "成本压力",
  cost_sensitivity: "成本敏感性",
  parameter_sensitivity: "参数稳定性",
  walk_train: "滚动训练",
  walk_test: "滚动验证",
};
const date = (v: string | number) =>
  new Date(v).toLocaleString("zh-CN", { hour12: false });
const utc = (v: number) => new Date(v).toISOString().slice(0, 16);
const value = (v: unknown) =>
  v === undefined
    ? "—"
    : v === null
      ? "样本不足"
      : typeof v === "string" && Number.isFinite(Number(v))
        ? Number(v).toLocaleString("zh-CN", { maximumFractionDigits: 3 })
        : String(v);
const metricLabels: Record<string, string> = {
  "metrics.returnPct": "区间收益 %",
  "metrics.maxDrawdownPct": "最大回撤 %",
  "metrics.closedTrades": "平仓样本",
  "metrics.fees": "手续费",
  "metrics.slippage": "滑点成本",
  "metrics.sharpe": "Sharpe",
  "metrics.exposurePct": "平均敞口 %",
  "benchmarks.buyHoldReturnPct": "买入持有收益 %",
};
export function ResearchWorkspace({
  rpc,
  sessionId,
  visible,
  datasets,
  onRun,
  bring,
  initialProjectId,
  onPaper,
}: {
  rpc: Caller;
  sessionId: string;
  visible: boolean;
  datasets: Dataset[];
  onRun: (id: string) => void;
  bring: (text: string) => string;
  initialProjectId?: string;
  onPaper?: () => void;
}) {
  const [projects, setProjects] = useState<Summary[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<Detail | null>(null),
    [events, setEvents] = useState<Event[]>([]),
    [view, setView] = useState<"overview" | "experiments" | "report">(
      "overview",
    ),
    [creating, setCreating] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [health, setHealth] = useState<{
      agent: boolean;
      worker: boolean;
      storage: string;
      mode: string;
    } | null>(null),
    [checked, setChecked] = useState<EvidenceRef | null>(null);
  const [name, setName] = useState("趋势策略研究"),
    [objective, setObjective] = useState(
      "比较均线与突破策略，检查验证期和成本增加后的表现，交付有证据的研究结论。",
    ),
    [symbols, setSymbols] = useState("BTCUSDT"),
    [interval, setIntervalValue] = useState("1h"),
    [mode, setMode] = useState("agent"),
    [datasetIds, setDatasetIds] = useState<string[]>([]);
  const [parentProjectId, setParentProjectId] = useState<string | undefined>();
  const [robustness, setRobustness] = useState<
    RobustnessProtocol | undefined
  >();
  const [inheritedConfig, setInheritedConfig] = useState<
    ResearchProject["protocol"]["config"] | null
  >(null);
  const [inheritedBudget, setInheritedBudget] = useState<
    ResearchProject["protocol"]["budget"] | null
  >(null);
  const [inheritedThresholds, setInheritedThresholds] = useState<
    ResearchProject["protocol"]["thresholds"] | null
  >(null);
  const end = Math.floor(Date.now() / 3600000) * 3600000 - 3600000;
  const [from, setFrom] = useState(() => utc(end - 180 * 86400000)),
    [to, setTo] = useState(() => utc(end)),
    [experiments, setExperiments] = useState(12),
    [requests, setRequests] = useState(20),
    [minTrades, setMinTrades] = useState(10),
    [drawdown, setDrawdown] = useState("20"),
    [excess, setExcess] = useState("0"),
    [cash, setCash] = useState("10000"),
    [fee, setFee] = useState("10"),
    [slip, setSlip] = useState("5"),
    [resume, setResume] = useState(false),
    [answer, setAnswer] = useState("");
  const generation = useRef(0),
    serial = useRef(0),
    lock = useRef(false),
    submissions = useRef(new Map<string, string>()),
    cursor = useRef(0);
  useEffect(() => {
    if (initialProjectId) {
      setSelected(initialProjectId);
      setCreating(false);
      setView("overview");
    }
  }, [initialProjectId]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const listener = (event: Event) => {
      const id = (event as unknown as CustomEvent<string>).detail;
      if (typeof id === "string") {
        setSelected(id);
        setCreating(false);
      }
    };
    window.addEventListener(
      "quant-open-project",
      listener as unknown as EventListener,
    );
    return () =>
      window.removeEventListener(
        "quant-open-project",
        listener as unknown as EventListener,
      );
  }, []);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const seq = ++serial.current,
        g = generation.current;
      const [list, diagnostics, next] = await Promise.all([
        call<{ projects: Summary[]; total: number }>(
          rpc,
          sessionId,
          "project-list",
          { offset, limit: 20 },
          signal,
        ),
        call<{
          agent: boolean;
          worker: boolean;
          storage: string;
          mode: string;
        }>(rpc, sessionId, "health", {}, signal),
        selected
          ? call<Detail>(
              rpc,
              sessionId,
              "project-read",
              { id: selected, after: cursor.current },
              signal,
            )
          : Promise.resolve(null),
      ]);
      if (signal?.aborted || seq !== serial.current || g !== generation.current)
        return;
      setProjects(list.projects ?? []);
      setTotal(list.total ?? 0);
      setHealth(diagnostics);
      if (next) {
        setDetail(next);
        if (next.events.length) {
          cursor.current = Math.max(
            cursor.current,
            ...next.events.map((e) => e.sequence),
          );
          setEvents((old) =>
            [
              ...new Map(
                [...old, ...next.events].map((e) => [e.sequence, e]),
              ).values(),
            ].slice(-300),
          );
        }
      }
    },
    [rpc, sessionId, selected, offset],
  );
  useEffect(() => {
    generation.current++;
    cursor.current = 0;
    setDetail(null);
    setEvents([]);
    setChecked(null);
    setError("");
    const c = new AbortController();
    void refresh(c.signal).catch((e) => {
      if (!c.signal.aborted) setError(e.message);
    });
    return () => {
      c.abort();
      generation.current++;
    };
  }, [refresh]);
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => {
      if (!lock.current) void refresh().catch((e) => setError(e.message));
    }, 2000);
    return () => clearInterval(timer);
  }, [visible, refresh]);
  async function act<T>(
    action: string,
    input: Record<string, unknown>,
    done?: (v: T) => void,
    write = true,
  ) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const g = generation.current,
      key = JSON.stringify({ action, input });
    let sid = submissions.current.get(key);
    if (!sid) {
      sid = crypto.randomUUID();
      submissions.current.set(key, sid);
    }
    let saved = false;
    try {
      const result = await call<T>(
        rpc,
        sessionId,
        action,
        write ? { ...input, submissionId: sid } : input,
      );
      saved = true;
      if (g !== generation.current) return;
      submissions.current.delete(key);
      setNotice("操作已完成。");
      done?.(result);
      try {
        await refresh();
      } catch {
        setNotice("操作已完成，界面尚未同步，请刷新状态。");
      }
    } catch (e) {
      if (g === generation.current)
        setError(
          saved
            ? "操作已保存，请刷新查看。"
            : e instanceof Error
              ? e.message
              : "操作失败",
        );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const p = detail?.project;
  useEffect(() => {
    if (
      initialProjectId &&
      p?.id === initialProjectId &&
      p.status === "completed"
    )
      setView("report");
  }, [initialProjectId, p?.id, p?.status]);
  const guidance = p ? researchGuidance(p) : null;
  const draftCheck = checkResearchDraft(
    {
      symbols: symbols
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
      interval: interval as Interval,
      from: Date.parse(`${from}Z`),
      to: Date.parse(`${to}Z`),
      datasetIds,
      experiments,
      minTrades,
      maxBars: inheritedBudget?.maxBars ?? 100000,
      ...(robustness ? { robustness } : {}),
    },
    datasets,
  );
  useEffect(() => {
    if (checked)
      document
        .getElementById(`research-evidence-${checked.projectId}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [checked]);
  useEffect(() => {
    if (view === "report" && p?.report)
      document
        .getElementById(`research-report-${p.id}`)
        ?.scrollIntoView?.({ block: "start" });
  }, [view, p?.id, p?.report?.hash]);
  const control = (action: string) => {
    if (p)
      void act("project-control", {
        id: p.id,
        expectedRevision: p.revision,
        action,
      });
  };
  const choose = (id: string) => {
    setSelected(id);
    setCreating(false);
    setView(
      projects.find((project) => project.id === id)?.status === "completed"
        ? "report"
        : "overview",
    );
  };
  function chooseData(id: string, enabled: boolean) {
    const chosen = datasets.find((d) => d.id === id)!;
    const next = enabled
      ? [
          ...datasetIds.filter((other) => {
            const d = datasets.find((v) => v.id === other);
            return (
              d?.symbol !== chosen.symbol && d?.interval === chosen.interval
            );
          }),
          id,
        ]
      : datasetIds.filter((v) => v !== id);
    setDatasetIds(next);
    const ds = datasets.filter((d) => next.includes(d.id));
    if (ds.length) {
      setSymbols(ds.map((d) => d.symbol).join(","));
      setIntervalValue(ds[0]!.interval);
      setFrom(utc(Math.max(...ds.map((d) => d.from))));
      setTo(utc(Math.min(...ds.map((d) => d.to))));
    }
  }
  function followup(project: ResearchProject) {
    setParentProjectId(project.id);
    setName(`${project.name} · 后续`.slice(0, 100));
    setObjective(project.objective);
    setSymbols(project.protocol.symbols.join(","));
    setIntervalValue(project.protocol.interval);
    setMode(project.protocol.mode);
    setDatasetIds(project.datasetIds);
    setFrom(utc(project.protocol.from));
    setTo(utc(project.protocol.to));
    setExperiments(project.protocol.budget.experiments);
    setRequests(project.protocol.budget.modelRequests);
    setMinTrades(project.protocol.thresholds.minClosedTrades);
    setDrawdown(project.protocol.thresholds.maxDrawdownPct);
    setExcess(project.protocol.thresholds.minExcessReturnPct);
    setCash(project.protocol.config.initialCash);
    setFee(project.protocol.config.costs.feeBps);
    setSlip(project.protocol.config.costs.slippageBps);
    setInheritedConfig(project.protocol.config);
    setInheritedBudget(project.protocol.budget);
    setInheritedThresholds(project.protocol.thresholds);
    setResume(project.protocol.resumeOnRestart);
    setRobustness(project.protocol.robustness);
    setCreating(true);
  }
  function askProject(question: string) {
    if (p)
      setNotice(
        bring(`请读取研究项目 ${p.id}，依据真实实验与证据回答：${question}`) ===
          "ok"
          ? "已带入对话，请检查后发送。"
          : "请在聊天中引用项目身份。",
      );
  }
  function inspectExperiment(experimentId: string) {
    if (!p || !detail) return;
    setView("experiments");
    setChecked(null);
    const ref = detail.evidence.find(
      (f) => f.experimentId === experimentId && f.path === "metrics.returnPct",
    );
    if (ref)
      void act<EvidenceRef>(
        "project-evidence",
        { id: p.id, evidenceId: ref.id },
        setChecked,
        false,
      );
  }
  return (
    <section className="research-space" aria-label="研究委托工作空间">
      <style>{researchStyles}</style>
      <div className="row between">
        <div>
          <div className="eyebrow">RESEARCH AGENT</div>
          <h2>把研究交给 Agent</h2>
          <p className="muted">提出目标、约定预算，收到可追溯的实验与结论。</p>
        </div>
        <button
          className="primary"
          onClick={() => {
            setCreating(true);
            setParentProjectId(undefined);
            setInheritedConfig(null);
            setInheritedBudget(null);
            setInheritedThresholds(null);
            setRobustness(undefined);
            setNotice("");
          }}
        >
          新建研究委托
        </button>
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}{" "}
          <button
            className="link"
            onClick={() =>
              void refresh()
                .then(() => setError(""))
                .catch((e) => setError(e.message))
            }
          >
            刷新状态
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="hint">
          {notice}
        </p>
      )}
      {health && (
        <div className="row health">
          <span className="health-dot" />
          {health.storage === "ready"
            ? "研究数据可用"
            : "研究写入已停止，请重启"}{" "}
          <span>·</span> {health.worker ? "计算服务就绪" : "请先完成构建"}{" "}
          <span>·</span>{" "}
          {health.agent ? "Agent 执行服务已加载" : "Agent 执行服务未加载"}
          <small>本地进程运行期间持续执行</small>
        </div>
      )}
      {(creating || (!projects.length && !selected)) && (
        <form
          className="card research-create"
          onSubmit={(e) => {
            e.preventDefault();
            if (draftCheck.errors.length) {
              setError(draftCheck.errors.join("；"));
              return;
            }
            void act<ResearchProject>(
              "project-create",
              {
                name,
                objective,
                symbols: symbols
                  .split(",")
                  .map((s) => s.trim().toUpperCase())
                  .filter(Boolean),
                interval,
                from: Date.parse(`${from}Z`),
                to: Date.parse(`${to}Z`),
                datasetIds,
                mode,
                ...(robustness ? { robustness } : {}),
                budget: {
                  ...inheritedBudget,
                  experiments,
                  modelRequests: requests,
                },
                thresholds: {
                  ...inheritedThresholds,
                  minClosedTrades: minTrades,
                  maxDrawdownPct: drawdown,
                  minExcessReturnPct: excess,
                },
                config: {
                  ...(inheritedConfig ?? {}),
                  initialCash: cash,
                  costs: {
                    ...inheritedConfig?.costs,
                    feeBps: fee,
                    slippageBps: slip,
                  },
                },
                resumeOnRestart: resume,
                ...(parentProjectId ? { parentProjectId } : {}),
              },
              (result) => choose(result.id),
            );
          }}
        >
          <h3>这次想验证什么</h3>
          <p className="hint">
            先描述问题，再核对条件。系统在本次预算内完成比较，交付结论、反证和下一步。
          </p>
          <div className="actions" aria-label="研究起点">
            <button
              type="button"
              onClick={() => {
                setName("趋势策略比较");
                setObjective(
                  "比较均线交叉与区间突破，依据验证期、最终区间和成本压力结果判断是否值得模拟观察。",
                );
              }}
            >
              比较两类策略
            </button>
            <button
              type="button"
              onClick={() => {
                setName("趋势策略成本检验");
                setObjective(
                  "比较均线交叉与区间突破，重点核查手续费和滑点增加后是否仍满足门槛，解释成本检验中的反证。",
                );
              }}
            >
              检验成本影响
            </button>
            <button
              type="button"
              disabled={!p?.report}
              onClick={() => {
                setCreating(false);
                setView("report");
              }}
            >
              解释已有结果
            </button>
          </div>
          {parentProjectId && (
            <p className="hint">
              将建立后续委托，保留原研究与预算记录。复用已经揭示的最终区间会被标记，不能作为新的盲测证据。
              沿用原委托的仓位风险、成交量参与率与高级预算配置；当前页面会重新比较两类默认模板。
            </p>
          )}
          <label>
            研究名称
            <input
              value={name}
              required
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            研究目标
            <textarea
              value={objective}
              required
              minLength={5}
              maxLength={4000}
              onChange={(e) => setObjective(e.target.value)}
            />
          </label>
          <div className="grid">
            <label>
              交易对，以逗号分隔
              <input
                value={symbols}
                onChange={(e) => setSymbols(e.target.value)}
              />
            </label>
            <label>
              周期
              <select
                value={interval}
                onChange={(e) => {
                  const next = e.target.value as Interval,
                    step = INTERVAL_MS[next];
                  setIntervalValue(next);
                  setFrom(
                    utc(Math.floor(Date.parse(`${from}Z`) / step) * step),
                  );
                  setTo(utc(Math.floor(Date.now() / step) * step - step));
                  setDatasetIds([]);
                }}
              >
                {["1m", "15m", "1h", "1d"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            执行方式
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="agent">Agent 自主比较、追加候选与解释</option>
              <option value="protocol">固定协议自动执行（免模型）</option>
            </select>
          </label>
          <small>
            {mode === "agent"
              ? "沿用当前 Harness 模型配置，Agent 在预算内决定研究下一步。"
              : "按固定规则完成两个模板及最终检验，报告会明确标注未使用模型规划。"}
          </small>
          <div className="draft-check">
            <label className="choice">
              <input
                type="checkbox"
                checked={!!robustness}
                onChange={(e) => {
                  const next = e.target.checked
                    ? {
                        version: 1 as const,
                        costMultipliers: [1.5, 2, 3],
                        parameterShiftPct: 20,
                        walkForwardFolds: 3,
                        minPassRatePct: 50,
                      }
                    : undefined;
                  setRobustness(next);
                  if (next)
                    setExperiments((n) =>
                      Math.max(n, minimumExperiments(2, next)),
                    );
                }}
              />
              启用稳健性研究（归因、成本情景、参数邻域与滚动验证）
            </label>
            <p className="hint">
              启用后将提高所需实验预算，全部规则在启动前冻结；不会在最终区间上追加寻参。
            </p>
            {robustness && (
              <div className="grid">
                <label>
                  验证期成本倍率
                  <select
                    value={robustness.costMultipliers.join(",")}
                    onChange={(e) =>
                      setRobustness({
                        ...robustness,
                        costMultipliers: e.target.value.split(",").map(Number),
                      })
                    }
                  >
                    <option value="1.5,2,3">1.5 / 2 / 3 倍</option>
                    <option value="2,3,4">2 / 3 / 4 倍</option>
                  </select>
                </label>
                <label>
                  参数邻域
                  <select
                    value={robustness.parameterShiftPct}
                    onChange={(e) =>
                      setRobustness({
                        ...robustness,
                        parameterShiftPct: Number(e.target.value),
                      })
                    }
                  >
                    {[10, 20, 30].map((v) => (
                      <option key={v} value={v}>
                        ±{v}%
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  滚动窗口
                  <select
                    value={robustness.walkForwardFolds}
                    onChange={(e) =>
                      setRobustness({
                        ...robustness,
                        walkForwardFolds: Number(e.target.value),
                      })
                    }
                  >
                    {[2, 3, 4].map((v) => (
                      <option key={v} value={v}>
                        {v} 个窗口
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  每类诊断最低通过率 %
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={robustness.minPassRatePct}
                    onChange={(e) =>
                      setRobustness({
                        ...robustness,
                        minPassRatePct: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <p>
                  当前委托至少需要 {minimumExperiments(2, robustness)}{" "}
                  个实验。通过率是本次协议门槛，不代表盈利概率。
                </p>
              </div>
            )}
          </div>
          <details>
            <summary>数据、评估门槛与预算</summary>
            <div className="research-fields">
              <div className="grid">
                <label>
                  开始（UTC）
                  <input
                    type="datetime-local"
                    value={from}
                    required
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </label>
                <label>
                  结束（UTC，已收盘）
                  <input
                    type="datetime-local"
                    value={to}
                    required
                    onChange={(e) => setTo(e.target.value)}
                  />
                </label>
              </div>
              <p className="hint">
                未选择缓存快照时自动准备公共行情。时间按60%开发、20%验证、20%最终保留区间冻结。
              </p>
              {datasets.map((d) => (
                <label className="choice" key={d.id}>
                  <input
                    type="checkbox"
                    checked={datasetIds.includes(d.id)}
                    onChange={(e) => chooseData(d.id, e.target.checked)}
                  />
                  <span>
                    {d.symbol} · {d.interval} ·{" "}
                    {d.synthetic ? "合成演示" : "历史行情"}
                    <small>
                      {date(d.from)} — {date(d.to)}
                    </small>
                  </span>
                </label>
              ))}
              <div className="grid">
                <label>
                  最多实验数
                  <input
                    type="number"
                    min={minimumExperiments(2, robustness)}
                    max={48}
                    value={experiments}
                    onChange={(e) => setExperiments(Number(e.target.value))}
                  />
                </label>
                <label>
                  最多模型请求
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={requests}
                    onChange={(e) => setRequests(Number(e.target.value))}
                  />
                </label>
                <label>
                  最少平仓样本
                  <input
                    type="number"
                    min={1}
                    value={minTrades}
                    onChange={(e) => setMinTrades(Number(e.target.value))}
                  />
                </label>
                <label>
                  最大回撤 %
                  <input
                    value={drawdown}
                    onChange={(e) => setDrawdown(e.target.value)}
                  />
                </label>
                <label>
                  最低超额收益 %
                  <input
                    value={excess}
                    onChange={(e) => setExcess(e.target.value)}
                  />
                </label>
                <label>
                  研究资金 USDT
                  <input
                    value={cash}
                    onChange={(e) => setCash(e.target.value)}
                  />
                </label>
                <label>
                  手续费 bps
                  <input value={fee} onChange={(e) => setFee(e.target.value)} />
                  <small>{costLabel(fee)}，买入、卖出分别收取</small>
                </label>
                <label>
                  滑点 bps
                  <input
                    value={slip}
                    onChange={(e) => setSlip(e.target.value)}
                  />
                  <small>{costLabel(slip)}，每次成交按不利方向调整</small>
                </label>
              </div>
              <label className="choice">
                <input
                  type="checkbox"
                  checked={resume}
                  onChange={(e) => setResume(e.target.checked)}
                />
                允许宿主重启后在原授权有效期和预算内继续研究
              </label>
            </div>
          </details>
          <div
            className="draft-check"
            aria-label="委托预检查"
            aria-live="polite"
          >
            <strong>开始前核对</strong>
            <p>
              系统预填资金、成本和门槛；请按实际研究假设修改。时间统一为 UTC。
            </p>
            {draftCheck.errors.map((s) => (
              <p className="down" key={s}>
                {s}
              </p>
            ))}
            {draftCheck.warnings.map((s) => (
              <p className="hint" key={s}>
                {s}
              </p>
            ))}
            {!draftCheck.errors.length && (
              <p>
                预计每交易对 {draftCheck.bars.toLocaleString("zh-CN")}{" "}
                根K线；当前候选与所选检验至少需要
                {minimumExperiments(2, robustness)}个实验。
              </p>
            )}
          </div>
          <p className="hint">
            当前支持均线交叉与区间突破。会完成候选开发/验证、最终保留区间和双倍成本检验。先生成可核对的委托，再确认启动。
          </p>
          <div className="actions">
            <button
              className="primary"
              type="submit"
              disabled={busy || draftCheck.errors.length > 0}
            >
              生成研究委托
            </button>
            {creating && (
              <button type="button" onClick={() => setCreating(false)}>
                收起
              </button>
            )}
          </div>
        </form>
      )}
      {projects.length > 0 && (
        <div className="project-list" role="list" aria-label="研究项目">
          {projects.map((item) => (
            <button
              role="listitem"
              aria-pressed={item.id === selected}
              className={`project-tile ${item.id === selected ? "selected" : ""}`}
              key={item.id}
              onClick={() => choose(item.id)}
            >
              <span className="badge">{stateLabels[item.status]}</span>
              <strong>{item.name}</strong>
              <small>
                {item.completedExperiments}/{item.protocol.budget.experiments}{" "}
                个实验 · {item.protocol.mode === "agent" ? "Agent" : "固定协议"}
              </small>
              <span className="hint">{item.reason}</span>
            </button>
          ))}
        </div>
      )}
      {total > 20 && (
        <div className="actions">
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            上一页项目
          </button>
          <small>
            {offset + 1}–{Math.min(total, offset + 20)} / {total}
          </small>
          <button
            disabled={offset + 20 >= total}
            onClick={() => setOffset(offset + 20)}
          >
            下一页项目
          </button>
        </div>
      )}
      {p && (
        <div className="project-detail">
          <div className="card">
            <div className="row between">
              <div>
                <span className="badge">{stateLabels[p.status]}</span>
                <h2>{p.name}</h2>
              </div>
              <small>
                {p.protocol.mode === "agent" ? "Harness Agent" : "固定研究协议"}
              </small>
            </div>
            <p>{p.objective}</p>
            {p.protocol.simulationSource && (
              <div className="notice">
                <strong>来自模拟事实复盘的关联研究</strong>
                <p>
                  保留来源账户与冻结复盘身份；研究不会修改原模拟账户。请重新核对数据区间、样本和预算。
                </p>
                <button
                  onClick={() =>
                    setNotice(
                      bring(
                        `请用 qt_monitor_read 的 id=${p.protocol.simulationSource!.reviewId} 读取本研究的来源事实复盘，并核对未解决问题。`,
                      ) === "ok"
                        ? "已带入对话，请检查后发送。"
                        : "请在聊天中引用复盘身份。",
                    )
                  }
                >
                  核对来源复盘
                </button>
              </div>
            )}
            <p className={p.error ? "down" : "muted"}>{p.reason}</p>
            {guidance && (
              <div className="research-guidance" role="status">
                <strong>{guidance.now}</strong>
                <p>{guidance.next}</p>
                {p.error && p.error !== p.reason && (
                  <p className="down">{p.error}</p>
                )}
                {p.protocol.parentProjectId && (
                  <small>
                    关联自此前研究；原实验与区间使用记录保留，预算独立核对。
                  </small>
                )}
              </div>
            )}
            <details open={!p.report}>
              <summary>研究进度与预算</summary>
              <div className="research-fields">
                <div className="research-stages">
                  {[
                    ...(p.protocol.mode === "agent" ? ["planning"] : []),
                    "data",
                    "candidates",
                    "selection",
                    "final",
                    "report",
                  ].map((stage) => (
                    <span
                      key={stage}
                      className={p.stage === stage ? "active" : ""}
                    >
                      {phases[stage]}
                    </span>
                  ))}
                </div>
                <div className="grid">
                  <div className="stat">
                    <small>已完成实验 / 实验预算</small>
                    <div className="number">
                      {
                        p.experiments.filter((e) => e.status === "completed")
                          .length
                      }{" "}
                      / {p.protocol.budget.experiments}
                    </div>
                    <small>已使用 {p.budgetUsed.experiments} 个实验额度</small>
                  </div>
                  <div className="stat">
                    <small>模型请求 / 请求预算</small>
                    <div className="number">
                      {p.budgetUsed.modelRequests} /{" "}
                      {p.protocol.budget.modelRequests}
                    </div>
                    <small>
                      计算 {(p.budgetUsed.computeMs / 1000).toFixed(1)} 秒 ·
                      用量
                      {p.budgetUsed.usageComplete ? "已报告" : "存在缺失"}
                    </small>
                  </div>
                </div>
                {detail.dataJobs
                  .filter((j) => ["queued", "running"].includes(j.status))
                  .map((j) => (
                    <div key={j.id}>
                      <small>
                        {j.symbol} 数据准备 {j.progress}%
                      </small>
                      <progress value={j.progress} max={100} />
                    </div>
                  ))}
              </div>
            </details>
            <div className="actions">
              {p.status === "draft" && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => control("start")}
                >
                  确认协议并启动研究
                </button>
              )}
              {["ready", "running", "waiting_job", "waiting_agent"].includes(
                p.status,
              ) && (
                <button disabled={busy} onClick={() => control("pause")}>
                  暂停研究
                </button>
              )}
              {guidance?.resume && (
                <button disabled={busy} onClick={() => control("resume")}>
                  恢复研究
                </button>
              )}
              {!["completed", "failed", "cancelled"].includes(p.status) && (
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => control("cancel")}
                >
                  取消研究
                </button>
              )}
              <button
                onClick={() =>
                  askProject("请解释当前进度、阻塞原因与可执行的下一步。")
                }
              >
                带入对话
              </button>
              {[
                "completed",
                "cancelled",
                "failed",
                "waiting_input",
                "paused",
              ].includes(p.status) && (
                <button onClick={() => followup(p)}>新建后续研究</button>
              )}
            </div>
            <details open={p.status === "draft"}>
              <summary>本次研究条件与数据来源</summary>
              <ResearchConditionsCard
                project={p}
                datasets={detail.datasets ?? datasets}
              />
            </details>
            <details open={p.status === "draft"}>
              <summary>冻结协议与授权范围</summary>
              <div className="research-fields">
                <p>
                  {p.protocol.symbols.join(" / ")} · {p.protocol.interval} ·{" "}
                  {date(p.protocol.from)} — {date(p.protocol.to)}
                </p>
                <p>
                  最多 {p.protocol.budget.experiments} 个实验、
                  {p.protocol.budget.modelRequests} 次模型请求、
                  {p.protocol.budget.computeSeconds} 秒计算；授权{" "}
                  {p.protocol.budget.hours} 小时。
                </p>
                <p>
                  门槛：平仓不少于 {p.protocol.thresholds.minClosedTrades}{" "}
                  笔、回撤不超过 {p.protocol.thresholds.maxDrawdownPct}
                  %、相对买入持有超额收益至少{" "}
                  {p.protocol.thresholds.minExcessReturnPct}%。压力成本为{" "}
                  {p.protocol.thresholds.stressMultiplier} 倍。
                </p>
                <p>
                  研究资金 {p.protocol.config.initialCash} USDT；手续费{" "}
                  {p.protocol.config.costs.feeBps} bps；滑点{" "}
                  {p.protocol.config.costs.slippageBps}{" "}
                  bps。仓位与风险参数保存在完整协议中。
                </p>
                <small>
                  最终候选冻结后揭示保留区间。研究启动不会启动模拟盘。
                </small>
                <pre>
                  {JSON.stringify(
                    {
                      ranges: p.ranges,
                      risk: p.protocol.config.risk,
                      protocolHash: p.protocolHash,
                    },
                    null,
                    2,
                  )}
                </pre>
              </div>
            </details>
          </div>
          {p.status === "waiting_input" && guidance?.answer && (
            <form
              className="card"
              onSubmit={(e) => {
                e.preventDefault();
                void act(
                  "project-answer",
                  { id: p.id, expectedRevision: p.revision, text: answer },
                  () => setAnswer(""),
                );
              }}
            >
              <h3>需要你的信息</h3>
              <p>{p.reason}</p>
              <label>
                补充信息
                <textarea
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  required
                  maxLength={3000}
                />
              </label>
              <button type="submit" disabled={busy}>
                提交补充并继续
              </button>
              <small>补充信息不会改变已冻结的市场、风险门槛或预算。</small>
            </form>
          )}
          <div className="actions">
            {(["overview", "experiments", "report"] as const).map((tab) => (
              <button
                aria-pressed={view === tab}
                key={tab}
                onClick={() => setView(tab)}
              >
                {tab === "overview"
                  ? "研究时间线"
                  : tab === "experiments"
                    ? "实验与证据"
                    : "研究报告"}
              </button>
            ))}
          </div>
          {view === "overview" && (
            <section className="card">
              <h3>每一步都有记录</h3>
              <div className="timeline">
                {events
                  .slice(-30)
                  .reverse()
                  .map((event) => (
                    <div className="event" key={event.sequence}>
                      <strong>{eventLabels[event.type] ?? event.type}</strong>
                      <small>{date(event.at)}</small>
                      <p>{eventDescription(event.type, event.facts, p)}</p>
                      <details>
                        <summary>事件明细</summary>
                        <pre>{JSON.stringify(event.facts, null, 2)}</pre>
                      </details>
                    </div>
                  ))}
              </div>
            </section>
          )}
          {view === "experiments" && (
            <section className="card">
              <h3>实验矩阵</h3>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>候选 / 阶段</th>
                      <th>状态</th>
                      <th>收益 %</th>
                      <th>回撤 %</th>
                      <th>平仓</th>
                      <th>评估</th>
                      <th>证据</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.experiments.map((e) => (
                      <tr key={e.id}>
                        <td>
                          {
                            p.candidates.find((c) => c.id === e.candidateId)
                              ?.name
                          }
                          <br />
                          <small>
                            {phases[e.phase]}
                            {e.diagnostic?.fold !== undefined
                              ? ` · 窗口${e.diagnostic.fold + 1}`
                              : ""}
                            {e.diagnostic?.multiplier
                              ? ` · ${e.diagnostic.multiplier}倍`
                              : ""}
                          </small>
                        </td>
                        <td>
                          {
                            {
                              planned: "待执行",
                              queued: "排队中",
                              running: "计算中",
                              completed: "完成",
                              failed: "失败",
                              cancelled: "取消",
                            }[e.status]
                          }
                        </td>
                        <td>{value(e.metrics?.returnPct)}</td>
                        <td>{value(e.metrics?.maxDrawdownPct)}</td>
                        <td>{value(e.metrics?.closedTrades)}</td>
                        <td>
                          {e.evaluation
                            ? {
                                pass: "通过",
                                fail: "未通过",
                                insufficient: "样本不足",
                              }[e.evaluation.verdict]
                            : "—"}
                        </td>
                        <td>
                          <button onClick={() => onRun(e.runId)}>
                            查看计算
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {p.experiments
                .filter((e) => e.evaluation?.reasons.length || e.error)
                .map((e) => (
                  <p className="hint" key={e.id}>
                    {phases[e.phase]} ·{" "}
                    {e.evaluation?.reasons.map((r) => r.message).join("；") ??
                      e.error}
                  </p>
                ))}
              <details>
                <summary>核对指标证据（{detail.evidence.length} 项）</summary>
                <div className="evidence-grid">
                  {detail.evidence.map((ref) => (
                    <button
                      key={ref.id}
                      onClick={() =>
                        void act<EvidenceRef>(
                          "project-evidence",
                          { id: p.id, evidenceId: ref.id },
                          setChecked,
                          false,
                        )
                      }
                    >
                      <small>
                        {
                          phases[
                            p.experiments.find((e) => e.id === ref.experimentId)
                              ?.phase ?? "development"
                          ]
                        }{" "}
                        · {ref.runId.slice(0, 8)}
                      </small>
                      <span>
                        {metricLabels[ref.path] ?? ref.path}：{value(ref.value)}
                      </span>
                    </button>
                  ))}
                </div>
              </details>
              {checked && (
                <div
                  className="notice"
                  role="status"
                  id={`research-evidence-${p.id}`}
                >
                  <strong>证据身份与数值已核对</strong>
                  <p>
                    {metricLabels[checked.path] ?? checked.path}：
                    {value(checked.value)}
                  </p>
                  <small>
                    Run {checked.runId} · {date(checked.from)} —{" "}
                    {date(checked.to)}
                  </small>
                  <details>
                    <summary>完整证据引用</summary>
                    <pre>{JSON.stringify(checked, null, 2)}</pre>
                  </details>
                </div>
              )}
            </section>
          )}
          {view === "report" && (
            <section className="card" id={`research-report-${p.id}`}>
              {p.report ? (
                <>
                  <span className="badge">
                    {p.report.synthetic
                      ? "合成数据流程验证"
                      : p.report.conclusion === "supported"
                        ? "满足本协议门槛"
                        : p.report.conclusion === "rejected"
                          ? "假设未通过"
                          : "证据不足"}
                  </span>
                  <h3>{p.report.summary}</h3>
                  <ReportReading
                    project={p}
                    onExperiment={inspectExperiment}
                    onFollowup={() => followup(p)}
                    onQuestion={askProject}
                  />
                  {p.report.diagnostics && (
                    <RobustnessResults
                      project={p}
                      onExperiment={inspectExperiment}
                      onEvidence={(ref) => {
                        setView("experiments");
                        setChecked(null);
                        void act<EvidenceRef>(
                          "project-evidence",
                          { id: p.id, evidenceId: ref.id },
                          setChecked,
                          false,
                        );
                      }}
                    />
                  )}
                  <div className="actions">
                    <button
                      onClick={() =>
                        download(
                          `research-${p.id}.md`,
                          p.report!.markdown,
                          "text/markdown",
                        )
                      }
                    >
                      导出研究报告
                    </button>
                    <button
                      onClick={() =>
                        void act<unknown>(
                          "project-export",
                          { id: p.id },
                          (data) =>
                            download(
                              `research-${p.id}.json`,
                              JSON.stringify(data, null, 2),
                            ),
                          false,
                        )
                      }
                    >
                      导出完整研究
                    </button>
                  </div>
                  {p.report.analyses.map((a, i) => (
                    <div className="review" key={i}>
                      <small>
                        {a.kind === "interpretation" ? "AI解释" : "待验证假设"}
                      </small>
                      <p>{a.text}</p>
                      <small>
                        证据{" "}
                        {a.evidenceIds.map((id) => id.slice(0, 8)).join(" · ")}
                      </small>
                    </div>
                  ))}
                  <h3>结论的证据</h3>
                  {p.report.facts
                    .filter((f) =>
                      [
                        "metrics.returnPct",
                        "metrics.maxDrawdownPct",
                        "metrics.closedTrades",
                      ].includes(f.path),
                    )
                    .map((f) => (
                      <button
                        className="evidence-row"
                        key={f.id}
                        onClick={() => {
                          setView("experiments");
                          void act<EvidenceRef>(
                            "project-evidence",
                            { id: p.id, evidenceId: f.id },
                            setChecked,
                            false,
                          );
                        }}
                      >
                        <span>
                          {
                            phases[
                              p.experiments.find((e) => e.id === f.experimentId)
                                ?.phase ?? "development"
                            ]
                          }{" "}
                          · {metricLabels[f.path]}
                        </span>
                        <strong>{value(f.value)} ↗</strong>
                      </button>
                    ))}
                  {p.report.conclusion === "supported" &&
                    !p.report.synthetic && (
                      <PromotionPanel
                        key={p.id}
                        project={p}
                        rpc={rpc}
                        sessionId={sessionId}
                        busy={busy}
                        {...(onPaper ? { onPaper } : {})}
                        onApprove={(input) =>
                          void act("project-approve", input, () =>
                            setNotice(
                              "新模拟账户已创建，尚未启动；请前往模拟盘核对。",
                            ),
                          )
                        }
                      />
                    )}
                </>
              ) : (
                <p className="empty">
                  研究完成最终检验后交付报告。未通过或证据不足也会如实交付。
                </p>
              )}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
const eventLabels: Record<string, string> = {
  created: "研究委托已生成",
  start: "用户已授权研究",
  data_ready: "数据已核对",
  data_submitted: "已提交数据准备",
  dataset_bound: "已绑定数据快照",
  waiting_data: "等待数据任务",
  experiment_submitted: "已提交实验",
  experiment_complete: "实验已完成",
  experiment_failed: "实验执行失败",
  candidates_complete: "候选开发与验证已完成",
  selection_frozen: "最终候选已冻结",
  final_complete: "最终检验已完成",
  completed: "研究报告已交付",
  agent_dispatched: "Agent 接手下一步",
  agent_action_complete: "Agent 已提交下一步",
  analysis_saved: "已保存有证据的解释",
  candidate_added: "按证据追加候选",
  model_request: "模型请求已计入预算",
  model_usage: "模型用量已结算",
  pause: "用户已暂停研究",
  resume: "用户已恢复研究",
  cancel: "用户已取消研究",
  attention: "需要处理",
  agent_failed: "Agent 执行需要处理",
  outcome_unknown: "上次执行结果待核对",
  answer_received: "已收到补充信息",
  restart: "宿主恢复核对",
  paper_approved: "用户已确认模拟配置",
  question: "需要补充信息",
};
