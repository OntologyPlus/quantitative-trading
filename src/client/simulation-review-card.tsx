import { useState } from "react";
import { call, type Caller } from "./api.js";
import type {
  SimulationReview,
  SimulationEvidence,
} from "../domain/simulation.js";

const number = (v: string | number | null) =>
  v === null
    ? "样本不足"
    : Number(v).toLocaleString("zh-CN", { maximumFractionDigits: 4 });
export function SimulationReviewCard({
  review,
  rpc,
  sessionId,
  busy,
  bring,
  onFollowup,
  onProject,
}: {
  review: SimulationReview;
  rpc: Caller;
  sessionId: string;
  busy: boolean;
  bring: (s: string) => string;
  onFollowup: (review: SimulationReview, code: string) => void;
  onProject: (id: string) => void;
}) {
  const [checked, setChecked] = useState<SimulationEvidence | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const diagnosis = review.diagnosis;
  async function inspect(path: string) {
    setChecked(null);
    setError("");
    try {
      setChecked(
        await call<SimulationEvidence>(rpc, sessionId, "monitor-read", {
          id: review.id,
          path,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "证据核对失败");
    }
  }
  const fact = (path: string, value: string | number | null) => (
    <button disabled={busy} onClick={() => void inspect(path)}>
      {number(value)} ↗
    </button>
  );
  return (
    <article className="stat simulation-review" aria-label="模拟事实复盘">
      <small>
        {new Date(review.at).toLocaleString("zh-CN")} · 累计事实复盘
      </small>
      <p>
        累计收益 {number(review.metrics.returnPct)}% · 最大回撤{" "}
        {number(review.metrics.maxDrawdownPct)}% · {review.metrics.closedTrades}{" "}
        笔平仓
      </p>
      <p className="hint">
        {review.reason}
        {review.observationGap ? " 期间存在暂停、缺口或观察历史不完整。" : ""}
      </p>
      {diagnosis && (
        <>
          <h4>原研究与观察事实</h4>
          <p className="hint">
            不同区间的数值仅作描述性对照。复盘规则：至少
            {diagnosis.policy.minDays}天行情跨度及
            {diagnosis.policy.minClosedTrades}
            笔平仓，再检查交易频率是否超出历史描述的
            {diagnosis.policy.frequencyRatioLow}—
            {diagnosis.policy.frequencyRatioHigh}倍。
          </p>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>事实</th>
                  <th>模拟账本 / 观察</th>
                  <th>历史保留区间</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>收益 %（不同区间）</td>
                  <td>{fact("metrics.returnPct", review.metrics.returnPct)}</td>
                  <td>
                    {diagnosis.reference
                      ? fact(
                          "baseline.metrics.returnPct",
                          diagnosis.reference.metrics.returnPct,
                        )
                      : "未关联研究"}
                  </td>
                </tr>
                <tr>
                  <td>最大回撤 %</td>
                  <td>
                    {fact(
                      "metrics.maxDrawdownPct",
                      review.metrics.maxDrawdownPct,
                    )}
                  </td>
                  <td>
                    {diagnosis.reference
                      ? fact(
                          "baseline.metrics.maxDrawdownPct",
                          diagnosis.reference.metrics.maxDrawdownPct,
                        )
                      : "—"}
                  </td>
                </tr>
                <tr>
                  <td>平仓样本</td>
                  <td>
                    {fact("metrics.closedTrades", review.metrics.closedTrades)}
                  </td>
                  <td>
                    {diagnosis.reference
                      ? fact(
                          "baseline.metrics.closedTrades",
                          diagnosis.reference.metrics.closedTrades,
                        )
                      : "—"}
                  </td>
                </tr>
                <tr>
                  <td>行情跨度 / 研究天数</td>
                  <td>
                    {fact("diagnosis.observedDays", diagnosis.observedDays)}
                  </td>
                  <td>
                    {fact("diagnosis.baselineDays", diagnosis.baselineDays)}
                  </td>
                </tr>
                <tr>
                  <td>平仓笔数 / 天</td>
                  <td>
                    {fact(
                      "diagnosis.frequencyPerDay",
                      diagnosis.frequencyPerDay,
                    )}
                  </td>
                  <td>
                    {fact(
                      "diagnosis.baselineFrequencyPerDay",
                      diagnosis.baselineFrequencyPerDay,
                    )}
                  </td>
                </tr>
                <tr>
                  <td>费用率 bps</td>
                  <td>{fact("diagnosis.feeBps", diagnosis.feeBps)}</td>
                  <td>
                    {fact("diagnosis.baselineFeeBps", diagnosis.baselineFeeBps)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="hint">
            模拟费用率按冻结账本的手续费/成交金额计算；历史列为研究配置，均不代表实盘收费。
          </p>
          {diagnosis.reference && (
            <button onClick={() => onProject(diagnosis.reference!.projectId)}>
              打开原研究与限制
            </button>
          )}
          <h4>发现与限制</h4>
          {diagnosis.findings.map((f) => (
            <div
              className={f.severity === "attention" ? "notice error" : "notice"}
              key={f.code}
            >
              <strong>{f.title}</strong>
              <p>{f.detail}</p>
              <div className="actions">
                {f.paths.map((path) => (
                  <button key={path} onClick={() => void inspect(path)}>
                    核对
                    {(
                      {
                        "diagnosis.observedDays": "观察长度",
                        "metrics.closedTrades": "平仓样本",
                        "diagnosis.health.gapCount": "中断次数",
                        "diagnosis.health.gapMs": "中断时长",
                        "diagnosis.health.lastMarketAt": "最后有效行情",
                        "diagnosis.health.stalePositionCount": "过期估值持仓数",
                        "metrics.maxDrawdownPct": "累计回撤",
                        "diagnosis.maxDrawdownLimit": "研究回撤上限",
                        "diagnosis.frequencyRatio": "频率比例",
                        "diagnosis.frequencyPerDay": "模拟频率",
                        "diagnosis.baselineFrequencyPerDay": "历史频率",
                      } as Record<string, string>
                    )[path] ?? "数值证据"}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <ul>
            {diagnosis.basisWarnings.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <h4>把待验证问题交回研究</h4>
          {diagnosis.researchQuestions.map((q) => (
            <div key={q.code}>
              <p>{q.objective}</p>
              <button
                disabled={busy}
                onClick={() => onFollowup(review, q.code)}
              >
                从此问题生成研究草稿
              </button>
            </div>
          ))}
          <small>
            只生成关联草稿；数据区间、预算与启动仍由你核对，不修改正在运行的策略。
          </small>
        </>
      )}
      {error && (
        <p className="down" role="alert">
          {error}
        </p>
      )}
      {checked && (
        <div className="notice" role="status">
          <strong>复盘证据已核对</strong>
          <p>
            {checked.path}：
            {checked.value === null
              ? "无足够样本或记录"
              : String(checked.value)}
          </p>
          <small>冻结于 {new Date(checked.asOf).toLocaleString("zh-CN")}</small>
          <details>
            <summary>完整证据身份</summary>
            <pre>{JSON.stringify(checked, null, 2)}</pre>
          </details>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      <button
        onClick={() =>
          setNotice(
            bring(
              `请用 qt_monitor_read 的 id=${review.id} 读取冻结事实复盘，核对观察缺口、原研究口径及证据；区分描述性差异和待验证假设，不把不同区间收益差直接解释为策略失效。`,
            ) === "ok"
              ? "已带入对话，请检查后发送。"
              : "请在聊天中引用复盘身份。",
          )
        }
      >
        带入对话分析
      </button>
    </article>
  );
}
