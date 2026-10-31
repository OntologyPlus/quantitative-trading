import { z } from "zod";
import { id, rulesSchema } from "./schemas.js";
export const provenanceSchema = z
  .object({
    version: z.literal(1),
    provider: z.string().min(1).max(200),
    retrievedAt: z.number().int().nonnegative(),
    revisionOf: id.optional(),
    listing: z
      .object({
        listedAt: z.number().int().nonnegative(),
        delistedAt: z.number().int().nonnegative().optional(),
        knownAt: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    ruleHistory: z
      .array(
        z
          .object({
            effectiveAt: z.number().int().nonnegative(),
            knownAt: z.number().int().nonnegative(),
            rules: rulesSchema,
          })
          .strict(),
      )
      .max(1000)
      .optional(),
  })
  .strict()
  .superRefine((p, c) => {
    if (
      p.listing?.delistedAt !== undefined &&
      p.listing.delistedAt <= p.listing.listedAt
    )
      c.addIssue({ code: "custom", message: "退市须晚于上市" });
    const h = p.ruleHistory ?? [];
    if (h.some((v, i) => i > 0 && v.effectiveAt <= h[i - 1]!.effectiveAt))
      c.addIssue({ code: "custom", message: "历史规则须按生效时间严格递增" });
  });
export type Provenance = z.infer<typeof provenanceSchema>;
