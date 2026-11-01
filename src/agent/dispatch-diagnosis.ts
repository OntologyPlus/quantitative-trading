import type { ModelDispatch } from "../domain/project.js";

export type IdleFailureKind =
  | "prior_consumed"
  | "no_model_call"
  | "tool_error"
  | "output_budget"
  | "analyze_only"
  | "no_advancing_action";

export function dispatchUserPrompt(
  stage: ModelDispatch["stage"],
  objective: string,
) {
  if (stage === "selection")
    return `研究事件：selection。请读取 qt_project_context 后，本轮只提交一个 select 或 propose（必要时可先 qt_evidence_read）。不要长篇分析，不要调用 analyze；reason 与 evidenceIds 保持简短。项目目标：${objective}`;
  if (stage === "planning")
    return `研究事件：planning。请读取项目后提交 begin 或 request_input，不要展开无关分析，不要调用 analyze。项目目标：${objective}`;
  return `研究事件：report。请必要时用短 analyze 关联证据，然后调用 finish。项目目标：${objective}`;
}

/** One compact retry after the model hit the output cap without an advancing action. */
export function dispatchCompactRetryPrompt(
  stage: ModelDispatch["stage"],
  objective: string,
) {
  if (stage === "selection")
    return `上轮输出触达上限且未提交推进动作。本轮禁止任何分析正文与 analyze；只调用 qt_project_action 提交一个紧凑的 select 或 propose。项目目标：${objective}`;
  if (stage === "planning")
    return `上轮输出触达上限且未提交推进动作。本轮禁止分析正文；只调用 qt_project_action 提交 begin 或 request_input。项目目标：${objective}`;
  return `上轮输出触达上限且未提交推进动作。本轮用极短 analyze（可选）后立即 finish，或直接 finish。项目目标：${objective}`;
}

export function diagnoseIdleFailure(
  d: Pick<ModelDispatch, "requestKeys" | "usageKeys" | "trace">,
  outputBudget: number,
  opts: { accepted: boolean; pending: boolean },
): { kind: IdleFailureKind; message: string; unknown: boolean } {
  if (opts.accepted && !opts.pending)
    return {
      kind: "prior_consumed",
      unknown: true,
      message:
        "上次执行已消费但未提交有效动作，需要检查宿主日志后继续",
    };
  const usedModel = d.requestKeys.length > 0 || d.usageKeys.length > 0;
  const tools = d.trace?.tools ?? [];
  const actions = tools.filter((t) => t.name === "qt_project_action");
  const failed = actions.filter((t) => !t.ok);
  const analyzeOnly =
    actions.length > 0 &&
    actions.every((t) => t.ok && t.action === "analyze");
  const hitMax = (d.trace?.finishKinds ?? []).includes("max-tokens");
  const outputTokens = d.trace?.outputTokens ?? 0;
  const nearCap = outputBudget > 0 && outputTokens >= outputBudget * 0.9;
  if (!usedModel)
    return {
      kind: "no_model_call",
      unknown: false,
      message:
        "Agent 本轮未发起模型请求，也未提交有效下一步动作；请回复研究所需信息或检查宿主会话",
    };
  if (failed.length)
    return {
      kind: "tool_error",
      unknown: false,
      message: `Agent 本轮工具动作失败：${failed
        .map((f) => f.error || f.action || f.name)
        .join("；")}。模型已计费，请根据错误修正后继续`,
    };
  if (hitMax || nearCap)
    return {
      kind: "output_budget",
      unknown: false,
      message: `Agent 本轮模型有返回并计费，但输出可能触达上限（${outputTokens}/${outputBudget} tokens${hitMax ? "，finish=max-tokens" : ""}），未提交 select/propose/finish 等推进动作。请缩短分析或提高单次输出预算后继续`,
    };
  if (analyzeOnly)
    return {
      kind: "analyze_only",
      unknown: false,
      message:
        "Agent 本轮仅保存了 analyze 解释，未提交 select/propose/begin/finish 等推进动作；selection 阶段应直接选择或追加候选",
    };
  return {
    kind: "no_advancing_action",
    unknown: false,
    message:
      "Agent 本轮模型有返回并计费，但未调用推进动作（select/propose/begin/finish/request_input）。这通常不是模型配置问题，请检查本轮是否只输出了分析而未提交工具动作",
  };
}
