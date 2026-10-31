import type { EvidenceRef, ResearchProject } from "../domain/project.js";

const display = (v: string | number | null) =>
  v === null
    ? "样本不足"
    : Number(v).toLocaleString("zh-CN", { maximumFractionDigits: 4 });
export function RobustnessResults({
  project,
  onExperiment,
  onEvidence,
}: {
  project: ResearchProject;
  onExperiment: (id: string) => void;
  onEvidence: (ref: EvidenceRef) => void;
}) {
  const report = project.report!,
    d = report.diagnostics!;
  const cost = d.rows
    .filter((r) => r.multiplier !== undefined)
    .sort((a, b) => a.multiplier! - b.multiplier!);
  const low = Math.min(0, ...cost.map((r) => Number(r.returnPct))),
    high = Math.max(0, ...cost.map((r) => Number(r.returnPct)));
  const maxCost = Math.max(1, ...cost.map((r) => r.multiplier!));
  const y = (value: number) => 120 - ((value - low) / (high - low || 1)) * 100;
  const x = (value: number) => 35 + ((value - 1) / (maxCost - 1 || 1)) * 400;
  const points = cost
    .map((r) => `${x(r.multiplier!)},${y(Number(r.returnPct))}`)
    .join(" ");
  const evidence = (path: string, value: string | number | null) => {
    const ref = report.facts.find(
      (f) => f.runId === d.attribution.runId && f.path === path,
    );
    return (
      <button disabled={!ref} onClick={() => ref && onEvidence(ref)}>
        {display(value)}
        {ref ? " ↗" : ""}
      </button>
    );
  };
  const rows = (values: typeof d.rows) => (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>情景 / 候选</th>
            <th>收益 %</th>
            <th>回撤 %</th>
            <th>平仓</th>
            <th>评估与证据</th>
          </tr>
        </thead>
        <tbody>
          {values.map((r) => (
            <tr key={r.experimentId}>
              <td>
                {r.multiplier !== undefined
                  ? `${r.multiplier}倍成本`
                  : (r.parameter ??
                    (r.fold !== undefined
                      ? `窗口 ${r.fold + 1} · ${r.candidateName}`
                      : "原始参数"))}
                <small className="diagnostic-range">
                  {new Date(r.from).toISOString().slice(0, 16)} —{" "}
                  {new Date(r.to).toISOString().slice(0, 16)} UTC
                </small>
              </td>
              <td>{display(r.returnPct)}</td>
              <td>{display(r.maxDrawdownPct)}</td>
              <td>{r.closedTrades}</td>
              <td>
                <button onClick={() => onExperiment(r.experimentId)}>
                  {{
                    pass: "满足门槛",
                    fail: "未通过",
                    insufficient: "证据不足",
                  }[r.verdict] ?? r.verdict}{" "}
                  ↗
                </button>
                {r.reasons.length > 0 && (
                  <small className="diagnostic-range">
                    {r.reasons.join("；")}
                  </small>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <section className="diagnostic-results" aria-label="稳健性研究结果">
      <h3>稳健性研究</h3>
      <p>
        每类诊断至少 {project.protocol.robustness!.minPassRatePct}%
        满足协议门槛。通过率不是盈利概率。
      </p>
      <div className="report-checks">
        {d.checks.map((c) => (
          <div className="draft-check" key={c.phase}>
            <strong>{c.name}</strong>
            <p>
              {c.pass} / {c.total} 满足门槛 ·{" "}
              {
                { pass: "通过", fail: "未通过", insufficient: "证据不足" }[
                  c.verdict
                ]
              }
            </p>
          </div>
        ))}
      </div>
      <h3>成本敏感性 · 验证期</h3>
      <p className="hint">
        基础成本与预先冻结的情景逐项重放，包含仓位和风险触发的变化；不推断未测费率。
      </p>
      <svg
        className="chart"
        viewBox="0 0 480 155"
        role="img"
        aria-label="验证期成本倍率与收益对照"
      >
        <line
          x1="35"
          y1={y(0)}
          x2="435"
          y2={y(0)}
          stroke="currentColor"
          opacity=".3"
        />
        <polyline
          points={points}
          fill="none"
          stroke="#81e5ba"
          strokeWidth="2"
        />
        {cost.map((r) => (
          <g key={r.experimentId}>
            <circle
              cx={x(r.multiplier!)}
              cy={y(Number(r.returnPct))}
              r="3"
              fill="#81e5ba"
            />
            <text
              x={x(r.multiplier!)}
              y="145"
              textAnchor="middle"
              fill="currentColor"
              fontSize="11"
            >
              {r.multiplier}×
            </text>
          </g>
        ))}
        <text x="2" y="15" fill="currentColor" fontSize="10">
          {display(high)}%
        </text>
        <text x="2" y="127" fill="currentColor" fontSize="10">
          {display(low)}%
        </text>
      </svg>
      {rows(cost)}
      <h3>参数稳定性 · 验证期</h3>
      <p className="hint">
        均线只扰动慢周期，突破只扰动入场回看周期；其他规则保持原配置。扰动取整且至少一单位，边界裁剪及重复点不重复计为新证据。
      </p>
      {rows(
        d.rows
          .filter(
            (r) =>
              r.phase === "validation" || r.phase === "parameter_sensitivity",
          )
          .map((r) => {
            if (r.phase !== "validation") return r;
            const { multiplier, ...base } = r;
            return base;
          }),
      )}
      <h3>滚动验证 · 初始候选池</h3>
      <p className="hint">
        每窗先按训练门槛、训练收益和候选身份选定策略，再检验紧随其后的区间。每窗独立初始化资金，所有窗口均在最终保留区间之前。
      </p>
      {rows(d.rows.filter((r) => r.phase === "walk_test"))}
      <details>
        <summary>核对各窗口的训练实验</summary>
        {rows(d.rows.filter((r) => r.phase === "walk_train"))}
      </details>
      <h3>最终区间收益归因</h3>
      <p className="hint">
        月度为 UTC
        月末估值差（边界时点计入前月），包含持仓浮盈亏；点击数值核对来源。
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>UTC月份</th>
              <th>期初权益</th>
              <th>期末权益</th>
              <th>盈亏 USDT</th>
              <th>收益 %</th>
            </tr>
          </thead>
          <tbody>
            {d.attribution.data.months.map((m, i) => (
              <tr key={m.month}>
                <td>{m.month}</td>
                {(
                  ["startEquity", "endEquity", "pnl", "returnPct"] as const
                ).map((key) => (
                  <td key={key}>
                    {evidence(`attribution.months.${i}.${key}`, m[key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>交易对</th>
              <th>含期末市值盈亏 USDT</th>
              <th>手续费 USDT</th>
              <th>平仓</th>
            </tr>
          </thead>
          <tbody>
            {d.attribution.data.symbols.map((s, i) => (
              <tr key={s.symbol}>
                <td>{s.symbol}</td>
                {(["pnl", "fees", "closedTrades"] as const).map((key) => (
                  <td key={key}>
                    {evidence(`attribution.symbols.${i}.${key}`, s[key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        最大盈利交易占已平仓盈利净收益：
        {d.attribution.data.topTradeSharePct === null ? (
          "无盈利平仓样本"
        ) : (
          <>
            {evidence(
              "attribution.topTradeSharePct",
              d.attribution.data.topTradeSharePct,
            )}
            %
          </>
        )}
      </p>
      <p className="hint">
        该比例不包含亏损交易和未实现盈亏，不能解释为占账户总利润的比例。
      </p>
    </section>
  );
}
