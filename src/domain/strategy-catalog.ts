import type { Risk, Strategy } from "./contracts.js";

/**
 * Starting points for common public strategy families. Parameters are the
 * textbook defaults, not tuned or validated values; every entry still has to
 * pass the research protocol before it says anything about a market.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  family: string;
  description: string;
  definition: Omit<Strategy, "symbols" | "interval" | "fast" | "slow" | "entryPeriod" | "exitPeriod"> &
    Partial<Pick<Strategy, "fast" | "slow" | "entryPeriod" | "exitPeriod">>;
  /** Suggested risk options that are part of the idea (e.g. ATR stops). */
  risk?: Partial<Risk>;
  /** Minimum number of symbols. */
  minSymbols?: number;
}

export const STRATEGY_CATALOG: CatalogEntry[] = [
  {
    id: "sma-cross",
    name: "双均线交叉",
    family: "趋势跟随",
    description: "快均线上穿慢均线买入，下穿卖出。",
    definition: { template: "sma_cross", fast: 20, slow: 60 },
  },
  {
    id: "donchian-turtle",
    name: "唐奇安通道（海龟）",
    family: "趋势跟随",
    description: "收盘突破前 20 根最高价买入，跌破前 10 根最低价卖出；2 倍 ATR 止损。",
    definition: {
      template: "expr",
      rules: {
        version: 1,
        entry: "close > lag(highest(high, 20), 1)",
        exit: "close < lag(lowest(low, 10), 1)",
      },
    },
    risk: { stopAtr: "2", atrPeriod: 20 },
  },
  {
    id: "ema-adx",
    name: "EMA 交叉 + ADX 趋势过滤",
    family: "趋势跟随",
    description: "EMA12 上穿 EMA26 且 ADX(14) > 25 时买入，下穿卖出。",
    definition: {
      template: "expr",
      rules: {
        version: 1,
        entry: "cross_above(ema(close, 12), ema(close, 26)) and adx(14) > 25",
        exit: "cross_below(ema(close, 12), ema(close, 26))",
      },
    },
  },
  {
    id: "macd",
    name: "MACD 信号线交叉",
    family: "趋势跟随",
    description: "MACD 线上穿信号线且位于零轴上方买入，下穿卖出。",
    definition: {
      template: "expr",
      rules: {
        version: 1,
        entry: "cross_above(macd(close, 12, 26), macd_signal(close, 12, 26, 9)) and macd(close, 12, 26) > 0",
        exit: "cross_below(macd(close, 12, 26), macd_signal(close, 12, 26, 9))",
      },
    },
  },
  {
    id: "rsi-reversion",
    name: "RSI 超卖回归",
    family: "均值回归",
    description: "长期均线之上、RSI(14) 低于 30 时买入，回到 55 以上卖出；持有不超过 48 根。",
    definition: {
      template: "expr",
      rules: {
        version: 1,
        entry: "rsi(close, 14) < 30 and close > sma(close, 200)",
        exit: "rsi(close, 14) > 55",
      },
    },
    risk: { maxHoldBars: 48 },
  },
  {
    id: "bollinger-reversion",
    name: "布林带下轨回归",
    family: "均值回归",
    description: "收盘跌破布林下轨（20, 2）买入，回到中轨卖出。",
    definition: {
      template: "expr",
      rules: {
        version: 1,
        entry: "close < bb_lower(close, 20, 2)",
        exit: "close > bb_mid(close, 20, 2)",
      },
    },
  },
  {
    id: "zscore-reversion",
    name: "Z 分数回归",
    family: "均值回归",
    description: "价格相对 50 根均值低于 −2 个标准差买入，回到均值卖出。",
    definition: {
      template: "expr",
      rules: { version: 1, entry: "zscore(close, 50) < -2", exit: "zscore(close, 50) > 0" },
    },
  },
  {
    id: "bollinger-breakout",
    name: "布林带上轨突破",
    family: "波动率突破",
    description: "收盘突破布林上轨（20, 2）买入，跌回中轨卖出；3 倍 ATR 移动止损。",
    definition: {
      template: "expr",
      rules: {
        version: 1,
        entry: "close > bb_upper(close, 20, 2)",
        exit: "close < bb_mid(close, 20, 2)",
      },
    },
    risk: { trailingAtr: "3", atrPeriod: 14 },
  },
  {
    id: "squeeze-breakout",
    name: "波动收缩后突破",
    family: "波动率突破",
    description: "短期波动低于长期波动时，收盘突破前 20 根高点买入；跌破前 10 根低点卖出。",
    definition: {
      template: "expr",
      rules: {
        version: 1,
        entry: "rvol(20) < rvol(100) and close > lag(highest(high, 20), 1)",
        exit: "close < lag(lowest(low, 10), 1)",
      },
    },
  },
  {
    id: "momentum-trend",
    name: "时间序列动量",
    family: "动量",
    description: "近 48 根涨幅超过 5% 且在 200 均线之上买入，动量转负卖出；按 40% 年化波动率定仓。",
    definition: {
      template: "expr",
      rules: {
        version: 1,
        entry: "roc(close, 48) > 5 and close > sma(close, 200)",
        exit: "roc(close, 48) < 0",
      },
    },
    risk: { sizing: "volatility", targetVolPct: "40", volPeriod: 48 },
  },
  {
    id: "xs-momentum",
    name: "横截面动量轮动",
    family: "横截面",
    description: "每 168 根按近 168 根涨幅排序，持有最强的 3 个且须在 200 均线之上。",
    definition: {
      template: "rotation",
      rotation: {
        version: 1,
        score: "roc(close, 168)",
        filter: "close > sma(close, 200)",
        top: 3,
        every: 168,
      },
    },
    minSymbols: 4,
  },
  {
    id: "xs-low-vol",
    name: "低波动轮动",
    family: "横截面",
    description: "每 168 根按近 168 根波动率从低到高排序，持有波动最低的 3 个。",
    definition: {
      template: "rotation",
      rotation: { version: 1, score: "-rvol(168)", top: 3, every: 168 },
    },
    minSymbols: 4,
  },
];
