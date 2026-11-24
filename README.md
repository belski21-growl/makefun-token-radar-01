# Token Radar
[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/belski21-growl/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/belski21-growl/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A ranked board of pre-token protocols by **implied launch value** — what a token
launch could be worth, priced from the snapshot's own figures instead of from
hype. Built for the make.fun competition **token-radar-01** ($1,325 prize,
deadline 14 December 2026 10:00 WIB).

The board covers **198 rows**: the house's 40-protocol watchlist (every protocol
with at least $50M of TVL and no token on record) plus 158 more pre-token
protocols below that floor, screened the same way. The 24 protocols that already
have a live token are never ranked — they are shown apart, at their market caps,
and they are the traded comparables the size curve is fitted on.

## The top of the board

| Rank | Protocol | Implied value |
| --- | --- | --- |
| 1 | Steakhouse Financial | $78.3M |
| 2 | Sentora Curator | $72.4M |
| 3 | Gauntlet | $60.8M |
| 4 | Veda | $58.7M |
| 5 | USDD | $46.1M |

## How a row is priced (model radar-3f)

A protocol is rankable when the snapshot records no token for it at all — no
market cap, no CoinGecko id, no symbol — and it passes the watchlist screen:
not a bridge, liquid-staking or restaking product, no whole word `wrapped`,
`staked` or `staking` in the name, no version marker, no exchange-name prefix.

Implied value is one function of the snapshot's own numbers. The size term is
a curve fitted to the traded tokens in this very snapshot at run time, by
ordinary least squares in log space:

```
log10(mcap) = 3.0247 + 0.5223 × log10(TVL)      (R² = 0.1939, n = 128)
implied = max(1, round(10^(3.0247 + 0.5223 × log10(tvl_usd)) × growth × maturity × breadth))
```

The fit runs on every protocol that already trades — market cap above zero and
TVL above zero. The 15 protocols that record a market cap of exactly zero are
excluded, because log10(0) has no value and a zero cap is a record with no price
in it, not a price of zero. No coefficient is hard-coded: `main.ts` fits the
curve from the snapshot on every run, so a future snapshot re-prices the board
on its own, and the dashboard prints the fitted equation, its R² and its sample
size in the model panel. The slope is below one, so value grows slower than
size — ten times the TVL is worth only a few times the value, not ten times —
which is what the traded tokens themselves say.

Three smaller terms, unchanged from the earlier linear model, adjust the curve
value:

- **growth** — `1 + clamp(change_7d, −60, 120) / 100 × 0.5`. Fast-growing TVL
  is worth more at the same size.
- **maturity** — `0.6 + min(age_days, 1095) / 1095 × 0.4`, where age is the time
  since DefiLlama first listed the protocol; unknown age counts as 365 days.
  A protocol that has run a long time with no token carries more pent-up
  launch value.
- **breadth** — `1 + 0.02 × min(chains − 1, 5)`. More chains, more farmers.

No protocol name is ever special-cased: the same function scores every row.

## Farm plans

Every row carries a 6–7 step farm plan built from that protocol's own record —
its category, chains, TVL and age: a category-specific main action with concrete
capital ($50–$250 by TVL) and gas cost, a weekly qualifying action, a second-chain
step for multi-chain protocols, a hold period of 30–60 days by age, a claim-safety
step and a farm-log step. Each step states its cost and time. The plan is a
starting point, not advice: "no token" means the snapshot records none, which is
DefiLlama's record, not proof — verify the protocol's own page before farming,
never pay to claim an airdrop, never share a seed phrase.

## The dashboard

`dashboard/` is a static page with no network: `index.html` is the shell,
`app.js` renders everything from `data.js` beside it, `app.css` is the dark
theme. It shows the ranked board with search, category / chain / minimum-TVL
filters and sorting, a spotlight of the top three, the live-token protocols set
aside, the model panel with the fitted curve equation (intercept, slope, R²,
comparable count) and the full formula, and a detail drawer per protocol with
the curve value at that protocol's TVL, the model's own inputs and its farm
plan. The page recomputes each row's implied value from the same factors and
checks it against `board.json` — 0 mismatches across all 198 rows.

## Running it

Node 22, standard library only, no dependencies and no network at run time:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

`main.ts` reads the sealed snapshot, fits the size curve and scores the board
with the radar-3f model in `lib/model.ts`, writes `board.json` and `data.js`,
copies `dashboard/` and `screenshots/` into the output, then reads `board.json`
and `data.js` back off the disk and checks them against the board in memory —
a short or changed write fails here, not in the grader — and finally seals
`dossier.json` with the kit's vendored `vendor/makefun-board.ts`. The output is
deterministic: two runs into separate directories write byte-identical files.
The run prints the fitted curve on stdout, so the fit is visible in the log as
well as on the page.

## Files

- `main.ts` — the entry program: snapshot in, board + dashboard + dossier out.
- `lib/model.ts` — the radar-3f model (fitted log-log size curve + growth /
  maturity / breadth), the board builder, the farm-plan generator.
- `dashboard/` — the static page (`index.html`, `app.css`, `app.js`).
- `screenshots/` — the board, a detail view and a filtered view at 1440×900.
- `vendor/makefun-board.ts` — the kit's dossier builder, copied byte-for-byte.
- `LICENSE` — MIT.

## Validation

- Two runs into separate output directories produce byte-identical output.
- Board: 198 rows, ranks exactly 1–198, implied values strictly non-increasing,
  all 198 distinct, all slugs in the snapshot, watchlist 40/40 covered.
- Fitted curve (runtime, matches an independent replication): log10(mcap) =
  3.0247 + 0.5223 × log10(TVL), R² = 0.1939, n = 128 comps, 15 zero-mcap
  protocols excluded.
- Dashboard recompute: 0 mismatches across all 198 rows.
- Dossier: 764,119 bytes (< 1.5 MiB), text 45,503 bytes (< 65,536, nothing cut).

Implied values are this entry's model — an estimate of what a launch could be
worth at today's record, never a price and never a prediction that a token comes.
