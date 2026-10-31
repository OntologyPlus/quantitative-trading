import { useEffect, useState } from "react";
import type { ResearchProject } from "../domain/project.js";
import type { PromotionPreview } from "../domain/simulation.js";
import { call, type Caller } from "./api.js";

export function PromotionPanel({
  project,
  rpc,
  sessionId,
  busy,
  onApprove,
  onPaper,
}: {
  project: ResearchProject;
  rpc: Caller;
  sessionId: string;
  busy: boolean;
  onApprove: (input: Record<string, unknown>) => void;
  onPaper?: () => void;
}) {
  const [opened, setOpened] = useState(false),
    [replacement, setReplacement] = useState(
      project.protocol.simulationSource?.accountId ?? "",
    );
  const [preview, setPreview] = useState<PromotionPreview | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setPreview(null);
    void call<PromotionPreview>(
      rpc,
      sessionId,
      "project-promotion-preview",
      {
        id: project.id,
        config: project.protocol.config,
        ...(replacement ? { replacementAccountId: replacement } : {}),
      },
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    rpc,
    sessionId,
    project.id,
    project.revision,
    project.report?.hash,
    opened,
    replacement,
    refresh,
  ]);
  const current =
    preview &&
    (preview.source?.id ?? "") === replacement &&
    preview.reportHash === project.report!.hash;
  return (
    <details
      className="promotion-panel"
      onToggle={(e) => setOpened(e.currentTarget.open)}
    >
      <summary>核对模拟版本与运行变更</summary>
      <p>
        使用本研究确切的策略、资金和风险配置。新账户采用独立虚拟资金，不迁移原账户资金或持仓；创建后仍需明确启动。
      </p>
      <label>
        本次操作
        <select
          value={replacement}
          onChange={(e) => setReplacement(e.target.value)}
        >
          <option value="">创建独立模拟账户</option>
          {preview?.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              替换 {a.name} · {a.status}
            </option>
          ))}
          {replacement &&
            !preview?.accounts.some((a) => a.id === replacement) && (
              <option value={replacement}>
                替换来源账户 {replacement.slice(0, 8)}
              </option>
            )}
        </select>
      </label>
      {loading && <p role="status">正在核对研究、版本和账户状态…</p>}
      {error && (
        <p className="down" role="alert">
          {error}
        </p>
      )}
      {current && (
        <>
          {preview.source && (
            <p>
              原账户：{preview.source.name} · {preview.source.status} · 版本{" "}
              {preview.source.definitionHash.slice(0, 12)}
            </p>
          )}
          <p>
            新策略版本 {preview.targetDefinitionHash.slice(0, 12)} · 配置{" "}
            {preview.targetConfigHash.slice(0, 12)}
          </p>
          {preview.changes.length > 0 ? (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>变更项</th>
                    <th>原配置</th>
                    <th>新研究配置</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.map((c) => (
                    <tr key={c.field}>
                      <td>{c.label}</td>
                      <td>{c.before}</td>
                      <td>{c.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="hint">
              {preview.source
                ? "策略与经济参数未变；仍会创建独立账户并保留旧记录。"
                : "没有选择要替换的账户。"}
            </p>
          )}
          {preview.blockers.map((s) => (
            <p key={s} className="down">
              {s}
            </p>
          ))}
          <details>
            <summary>确认资金、风险与完整配置</summary>
            <pre>{JSON.stringify(project.protocol.config, null, 2)}</pre>
          </details>
        </>
      )}
      <div className="actions">
        <button
          disabled={loading || busy}
          onClick={() => setRefresh((n) => n + 1)}
        >
          重新核对变更
        </button>
        <button
          className="primary"
          disabled={busy || loading || !current || !preview?.canApprove}
          onClick={() =>
            preview &&
            onApprove({
              id: project.id,
              expectedRevision: project.revision,
              reportHash: project.report!.hash,
              config: project.protocol.config,
              name: `${project.name} · 模拟观察`,
              previewHash: preview.hash,
              ...(replacement ? { replacementAccountId: replacement } : {}),
            })
          }
        >
          {replacement
            ? "确认变更并替换原观察账户"
            : "确认此配置并创建模拟账户"}
        </button>
        {onPaper && <button onClick={onPaper}>前往模拟盘处理或启动</button>}
      </div>
    </details>
  );
}
