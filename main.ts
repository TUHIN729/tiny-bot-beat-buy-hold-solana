// Breakout Rider — a tiny Donchian-breakout trend bot for the Solana 1h bars replay.
//
// Strategy (long only, no leverage, no shorts):
//   - Entry, per symbol: the hourly close breaks above the highest high of the
//     previous 10 bars AND the 12-bar return is positive (momentum confirmation).
//     A breakout in a symbol whose 14-bar ATR is over 6% of its price is skipped
//     (chop / spike filter), as is a bar with zero volume.
//   - Exit, whole position: the close breaks below the lowest low of the previous
//     5 bars, OR the close falls more than 1.5x ATR(14) below the highest close
//     since entry (ATR trailing stop), OR the position is worth under 92% of its
//     cost (hard stop). An exit signal that the market refuses is re-sent on the
//     next bar while it still holds.
//   - Sizing: each entry spends equity / 7 (one slot per universe symbol), capped
//     at 25% of equity (the max-weight cap), scaled by inverse volatility between
//     0.5x and 1.0x so jumpy symbols get smaller stakes; never more than the cash
//     this reply has not already spent (a sell's proceeds only fund later buys).
//   - Equity guard: while equity sits more than 10% below its peak, no new
//     entries — only exits. That keeps the bot in cash through grinding
//     downtrends instead of catching every falling knife.
//   - Indicators read every batch, warm-up included; while warming up it sends
//     no orders (the replay would reject them). Orders are decided on a bar's
//     close and fill at the next bar's open, so every signal is one bar late by
//     design — the rule is built for that lag, not against it.
//
// Everything is deterministic: plain float64 arithmetic on the bars themselves,
// no clock, no randomness, no network, no files outside this repository. The
// same bars always give the same orders, run after run.
//
// The grader runs `node /bot/main.ts` with this directory mounted at /bot;
// vendor/makefun-bars.ts is a byte-identical copy of the kit's sdk/makefun-bars.ts.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const ENTRY_BARS = 10; // breakout above the highest high of the previous N bars
const EXIT_BARS = 5; // exit below the lowest low of the previous N bars
const ATR_BARS = 14;
const TRAIL_ATR = 1.5; // trailing stop: peak close minus this many ATRs
const HARD_STOP = 0.92; // exit when the position is worth under 92% of its cost
const MAX_ATR_PCT = 0.06; // skip entries whose ATR is over 6% of price
const MOMENTUM_BARS = 12; // entry needs a positive return over this many bars
const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on
const EQUITY_GUARD = 0.9; // no new entries while equity is under 90% of peak

interface Series {
  closes: number[];
  highs: number[];
  lows: number[];
  /** Highest close since the current position was opened (0 when flat). */
  peak: number;
}

const series = new Map<string, Series>();

function getSeries(symbol: string): Series {
  let s = series.get(symbol);
  if (s === undefined) {
    s = { closes: [], highs: [], lows: [], peak: 0 };
    series.set(symbol, s);
  }
  return s;
}

function push(bar: Bar): Series {
  const s = getSeries(bar.symbol);
  s.closes.push(Number(bar.c));
  s.highs.push(Number(bar.h));
  s.lows.push(Number(bar.l));
  return s;
}

/** Mean true range over the last ATR_BARS bars, or null until enough bars exist. */
function atr(s: Series): number | null {
  const n = s.closes.length;
  if (n < ATR_BARS + 1) return null;
  let sum = 0;
  for (let j = n - ATR_BARS; j < n; j++) {
    const prev = s.closes[j - 1];
    sum += Math.max(s.highs[j] - s.lows[j], Math.abs(s.highs[j] - prev), Math.abs(s.lows[j] - prev));
  }
  return sum / ATR_BARS;
}

/** Highest high of the previous `count` bars, excluding the latest bar. */
function prevHigh(s: Series, count: number): number | null {
  const n = s.highs.length;
  if (n < count + 1) return null;
  let m = -Infinity;
  for (let j = n - count - 1; j < n - 1; j++) if (s.highs[j] > m) m = s.highs[j];
  return m;
}

/** Lowest low of the previous `count` bars, excluding the latest bar. */
function prevLow(s: Series, count: number): number | null {
  const n = s.lows.length;
  if (n < count + 1) return null;
  let m = Infinity;
  for (let j = n - count - 1; j < n - 1; j++) if (s.lows[j] < m) m = s.lows[j];
  return m;
}

/** Whether a held position exits on this close. */
function exits(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, s: Series): boolean {
  const close = s.closes[s.closes.length - 1];
  if (close > s.peak) s.peak = close;
  const low = prevLow(s, EXIT_BARS);
  if (low !== null && close < low) return true;
  const a = atr(s);
  if (a !== null && close < s.peak - TRAIL_ATR * a) return true;
  const value = state.value(symbol, held.qty);
  if (value * 100n < held.cost * BigInt(Math.round(HARD_STOP * 100))) return true; // under 92% of cost
  return false;
}

/** Peak equity seen so far, tracked across batches (deterministic: bars only). */
let peakEquitySeen = 0n;
function peakOf(state: BarsState): bigint {
  if (state.equity > peakEquitySeen) peakEquitySeen = state.equity;
  return peakEquitySeen;
}

await runBars({
  onBatch(state, batch) {
    const fresh = new Set<string>();
    const breakout = new Set<string>();
    for (const bar of batch.bars) {
      const s = push(bar);
      fresh.add(bar.symbol);
      if (bar.v === '0') continue;
      const high = prevHigh(s, ENTRY_BARS);
      if (high === null) continue;
      const close = s.closes[s.closes.length - 1];
      if (close <= high) continue;
      if (s.closes.length > MOMENTUM_BARS && close <= s.closes[s.closes.length - 1 - MOMENTUM_BARS]) continue;
      breakout.add(bar.symbol);
    }
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const held = state.positions.get(symbol);
      const s = series.get(symbol)!;
      if (held !== undefined) {
        if (exits(state, symbol, held, s)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      } else if (breakout.has(symbol)) {
        entries.push(symbol);
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    // Sells in this reply do not fund its buys; only the cash on hand does.
    let cash = state.cash;
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stakeBase = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    const base = stakeBase < byWeight ? stakeBase : byWeight;
    const peakEquity = peakOf(state);
    const guardOk = state.equity * 100n >= peakEquity * BigInt(Math.round(EQUITY_GUARD * 100)); // equity >= 90% of peak
    if (guardOk) {
      for (const symbol of entries) {
        if (orders.length >= caps.max_orders_per_bar) break;
        const s = series.get(symbol)!;
        const close = s.closes[s.closes.length - 1];
        const a = atr(s);
        if (a === null) continue;
        const atrPct = a / close;
        if (atrPct > MAX_ATR_PCT || atrPct <= 0) continue;
        // Inverse-volatility scale: calm symbols get the full stake, jumpy ones half.
        const volScale = Math.min(1, Math.max(0.5, 0.02 / atrPct));
        let slice = (base * BigInt(Math.floor(volScale * 1000))) / 1000n;
        if (cash < slice) slice = cash;
        if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) continue;
        orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
        cash -= slice;
        // A fresh position starts tracking its peak from this close.
        s.peak = close;
      }
    }
    return orders;
  },
});
