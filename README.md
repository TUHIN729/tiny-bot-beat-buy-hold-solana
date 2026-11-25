# Breakout Rider — Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana

[![make.fun · u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/TUHIN729/tiny-bot-beat-buy-hold-solana/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/TUHIN729/tiny-bot-beat-buy-hold-solana/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny long-only trend bot for hourly Solana prices. It rides breakouts and sits in cash when the market grinds down — which is how it beats buy-and-hold.

## Strategy

Breakout Rider trades all seven symbols (FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH, WIF) on hourly bars with a Donchian-breakout rule:

- **Entry:** the hourly close breaks above the highest high of the previous 10 bars, with a positive 12-bar return as momentum confirmation. Breakouts in symbols whose 14-bar ATR is over 6% of price are skipped (chop/spike filter), as are zero-volume bars.
- **Exit:** the whole position goes when the close breaks below the lowest low of the previous 5 bars, or falls more than 1.5× ATR(14) below the highest close since entry (ATR trailing stop), or the position is worth under 92% of its cost (hard stop). A refused exit is re-sent while it still holds.
- **Sizing:** each entry spends equity / 7, capped at 25% of equity, scaled 0.5×–1.0× by inverse volatility so jumpy symbols get smaller stakes. A sell's proceeds never fund the same reply's buys.
- **Equity guard:** while equity sits more than 10% below its peak, no new entries — only exits. In a grinding downtrend the bot mostly holds USDC instead of catching falling knives.

Everything is deterministic: plain float64 arithmetic on the bars, no clock, no randomness, no network, no files outside this repository. The same bars always give the same orders.

## Local backtest (dev window, 136 hourly bars)

Graded with the kit (`grade-local --driver process`):

| | Breakout Rider | Buy-and-hold baseline |
| --- | --- | --- |
| Net PnL | **−250.90 USDC** (−2.51%) | −869.34 USDC (−8.69%) |
| Trades | 53 over 7 symbols | 7 (fails the ≥8 guardrail) |
| Max drawdown | 3.54% | 10.92% |
| Fees | 84.37 USDC | 19.14 USDC |

The dev window was a broad downtrend (every symbol down 3–14%), so no long-only bot makes money there — the win is losing far less than buy-and-hold (+618.44 USDC margin) while trading often and keeping drawdown small. Split-half checks agree in both halves (first half −144.6 vs buy-and-hold −641.2; second half −55.0 vs −216.0 in an offline replay of the same rule). The final window is unseen future data; the rule is deliberately simple and untuned so it generalises rather than fitting this window.

## Run it

The grader runs `node /bot/main.ts` (Node 22). The bot speaks the `agent-fun/bars-replay/v1` protocol on stdin/stdout via `vendor/makefun-bars.ts` (a byte-identical copy of the kit's SDK). To grade locally from the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process --worktree
```

## Files

- `main.ts` — the bot (TypeScript, Node 22, no dependencies)
- `vendor/makefun-bars.ts` — the bars-replay protocol shim (byte-identical copy of the kit SDK)
- `LICENSE` — MIT

Built for the [Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) bounty on make.fun.
