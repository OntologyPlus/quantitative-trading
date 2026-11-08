// Visual summaries for research-lab results. Raw JSON stays available below.
import type { ReactNode } from "react";
type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN);
const f = (v: unknown, d = 2) => {
  const n = num(v);
  return Number.isFinite(n) ? n.toLocaleString("zh-CN", { maximumFractionDigits: d, minimumFractionDigits: d }) : "—";
};
const tone = (v: unknown) => (num(v) > 0 ? "up" : num(v) < 0 ? "down" : "");
const day = (ms: unknown) => new Date(num(ms)).toISOString().slice(0, 10);

function Line({ values, label, height = 120 }: { values: number[]; label: string; height?: number }) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return null;
  const lo = Math.min(...v),
    hi = Math.max(...v),
    span = hi - lo || 1;
  const pts = values
    .map((x, i) => (Number.isFinite(x) ? `${((i / (values.length - 1)) * 480).toFixed(1)},${(height - 8 - ((x - lo) / span) * (height - 16)).toFixed(1)}` : ""))
    .filter(Boolean)
    .join(" ");
  const zero = lo < 0 && hi > 0 ? height - 8 - ((0 - lo) / span) * (height - 16) : null;
  return (
    <div>
      <div className="row between">
        <small>{label}</small>
        <small>
          {f(lo)} — {f(hi)}
        </small>
      </div>
      <svg className="chart" viewBox={`0 0 480 ${height}`} preserveAspectRatio="none" role="img" aria-label={label} style={{ height }}>
        {zero !== null && <path d={`M0 ${zero}H480`} stroke="#3a4552" strokeDasharray="3 4" />}
        <polyline points={pts} fill="none" stroke="#81e5ba" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}
function Stats({ items }: { items: [string, unknown, string?][] }) {
  return (
    <div className="compare">
      {items.map(([k, v, hint]) => (
        <div className="stat" key={k}>
          <small>{k}</small>
          <div className={`number ${hint === "signed" ? tone(v) : ""}`}>{typeof v === "string" && !Number.isFinite(Number(v)) ? v : f(v, 3)}</div>
        </div>
      ))}
    </div>
  );
}
/** Diverging background for a value scaled to ±max. */
const heat = (v: number, max: number) => {
  if (!Number.isFinite(v) || max === 0) return "transparent";
  const a = Math.min(1, Math.abs(v) / max) * 0.55;
  return v >= 0 ? `rgba(129,229,186,${a})` : `rgba(255,142,152,${a})`;
};

function SweepView({ r }: { r: Row }) {
  const rows = (r.rows as Row[]) ?? [],
    stats = r.statistics as Row | null,
    sortBy = String(r.sortBy ?? "sharpe");
  const keys = ["fast", "slow", "entryPeriod", "exitPeriod"].filter(
    (k) => new Set(rows.map((x) => (x.params as Row)[k])).size > 1,
  );
  const metric = (x: Row) => (sortBy === "returnPct" ? num(x.returnPct) : sortBy === "calmar" ? num(x.returnPct) / num(x.maxDrawdownPct) : num(x.sharpe));
  let grid: ReactNode = null;
  if (keys.length === 2) {
    const [kx, ky] = keys as [string, string],
      xs = [...new Set(rows.map((x) => num((x.params as Row)[kx])))].sort((a, b) => a - b),
      ys = [...new Set(rows.map((x) => num((x.params as Row)[ky])))].sort((a, b) => a - b),
      cell = new Map(rows.map((x) => [`${(x.params as Row)[kx]}:${(x.params as Row)[ky]}`, x])),
      max = Math.max(...rows.map((x) => Math.abs(metric(x))).filter(Number.isFinite), 0);
    grid = (
      <div className="scroll">
        <table aria-label="参数平面">
          <thead>
            <tr>
              <th>
                {ky} ↓ / {kx} →
              </th>
              {xs.map((x) => (
                <th key={x}>{x}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ys.map((y) => (
              <tr key={y}>
                <th>{y}</th>
                {xs.map((x) => {
                  const c = cell.get(`${x}:${y}`);
                  const v = c ? metric(c) : NaN;
                  return (
                    <td key={x} style={{ background: heat(v, max), opacity: c && c.eligible === false ? 0.45 : 1 }} title={c ? `收益 ${f(c.returnPct)}% · 回撤 ${f(c.maxDrawdownPct)}% · 平仓 ${c.closedTrades}` : ""}>
                      {c ? f(v, 2) : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <small>格内为排序指标（{sortBy}，筛选估算）；颜色越深绝对值越大，半透明格平仓数不足。平坦而连续的高值区域比孤立尖峰更可信。</small>
      </div>
    );
  }
  const dsr = stats?.deflatedSharpe as Row | undefined,
    of = stats?.overfitting as Row | null | undefined,
    rc = stats?.realityCheck as Row | null | undefined;
  return (
    <div className="card">
      <h3>参数扫描 · {String(r.combinations)} 组</h3>
      {stats ? (
        <Stats
          items={[
            ["DSR（选择偏差校正后）", dsr?.dsr],
            ["PSR（未校正）", dsr?.psr],
            ["过拟合概率 PBO", of?.pbo ?? "样本不足"],
            ["Reality Check p 值", rc?.pValue ?? "样本不足"],
          ]}
        />
      ) : (
        <p className="hint">日收益少于 30 个，未计算选择偏差统计。</p>
      )}
      <p className="hint">DSR 越接近 1、PBO 越低、p 值越小，越不像运气；PBO &gt; 0.5 表示样本内最优在样本外通常不如中位数。</p>
      {grid}
      <h3>精确引擎确认</h3>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>参数</th>
              <th>收益 %</th>
              <th>回撤 %</th>
              <th>Sharpe</th>
              <th>平仓</th>
            </tr>
          </thead>
          <tbody>
            {((r.confirmed as Row[]) ?? []).map((c, i) => {
              const m = c.metrics as Row;
              return (
                <tr key={i}>
                  <td className="mono">{JSON.stringify(c.params)}</td>
                  <td className={tone(m.returnPct)}>{f(m.returnPct)}</td>
                  <td>{f(m.maxDrawdownPct)}</td>
                  <td>{f(m.sharpe)}</td>
                  <td>{String(m.closedTrades)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WalkForwardView({ r }: { r: Row }) {
  const oos = r.outOfSample as Row,
    folds = (r.folds as Row[]) ?? [],
    base = r.staticBaseline as Row,
    stab = r.parameterStability as Row;
  return (
    <div className="card">
      <h3>滚动前推 · {folds.length} 个窗口（{r.mode === "anchored" ? "锚定" : "滚动"}）</h3>
      <Stats
        items={[
          ["样本外收益 %", oos.returnPct, "signed"],
          ["样本外年化 %", oos.annualisedReturnPct, "signed"],
          ["样本外回撤 %", oos.maxDrawdownPct],
          ["前推效率", r.efficiency ?? "—"],
          ["静态参数收益 %", base.returnPct, "signed"],
          ["参数变化次数", stab.changes],
        ]}
      />
      <Line values={((oos.curve as Row[]) ?? []).map((p) => num(p.equity))} label="拼接样本外净值（起点 = 1）" />
      <p className="hint">前推效率 = 样本外年化 ÷ 样本内平均年化；明显低于 0.5 说明样本内表现大多来自拟合。</p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>测试窗口</th>
              <th>选中参数</th>
              <th>训练收益 %</th>
              <th>测试收益 %</th>
              <th>测试回撤 %</th>
              <th>平仓</th>
            </tr>
          </thead>
          <tbody>
            {folds.map((x) => (
              <tr key={String(x.index)}>
                <td>
                  {day((x.test as Row).from)} → {day((x.test as Row).to)}
                </td>
                <td className="mono">{x.params ? JSON.stringify(x.params) : "现金"}</td>
                <td>{f(x.trainReturnPct)}</td>
                <td className={tone(x.returnPct)}>{f(x.returnPct)}</td>
                <td>{f(x.maxDrawdownPct)}</td>
                <td>{String(x.closedTrades)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PerformanceView({ r }: { r: Row }) {
  const s = r.summary as Row,
    t = r.trades as Row,
    monthly = (r.monthly as Row[]) ?? [],
    years = [...new Set(monthly.map((m) => String(m.period).slice(0, 4)))],
    mmax = Math.max(...monthly.map((m) => Math.abs(num(m.returnPct))).filter(Number.isFinite), 0),
    cost = r.costSensitivity as Row,
    roll = r.rollingSharpe as Row;
  return (
    <div className="card">
      <h3>绩效报告</h3>
      <Stats
        items={[
          ["总收益 %", s.totalReturnPct, "signed"],
          ["年化 %", s.cagrPct, "signed"],
          ["Sharpe", s.sharpe ?? "—"],
          ["Sortino", s.sortino ?? "—"],
          ["Calmar", s.calmar ?? "—"],
          ["最大回撤 %", s.maxDrawdownPct],
          ["最长回撤天数", s.longestDrawdownDays],
          ["PSR", s.probabilisticSharpe ?? "—"],
        ]}
      />
      <Line values={((r.equity as Row[]) ?? []).map((p) => num(p.equity))} label="日终净值" />
      <Line values={((roll?.points as Row[]) ?? []).map((p) => num(p.sharpe))} label={`滚动 ${String(roll?.windowDays)} 天 Sharpe`} height={90} />
      <h3>月度收益 %</h3>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>年</th>
              {Array.from({ length: 12 }, (_, i) => (
                <th key={i}>{i + 1}</th>
              ))}
              <th>全年</th>
            </tr>
          </thead>
          <tbody>
            {years.map((y) => (
              <tr key={y}>
                <th>{y}</th>
                {Array.from({ length: 12 }, (_, i) => {
                  const m = monthly.find((x) => x.period === `${y}-${String(i + 1).padStart(2, "0")}`);
                  return (
                    <td key={i} style={{ background: m ? heat(num(m.returnPct), mmax) : "transparent" }}>
                      {m ? f(m.returnPct, 1) : ""}
                    </td>
                  );
                })}
                <td className={tone(((r.yearly as Row[]) ?? []).find((x) => x.period === y)?.returnPct)}>
                  {f(((r.yearly as Row[]) ?? []).find((x) => x.period === y)?.returnPct, 1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid">
        <div>
          <h3>交易</h3>
          <table>
            <tbody>
              {[
                ["完整交易", t.roundTrips],
                ["胜率 %", f(t.winRatePct)],
                ["平均盈利", f(t.averageWin)],
                ["平均亏损", f(t.averageLoss)],
                ["期望值", f(t.expectancy)],
                ["平均持有小时", f(t.averageHoldingHours, 1)],
                ["最长连亏", t.maxConsecutiveLosses],
              ].map(([k, v]) => (
                <tr key={String(k)}>
                  <th>{String(k)}</th>
                  <td>{String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h3>市场状态</h3>
          <table>
            <thead>
              <tr>
                <th>状态</th>
                <th>天数</th>
                <th>日均 %</th>
                <th>胜率 %</th>
              </tr>
            </thead>
            <tbody>
              {(((r.regimes as Row).rows as Row[]) ?? []).map((x) => (
                <tr key={String(x.regime)}>
                  <td>{({ up: "上涨", down: "下跌", sideways: "震荡" } as Record<string, string>)[String(x.regime)]}</td>
                  <td>{String(x.days)}</td>
                  <td className={tone(x.meanDailyReturnPct)}>{f(x.meanDailyReturnPct, 3)}</td>
                  <td>{f(x.hitRatePct, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <h3>成本敏感性</h3>
      <table>
        <thead>
          <tr>
            <th>成本倍数</th>
            <th>手续费 bps</th>
            <th>滑点 bps</th>
            <th>收益 %</th>
            <th>Sharpe</th>
          </tr>
        </thead>
        <tbody>
          {((cost.rows as Row[]) ?? []).map((x) => (
            <tr key={String(x.multiplier)}>
              <td>×{String(x.multiplier)}</td>
              <td>{String(x.feeBps)}</td>
              <td>{String(x.slippageBps)}</td>
              <td className={tone(x.returnPct)}>{f(x.returnPct)}</td>
              <td>{f(x.sharpe)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cost.breakEvenMultiplier !== null && <small>约在成本 ×{f(cost.breakEvenMultiplier)} 时收益归零。</small>}
    </div>
  );
}

export function LabResult({ action, result }: { action: string; result: unknown }) {
  if (!result || typeof result !== "object") return null;
  const r = result as Row;
  if (action === "parameter-sweep") return <SweepView r={r} />;
  if (action === "walk-forward") return <WalkForwardView r={r} />;
  if (action === "performance-report") return <PerformanceView r={r} />;
  return null;
}
