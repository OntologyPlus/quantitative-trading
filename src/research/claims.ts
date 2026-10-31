import { z } from "zod";
import { Decimal } from "decimal.js";
import { id, fail } from "../domain/schemas.js";
import type { EvidenceRef } from "../domain/project.js";
export const claimSchema = z
  .object({
    left: id,
    operator: z.enum(["gt", "gte", "lt", "lte", "eq"]),
    right: id,
  })
  .strict();
export type Claim = z.infer<typeof claimSchema>;
export function claimTemplate(
  claims: Claim[],
  facts: EvidenceRef[],
  allowed: string[],
) {
  if (!claims.length) fail("CLAIM_MISSING", "事实解释需要结构化比较");
  return claims
    .map((c) => {
      const a = facts.find((f) => f.id === c.left),
        b = facts.find((f) => f.id === c.right);
      if (
        !a ||
        !b ||
        !allowed.includes(a.id) ||
        !allowed.includes(b.id) ||
        a.value === null ||
        b.value === null
      )
        fail("CLAIM_EVIDENCE", "比较需要两项可用数值证据");
      if (a.from !== b.from || a.to !== b.to)
        fail("CLAIM_RANGE", "比较证据必须来自同一区间");
      const unit = (path: string) =>
        path.endsWith("Pct")
          ? "pct"
          : path.endsWith("sharpe")
            ? "sharpe"
            : path;
      if (unit(a.path) !== unit(b.path))
        fail("CLAIM_UNIT", "比较证据单位不一致");
      const x = new Decimal(a.value),
        y = new Decimal(b.value);
      if (!x[c.operator](y)) fail("CLAIM_FALSE", "证据不支持所提交的比较方向");
      const labels = {
        gt: "高于",
        gte: "不低于",
        lt: "低于",
        lte: "不高于",
        eq: "等于",
      };
      return `${a.path}（[[e:${a.id}]]）${labels[c.operator]}${b.path}（[[e:${b.id}]]）。`;
    })
    .join("\n");
}
