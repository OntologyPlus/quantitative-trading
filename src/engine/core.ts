import { conditionMatches, historyRequired } from "../domain/conditions.js";
import { compile, evaluate, seriesOf, type Node } from "../domain/dsl.js";
import { Decimal } from "decimal.js";
import { field, windowMax, windowMin, windowSum } from "./fixed.js";
import { INTERVAL_MS } from "../domain/contracts.js";
import type {
  Bar,
  Costs,
  Decision,
  EngineState,
  Fill,
  Intent,
  Metrics,
  Position,
  RunConfig,
  Strategy,
} from "../domain/contracts.js";
Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN });
export const D = (x: Decimal.Value) => new Decimal(x);
// Decimal values are immutable; reuse parses of strings that repeat across
// bars (cash, peak, day anchor, quantities, limits).
const parsedCache = new Map<string, Decimal>();
const Dm = (x: string) => {
  let v = parsedCache.get(x);
  if (!v) {
    if (parsedCache.size > 256) parsedCache.clear();
    parsedCache.set(x, (v = new Decimal(x)));
  }
  return v;
};
const s = (x: Decimal) => x.toFixed();
const percent = (x: Decimal) => x.mul(100);
export function initialState(cash: string): EngineState {
  return {
    cash,
    positions: {},
    prices: {},
    history: {},
    pending: {},
    fills: [],
    decisions: [],
    ledger: [],
    curve: [],
    peak: cash,
    day: "",
    dayStart: cash,
    sequence: 0,
    lastTime: {},
    stoppedOpening: false,
  };
}
export function equity(state: EngineState) {
  let e = Dm(state.cash);
  for (const symbol in state.positions)
    e = e.plus(
      Dm(state.positions[symbol]!.quantity).mul(state.prices[symbol] ?? "0"),
    );
  return e;
}
function log(
  st: EngineState,
  bar: Pick<Bar, "time" | "symbol">,
  code: string,
  reason: string,
  orderId?: string,
) {
  const value: Decision = {
    id: `d${++st.sequence}`,
    at: bar.time,
    symbol: bar.symbol,
    code,
    reason,
    facts: {
      cash: st.cash,
      equity: equity(st).toFixed(),
      observedPrice: st.prices[bar.symbol] ?? "unknown",
    },
  };
  if (orderId) value.orderId = orderId;
  st.decisions.push(value);
}
export function intent(
  st: EngineState,
  bar: Bar,
  side: "BUY" | "SELL",
  reason: string,
  signalAt: number,
  extra: Pick<Intent, "stopDistance" | "weightPct"> = {},
): Intent {
  const i: Intent = {
    id: `o${++st.sequence}`,
    symbol: bar.symbol,
    side,
    signalAt,
    reason,
  };
  if (extra.stopDistance !== undefined) i.stopDistance = extra.stopDistance;
  if (extra.weightPct !== undefined) i.weightPct = extra.weightPct;
  st.pending[bar.symbol] = i;
  log(st, { ...bar, time: signalAt }, "SIGNAL", reason, i.id);
  st.decisions.at(-1)!.facts = {
    ...st.decisions.at(-1)!.facts,
    barTime: String(bar.time),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  };
  return i;
}
export function execute(
  st: EngineState,
  cfg: RunConfig,
  i: Intent,
  price: string,
  volume: string,
  at: number,
) {
  const b = { time: at, symbol: i.symbol },
    rule = cfg.rules[i.symbol];
  if (!rule) {
    log(st, b, "RULES_MISSING", "缺少交易规则", i.id);
    delete st.pending[i.symbol];
    return;
  }
  const reject = (code: string, reason: string) => {
    log(st, b, code, reason, i.id);
    delete st.pending[i.symbol];
  };
  const mid = D(price),
    feeRate = D(cfg.costs.feeBps).div(10000),
    slipRate = D(cfg.costs.slippageBps).div(10000),
    px = mid.mul(i.side === "BUY" ? D(1).plus(slipRate) : D(1).minus(slipRate));
  const e = equity(st),
    p = st.positions[i.symbol];
  let q: Decimal;
  if (i.side === "BUY") {
    if (st.stoppedOpening) return reject("LOSS_LIMIT", "损失限制暂停新开仓");
    if (p) return reject("DUPLICATE_POSITION", "已持有该标的");
    if (Object.keys(st.positions).length >= cfg.risk.maxPositions)
      return reject("POSITION_LIMIT", "达到持仓数量上限");
    const exposure = e.minus(st.cash),
      maxSymbol = e.mul(cfg.risk.maxSymbolPct).div(100),
      remaining = e.mul(cfg.risk.maxExposurePct).div(100).minus(exposure);
    let target = e.mul(i.weightPct ?? cfg.risk.weightPct).div(100).div(px);
    if (cfg.risk.sizing === "risk")
      target = e
        .mul(cfg.risk.riskPct)
        .div(100)
        .div(
          px.mul(
            (i.stopDistance !== undefined
              ? D(i.stopDistance).div(px)
              : D(cfg.risk.stopLossPct).div(100)
            )
              .plus(feeRate.mul(2))
              .plus(slipRate.mul(2)),
          ),
        );
    q = Decimal.min(
      target,
      maxSymbol.div(px),
      remaining.div(px),
      D(st.cash).div(px.mul(D(1).plus(feeRate))),
      D(rule.maxQty),
    );
    q = q.div(rule.stepSize).floor().mul(rule.stepSize);
    if (q.lte(0)) return reject("INSUFFICIENT_CASH", "现金或敞口余量不足");
    if (q.lt(rule.minQty) || q.mul(px).lt(rule.minNotional))
      return reject("MIN_NOTIONAL", "数量或金额小于交易规则下限");
  } else {
    if (!p) return reject("NO_POSITION", "没有可卖持仓");
    q = D(p.quantity);
  }
  if (
    D(cfg.costs.participationPct).gt(0) &&
    q.gt(D(volume).mul(cfg.costs.participationPct).div(100))
  )
    return reject("LIQUIDITY_LIMIT", "订单超过配置的成交量参与上限");
  const value = q.mul(px),
    fee = value.mul(feeRate),
    fillId = `f${++st.sequence}`;
  let pnl: string | null = null;
  if (i.side === "BUY") {
    st.cash = s(D(st.cash).minus(value).minus(fee));
    st.positions[i.symbol] = {
      quantity: s(q),
      cost: s(value.plus(fee)),
      stop:
        i.stopDistance !== undefined
          ? s(Decimal.max(0, px.minus(i.stopDistance)))
          : Number(cfg.risk.stopLossPct) > 0
            ? s(px.mul(D(1).minus(D(cfg.risk.stopLossPct).div(100))))
            : "0",
      take:
        Number(cfg.risk.takeProfitPct) > 0
          ? s(px.mul(D(1).plus(D(cfg.risk.takeProfitPct).div(100))))
          : "0",
    };
    if (hasExtendedRisk(cfg.risk)) {
      st.positions[i.symbol]!.openedAt = at;
      st.positions[i.symbol]!.peak = s(px);
    }
  } else {
    pnl = s(value.minus(fee).minus(p!.cost));
    st.cash = s(D(st.cash).plus(value).minus(fee));
    delete st.positions[i.symbol];
  }
  const fill: Fill = {
    id: fillId,
    orderId: i.id,
    symbol: i.symbol,
    side: i.side,
    quantity: s(q),
    price: s(px),
    fee: s(fee),
    slippage: s(px.minus(mid).abs().mul(q)),
    at,
    signalAt: i.signalAt,
    reason: i.reason,
    realizedPnl: pnl,
  };
  st.fills.push(fill);
  st.ledger.push(
    {
      id: `${fillId}-cash`,
      fillId,
      asset: "USDT",
      delta: s(i.side === "BUY" ? value.neg() : value),
      kind: "trade",
    },
    {
      id: `${fillId}-base`,
      fillId,
      asset: i.symbol.slice(0, -4),
      delta: s(i.side === "BUY" ? q : q.neg()),
      kind: "trade",
    },
    {
      id: `${fillId}-fee`,
      fillId,
      asset: "USDT",
      delta: s(fee.neg()),
      kind: "fee",
    },
  );
  delete st.pending[i.symbol];
  log(st, b, "FILLED", i.reason, i.id);
  if (D(st.cash).lt(0)) throw Error("现金不能为负");
}
export function assertLedger(st: EngineState, initialCash: string) {
  const balances: Record<string, Decimal> = { USDT: D(initialCash) },
    ids = new Set<string>();
  for (const l of st.ledger) {
    if (ids.has(l.id)) throw Error("重复账本条目");
    ids.add(l.id);
    balances[l.asset] = (balances[l.asset] ?? D(0)).plus(l.delta);
  }
  if (!balances.USDT!.eq(st.cash) || D(st.cash).lt(0))
    throw Error("现金账本不一致");
  const positions: Record<string, { quantity: Decimal; cost: Decimal }> = {},
    fillIds = new Set<string>(),
    orderIds = new Set<string>();
  if (st.ledger.length !== st.fills.length * 3)
    throw Error("成交与账本条目数量不一致");
  const ledgerByFill = new Map<string, typeof st.ledger>();
  for (const l of st.ledger) {
    const group = ledgerByFill.get(l.fillId) ?? [];
    group.push(l);
    ledgerByFill.set(l.fillId, group);
  }
  for (const f of st.fills) {
    if (fillIds.has(f.id) || orderIds.has(f.orderId) || f.at < f.signalAt)
      throw Error("重复成交或无效成交时间");
    fillIds.add(f.id);
    orderIds.add(f.orderId);
    const q = D(f.quantity),
      value = q.mul(f.price),
      fee = D(f.fee),
      base = f.symbol.slice(0, -4),
      entries = ledgerByFill.get(f.id) ?? [];
    const expected = [
      {
        asset: "USDT",
        delta: f.side === "BUY" ? value.neg() : value,
        kind: "trade",
      },
      { asset: base, delta: f.side === "BUY" ? q : q.neg(), kind: "trade" },
      { asset: "USDT", delta: fee.neg(), kind: "fee" },
    ];
    if (
      entries.length !== 3 ||
      expected.some(
        (e, i) =>
          entries[i]!.asset !== e.asset ||
          !D(entries[i]!.delta).eq(e.delta) ||
          entries[i]!.kind !== e.kind,
      )
    )
      throw Error("成交与账本事实不一致");
    if (f.side === "BUY") {
      if (positions[f.symbol] || f.realizedPnl !== null)
        throw Error("无效重复开仓");
      positions[f.symbol] = { quantity: q, cost: value.plus(fee) };
    } else {
      const p = positions[f.symbol];
      if (
        !p ||
        !p.quantity.eq(q) ||
        f.realizedPnl === null ||
        !value.minus(fee).minus(p.cost).eq(f.realizedPnl)
      )
        throw Error("平仓成本或损益不一致");
      delete positions[f.symbol];
    }
  }
  if (Object.keys(positions).length !== Object.keys(st.positions).length)
    throw Error("持仓投影不一致");
  for (const [symbol, p] of Object.entries(st.positions))
    if (
      !positions[symbol]?.quantity.eq(p.quantity) ||
      !positions[symbol]!.cost.eq(p.cost) ||
      !D(p.quantity).eq(balances[symbol.slice(0, -4)] ?? 0)
    )
      throw Error("持仓账本不一致");
  for (const [asset, b] of Object.entries(balances))
    if (asset !== "USDT" && !b.eq(st.positions[`${asset}USDT`]?.quantity ?? 0))
      throw Error("基础资产账本不一致");
}
function signal(history: Bar[], strategy: Strategy): "BUY" | "SELL" | null {
  if (strategy.template === "expr") {
    const rules = strategy.rules!,
      [entry, exit] = evaluate(history, [
        compile(rules.entry, "bool"),
        compile(rules.exit, "bool"),
      ]).conditions;
    return exit ? "SELL" : entry ? "BUY" : null;
  }
  if (strategy.conditions) {
    const c = strategy.conditions,
      step = INTERVAL_MS[strategy.interval];
    const base =
      c.mode === "filter"
        ? signal(history, { ...strategy, conditions: undefined })
        : null;
    if (
      base === "SELL" ||
      c.exit.every((rule) => conditionMatches(history, rule, step))
    )
      return "SELL";
    if (!c.entry.every((rule) => conditionMatches(history, rule, step)))
      return null;
    return c.mode === "replace" ? "BUY" : base;
  }
  const n = history.length,
    last = history[n - 1]!;
  if (strategy.template === "sma_cross") {
    if (n < strategy.slow + 1) return null;
    // mean(fast) - mean(slow) has the sign of sumFast * slow - sumSlow * fast (exact).
    const { fast, slow } = strategy,
      fNow = windowSum(history, n, fast, "close"),
      sNow = windowSum(history, n, slow, "close"),
      closeLast = field(last, "close"),
      fPrev = fNow - closeLast + field(history[n - 1 - fast]!, "close"),
      sPrev = sNow - closeLast + field(history[n - 1 - slow]!, "close"),
      big = (x: number) => BigInt(x),
      prev = fPrev * big(slow) - sPrev * big(fast),
      now = fNow * big(slow) - sNow * big(fast);
    return prev <= 0n && now > 0n
      ? "BUY"
      : prev >= 0n && now < 0n
        ? "SELL"
        : null;
  }
  if (n <= Math.max(strategy.entryPeriod, strategy.exitPeriod)) return null;
  const high = windowMax(history, n - 1 - strategy.entryPeriod, n - 1, "high"),
    low = windowMin(history, n - 1 - strategy.exitPeriod, n - 1, "low"),
    close = field(last, "close");
  return close > high ? "BUY" : close < low ? "SELL" : null;
}
// Exact products for threshold tests; no rounding at this precision for inputs
// the schemas allow. Comparing (peak - e) * 100 >= limit * peak exactly is
// equivalent to comparing the 40-digit rounded-down quotient with the limit,
// because the limit is a short finite decimal and round-down is monotone.
const Exact = Decimal.clone({ precision: 200, rounding: Decimal.ROUND_DOWN });
const atLeastPct = (loss: Decimal, base: Decimal, limitPct: string) => {
  if (!base.gt(0)) return false;
  const limit = Dm(limitPct);
  // Products of ≤40 significant digits are exact at the default precision.
  if (base.sd(true) + limit.sd(true) <= 40)
    return loss.mul(100).gte(limit.mul(base));
  return new Exact(loss.toFixed())
    .mul(100)
    .gte(new Exact(limitPct).mul(base.toFixed()));
};
interface MarkMemo {
  dayNumber: number;
  cash: string;
  peak: string;
  dayStart: string;
  risk: RunConfig["risk"];
  stopped: boolean;
  drawdown: string | null;
}
interface PendingCurve {
  entry: EngineState["curve"][number];
  peak: Decimal;
  equity: Decimal;
  memo: MarkMemo | null;
}
const markMemo = new WeakMap<EngineState, MarkMemo>();
const pendingCurve = new WeakMap<EngineState, PendingCurve>();
const drawdownOf = (peak: Decimal, e: Decimal) =>
  peak.eq(0) ? D(0) : peak.minus(e).div(peak).mul(100);

/**
 * Marks equity at `at`. With `deferText`, the drawdown text of this curve point
 * is computed only if the point survives: in batch backtests the close mark of
 * one bar is normally replaced by the open mark of the next bar at the same
 * timestamp. Call `settleCurve` before reading the curve.
 */
export function mark(
  st: EngineState,
  cfg: RunConfig,
  at: number,
  deferText = false,
) {
  const dayNumber = Math.floor(at / 86400000),
    memo = markMemo.get(st),
    flat = Object.keys(st.positions).length === 0;
  if (
    flat &&
    memo &&
    memo.dayNumber === dayNumber &&
    memo.cash === st.cash &&
    memo.peak === st.peak &&
    memo.dayStart === st.dayStart &&
    memo.risk === cfg.risk &&
    st.day !== ""
  ) {
    // Flat book with unchanged cash, peak and day anchor: every derived value
    // equals the previous mark's.
    st.stoppedOpening = memo.stopped;
    if (memo.drawdown === null && !deferText)
      memo.drawdown = s(drawdownOf(D(st.peak), D(st.cash)));
    const entry = {
      at,
      cash: st.cash,
      equity: st.cash,
      drawdownPct: memo.drawdown ?? "",
    };
    pushCurve(st, entry);
    if (memo.drawdown === null)
      pendingCurve.set(st, { entry, peak: D(st.peak), equity: D(st.cash), memo });
    return;
  }
  const e = flat ? Dm(st.cash) : equity(st),
    peak = Decimal.max(Dm(st.peak), e),
    equityText = s(e);
  st.peak = s(peak);
  if (!memo || memo.dayNumber !== dayNumber || st.day === "") {
    const day = new Date(at).toISOString().slice(0, 10);
    if (st.day !== day) {
      st.day = day;
      st.dayStart = equityText;
    }
  }
  const dayStart = Dm(st.dayStart);
  st.stoppedOpening =
    atLeastPct(peak.minus(e), peak, cfg.risk.maxDrawdownPct) ||
    atLeastPct(dayStart.minus(e), dayStart, cfg.risk.dailyLossPct);
  const drawdown = deferText ? null : s(drawdownOf(peak, e)),
    next: MarkMemo = {
      dayNumber,
      cash: st.cash,
      peak: st.peak,
      dayStart: st.dayStart,
      risk: cfg.risk,
      stopped: st.stoppedOpening,
      drawdown: flat ? drawdown : null,
    };
  markMemo.set(st, next);
  const entry = { at, cash: st.cash, equity: equityText, drawdownPct: drawdown ?? "" };
  pushCurve(st, entry);
  if (drawdown === null)
    pendingCurve.set(st, { entry, peak, equity: e, memo: flat ? next : null });
}
/** Computes any deferred drawdown text on the last curve point. */
export function settleCurve(st: EngineState) {
  const p = pendingCurve.get(st);
  if (!p) return;
  pendingCurve.delete(st);
  if (p.entry.drawdownPct !== "") return;
  p.entry.drawdownPct = s(drawdownOf(p.peak, p.equity));
  if (p.memo && p.memo.drawdown === null) p.memo.drawdown = p.entry.drawdownPct;
}
function pushCurve(st: EngineState, value: EngineState["curve"][number]) {
  const last = st.curve.at(-1),
    pending = pendingCurve.get(st);
  if (last?.at === value.at) {
    if (pending?.entry === last) pendingCurve.delete(st);
    st.curve[st.curve.length - 1] = value;
    return;
  }
  if (pending) settleCurve(st);
  st.curve.push(value);
}
function appendHistory(
  st: EngineState,
  strategy: Strategy,
  bar: Bar,
  risk?: RunConfig["risk"],
) {
  st.lastTime[bar.symbol] = bar.time;
  const history = (st.history[bar.symbol] ??= []);
  history.push(bar);
  const max = historyRequired(strategy, risk);
  if (history.length > max) history.splice(0, history.length - max);
}

// ---- extended risk: ATR stops, trailing stops, time stops, volatility sizing
export function hasExtendedRisk(r: RunConfig["risk"]) {
  return !!(
    r.stopAtr ||
    r.trailingStopPct ||
    r.trailingAtr ||
    r.maxHoldBars ||
    r.sizing === "volatility"
  );
}
const plain = (x: number) => new Decimal(x).toFixed();
const lastOf = (history: Bar[], node: Node) => {
  const v = seriesOf(history, node);
  return v[v.length - 1] ?? NaN;
};
/** Entry overrides from closed-bar indicators; null while they warm up. */
function entryOverrides(
  history: Bar[],
  cfg: RunConfig,
  interval: Strategy["interval"],
): Pick<Intent, "stopDistance" | "weightPct"> | null {
  const r = cfg.risk,
    out: Pick<Intent, "stopDistance" | "weightPct"> = {};
  if (r.stopAtr) {
    const atr = lastOf(history, compile(`atr(${r.atrPeriod ?? 14})`, "series"));
    if (!(atr > 0)) return null;
    out.stopDistance = plain(atr * Number(r.stopAtr));
  }
  if (r.sizing === "volatility") {
    const perBar = lastOf(history, compile(`rvol(${r.volPeriod ?? 20})`, "series")),
      annual = perBar * Math.sqrt((365 * 86400000) / INTERVAL_MS[interval]);
    if (!(annual > 0)) return null;
    out.weightPct = plain(Math.min(100, (Number(r.targetVolPct) / annual) * 100));
  }
  return out;
}
/** Ratchets protective stops after a closed bar; never loosens them. */
function trail(st: EngineState, cfg: RunConfig, bar: Bar) {
  const p = st.positions[bar.symbol],
    r = cfg.risk;
  if (!p || (!r.trailingStopPct && !r.trailingAtr)) return;
  let stop = D(p.stop);
  if (r.trailingStopPct)
    stop = Decimal.max(
      stop,
      D(bar.high).mul(D(1).minus(D(r.trailingStopPct).div(100))),
    );
  if (r.trailingAtr) {
    const peak = Decimal.max(p.peak ?? bar.high, bar.high);
    p.peak = s(peak);
    const atr = lastOf(
      st.history[bar.symbol]!,
      compile(`atr(${r.atrPeriod ?? 14})`, "series"),
    );
    if (atr > 0)
      stop = Decimal.max(stop, peak.minus(plain(atr * Number(r.trailingAtr))));
  }
  p.stop = s(stop);
}
function timeStopDue(
  st: EngineState,
  cfg: RunConfig,
  bar: Bar,
  interval: Strategy["interval"],
) {
  const p = st.positions[bar.symbol],
    n = cfg.risk.maxHoldBars;
  if (!p || !n || p.openedAt === undefined || st.pending[bar.symbol])
    return false;
  return Math.floor((bar.time - p.openedAt) / INTERVAL_MS[interval]) + 1 >= n;
}
function idle(st: EngineState, warm: boolean) {
  st.sequence++;
  const v = (st.idle ??= { warmup: 0, noSignal: 0 });
  if (warm) v.warmup++;
  else v.noSignal++;
}

function decide(
  st: EngineState,
  strategy: Strategy,
  cfg: RunConfig,
  bar: Bar,
  quiet = false,
) {
  if (bar.time < cfg.from || bar.time > cfg.to) return;
  const history = st.history[bar.symbol]!,
    max =
      strategy.template === "expr"
        ? historyRequired(strategy)
        : Math.max(
            strategy.slow + 1,
            strategy.entryPeriod + 1,
            strategy.exitPeriod + 1,
          );
  const at = bar.time + INTERVAL_MS[strategy.interval];
  if (timeStopDue(st, cfg, bar, strategy.interval)) {
    intent(st, bar, "SELL", "TIME_STOP", at);
    return;
  }
  const side = signal(history, strategy);
  if (
    side &&
    ((side === "BUY" && !st.positions[bar.symbol]) ||
      (side === "SELL" && st.positions[bar.symbol]))
  ) {
    if (st.pending[bar.symbol])
      log(st, { ...bar, time: at }, "PENDING_EXISTS", "已有待成交订单");
    else if (side === "BUY" && st.stoppedOpening)
      log(st, { ...bar, time: at }, "LOSS_LIMIT", "损失限制暂停新开仓");
    else if (side === "BUY") {
      const extra = entryOverrides(history, cfg, strategy.interval);
      if (extra) intent(st, bar, side, strategy.template, at, extra);
      else
        log(st, { ...bar, time: at }, "RISK_WARMUP", "ATR 或波动率指标预热中，暂不开仓");
    } else intent(st, bar, side, strategy.template, at);
  } else if (quiet) {
    // Backtests count idle bars instead of logging one decision per bar; the
    // sequence still advances so order, fill and decision ids stay stable.
    idle(st, history.length < max);
  } else
    log(
      st,
      { ...bar, time: at },
      history.length < max ? "WARMUP" : "NO_SIGNAL",
      history.length < max ? "指标预热中" : "没有新的可执行信号",
    );
}

/**
 * Cross-sectional rotation at the close of a batch: rank symbols by the score
 * expression, hold the top N that pass the filter. Exits are queued before
 * entries execute at the next open (see ingestBatch).
 */
function rotate(
  st: EngineState,
  strategy: Strategy,
  cfg: RunConfig,
  bars: Bar[],
) {
  const rot = strategy.rotation!,
    step = INTERVAL_MS[strategy.interval],
    time = bars[0]!.time,
    at = time + step,
    need = historyRequired(strategy);
  for (const bar of bars)
    if (timeStopDue(st, cfg, bar, strategy.interval))
      intent(st, bar, "SELL", "TIME_STOP", at);
  if (Math.floor(time / step) % rot.every !== 0) {
    idle(st, bars.some((b) => st.history[b.symbol]!.length < need));
    return;
  }
  const score = compile(rot.score, "series"),
    filter = rot.filter ? compile(rot.filter, "bool") : null;
  const ranked = bars
    .map((bar) => {
      const h = st.history[bar.symbol]!;
      if (h.length < need) return { bar, value: NaN, ok: false };
      const r = evaluate(h, filter ? [filter] : [], [score]),
        value = r.scores[0]!;
      return { bar, value, ok: Number.isFinite(value) && (!filter || r.conditions[0]!) };
    })
    .filter((x) => x.ok)
    .sort((a, b) => b.value - a.value || (a.bar.symbol < b.bar.symbol ? -1 : 1));
  if (!ranked.length) {
    idle(st, true);
    return;
  }
  const target = new Set(ranked.slice(0, rot.top).map((x) => x.bar.symbol));
  log(
    st,
    { time: at, symbol: ranked[0]!.bar.symbol },
    "ROTATION",
    `排名前 ${rot.top}：${[...target].join("、")}`,
  );
  st.decisions.at(-1)!.facts = {
    ...st.decisions.at(-1)!.facts,
    ranking: ranked.map((x) => `${x.bar.symbol}:${x.value.toPrecision(8)}`).join(","),
  };
  // Exits first: held symbols present in this batch that fell out of the target.
  for (const bar of bars)
    if (st.positions[bar.symbol] && !target.has(bar.symbol) && !st.pending[bar.symbol])
      intent(st, bar, "SELL", "ROTATION_OUT", at);
  for (const x of ranked.slice(0, rot.top)) {
    const bar = x.bar;
    if (st.positions[bar.symbol] || st.pending[bar.symbol]) continue;
    if (st.stoppedOpening) {
      log(st, { ...bar, time: at }, "LOSS_LIMIT", "损失限制暂停新开仓");
      continue;
    }
    const extra = entryOverrides(st.history[bar.symbol]!, cfg, strategy.interval);
    if (extra) intent(st, bar, "BUY", "ROTATION_IN", at, extra);
    else log(st, { ...bar, time: at }, "RISK_WARMUP", "ATR 或波动率指标预热中，暂不开仓");
  }
}
function fillPending(st: EngineState, cfg: RunConfig, bar: Bar, time: number) {
  const order = st.pending[bar.symbol];
  if (order && order.signalAt !== time) {
    // A hole in the data: the bar the signal was meant for never traded.
    log(st, bar, "DATA_GAP", "行情缺口，原定开盘无成交数据，信号作废", order.id);
    delete st.pending[bar.symbol];
  } else if (order)
    execute(
      st,
      cfg,
      order,
      bar.open,
      st.history[bar.symbol]?.at(-1)?.volume ?? "0",
      time,
    );
}
function protect(st: EngineState, cfg: RunConfig, bar: Bar, time: number) {
  const p = st.positions[bar.symbol];
  if (!p) return;
  const stop = D(p.stop),
    take = D(p.take);
  let px: string | undefined,
    reason = "";
  if (stop.gt(0) && D(bar.low).lte(stop)) {
    px = s(Decimal.min(bar.open, stop));
    reason = "STOP_LOSS";
  } else if (take.gt(0) && D(bar.high).gte(take)) {
    px = s(Decimal.max(bar.open, take));
    reason = "TAKE_PROFIT";
  }
  if (px) {
    const i = intent(st, bar, "SELL", reason, time);
    execute(st, cfg, i, px, bar.volume, time);
  }
}
// Batch a common market timestamp: no symbol may see another symbol's future close at the open.
export function ingestBatch(
  st: EngineState,
  strategy: Strategy,
  cfg: RunConfig,
  input: Bar[],
) {
  const bars = input.filter(
    (b) =>
      strategy.symbols.includes(b.symbol) &&
      b.time > (st.lastTime[b.symbol] ?? -1),
  );
  if (!bars.length) return;
  const time = bars[0]!.time,
    active = time >= cfg.from && time <= cfg.to,
    rotation = strategy.template === "rotation";
  for (const bar of bars) st.prices[bar.symbol] = bar.open;
  if (active) {
    mark(st, cfg, time);
    if (rotation) {
      // Sells release cash before buys at the same open.
      for (const bar of bars)
        if (st.pending[bar.symbol]?.side === "SELL") fillPending(st, cfg, bar, time);
      for (const bar of bars) fillPending(st, cfg, bar, time);
      for (const bar of bars) protect(st, cfg, bar, time);
    } else
      for (const bar of bars) {
        fillPending(st, cfg, bar, time);
        protect(st, cfg, bar, time);
      }
  }
  for (const bar of bars) {
    appendHistory(st, strategy, bar, cfg.risk);
    st.prices[bar.symbol] = bar.close;
    if (active) trail(st, cfg, bar);
  }
  if (active) {
    mark(st, cfg, time + INTERVAL_MS[strategy.interval], true);
    if (rotation) rotate(st, strategy, cfg, bars);
    else for (const bar of bars) decide(st, strategy, cfg, bar, true);
  }
}
export function ingestClosedBar(
  st: EngineState,
  strategy: Strategy,
  cfg: RunConfig,
  bar: Bar,
  mode: "backtest" | "paper" = "backtest",
) {
  if (mode === "backtest") {
    ingestBatch(st, strategy, cfg, [bar]);
    return;
  }
  if (strategy.template === "rotation")
    throw Error("轮动策略需要同步的多标的行情，模拟盘暂不支持");
  if (
    !strategy.symbols.includes(bar.symbol) ||
    bar.time <= (st.lastTime[bar.symbol] ?? -1)
  )
    return;
  appendHistory(st, strategy, bar, cfg.risk);
  st.prices[bar.symbol] = bar.close;
  trail(st, cfg, bar);
  mark(st, cfg, bar.time + INTERVAL_MS[strategy.interval]);
  decide(st, strategy, cfg, bar);
}
export function metrics(st: EngineState, cfg: RunConfig): Metrics {
  settleCurve(st);
  const e = equity(st),
    closed = st.fills.filter((f) => f.realizedPnl !== null),
    wins = closed.filter((f) => D(f.realizedPnl!).gt(0)),
    losses = closed.filter((f) => D(f.realizedPnl!).lt(0)),
    sum = (values: string[]) => values.reduce((a, b) => a.plus(b), D(0));
  const profit = sum(wins.map((f) => f.realizedPnl!)),
    loss = sum(losses.map((f) => f.realizedPnl!)).abs();
  // Last equity per UTC day; a point at the day boundary belongs to the prior day.
  const days = new Map<number, string>();
  for (const p of st.curve)
    days.set(Math.floor(Math.max(0, p.at - 1) / 86400000), p.equity);
  const daily = [...days.values()],
    returns: number[] = [];
  for (let i = 1; i < daily.length; i++)
    if (D(daily[i - 1]!).gt(0))
      returns.push(
        D(daily[i]!)
          .div(daily[i - 1]!)
          .minus(1)
          .toNumber(),
      );
  const avg = returns.reduce((a, b) => a + b, 0) / (returns.length || 1),
    sd =
      returns.length > 1
        ? Math.sqrt(
            returns.reduce((a, b) => a + (b - avg) ** 2, 0) /
              (returns.length - 1),
          )
        : 0;
  return {
    returnPct: s(e.div(cfg.initialCash).minus(1).mul(100)),
    maxDrawdownPct: s(
      st.curve.reduce((a, b) => Decimal.max(a, b.drawdownPct), D(0)),
    ),
    fees: s(sum(st.fills.map((f) => f.fee))),
    slippage: s(sum(st.fills.map((f) => f.slippage))),
    trades: st.fills.length,
    closedTrades: closed.length,
    winRatePct: closed.length
      ? s(D(wins.length).div(closed.length).mul(100))
      : null,
    profitFactor: loss.gt(0) ? s(profit.div(loss)) : null,
    payoffRatio:
      wins.length && losses.length
        ? s(profit.div(wins.length).div(loss.div(losses.length)))
        : null,
    sharpe:
      returns.length >= 30 && sd > 0
        ? String((avg / sd) * Math.sqrt(365))
        : null,
    annualVolatilityPct:
      returns.length >= 30 && sd > 0 ? String(sd * Math.sqrt(365) * 100) : null,
    turnover: s(
      sum(st.fills.map((f) => s(D(f.quantity).mul(f.price)))).div(
        cfg.initialCash,
      ),
    ),
    exposurePct: st.curve.length
      ? s(
          st.curve
            .reduce(
              (a, p) =>
                p.equity === p.cash && p.equity !== "0"
                  ? a // flat: exposure term is exactly zero
                  : a.plus(D(p.equity).minus(p.cash).div(p.equity).mul(100)),
              D(0),
            )
            .div(st.curve.length),
        )
      : "0",
    realizedPnl: s(sum(closed.map((f) => f.realizedPnl!))),
    unrealizedPnl: s(
      Object.entries(st.positions).reduce(
        (a, [symbol, p]) =>
          a.plus(
            D(p.quantity)
              .mul(st.prices[symbol] ?? "0")
              .minus(p.cost),
          ),
        D(0),
      ),
    ),
  };
}
