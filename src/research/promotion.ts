import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { hash } from "../adapters/market.js";
import { configInput, fail, id } from "../domain/schemas.js";
import { configurationChanges } from "../domain/simulation-analysis.js";
import type { Account, StrategyRecord } from "../domain/contracts.js";
import type { ResearchProject } from "../domain/project.js";
import type {
  PromotionPreview,
  SimulationApproval,
  SimulationTransition,
} from "../domain/simulation.js";

export function accountConfiguration(a: Account) {
  return configInput.parse({
    initialCash: a.config.initialCash,
    risk: a.config.risk,
    costs: a.config.costs,
    from: 0,
    to: 8640000000000000,
  });
}
export function makePromotionPreview(
  p: ResearchProject,
  target: StrategyRecord,
  config: ReturnType<typeof configInput.parse>,
  engineVersion: string,
  source: Account | null,
  sourceVersion: StrategyRecord | null,
  retired: boolean,
  engineAligned: boolean,
  accounts: Account[],
): PromotionPreview {
  const blockers: string[] = [];
  if (
    p.status !== "completed" ||
    !p.report ||
    p.report.conclusion !== "supported" ||
    p.report.synthetic
  )
    blockers.push("研究未满足模拟观察门槛");
  if (hash(config) !== hash(p.protocol.config))
    blockers.push("资金、风险或成本与已验证研究配置不同，请先建立对应研究");
  if (!engineAligned)
    blockers.push("研究包含不同或旧执行引擎的实验，请按当前版本建立后续研究");
  if (source) {
    if (source.status === "running")
      blockers.push("请先暂停或停止原账户，核对最新状态后再确认替换");
    if (Object.keys(source.state.positions).length)
      blockers.push(
        "原账户仍有持仓；如决定替换，请先独立确认按有效行情模拟平仓",
      );
    if (Object.keys(source.state.pending).length)
      blockers.push("原账户仍有待成交意图，请先停止并撤销");
    if (retired) blockers.push("原账户已被其他经批准版本接替，不能重复替换");
  }
  const body = {
    version: 1 as const,
    projectId: p.id,
    reportHash: p.report?.hash ?? "",
    targetDefinitionHash: hash(target.definition),
    targetConfigHash: hash(config),
    targetEngineVersion: engineVersion,
    source:
      source && sourceVersion
        ? {
            id: source.id,
            name: source.name,
            revision: source.revision,
            generation: source.generation,
            status: source.status,
            definitionHash: hash(sourceVersion.definition),
            configHash: hash(accountConfiguration(source)),
            engineVersion: source.config.engineVersion,
          }
        : null,
    changes:
      source && sourceVersion
        ? configurationChanges(
            { definition: sourceVersion.definition, config: source.config },
            {
              definition: target.definition,
              config: { ...config, engineVersion },
            },
          )
        : [],
    canApprove: blockers.length === 0,
    blockers,
  };
  return {
    ...body,
    hash: hash(body),
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
    })),
  };
}
export function verifyTransition(
  value: unknown,
  accounts: Account[],
  strategies: StrategyRecord[],
  projects: ResearchProject[],
  approvals: SimulationApproval[],
): SimulationTransition {
  const v = z
    .object({
      id,
      version: z.literal(1),
      fromAccountId: id,
      toAccountId: id,
      projectId: id,
      reportHash: z.string(),
      preview: z.unknown(),
      approvedBy: z.literal("user"),
      approvedAt: z.string(),
      hash: z.string(),
    })
    .strict()
    .parse(value) as SimulationTransition;
  // Validate nested shape without reordering fields covered by the saved hash.
  z.object({
    version: z.literal(1),
    hash: z.string(),
    projectId: id,
    reportHash: z.string(),
    targetDefinitionHash: z.string(),
    targetConfigHash: z.string(),
    targetEngineVersion: z.string(),
    source: z
      .object({
        id,
        name: z.string(),
        revision: z.number().int().positive(),
        generation: z.number().int().nonnegative(),
        status: z.string(),
        definitionHash: z.string(),
        configHash: z.string(),
        engineVersion: z.string(),
      })
      .strict()
      .nullable(),
    changes: z.array(
      z
        .object({
          field: z.string(),
          label: z.string(),
          before: z.string(),
          after: z.string(),
        })
        .strict(),
    ),
    canApprove: z.boolean(),
    blockers: z.array(z.string()),
    accounts: z.array(
      z.object({ id, name: z.string(), status: z.string() }).strict(),
    ),
  })
    .strict()
    .parse(v.preview);
  const { hash: digest, ...body } = v;
  const { hash: previewHash, accounts: choices, ...previewBody } = v.preview;
  if (
    hash(body) !== digest ||
    hash(previewBody) !== previewHash ||
    !v.preview.canApprove ||
    v.preview.blockers.length ||
    v.id !== v.fromAccountId ||
    v.fromAccountId === v.toAccountId
  )
    fail("TRANSITION_HASH", "模拟版本变更或批准预览的完整性无效");
  const source = accounts.find((a) => a.id === v.fromAccountId),
    target = accounts.find((a) => a.id === v.toAccountId);
  const fromVersion = strategies.find((s) => s.id === source?.strategyId),
    toVersion = strategies.find((s) => s.id === target?.strategyId);
  const p = projects.find((p) => p.id === v.projectId),
    approval = approvals.find((a) => a.id === v.toAccountId);
  if (
    !source ||
    !target ||
    !fromVersion ||
    !toVersion ||
    !p?.report ||
    !approval ||
    p.report.hash !== v.reportHash ||
    p.report.conclusion !== "supported" ||
    p.report.synthetic ||
    approval.projectId !== p.id ||
    approval.configHash !== v.preview.targetConfigHash ||
    approval.definitionHash !== v.preview.targetDefinitionHash ||
    approval.previewHash !== previewHash ||
    approval.replacementAccountId !== source.id ||
    v.preview.source?.id !== source.id ||
    v.preview.source.definitionHash !== hash(fromVersion.definition) ||
    v.preview.source.configHash !== hash(accountConfiguration(source)) ||
    v.preview.targetDefinitionHash !== hash(toVersion.definition) ||
    v.preview.targetConfigHash !== hash(accountConfiguration(target)) ||
    v.preview.targetEngineVersion !== target.config.engineVersion ||
    v.preview.reportHash !== v.reportHash ||
    v.preview.projectId !== p.id ||
    !isDeepStrictEqual(
      v.preview.changes,
      configurationChanges(
        { definition: fromVersion.definition, config: source.config },
        { definition: toVersion.definition, config: target.config },
      ),
    )
  )
    fail(
      "TRANSITION_REFERENCE",
      "模拟版本变更的账户、配置或研究批准引用不一致",
    );
  return v;
}
