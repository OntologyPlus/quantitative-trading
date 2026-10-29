import { useEffect } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { TOOL_TITLES } from "../domain/contracts.js";
import { Studio, STUDIO_ID, STUDIO_KIND } from "./studio.js";
import type { Caller } from "./api.js";
import { styles } from "./styles.js";
export { TOOL_TITLES };
export const inject = [
  "slots",
  "connection",
  "sidebarRight",
  "sidebarRightTabs",
];
function ToolCard(
  props: ToolCallViewProps & {
    open: (projectId?: string) => void;
  },
) {
  const done = props.phase === "result";
  let summary: Record<string, unknown> | null = null;
  if (done && !props.block.isError) {
    for (const block of props.block.content ?? [])
      if (block.type === "text") {
        try {
          const parsed = JSON.parse(block.text);
          const data = parsed.data ?? parsed;
          summary = (data.project ?? data) as Record<string, unknown>;
        } catch {
          /* Other tool text remains in the host transcript. */
        }
        if (summary) break;
      }
  }
  const projectId =
    summary &&
    typeof summary.id === "string" &&
    ["qt_project_create", "qt_project_read", "qt_project_action"].includes(
      props.toolName,
    )
      ? summary.id
      : undefined;
  return (
    <section className="qt">
      <style>{styles}</style>
      <div className="card">
        <small>QUANT LAB · 量化研究</small>
        <strong>{TOOL_TITLES[props.toolName]}</strong>
        <p>
          {!done
            ? "正在读取或提交任务…"
            : props.block.isError
              ? "这一步未完成，请查看错误后重试。"
              : "工具已返回；持续任务的完成状态请在工作台查看。"}
        </p>
        {summary && (
          <div className="review">
            {typeof summary.name === "string" && (
              <strong>{summary.name}</strong>
            )}
            {typeof summary.reason === "string" && <p>{summary.reason}</p>}
            {typeof summary.status === "string" && (
              <small>任务状态：{summary.status}</small>
            )}
            {typeof summary.manifestHash === "string" && (
              <small className="mono">Manifest {summary.manifestHash}</small>
            )}
          </div>
        )}
        <button onClick={() => props.open(projectId)}>打开量化工作台 ↗</button>
      </div>
    </section>
  );
}
export function apply(ctx: Context) {
  const rpc = (
    ctx as unknown as {
      connection: {
        rpc: Caller;
      };
    }
  ).connection.rpc;
  ctx.slots.inject("tool.call.toolview", () => {
    const disposers = Object.keys(TOOL_TITLES).map((key) =>
      ctx.slots.register({ name: "tool.call.toolview", key }, (props) => (
        <ToolCard
          {...props}
          open={(projectId) => {
            ctx.sidebarRight.openTab(STUDIO_KIND);
            if (projectId)
              window.dispatchEvent(
                new CustomEvent("quant-open-project", { detail: projectId }),
              );
          }}
        />
      )),
    );
    return () => disposers.reverse().forEach((f) => f());
  });
  ctx.effect(() => {
    const tab = ctx.sidebarRightTabs.register({
      id: STUDIO_ID,
      kind: STUDIO_KIND,
      keepMounted: true,
      title: () => "量化工作台",
      guide: [
        {
          id: "quant-research",
          order: 10,
          title: () => "量化工作台",
          description: () => "策略、数据、回测与模拟交易",
        },
      ],
    });
    const view = ctx.slots.inject("sidebar.right.pane.tab", () =>
      ctx.slots.register(
        { name: "sidebar.right.pane.tab", key: STUDIO_ID },
        (props) => (
          <Studio
            key={props.sessionId}
            rpc={rpc}
            sessionId={props.sessionId}
            useTabInfo={props.useTabInfo}
            bring={(text) => {
              const a = props.inputActions;
              if (!a?.captureInsertion || !a.insertText) return "unavailable";
              return a.insertText(`\n${text}\n`, a.captureInsertion())
                ? "ok"
                : "busy";
            }}
          />
        ),
      ),
    );
    return () => {
      view();
      tab();
    };
  });
}
