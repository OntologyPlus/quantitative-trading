import { z } from "zod";
import { id } from "../domain/schemas.js";
import type { parameterSweep } from "../research/sweep.js";
import type { walkForward } from "../research/walkforward.js";
import type { performanceReport } from "../research/performance.js";

export const labToolInput = z
  .object({
    action: z.enum(["parameter-sweep", "walk-forward", "performance-report"]),
    input: z.object({ runId: id }).passthrough(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(2).max(200).default(50),
  })
  .strict();

/** Keep endpoints when sampling chart points; numerical summaries stay full resolution. */
function sample<T>(items: T[], limit: number): T[] {
  return items.length <= limit
    ? items
    : Array.from(
        { length: limit },
        (_, i) => items[Math.round((i * (items.length - 1)) / (limit - 1))]!,
      );
}

/** The hash identifies the full analysis, not its bounded conversational view. */
export function labToolView(
  action: z.infer<typeof labToolInput>["action"],
  value: unknown,
  offset: number,
  limit: number,
) {
  if (action === "parameter-sweep") {
    const {
      hash: analysisHash,
      rows,
      ...result
    } = value as Awaited<ReturnType<typeof parameterSweep>>;
    return {
      analysisHash,
      result: { ...result, rows: rows.slice(offset, offset + limit) },
      view: {
        offset,
        limit,
        totalRows: rows.length,
        hasMore: offset + limit < rows.length,
      },
    };
  }
  if (action === "walk-forward") {
    const { hash: analysisHash, ...result } = value as Awaited<
      ReturnType<typeof walkForward>
    >;
    return {
      analysisHash,
      result: {
        ...result,
        outOfSample: {
          ...result.outOfSample,
          curve: sample(result.outOfSample.curve, limit),
        },
      },
      view: {
        totalCurvePoints: result.outOfSample.curve.length,
        chartPointLimit: limit,
        chartSampled: result.outOfSample.curve.length > limit,
      },
    };
  }
  const { hash: analysisHash, ...result } = value as ReturnType<
    typeof performanceReport
  >;
  return {
    analysisHash,
    result: {
      ...result,
      equity: sample(result.equity, limit),
      rollingSharpe: {
        ...result.rollingSharpe,
        points: sample(result.rollingSharpe.points, limit),
      },
    },
    view: {
      totalEquityPoints: result.equity.length,
      totalRollingPoints: result.rollingSharpe.points.length,
      chartPointLimit: limit,
      chartSampled:
        Math.max(result.equity.length, result.rollingSharpe.points.length) >
        limit,
    },
  };
}
