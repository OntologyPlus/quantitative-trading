import type { Dataset } from "../domain/contracts.js";
import type { ResearchProject } from "../domain/project.js";
import {
  researchConditions,
  reportChecks,
  researchNextSteps,
} from "../domain/research-view.js";

export function ResearchConditionsCard({
  project,
  datasets,
}: {
  project: ResearchProject;
  datasets: Dataset[];
}) {
  const conditions = researchConditions(project, datasets);
  const primary = ["研究范围", "研究时间（UTC）", "手续费", "滑点"];
  return (
    <section className="research-conditions" aria-label="本次研究条件">
      <h3>本次研究条件</h3>
      <p className="hint">
        以下为本次委托的实际口径。默认值经确认后冻结，不能视为所有市场通用的设置。
      </p>
      <dl className="condition-list">
        {conditions
          .filter((c) => primary.includes(c.label))
          .map((c) => (
            <div key={c.label}>
              <dt>
                {c.label}
                <small>{c.origin}</small>
              </dt>
              <dd>{c.value}</dd>
            </div>
          ))}
      </dl>
      <details open={project.status === "draft"}>
        <summary>数据来源、仓位与成交约定</summary>
        <dl className="condition-list">
          {conditions
            .filter((c) => !primary.includes(c.label))
            .map((c) => (
              <div key={c.label}>
                <dt>
                  {c.label}
                  <small>{c.origin}</small>
                </dt>
                <dd>{c.value}</dd>
              </div>
            ))}
        </dl>
      </details>
    </section>
  );
}

export function ReportReading({
  project,
  onExperiment,
  onFollowup,
  onQuestion,
}: {
  project: ResearchProject;
  onExperiment: (id: string) => void;
  onFollowup: () => void;
  onQuestion: (question: string) => void;
}) {
  return (
    <>
      <h3>关键依据与反证</h3>
      <p className="hint">
        通过仅表示满足本协议门槛；结论以最终区间、成本检验和数据限制共同判断。
      </p>
      <div className="report-checks">
        {reportChecks(project).map((c) => (
          <button
            key={c.experimentId}
            onClick={() => onExperiment(c.experimentId)}
          >
            <span className="row between">
              <strong>{c.phase}</strong>
              <span className={c.verdict === "fail" ? "down" : "muted"}>
                {
                  {
                    pass: "满足门槛",
                    fail: "未通过",
                    insufficient: "证据不足",
                    pending: "待核对",
                  }[c.verdict]
                }
              </span>
            </span>
            <span>{c.text}</span>
            <small>查看对应实验与指标证据 ↗</small>
          </button>
        ))}
      </div>
      <h3>限制（引用时务必保留）</h3>
      <ul className="research-limitations">
        {project.report!.limitations.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <h3>下一步</h3>
      <ul>
        {researchNextSteps(project).map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <div className="actions">
        <button onClick={onFollowup}>按此结果建立后续研究</button>
        <button
          onClick={() =>
            onQuestion(
              "请解释所选候选的主要反证、适用限制及下一项值得补充的实验；区分已有证据和待验证假设。",
            )
          }
        >
          解释反证与下一步
        </button>
      </div>
    </>
  );
}
