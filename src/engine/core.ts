import { conditionMatches, historyRequired } from "../domain/conditions.js";
import { Decimal } from "decimal.js";
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
  return Object.entries(state.positions).reduce(
    (e, [symbol, p]) => e.plus(D(p.quantity).mul(state.prices[symbol] ?? "0")),
    D(state.cash),
  );
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
): Intent {
  const i = {
    id: `o${++st.sequence}`,
    symbol: bar.symbol,
    side,
    signalAt,
    reason,
  };
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
    let target = e.mul(cfg.risk.weightPct).div(100).div(px);
    if (cfg.risk.sizing === "risk")
      target = e
        .mul(cfg.risk.riskPct)
        .div(100)
        .div(
          px.mul(
            D(cfg.risk.stopLossPct)
              .div(100)
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
        Number(cfg.risk.stopLossPct) > 0
          ? s(px.mul(D(1).minus(D(cfg.risk.stopLossPct).div(100))))
          : "0",
      take:
        Number(cfg.risk.takeProfitPct) > 0
          ? s(px.mul(D(1).plus(D(cfg.risk.takeProfitPct).div(100))))
          : "0",
    };
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
    const mean = (end: number, len: number) =>
      history
        .slice(end - len, end)
        .reduce((a, b) => a.plus(b.close), D(0))
        .div(len);
    const prev = mean(n - 1, strategy.fast).minus(mean(n - 1, strategy.slow)),
      now = mean(n, strategy.fast).minus(mean(n, strategy.slow));
    return prev.lte(0) && now.gt(0)
      ? "BUY"
      : prev.gte(0) && now.lt(0)
        ? "SELL"
        : null;
  }
  if (n <= Math.max(strategy.entryPeriod, strategy.exitPeriod)) return null;
  const high = Decimal.max(
      ...history
        .slice(n - 1 - strategy.entryPeriod, n - 1)
        .map((b) => D(b.high)),
    ),
    low = Decimal.min(
      ...history.slice(n - 1 - strategy.exitPeriod, n - 1).map((b) => D(b.low)),
    );
  return D(last.close).gt(high) ? "BUY" : D(last.close).lt(low) ? "SELL" : null;
}
export function mark(st: EngineState, cfg: RunConfig, at: number) {
  const e = equity(st);
  st.peak = s(Decimal.max(st.peak, e));
  const day = new Date(at).toISOString().slice(0, 10);
  if (st.day !== day) {
    st.day = day;
    st.dayStart = s(e);
  }
  const drawdown = D(st.peak).eq(0)
    ? D(0)
    : D(st.peak).minus(e).div(st.peak).mul(100);
  st.stoppedOpening =
    drawdown.gte(cfg.risk.maxDrawdownPct) ||
    D(st.dayStart)
      .minus(e)
      .div(st.dayStart)
      .mul(100)
      .gte(cfg.risk.dailyLossPct);
  const value = { at, cash: st.cash, equity: s(e), drawdownPct: s(drawdown) };
  if (st.curve.at(-1)?.at === at) st.curve[st.curve.length - 1] = value;
  else st.curve.push(value);
}
function appendHistory(st: EngineState, strategy: Strategy, bar: Bar) {
  st.lastTime[bar.symbol] = bar.time;
  const history = (st.history[bar.symbol] ??= []);
  history.push(bar);
  const max = historyRequired(strategy);
  if (history.length > max) history.splice(0, history.length - max);
}
function decide(st: EngineState, strategy: Strategy, cfg: RunConfig, bar: Bar) {
  if (bar.time < cfg.from || bar.time > cfg.to) return;
  const history = st.history[bar.symbol]!,
    max = Math.max(
      strategy.slow + 1,
      strategy.entryPeriod + 1,
      strategy.exitPeriod + 1,
    );
  const side = signal(history, strategy),
    at = bar.time + INTERVAL_MS[strategy.interval];
  if (
    side &&
    ((side === "BUY" && !st.positions[bar.symbol]) ||
      (side === "SELL" && st.positions[bar.symbol]))
  ) {
    if (st.pending[bar.symbol])
      log(st, { ...bar, time: at }, "PENDING_EXISTS", "已有待成交订单");
    else if (side === "BUY" && st.stoppedOpening)
      log(st, { ...bar, time: at }, "LOSS_LIMIT", "损失限制暂停新开仓");
    else intent(st, bar, side, strategy.template, at);
  } else
    log(
      st,
      { ...bar, time: at },
      history.length < max ? "WARMUP" : "NO_SIGNAL",
      history.length < max ? "指标预热中" : "没有新的可执行信号",
    );
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
    active = time >= cfg.from && time <= cfg.to;
  for (const bar of bars) st.prices[bar.symbol] = bar.open;
  if (active) {
    mark(st, cfg, time);
    for (const bar of bars) {
      const order = st.pending[bar.symbol];
      if (order)
        execute(
          st,
          cfg,
          order,
          bar.open,
          st.history[bar.symbol]?.at(-1)?.volume ?? "0",
          time,
        );
      const p = st.positions[bar.symbol];
      if (p) {
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
    }
  }
  for (const bar of bars) {
    appendHistory(st, strategy, bar);
    st.prices[bar.symbol] = bar.close;
  }
  if (active) {
    mark(st, cfg, time + INTERVAL_MS[strategy.interval]);
    for (const bar of bars) decide(st, strategy, cfg, bar);
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
  if (
    !strategy.symbols.includes(bar.symbol) ||
    bar.time <= (st.lastTime[bar.symbol] ?? -1)
  )
    return;
  appendHistory(st, strategy, bar);
  st.prices[bar.symbol] = bar.close;
  mark(st, cfg, bar.time + INTERVAL_MS[strategy.interval]);
  decide(st, strategy, cfg, bar);
}
export function metrics(st: EngineState, cfg: RunConfig): Metrics {
  const e = equity(st),
    closed = st.fills.filter((f) => f.realizedPnl !== null),
    wins = closed.filter((f) => D(f.realizedPnl!).gt(0)),
    losses = closed.filter((f) => D(f.realizedPnl!).lt(0)),
    sum = (values: string[]) => values.reduce((a, b) => a.plus(b), D(0));
  const profit = sum(wins.map((f) => f.realizedPnl!)),
    loss = sum(losses.map((f) => f.realizedPnl!)).abs();
  const days = new Map<string, string>();
  for (const p of st.curve)
    days.set(
      new Date(Math.max(0, p.at - 1)).toISOString().slice(0, 10),
      p.equity,
    );
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
                a.plus(D(p.equity).minus(p.cash).div(p.equity).mul(100)),
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
