/**
 * Selection-bias statistics for strategy research.
 *
 * - Probabilistic and Deflated Sharpe Ratio (Bailey & López de Prado 2012/2014)
 * - Probability of Backtest Overfitting via CSCV (Bailey, Borwein, López de
 *   Prado & Zhu 2015)
 * - White's Reality Check with the stationary bootstrap (White 2000;
 *   Politis & Romano 1994)
 *
 * All Sharpe ratios here are per observation (not annualised). Bootstraps use
 * a seeded xorshift generator, so results are reproducible from their inputs.
 */

const EULER_GAMMA = 0.5772156649015329;

export function mean(x: ArrayLike<number>) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]!;
  return x.length ? s / x.length : NaN;
}
/** Sample standard deviation. */
export function stdev(x: ArrayLike<number>) {
  const m = mean(x);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i]! - m) ** 2;
  return x.length > 1 ? Math.sqrt(s / (x.length - 1)) : NaN;
}
export function sharpe(x: ArrayLike<number>) {
  const sd = stdev(x);
  return sd > 0 ? mean(x) / sd : NaN;
}
/** Skewness and (non-excess) kurtosis using population moments. */
export function moments(x: ArrayLike<number>) {
  const m = mean(x),
    n = x.length;
  let m2 = 0,
    m3 = 0,
    m4 = 0;
  for (let i = 0; i < n; i++) {
    const d = x[i]! - m;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  return { skew: m2 > 0 ? m3 / m2 ** 1.5 : 0, kurt: m2 > 0 ? m4 / (m2 * m2) : 3 };
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf, |error| < 1.5e-7). */
export function normCdf(z: number) {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2)),
    y =
      1 -
      ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
        t *
        Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
/** Inverse standard normal CDF (Acklam, relative error < 1.2e-9). */
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : NaN;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239],
    b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572],
    c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783],
    d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416],
    lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5,
    r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** P(true Sharpe > benchmark) given an observed per-period Sharpe. */
export function probabilisticSharpe(returns: ArrayLike<number>, benchmark = 0) {
  const n = returns.length,
    sr = sharpe(returns),
    { skew, kurt } = moments(returns);
  if (!(n > 2) || !Number.isFinite(sr)) return NaN;
  const denom = Math.sqrt(1 - skew * sr + ((kurt - 1) / 4) * sr * sr);
  return normCdf(((sr - benchmark) * Math.sqrt(n - 1)) / denom);
}
/** Expected maximum Sharpe of `trials` independent zero-skill strategies. */
export function expectedMaxSharpe(trials: number, srVariance: number) {
  if (trials <= 1) return 0;
  return (
    Math.sqrt(srVariance) *
    ((1 - EULER_GAMMA) * normInv(1 - 1 / trials) + EULER_GAMMA * normInv(1 - 1 / (trials * Math.E)))
  );
}
/**
 * Deflated Sharpe Ratio of the selected strategy: PSR against the Sharpe the
 * best of `trialSharpes.length` skill-less trials would show by luck.
 */
export function deflatedSharpe(selected: ArrayLike<number>, trialSharpes: number[]) {
  const finite = trialSharpes.filter(Number.isFinite),
    variance = finite.length > 1 ? stdev(finite) ** 2 : 0,
    sr0 = expectedMaxSharpe(Math.max(1, trialSharpes.length), variance);
  return {
    trials: trialSharpes.length,
    observedSharpe: sharpe(selected),
    benchmarkSharpe: sr0,
    psr: probabilisticSharpe(selected, 0),
    dsr: probabilisticSharpe(selected, sr0),
  };
}

function* combinations(n: number, k: number): Generator<number[]> {
  const idx = Array.from({ length: k }, (_, i) => i);
  for (;;) {
    yield idx.slice();
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]!++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1]! + 1;
  }
}
/**
 * Combinatorially symmetric cross-validation. `matrix[t][j]` is the return of
 * configuration j in period t. Rows are cut into `blocks` contiguous groups;
 * every half/half split picks the in-sample best and records its out-of-sample
 * relative rank. PBO is the share of splits where that rank is below median.
 */
export function pbo(matrix: number[][], blocks = 16) {
  const T = matrix.length,
    N = matrix[0]?.length ?? 0;
  if (N < 2) return null;
  const S = Math.min(blocks - (blocks % 2), 2 * Math.floor(T / 4));
  if (S < 4) return null;
  const size = Math.floor(T / S);
  // Per block and configuration: count, sum and sum of squares.
  const cnt = new Float64Array(S),
    sum = new Float64Array(S * N),
    sq = new Float64Array(S * N);
  for (let g = 0; g < S; g++) {
    const a = g * size,
      b = g === S - 1 ? T : (g + 1) * size;
    cnt[g] = b - a;
    for (let t = a; t < b; t++) {
      const row = matrix[t]!;
      for (let j = 0; j < N; j++) {
        const v = row[j]!;
        sum[g * N + j]! += v;
        sq[g * N + j]! += v * v;
      }
    }
  }
  const sr = (groups: number[], j: number) => {
    let n = 0,
      s1 = 0,
      s2 = 0;
    for (const g of groups) {
      n += cnt[g]!;
      s1 += sum[g * N + j]!;
      s2 += sq[g * N + j]!;
    }
    const v = (s2 - (s1 * s1) / n) / (n - 1);
    return v > 0 ? s1 / n / Math.sqrt(v) : -Infinity;
  };
  const logits: number[] = [];
  let below = 0;
  for (const train of combinations(S, S / 2)) {
    const inSet = new Set(train),
      test = Array.from({ length: S }, (_, g) => g).filter((g) => !inSet.has(g));
    let best = 0,
      bestIn = -Infinity;
    for (let j = 0; j < N; j++) {
      const v = sr(train, j);
      if (v > bestIn) {
        bestIn = v;
        best = j;
      }
    }
    const target = sr(test, best);
    let rank = 0;
    for (let j = 0; j < N; j++) if (sr(test, j) < target) rank++;
    // Relative rank of the in-sample winner out of sample, in (0, 1).
    const w = (rank + 1) / (N + 1),
      logit = Math.log(w / (1 - w));
    logits.push(logit);
    if (logit <= 0) below++;
  }
  logits.sort((a, b) => a - b);
  return {
    pbo: below / logits.length,
    splits: logits.length,
    blocks: S,
    medianLogit: logits[Math.floor(logits.length / 2)]!,
  };
}

/** Deterministic xorshift32 in [0, 1). */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
/**
 * White's Reality Check: is the best of N strategies' mean excess return
 * explainable by luck? `excess[t][j]` = return of strategy j minus benchmark.
 * Stationary bootstrap with mean block length `block`.
 */
export function realityCheck(excess: number[][], options: { samples?: number; block?: number; seed?: number } = {}) {
  const T = excess.length,
    N = excess[0]?.length ?? 0;
  if (T < 10 || N < 1) return null;
  const B = options.samples ?? 500,
    block = options.block ?? Math.max(2, Math.round(Math.sqrt(T))),
    random = rng(options.seed ?? 1),
    means = Array.from({ length: N }, (_, j) => mean(excess.map((r) => r[j]!)));
  const stat = Math.sqrt(T) * Math.max(...means);
  let exceed = 0;
  const idx = new Int32Array(T);
  for (let b = 0; b < B; b++) {
    let t = Math.floor(random() * T);
    for (let i = 0; i < T; i++) {
      if (i > 0) t = random() < 1 / block ? Math.floor(random() * T) : (t + 1) % T;
      idx[i] = t;
    }
    let best = -Infinity;
    for (let j = 0; j < N; j++) {
      let s = 0;
      for (let i = 0; i < T; i++) s += excess[idx[i]!]![j]!;
      best = Math.max(best, Math.sqrt(T) * (s / T - means[j]!));
    }
    if (best >= stat) exceed++;
  }
  return { pValue: (exceed + 1) / (B + 1), statistic: stat, samples: B, block };
}

/** Simple returns from an equity series. */
export function toReturns(equity: ArrayLike<number>) {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) out.push(equity[i - 1]! > 0 ? equity[i]! / equity[i - 1]! - 1 : 0);
  return out;
}
