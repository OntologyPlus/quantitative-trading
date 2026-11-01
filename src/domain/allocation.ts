import { Decimal } from "decimal.js";
import { fail } from "./schemas.js";

/** Normalize accepted percentage rounding, assigning the Decimal remainder once. */
export function allocateCapital(total: Decimal.Value, weights: number[]) {
  const sum = weights.reduce((s, w) => s.plus(String(w)), new Decimal(0));
  if (
    !weights.length ||
    weights.some((w) => !Number.isFinite(w) || w <= 0) ||
    sum.minus(100).abs().gte("0.00000001")
  )
    fail("ALLOCATION_WEIGHTS", "组合权重须合计100%（仅允许十进制舍入尾差）");
  const capital = new Decimal(total);
  if (!capital.isFinite() || capital.lt(0))
    fail("ALLOCATION_CASH", "组合资金无效");
  let remaining = capital;
  return weights.map((w, i) => {
    const value =
      i === weights.length - 1 ? remaining : capital.mul(String(w)).div(sum);
    remaining = remaining.minus(value);
    return value;
  });
}
