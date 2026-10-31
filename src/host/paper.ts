import { historyRequired } from "../domain/conditions.js";
import { z } from "zod";
import type { Account, Bar, StrategyRecord } from "../domain/contracts.js";
import { INTERVAL_MS } from "../domain/contracts.js";
import {
  assertLedger,
  D,
  execute,
  ingestClosedBar,
  intent,
  mark,
} from "../engine/core.js";
import {
  download,
  quote,
  symbols,
  validateBars,
  hash,
} from "../adapters/market.js";
import { barSchema, fail, id } from "../domain/schemas.js";
import { ENGINE_VERSION } from "../engine/backtest.js";
import { Research } from "./research.js";
import { observationEvent, observationMarket } from "./observation.js";
interface Runtime {
  socket: WebSocket | null;
  controller: AbortController;
  timer: ReturnType<typeof setInterval> | null;
  retry: ReturnType<typeof setTimeout> | null;
  generation: number;
  busy: boolean;
  retries: number;
  connected: boolean;
  lastMessage: number;
  queue: {
    bar: Bar;
    strategy: StrategyRecord;
  }[];
}
export class Paper {
  private faults = new Map<string, string>();
  private runtimes = new Map<string, Runtime>();
  constructor(
    readonly research: Research,
    readonly market = { symbols, download, quote, WebSocket },
  ) {}
  private get store() {
    return this.research.store;
  }
  private save(a: Account) {
    assertLedger(a.state, a.initialCash);
    this.store.saveState(a.id, a.state);
    this.store.put("account", a.id, a);
  }
  async control(input: unknown) {
    const x = z
      .object({
        submissionId: id,
        id,
        expectedRevision: z.number().int().positive(),
        action: z.enum(["start", "resume", "pause", "stop", "flatten"]),
      })
      .strict()
      .parse(input);
    let a = this.store.get<Account>("account", x.id);
    // Duplicate submissions are resolved before network requests and revision checks.
    const previous = this.store.db
      .prepare("SELECT result,hash FROM submissions WHERE id=?")
      .get(x.submissionId) as
      | {
          result: string;
          hash: string;
        }
      | undefined;
    if (previous)
      return this.store.submit(x.submissionId, "paper-control", x, () => ({}));
    if (a.revision !== x.expectedRevision)
      fail("REVISION_CONFLICT", "账户已更新，请刷新后重试");
    if (x.action === "start" || x.action === "resume") {
      if (this.store.maybe("simulationTransition", a.id))
        fail(
          "ACCOUNT_REPLACED",
          "此账户已由用户确认的新版本接替，请查看新模拟账户",
        );
      if (a.config.engineVersion !== ENGINE_VERSION)
        fail(
          "ENGINE_MISMATCH",
          "引擎版本已变化，请创建新模拟账户，原账户保留用于核对",
        );
      if (
        this.research.store
          .list<Account>("account")
          .some((v) => v.id !== a.id && v.status === "running")
      )
        fail("ACTIVE_ACCOUNT_LIMIT", "首版同时支持一个活跃模拟账户");
      if (!["created", "paused", "stopped"].includes(a.status))
        fail("INVALID_STATE", "当前状态不能启动");
      const strategy = this.store.get<StrategyRecord>("strategy", a.strategyId),
        controller = new AbortController();
      if (strategy.approvedConfigHash) {
        const input = {
          initialCash: a.config.initialCash,
          risk: a.config.risk,
          costs: a.config.costs,
          from: 0,
          to: 8640000000000000,
        };
        if (
          hash(input) !== strategy.approvedConfigHash ||
          hash(strategy.definition) !== strategy.definitionHash ||
          a.approvalHash !==
            hash({
              strategy: strategy.definitionHash,
              config: strategy.approvedConfigHash,
            })
        )
          fail("APPROVAL_MISMATCH", "账户配置与用户确认的运行版本不一致");
      }
      const list = await this.market.symbols(controller.signal),
        step = INTERVAL_MS[strategy.definition.interval],
        to = Math.floor(Date.now() / step) * step - step,
        n = historyRequired(strategy.definition) + 3;
      const history: Record<string, Bar[]> = {};
      const rules = { ...a.config.rules };
      for (const sym of strategy.definition.symbols) {
        const found = list.find((v) => v.symbol === sym);
        if (!found) fail("SYMBOL_UNSUPPORTED", `交易对 ${sym} 不支持`);
        rules[sym] = found.rules;
        history[sym] = await this.market.download(
          sym,
          strategy.definition.interval,
          Math.max(0, to - n * step),
          to,
          controller.signal,
        );
        history[sym] = validateBars(
          history[sym],
          sym,
          strategy.definition.interval,
        ).slice(-historyRequired(strategy.definition));
      }
      const value = this.store.submit(
        x.submissionId,
        "paper-control",
        x,
        () => {
          a = this.store.get<Account>("account", x.id);
          if (a.revision !== x.expectedRevision)
            fail("REVISION_CONFLICT", "同步期间账户已更新");
          if (
            this.store
              .list<Account>("account")
              .some((v) => v.id !== a.id && v.status === "running")
          )
            fail("ACTIVE_ACCOUNT_LIMIT", "首版同时支持一个活跃模拟账户");
          this.store.stateMatches(a.id, a.state);
          a.config.rules = rules;
          a.state.pending = {};
          a.state.history = {};
          a.state.lastTime = {};
          for (const [sym, bars] of Object.entries(history)) {
            for (const bar of bars) {
              a.state.history[sym] ??= [];
              a.state.history[sym]!.push(bar);
              a.state.lastTime[sym] = bar.time;
              a.state.prices[sym] = bar.close;
            }
            a.seen[sym] = bars.at(-1)?.time ?? to;
          }
          a.status = "running";
          a.generation++;
          a.revision++;
          a.error = "正在连接公共行情，尚未开始观察";
          observationEvent(
            this.store,
            a,
            x.action === "start" ? "start" : "resume",
            "用户已明确启动固定版本，等待公共行情连接",
          );
          this.save(a);
          return this.summary(a);
        },
      );
      const latest = this.store.get<Account>("account", x.id);
      if (
        latest.status === "running" &&
        this.runtimes.get(latest.id)?.generation !== latest.generation
      )
        this.attach(latest);
      return value;
    }
    if (x.action === "flatten") {
      if (a.status === "running")
        fail("PAUSE_FIRST", "请先暂停，再按当前有效行情模拟平仓");
      const quotes: Record<string, Awaited<ReturnType<typeof quote>>> = {};
      for (const sym of Object.keys(a.state.positions))
        quotes[sym] = await this.market.quote(sym);
      return this.store.submit(x.submissionId, "paper-control", x, () => {
        a = this.store.get<Account>("account", x.id);
        if (a.revision !== x.expectedRevision)
          fail("REVISION_CONFLICT", "账户已更新");
        for (const [sym, q] of Object.entries(quotes)) {
          a.state.prices[sym] = q.price;
          const bar = {
            symbol: sym,
            time: q.observedAt,
            open: q.price,
            high: q.price,
            low: q.price,
            close: q.price,
            volume: "1000000000000",
          };
          const i = intent(a.state, bar, "SELL", "USER_FLATTEN", q.observedAt);
          execute(
            a.state,
            {
              ...a.config,
              costs: { ...a.config.costs, participationPct: "0" },
            },
            i,
            q.price,
            bar.volume,
            q.observedAt,
          );
        }
        mark(a.state, a.config, Date.now());
        a.revision++;
        this.save(a);
        return this.summary(a);
      });
    }
    const value = this.store.submit(x.submissionId, "paper-control", x, () => {
      a = this.store.get<Account>("account", x.id);
      if (!["running", "paused", "created", "failed"].includes(a.status))
        fail("INVALID_STATE", "任务已停止");
      a.status = x.action === "pause" ? "paused" : "stopped";
      for (const order of Object.values(a.state.pending))
        a.state.decisions.push({
          id: `d${++a.state.sequence}`,
          at: Date.now(),
          symbol: order.symbol,
          code: "CANCELLED",
          reason: "用户停止或暂停，撤销待成交意图",
          orderId: order.id,
        });
      a.state.pending = {};
      a.generation++;
      a.revision++;
      a.error = "";
      observationEvent(
        this.store,
        a,
        x.action === "pause" ? "pause" : "stop",
        "用户停止观察，持仓保留，不补记缺口成交",
      );
      this.save(a);
      return this.summary(a);
    });
    this.detach(a.id);
    return value;
  }
  summary(a: Account) {
    let error = this.faults.get(a.id);
    try {
      this.store.assertLease();
    } catch {
      error = "执行租约已失效，请重启应用";
    }
    return {
      ...a,
      ...(error ? { status: "failed" as const, error } : {}),
      state: {
        ...a.state,
        history: undefined,
        fills: a.state.fills.slice(-100),
        ledger: undefined,
        decisions: a.state.decisions.slice(-100),
        curve: a.state.curve.slice(-1000),
      },
    };
  }
  private detach(id: string) {
    const r = this.runtimes.get(id);
    if (!r) return;
    this.runtimes.delete(id);
    r.controller.abort();
    if (r.timer) clearInterval(r.timer);
    if (r.retry) clearTimeout(r.retry);
    r.socket?.close();
  }
  private attach(a: Account) {
    this.detach(a.id);
    const r: Runtime = {
      socket: null,
      controller: new AbortController(),
      timer: null,
      retry: null,
      generation: a.generation,
      busy: false,
      retries: 0,
      connected: false,
      lastMessage: Date.now(),
      queue: [],
    };
    this.runtimes.set(a.id, r);
    const strategy = this.store.get<StrategyRecord>("strategy", a.strategyId);
    const connect = () => {
      if (r.controller.signal.aborted) return;
      const streams = strategy.definition.symbols
        .map(
          (sym) => `${sym.toLowerCase()}@kline_${strategy.definition.interval}`,
        )
        .join("/");
      r.socket = new this.market.WebSocket(
        `wss://data-stream.binance.vision/stream?streams=${streams}`,
      );
      r.socket.addEventListener("open", () => {
        r.connected = true;
        r.retries = 0;
        r.lastMessage = Date.now();
        const current = this.valid(a.id, r);
        if (current) {
          current.error = "";
          this.store.transaction(() => {
            observationEvent(
              this.store,
              current,
              "connected",
              "公共行情连接已建立",
            );
            this.store.put("account", current.id, current);
          });
        }
      });
      r.socket.addEventListener("message", (event) => {
        r.lastMessage = Date.now();
        try {
          const k = JSON.parse(String(event.data)).data?.k;
          if (this.valid(a.id, r))
            observationMarket(this.store, a.id, "transport", Date.now());
          if (k?.x)
            void this.onBar(
              a.id,
              r,
              {
                symbol: k.s,
                time: Number(k.t),
                open: k.o,
                high: k.h,
                low: k.l,
                close: k.c,
                volume: k.v,
              },
              strategy,
            );
        } catch {
          this.fault(a.id, r, "行情事件格式无效");
        }
      });
      r.socket.addEventListener("error", () => r.socket?.close());
      r.socket.addEventListener("close", () => {
        r.connected = false;
        const current = this.valid(a.id, r);
        if (current) {
          current.error = "行情连接中断，正在重连；当前不能监控保护退出";
          this.store.transaction(() => {
            observationEvent(
              this.store,
              current,
              "disconnected",
              current.error,
            );
            this.store.put("account", current.id, current);
          });
        }
        if (r.controller.signal.aborted) return;
        if (++r.retries > 5) {
          this.fault(a.id, r, "行情连接多次失败；请检查网络后恢复");
          return;
        }
        r.retry = setTimeout(connect, Math.min(30000, 1000 * 2 ** r.retries));
      });
    };
    r.timer = setInterval(() => {
      if (!r.connected && Date.now() - r.lastMessage > 120000) {
        this.fault(a.id, r, "行情超过两分钟不可用，模拟盘已暂停");
        return;
      }
      if (r.connected && Date.now() - r.lastMessage > 60000) r.socket?.close();
      void this.protect(a.id, r);
    }, 10000);
    connect();
  }
  private valid(id: string, r: Runtime): Account | null {
    if (r.controller.signal.aborted || this.research.closed) return null;
    try {
      this.store.assertLease();
    } catch (e) {
      this.faults.set(id, e instanceof Error ? e.message : String(e));
      this.detach(id);
      return null;
    }
    const a = this.store.get<Account>("account", id);
    return a.status === "running" && a.generation === r.generation ? a : null;
  }
  private fault(id: string, r: Runtime, message: string) {
    try {
      const a = this.valid(id, r);
      if (a) {
        a.status = "paused";
        a.error = message;
        a.generation++;
        a.revision++;
        this.store.transaction(() => {
          observationEvent(this.store, a, "fault", message);
          this.save(a);
        });
      }
    } catch (e) {
      this.faults.set(
        id,
        `${message}；${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.detach(id);
    }
  }
  private async onBar(
    id: string,
    r: Runtime,
    bar: Bar,
    strategy: StrategyRecord,
  ) {
    if (!this.valid(id, r)) return;
    if (r.busy) {
      if (
        !r.queue.some(
          (v) => v.bar.symbol === bar.symbol && v.bar.time === bar.time,
        )
      )
        r.queue.push({ bar, strategy });
      if (r.queue.length > 20) this.fault(id, r, "行情处理积压，已暂停");
      return;
    }
    r.busy = true;
    try {
      bar = barSchema.parse(bar);
      if (
        D(bar.high).lt(bar.open) ||
        D(bar.high).lt(bar.close) ||
        D(bar.low).gt(bar.open) ||
        D(bar.low).gt(bar.close) ||
        D(bar.high).lt(bar.low)
      )
        throw Error("行情 OHLC 关系无效");
      let a = this.valid(id, r);
      if (!a) return;
      const step = INTERVAL_MS[strategy.definition.interval];
      if (bar.time % step || bar.time + step > Date.now())
        throw Error("收到未收盘或未对齐行情");
      const last = a.seen[bar.symbol] ?? 0;
      if (bar.time <= last) return;
      if (bar.time - last !== step) {
        this.fault(
          id,
          r,
          "发现行情观察缺口，已暂停；恢复将重建指标，不补记成交",
        );
        return;
      }
      ingestClosedBar(
        a.state,
        strategy.definition,
        { ...a.config, from: 0 },
        bar,
        "paper",
      );
      a.seen[bar.symbol] = bar.time;
      const order = a.state.pending[bar.symbol];
      if (order) {
        order.signalAt = bar.time + step;
        try {
          const q = await this.market.quote(bar.symbol, r.controller.signal);
          if (
            q.observedAt < order.signalAt ||
            Date.now() - order.signalAt > 60000
          ) {
            a.state.decisions.push({
              id: `d${++a.state.sequence}`,
              at: Date.now(),
              symbol: bar.symbol,
              code: "SIGNAL_EXPIRED",
              reason: "报价早于信号或信号超过 60 秒",
              orderId: order.id,
            });
            delete a.state.pending[bar.symbol];
          } else if (
            order.side === "BUY" &&
            Object.keys(a.state.positions).some(
              (sym) =>
                !a!.lastQuoteAt[sym] ||
                Date.now() - a!.lastQuoteAt[sym]! > 60000,
            )
          ) {
            a.state.decisions.push({
              id: `d${++a.state.sequence}`,
              at: Date.now(),
              symbol: bar.symbol,
              code: "QUOTE_STALE",
              reason: "其他持仓估值过期，拒绝新开仓",
              orderId: order.id,
            });
            delete a.state.pending[bar.symbol];
          } else {
            a.state.prices[bar.symbol] = q.price;
            execute(
              a.state,
              a.config,
              order,
              q.price,
              bar.volume,
              q.observedAt,
            );
            a.lastQuoteAt[bar.symbol] = q.observedAt;
          }
        } catch (e) {
          delete a.state.pending[bar.symbol];
          a.error = e instanceof Error ? e.message : String(e);
        }
      }
      if (!this.valid(id, r)) return;
      mark(a.state, a.config, Date.now());
      a.lastEventAt = Date.now();
      this.store.transaction(() => {
        this.save(a);
        observationMarket(
          this.store,
          a.id,
          "bar",
          a.lastEventAt,
          bar.time + step,
        );
      });
    } catch (e) {
      this.fault(id, r, e instanceof Error ? e.message : String(e));
    } finally {
      r.busy = false;
      this.drain(id, r);
    }
  }
  private async protect(id: string, r: Runtime) {
    if (r.busy || !r.connected) return;
    r.busy = true;
    try {
      let a = this.valid(id, r);
      if (!a) return;
      let quoteObservedAt = 0;
      for (const sym of Object.keys(a.state.positions)) {
        const q = await this.market.quote(sym, r.controller.signal);
        if (!this.valid(id, r)) return;
        a.state.prices[sym] = q.price;
        a.lastQuoteAt[sym] = q.observedAt;
        quoteObservedAt = Math.max(quoteObservedAt, q.observedAt);
        const p = a.state.positions[sym]!,
          stop = D(p.stop),
          take = D(p.take);
        if (
          (stop.gt(0) && D(q.price).lte(stop)) ||
          (take.gt(0) && D(q.price).gte(take))
        ) {
          const bar = {
              symbol: sym,
              time: q.observedAt,
              open: q.price,
              high: q.price,
              low: q.price,
              close: q.price,
              volume: "1000000000000",
            },
            i = intent(
              a.state,
              bar,
              "SELL",
              stop.gt(0) && D(q.price).lte(stop) ? "STOP_LOSS" : "TAKE_PROFIT",
              q.observedAt,
            );
          execute(
            a.state,
            {
              ...a.config,
              costs: { ...a.config.costs, participationPct: "0" },
            },
            i,
            q.price,
            bar.volume,
            q.observedAt,
          );
        }
      }
      if (!this.valid(id, r)) return;
      mark(a.state, a.config, Date.now());
      a.lastEventAt = Date.now();
      a.error = "";
      this.store.transaction(() => {
        this.save(a);
        if (quoteObservedAt)
          observationMarket(this.store, a.id, "quote", quoteObservedAt);
      });
    } catch (e) {
      const a = this.valid(id, r);
      if (a) {
        a.error = e instanceof Error ? e.message : String(e);
        this.store.put("account", a.id, a);
      }
    } finally {
      r.busy = false;
      this.drain(id, r);
    }
  }
  private drain(id: string, r: Runtime) {
    const next = r.queue.shift();
    if (next && !r.controller.signal.aborted)
      void this.onBar(id, r, next.bar, next.strategy);
  }
  close() {
    for (const id of [...this.runtimes.keys()]) {
      try {
        observationEvent(
          this.store,
          this.store.get<Account>("account", id),
          "closed",
          "本地执行进程关闭，期间无法观察行情",
        );
      } catch {}
      this.detach(id);
    }
  }
}
