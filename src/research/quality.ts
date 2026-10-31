import type { RunRecord } from "../domain/contracts.js";
import { hash } from "../adapters/market.js";
import { verifyRun } from "./evaluation.js";

/** Deterministic moving-block bootstrap of UTC daily returns, descriptive only. */
export function researchQuality(run: RunRecord, searches: number) {
  verifyRun(run);
  const days = new Map<string, number>();
  for (const p of run.result!.state.curve)
    days.set(
      new Date(Math.max(0, p.at - 1)).toISOString().slice(0, 10),
      Number(p.equity),
    );
  const equity = [...days.values()];
  const returns = equity
    .slice(1)
    .map((v, i) => (equity[i]! > 0 ? v / equity[i]! - 1 : NaN));
  const dates = [...days.keys()].map((d) => Date.parse(d + "T00:00:00Z"));
  const continuous = dates.every(
    (d, i) => i === 0 || d - dates[i - 1]! === 86400000,
  );
  const n = returns.length,
    block = Math.max(2, Math.ceil(Math.sqrt(n)));
  let seed = parseInt(run.result!.hash.slice(0, 8), 16) || 1;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const means: number[] = [];
  if (continuous && n >= 30 && returns.every(Number.isFinite))
    for (let trial = 0; trial < 500; trial++) {
      let sum = 0,
        count = 0;
      while (count < n) {
        const start = Math.floor(random() * (n - block + 1));
        for (let j = 0; j < block && count < n; j++, count++)
          sum += returns[start + j]!;
      }
      means.push((sum / n) * 100);
    }
  means.sort((a, b) => a - b);
  const body = {
    version: 1,
    runId: run.id,
    resultHash: run.result!.hash,
    dailySamples: n,
    continuous,
    searches,
    method: "moving-block-bootstrap-500" as const,
    blockDays: block,
    meanDailyReturnIntervalPct: means.length ? [means[12]!, means[487]!] : null,
    limitations: [
      "区间为日均收益的描述性95%重采样区间，不是未来收益或盈利概率。",
      "未校正候选相关性与多重筛选；累计搜索次数需结合完整研究历史解释。",
      "少于30个日收益时不计算；区块长度由样本数平方根冻结，跨日缺口不可解释为连续观察。",
    ],
  };
  return { ...body, hash: hash(body) };
}
