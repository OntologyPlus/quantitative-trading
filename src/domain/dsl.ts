import type { Bar } from "./contracts.js";

/**
 * Strategy expression language.
 *
 * A small, side-effect-free language for entry/exit rules and ranking scores:
 *
 *   cross_above(ema(close, 12), ema(close, 26)) and adx(14) > 25
 *   rsi(close, 14) < 30 or close < bb_lower(close, 20, 2)
 *   roc(close, 168) - 0.5 * rvol(168)            (a ranking score)
 *
 * Expressions are parsed into a typed AST; nothing is executed as code.
 * Indicators are computed in IEEE-754 float64 using only + − × ÷ and sqrt,
 * which are correctly rounded, so results are bit-for-bit reproducible across
 * machines. Values are computed from the retained closed-bar history only.
 */

export type Kind = "series" | "bool";
export type Node =
  | { t: "num"; v: number; raw: string }
  | { t: "price"; f: "open" | "high" | "low" | "close" | "volume" }
  | { t: "call"; fn: string; args: Node[] }
  | { t: "bin"; op: "+" | "-" | "*" | "/"; a: Node; b: Node }
  | { t: "neg"; a: Node }
  | { t: "cmp"; op: "<" | ">" | "<=" | ">="; a: Node; b: Node }
  | { t: "logic"; op: "and" | "or"; a: Node; b: Node }
  | { t: "not"; a: Node };

export class DslError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

interface Fn {
  /** Argument shape: s = series, n = positive integer period, k = number. */
  sig: string;
  kind: Kind;
  doc: string;
}
const MAX_PERIOD = 1000;
export const FUNCTIONS: Record<string, Fn> = {
  sma: { sig: "sn", kind: "series", doc: "简单均线 sma(序列, 周期)" },
  ema: { sig: "sn", kind: "series", doc: "指数均线 ema(序列, 周期)" },
  wma: { sig: "sn", kind: "series", doc: "线性加权均线 wma(序列, 周期)" },
  rsi: { sig: "sn", kind: "series", doc: "Wilder RSI rsi(序列, 周期)，0–100" },
  atr: { sig: "n", kind: "series", doc: "Wilder 平均真实波幅 atr(周期)" },
  natr: { sig: "n", kind: "series", doc: "atr / close × 100" },
  adx: { sig: "n", kind: "series", doc: "Wilder ADX adx(周期)，0–100" },
  plus_di: { sig: "n", kind: "series", doc: "+DI plus_di(周期)" },
  minus_di: { sig: "n", kind: "series", doc: "−DI minus_di(周期)" },
  highest: { sig: "sn", kind: "series", doc: "含当前 K 线的区间最高 highest(序列, 周期)" },
  lowest: { sig: "sn", kind: "series", doc: "含当前 K 线的区间最低 lowest(序列, 周期)" },
  stdev: { sig: "sn", kind: "series", doc: "总体标准差 stdev(序列, 周期)" },
  zscore: { sig: "sn", kind: "series", doc: "(序列 − 均值) / 标准差 zscore(序列, 周期)" },
  bb_mid: { sig: "snk", kind: "series", doc: "布林中轨 bb_mid(序列, 周期, 倍数)" },
  bb_upper: { sig: "snk", kind: "series", doc: "布林上轨 bb_upper(序列, 周期, 倍数)" },
  bb_lower: { sig: "snk", kind: "series", doc: "布林下轨 bb_lower(序列, 周期, 倍数)" },
  macd: { sig: "snn", kind: "series", doc: "ema(快) − ema(慢) macd(序列, 快, 慢)" },
  macd_signal: { sig: "snnn", kind: "series", doc: "MACD 信号线 macd_signal(序列, 快, 慢, 信号)" },
  macd_hist: { sig: "snnn", kind: "series", doc: "MACD 柱 macd_hist(序列, 快, 慢, 信号)" },
  roc: { sig: "sn", kind: "series", doc: "涨跌幅 % roc(序列, 周期)" },
  rvol: { sig: "n", kind: "series", doc: "逐根对数近似收益（简单收益）的标准差 %，rvol(周期)" },
  vwap: { sig: "n", kind: "series", doc: "滚动成交量加权均价 vwap(周期)" },
  lag: { sig: "sn", kind: "series", doc: "前 n 根的值 lag(序列, n)" },
  abs: { sig: "s", kind: "series", doc: "绝对值" },
  min: { sig: "ss", kind: "series", doc: "两者较小" },
  max: { sig: "ss", kind: "series", doc: "两者较大" },
  cross_above: { sig: "ss", kind: "bool", doc: "本根上穿：前一根 a ≤ b 且本根 a > b" },
  cross_below: { sig: "ss", kind: "bool", doc: "本根下穿：前一根 a ≥ b 且本根 a < b" },
  rising: { sig: "sn", kind: "bool", doc: "连续 n 根上升 rising(序列, n)" },
  falling: { sig: "sn", kind: "bool", doc: "连续 n 根下降 falling(序列, n)" },
};
const PRICES = new Set(["open", "high", "low", "close", "volume"]);

// ---------------------------------------------------------------- parser
type Tok = { k: "num" | "id" | "op" | "end"; v: string; at: number };
function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const at = i;
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+(\.\d+)?|\.\d+)/.exec(src.slice(i));
      if (!m) throw new DslError(`无效数字`, at);
      out.push({ k: "num", v: m[0], at });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: "id", v: m[0].toLowerCase(), at });
      i += m[0].length;
    } else {
      const two = src.slice(i, i + 2);
      if (two === "<=" || two === ">=" || two === "&&" || two === "||") {
        out.push({ k: "op", v: two === "&&" ? "and" : two === "||" ? "or" : two, at });
        i += 2;
      } else if ("+-*/(),<>!".includes(c)) {
        out.push({ k: "op", v: c === "!" ? "not" : c, at });
        i++;
      } else throw new DslError(`无法识别的字符 “${c}”`, at);
    }
  }
  out.push({ k: "end", v: "", at: src.length });
  return out;
}

export function parse(src: string, expect: Kind): Node {
  if (src.length > 2000) throw new DslError("表达式超过 2000 字符", 0);
  const toks = lex(src);
  let p = 0,
    nodes = 0;
  const peek = () => toks[p]!,
    next = () => toks[p++]!,
    isOp = (v: string) => {
      const t = peek();
      return (t.k === "op" || t.k === "id") && t.v === v;
    },
    eat = (v: string) => {
      const t = next();
      if (t.v !== v) throw new DslError(`此处应为 “${v}”`, t.at);
    },
    count = <T extends Node>(n: T): T => {
      if (++nodes > 200) throw new DslError("表达式过于复杂（超过 200 个节点）", 0);
      return n;
    };
  const kindOf = (n: Node): Kind =>
    n.t === "cmp" || n.t === "logic" || n.t === "not" || (n.t === "call" && FUNCTIONS[n.fn]!.kind === "bool")
      ? "bool"
      : "series";
  const want = (n: Node, k: Kind, at: number) => {
    if (kindOf(n) !== k)
      throw new DslError(k === "bool" ? "此处需要条件（比较或 cross_above 等）" : "此处需要数值序列，不能是条件", at);
    return n;
  };
  function or(): Node {
    let a = and();
    while (isOp("or")) {
      const at = next().at;
      a = count({ t: "logic", op: "or", a: want(a, "bool", at), b: want(and(), "bool", at) });
    }
    return a;
  }
  function and(): Node {
    let a = not();
    while (isOp("and")) {
      const at = next().at;
      a = count({ t: "logic", op: "and", a: want(a, "bool", at), b: want(not(), "bool", at) });
    }
    return a;
  }
  function not(): Node {
    if (isOp("not")) {
      const at = next().at;
      return count({ t: "not", a: want(not(), "bool", at) });
    }
    return cmp();
  }
  function cmp(): Node {
    const a = sum(),
      t = peek();
    if (t.k === "op" && ["<", ">", "<=", ">="].includes(t.v)) {
      next();
      return count({
        t: "cmp",
        op: t.v as "<",
        a: want(a, "series", t.at),
        b: want(sum(), "series", t.at),
      });
    }
    return a;
  }
  function sum(): Node {
    let a = prod();
    while (isOp("+") || isOp("-")) {
      const t = next();
      a = count({ t: "bin", op: t.v as "+", a: want(a, "series", t.at), b: want(prod(), "series", t.at) });
    }
    return a;
  }
  function prod(): Node {
    let a = unary();
    while (isOp("*") || isOp("/")) {
      const t = next();
      a = count({ t: "bin", op: t.v as "*", a: want(a, "series", t.at), b: want(unary(), "series", t.at) });
    }
    return a;
  }
  function unary(): Node {
    if (isOp("-")) {
      const at = next().at;
      const a = want(unary(), "series", at);
      return a.t === "num" ? count({ t: "num", v: -a.v, raw: `-${a.raw}` }) : count({ t: "neg", a });
    }
    return primary();
  }
  function primary(): Node {
    const t = next();
    if (t.k === "num") return count({ t: "num", v: Number(t.v), raw: t.v });
    if (t.k === "op" && t.v === "(") {
      const e = or();
      eat(")");
      return e;
    }
    if (t.k === "id") {
      if (PRICES.has(t.v)) return count({ t: "price", f: t.v as "close" });
      const fn = FUNCTIONS[t.v];
      if (!fn) throw new DslError(`未知函数或字段 “${t.v}”`, t.at);
      eat("(");
      const args: Node[] = [];
      if (!isOp(")"))
        for (;;) {
          args.push(or());
          if (isOp(",")) next();
          else break;
        }
      eat(")");
      if (args.length !== fn.sig.length)
        throw new DslError(`${t.v} 需要 ${fn.sig.length} 个参数`, t.at);
      fn.sig.split("").forEach((s, i) => {
        const a = args[i]!;
        if (s === "s") want(a, "series", t.at);
        else {
          if (a.t !== "num") throw new DslError(`${t.v} 的第 ${i + 1} 个参数须为数字常量`, t.at);
          if (s === "n" && (!Number.isInteger(a.v) || a.v < 1 || a.v > MAX_PERIOD))
            throw new DslError(`${t.v} 的周期须为 1–${MAX_PERIOD} 的整数`, t.at);
          if (s === "k" && !(a.v > 0 && a.v <= 10))
            throw new DslError(`${t.v} 的倍数须在 (0, 10] 内`, t.at);
        }
      });
      if ((t.v === "macd" || t.v === "macd_signal" || t.v === "macd_hist") && !((args[1] as { v: number }).v < (args[2] as { v: number }).v))
        throw new DslError("MACD 快线周期须小于慢线周期", t.at);
      return count({ t: "call", fn: t.v, args });
    }
    throw new DslError(t.k === "end" ? "表达式不完整" : `此处不应出现 “${t.v}”`, t.at);
  }
  const root = or();
  if (peek().k !== "end") throw new DslError(`多余的内容 “${peek().v}”`, peek().at);
  want(root, expect, 0);
  const lb = lookback(root);
  if (lb > 4000) throw new DslError(`指标预热需要 ${lb} 根，超过 4000 根上限`, 0);
  return root;
}

/** Canonical text: stable across formatting, used for hashing and display. */
export function print(n: Node): string {
  const prec = (x: Node) =>
    x.t === "logic" ? (x.op === "or" ? 1 : 2) : x.t === "not" ? 3 : x.t === "cmp" ? 4 : x.t === "bin" ? (x.op === "+" || x.op === "-" ? 5 : 6) : 8;
  const wrap = (x: Node, min: number) => (prec(x) < min ? `(${print(x)})` : print(x));
  switch (n.t) {
    case "num":
      return n.raw;
    case "price":
      return n.f;
    case "call":
      return `${n.fn}(${n.args.map(print).join(", ")})`;
    case "neg":
      return `-${wrap(n.a, 7)}`;
    case "bin":
      return `${wrap(n.a, prec(n))} ${n.op} ${wrap(n.b, prec(n) + 1)}`;
    case "cmp":
      return `${wrap(n.a, 5)} ${n.op} ${wrap(n.b, 5)}`;
    case "logic":
      return `${wrap(n.a, prec(n))} ${n.op} ${wrap(n.b, prec(n) + 1)}`;
    case "not":
      return `not ${wrap(n.a, 3)}`;
  }
}

/** Bars of history needed before the node's value is defined (and warmed up). */
export function lookback(n: Node): number {
  switch (n.t) {
    case "num":
      return 0;
    case "price":
      return 1;
    case "neg":
    case "not":
      return lookback(n.a);
    case "bin":
    case "cmp":
    case "logic":
      return Math.max(lookback(n.a), lookback(n.b));
    case "call": {
      const s = n.args[0] && n.args[0].t !== "num" ? lookback(n.args[0]) : 1,
        k = (i: number) => (n.args[i] as { v: number }).v;
      switch (n.fn) {
        case "sma":
        case "wma":
        case "highest":
        case "lowest":
        case "stdev":
        case "zscore":
        case "bb_mid":
        case "bb_upper":
        case "bb_lower":
          return s + k(1) - 1;
        case "ema":
          return s + 4 * k(1);
        case "rsi":
          return s + 4 * k(1) + 1;
        case "atr":
        case "natr":
        case "plus_di":
        case "minus_di":
          return 4 * k(0) + 1;
        case "adx":
          return 8 * k(0) + 1;
        case "macd":
          return s + 4 * k(2);
        case "macd_signal":
        case "macd_hist":
          return s + 4 * k(2) + 4 * k(3);
        case "roc":
        case "lag":
          return s + k(1);
        case "rising":
        case "falling":
          return s + k(1);
        case "rvol":
          return k(0) + 1;
        case "vwap":
          return k(0);
        case "abs":
          return s;
        case "min":
        case "max":
        case "cross_above":
        case "cross_below":
          return Math.max(lookback(n.args[0]!), lookback(n.args[1]!)) + (n.fn.startsWith("cross") ? 1 : 0);
      }
      return s;
    }
  }
}

/** Multiplies every period argument by `factor` (robustness neighbours). */
export function scalePeriods(n: Node, factor: number): Node {
  if (n.t === "call") {
    const fn = FUNCTIONS[n.fn]!;
    return {
      ...n,
      args: n.args.map((a, i) => {
        if (fn.sig[i] === "n" && a.t === "num") {
          const v = Math.max(1, Math.min(MAX_PERIOD, Math.round(a.v * factor)));
          return { t: "num", v, raw: String(v) };
        }
        return scalePeriods(a, factor);
      }),
    };
  }
  if (n.t === "bin" || n.t === "cmp" || n.t === "logic")
    return { ...n, a: scalePeriods(n.a, factor), b: scalePeriods(n.b, factor) };
  if (n.t === "neg" || n.t === "not") return { ...n, a: scalePeriods(n.a, factor) };
  return n;
}

// ---------------------------------------------------------------- evaluation
const numbers = new WeakMap<Bar, Float64Array>();
function barNumbers(b: Bar) {
  let v = numbers.get(b);
  if (!v) {
    v = new Float64Array([Number(b.open), Number(b.high), Number(b.low), Number(b.close), Number(b.volume)]);
    numbers.set(b, v);
  }
  return v;
}
const FIELD = { open: 0, high: 1, low: 2, close: 3, volume: 4 } as const;

class Ctx {
  readonly L: number;
  private memo = new Map<string, Float64Array>();
  private cols = new Map<number, Float64Array>();
  constructor(readonly history: Bar[]) {
    this.L = history.length;
  }
  col(f: number) {
    let c = this.cols.get(f);
    if (!c) {
      c = new Float64Array(this.L);
      for (let i = 0; i < this.L; i++) c[i] = barNumbers(this.history[i]!)[f]!;
      this.cols.set(f, c);
    }
    return c;
  }
  series(n: Node): Float64Array {
    const key = print(n);
    let v = this.memo.get(key);
    if (!v) this.memo.set(key, (v = compute(this, n)));
    return v;
  }
}

const nan = (L: number) => new Float64Array(L).fill(NaN);
/** Rolling mean with a running sum; NaN until `p` defined values. */
function rollingMean(x: Float64Array, p: number) {
  const L = x.length,
    out = nan(L);
  let sum = 0,
    run = 0;
  for (let i = 0; i < L; i++) {
    const v = x[i]!;
    if (Number.isNaN(v)) {
      sum = 0;
      run = 0;
      continue;
    }
    sum += v;
    run++;
    if (run > p) sum -= x[i - p]!;
    if (run >= p) out[i] = sum / p;
  }
  return out;
}
/** Population standard deviation; sums are centred on a reference value to limit cancellation. */
function rollingStd(x: Float64Array, p: number) {
  const L = x.length,
    out = nan(L);
  let s1 = 0,
    s2 = 0,
    run = 0,
    ref = NaN;
  for (let i = 0; i < L; i++) {
    const v = x[i]!;
    if (Number.isNaN(v)) {
      s1 = s2 = run = 0;
      ref = NaN;
      continue;
    }
    if (Number.isNaN(ref)) ref = v;
    const d = v - ref;
    s1 += d;
    s2 += d * d;
    run++;
    if (run > p) {
      const o = x[i - p]! - ref;
      s1 -= o;
      s2 -= o * o;
    }
    if (run >= p) out[i] = Math.sqrt(Math.max(0, s2 / p - (s1 / p) * (s1 / p)));
  }
  return out;
}
/** Monotonic-deque rolling max/min over the window ending at i (inclusive). */
function rollingExtreme(x: Float64Array, p: number, max: boolean) {
  const L = x.length,
    out = nan(L),
    dq = new Int32Array(L);
  let head = 0,
    tail = 0,
    run = 0;
  for (let i = 0; i < L; i++) {
    const v = x[i]!;
    if (Number.isNaN(v)) {
      head = tail = run = 0;
      continue;
    }
    run++;
    while (tail > head && (max ? x[dq[tail - 1]!]! <= v : x[dq[tail - 1]!]! >= v)) tail--;
    dq[tail++] = i;
    while (dq[head]! <= i - p) head++;
    if (run >= p) out[i] = x[dq[head]!]!;
  }
  return out;
}
/** EMA seeded with the SMA of the first `p` defined values. */
function ema(x: Float64Array, p: number, alpha = 2 / (p + 1)) {
  const L = x.length,
    out = nan(L);
  let start = 0;
  while (start < L && Number.isNaN(x[start]!)) start++;
  if (start + p > L) return out;
  let s = 0;
  for (let i = start; i < start + p; i++) s += x[i]!;
  let v = s / p;
  out[start + p - 1] = v;
  for (let i = start + p; i < L; i++) {
    v = alpha * x[i]! + (1 - alpha) * v;
    out[i] = v;
  }
  return out;
}
const wilder = (x: Float64Array, p: number) => ema(x, p, 1 / p);
function trueRange(c: Ctx) {
  const h = c.col(1),
    l = c.col(2),
    cl = c.col(3),
    out = nan(c.L);
  for (let i = 1; i < c.L; i++)
    out[i] = Math.max(h[i]! - l[i]!, Math.abs(h[i]! - cl[i - 1]!), Math.abs(l[i]! - cl[i - 1]!));
  return out;
}
function directional(c: Ctx, p: number) {
  const h = c.col(1),
    l = c.col(2),
    up = nan(c.L),
    dn = nan(c.L);
  for (let i = 1; i < c.L; i++) {
    const u = h[i]! - h[i - 1]!,
      d = l[i - 1]! - l[i]!;
    up[i] = u > d && u > 0 ? u : 0;
    dn[i] = d > u && d > 0 ? d : 0;
  }
  const tr = wilder(trueRange(c), p),
    pu = wilder(up, p),
    pd = wilder(dn, p),
    plus = nan(c.L),
    minus = nan(c.L),
    dx = nan(c.L);
  for (let i = 0; i < c.L; i++) {
    if (Number.isNaN(tr[i]!) || tr[i] === 0) continue;
    plus[i] = (100 * pu[i]!) / tr[i]!;
    minus[i] = (100 * pd[i]!) / tr[i]!;
    const s = plus[i]! + minus[i]!;
    dx[i] = s === 0 ? 0 : (100 * Math.abs(plus[i]! - minus[i]!)) / s;
  }
  return { plus, minus, adx: wilder(dx, p) };
}
function map2(a: Float64Array, b: Float64Array, f: (x: number, y: number) => number) {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = f(a[i]!, b[i]!);
  return out;
}

function compute(c: Ctx, n: Node): Float64Array {
  const L = c.L;
  switch (n.t) {
    case "num":
      return new Float64Array(L).fill(n.v);
    case "price":
      return c.col(FIELD[n.f]);
    case "neg":
      return c.series(n.a).map((x) => -x);
    case "bin": {
      const a = c.series(n.a),
        b = c.series(n.b);
      return map2(a, b, (x, y) =>
        n.op === "+" ? x + y : n.op === "-" ? x - y : n.op === "*" ? x * y : y === 0 ? NaN : x / y,
      );
    }
    case "cmp":
    case "logic":
    case "not":
      throw Error("条件不是数值序列");
    case "call": {
      const s = () => c.series(n.args[0]!),
        k = (i: number) => (n.args[i] as { v: number }).v;
      switch (n.fn) {
        case "sma":
        case "bb_mid":
          return rollingMean(s(), k(1));
        case "wma": {
          const x = s(),
            p = k(1),
            out = nan(L),
            w = (p * (p + 1)) / 2;
          let num = 0,
            sum = 0,
            run = 0;
          for (let i = 0; i < L; i++) {
            const v = x[i]!;
            if (Number.isNaN(v)) {
              num = sum = run = 0;
              continue;
            }
            run++;
            if (run <= p) {
              num += v * run;
              sum += v;
            } else {
              num += p * v - sum;
              sum += v - x[i - p]!;
            }
            if (run >= p) out[i] = num / w;
          }
          return out;
        }
        case "ema":
          return ema(s(), k(1));
        case "rsi": {
          const x = s(),
            g = nan(L),
            d = nan(L);
          for (let i = 1; i < L; i++) {
            const ch = x[i]! - x[i - 1]!;
            g[i] = ch > 0 ? ch : 0;
            d[i] = ch < 0 ? -ch : 0;
          }
          const ag = wilder(g, k(1)),
            ad = wilder(d, k(1));
          return map2(ag, ad, (u, v) => (Number.isNaN(u) || Number.isNaN(v) ? NaN : v === 0 ? (u === 0 ? 50 : 100) : 100 - 100 / (1 + u / v)));
        }
        case "atr":
          return wilder(trueRange(c), k(0));
        case "natr":
          return map2(wilder(trueRange(c), k(0)), c.col(3), (a, cl) => (a / cl) * 100);
        case "adx":
          return directional(c, k(0)).adx;
        case "plus_di":
          return directional(c, k(0)).plus;
        case "minus_di":
          return directional(c, k(0)).minus;
        case "highest":
        case "lowest":
          return rollingExtreme(s(), k(1), n.fn === "highest");
        case "stdev":
          return rollingStd(s(), k(1));
        case "zscore": {
          const x = s();
          return map2(map2(x, rollingMean(x, k(1)), (a, m) => a - m), rollingStd(x, k(1)), (d, sd) => (sd === 0 ? NaN : d / sd));
        }
        case "bb_upper":
        case "bb_lower": {
          const x = s(),
            sign = n.fn === "bb_upper" ? 1 : -1;
          return map2(rollingMean(x, k(1)), rollingStd(x, k(1)), (m, sd) => m + sign * k(2) * sd);
        }
        case "macd":
        case "macd_signal":
        case "macd_hist": {
          const x = s(),
            line = map2(ema(x, k(1)), ema(x, k(2)), (a, b) => a - b);
          if (n.fn === "macd") return line;
          const sig = ema(line, k(3));
          return n.fn === "macd_signal" ? sig : map2(line, sig, (a, b) => a - b);
        }
        case "roc": {
          const x = s(),
            p = k(1),
            out = nan(L);
          for (let i = p; i < L; i++) out[i] = x[i - p] === 0 ? NaN : (x[i]! / x[i - p]! - 1) * 100;
          return out;
        }
        case "lag": {
          const x = s(),
            p = k(1),
            out = nan(L);
          for (let i = p; i < L; i++) out[i] = x[i - p]!;
          return out;
        }
        case "rvol": {
          const cl = c.col(3),
            r = nan(L),
            p = k(0);
          for (let i = 1; i < L; i++) r[i] = (cl[i]! / cl[i - 1]! - 1) * 100;
          // Sample standard deviation of simple returns, in percent per bar.
          const f = Math.sqrt(p / Math.max(1, p - 1));
          return rollingStd(r, p).map((sd) => sd * f);
        }
        case "vwap": {
          const h = c.col(1),
            l = c.col(2),
            cl = c.col(3),
            v = c.col(4),
            p = k(0),
            pv = new Float64Array(L),
            out = nan(L);
          for (let i = 0; i < L; i++) pv[i] = ((h[i]! + l[i]! + cl[i]!) / 3) * v[i]!;
          const a = rollingMean(pv, p),
            b = rollingMean(v, p);
          for (let i = 0; i < L; i++) out[i] = b[i] === 0 ? NaN : a[i]! / b[i]!;
          return out;
        }
        case "abs":
          return s().map(Math.abs);
        case "min":
        case "max": {
          const a = s(),
            b = c.series(n.args[1]!);
          return map2(a, b, (x, y) => (Number.isNaN(x) || Number.isNaN(y) ? NaN : n.fn === "min" ? Math.min(x, y) : Math.max(x, y)));
        }
      }
      throw Error(`函数 ${n.fn} 不是数值序列`);
    }
  }
}

function truth(c: Ctx, n: Node, i: number): boolean {
  if (i < 0) return false;
  switch (n.t) {
    case "cmp": {
      const a = c.series(n.a)[i]!,
        b = c.series(n.b)[i]!;
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return n.op === "<" ? a < b : n.op === ">" ? a > b : n.op === "<=" ? a <= b : a >= b;
    }
    case "logic":
      return n.op === "and" ? truth(c, n.a, i) && truth(c, n.b, i) : truth(c, n.a, i) || truth(c, n.b, i);
    case "not":
      return !truth(c, n.a, i);
    case "call": {
      const a = c.series(n.args[0]!);
      if (n.fn === "rising" || n.fn === "falling") {
        const p = (n.args[1] as { v: number }).v;
        if (i - p < 0) return false;
        for (let j = i - p + 1; j <= i; j++) {
          const x = a[j]!,
            y = a[j - 1]!;
          if (Number.isNaN(x) || Number.isNaN(y) || (n.fn === "rising" ? !(x > y) : !(x < y))) return false;
        }
        return true;
      }
      const b = c.series(n.args[1]!);
      if (i < 1) return false;
      const a0 = a[i - 1]!,
        b0 = b[i - 1]!,
        a1 = a[i]!,
        b1 = b[i]!;
      if ([a0, b0, a1, b1].some(Number.isNaN)) return false;
      return n.fn === "cross_above" ? a0 <= b0 && a1 > b1 : a0 >= b0 && a1 < b1;
    }
  }
  throw Error("不是条件表达式");
}

const compiled = new Map<string, Node>();
/** Parses with a process-wide cache; definitions are validated on save. */
export function compile(src: string, kind: Kind): Node {
  const key = `${kind}\0${src}`;
  let n = compiled.get(key);
  if (!n) {
    n = parse(src, kind);
    if (compiled.size > 512) compiled.clear();
    compiled.set(key, n);
  }
  return n;
}

/**
 * Evaluates expressions at the last bar of `history`. One context per call
 * shares indicator series between the given expressions.
 */
export function evaluate(history: Bar[], conditions: Node[], scores: Node[] = []) {
  const c = new Ctx(history),
    i = history.length - 1;
  return {
    conditions: conditions.map((n) => truth(c, n, i)),
    scores: scores.map((n) => c.series(n)[i] ?? NaN),
  };
}
/** Series value at every retained bar (for tests and charts). */
export function seriesOf(history: Bar[], n: Node) {
  return new Ctx(history).series(n);
}
