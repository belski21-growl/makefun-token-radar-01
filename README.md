# Token Radar
[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/belski21-growl/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/belski21-growl/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A ranked board of pre-token protocols by **implied launch value** — an
estimate of what a token launch could be worth, priced from the snapshot's
own figures rather than from hype. Built for the make.fun competition
**token-radar-01** ($1,325 prize, deadline 14 December 2026 10:00 WIB).

The board holds **198 rows**: the house's 40-protocol watchlist (every
protocol with at least $50M of TVL and no token on record) plus 158 further
pre-token protocols below that floor, screened the same way. The 24
protocols that already trade are never ranked — they sit apart, at their
market caps, and they are the comparables the model prices the board from.

## The top of the board

| Rank | Protocol | Implied value |
| --- | --- | --- |
| 1 | Steakhouse Financial | $404.0M |
| 2 | Sentora Curator | $374.0M |
| 3 | Gauntlet | $240.6M |
| 4 | USDD | $141.4M |
| 5 | Veda | $109.6M |

## How a row is priced (model radar-3)

A protocol is rankable when the snapshot records no token for it at all — no
market cap, no CoinGecko id, no symbol — and it clears the watchlist screen:
not a bridge, liquid-staking or restaking product, no whole word `wrapped`,
`staked` or `staking` in the name, no version marker, no exchange-name prefix.

Implied value is one function of the snapshot's own numbers, in four factors:

```
implied = max(1, round(tvl_usd × comp × growth × maturity × breadth))
```

- **comp** — the category's comparable multiple: the median market-cap-per-TVL
  of the category's live-token protocols (three comparables at least, else the
  global median), steadied toward the global median with three phantom
  comparables at the global rate, discounted 1% per rankable pre-token protocol
  past the third in the same category (a crowded launch field splits the value),
  then eased past the 0.80 cap on a curve that never passes 1.00 — so two rich
  categories keep their order instead of tying at the cap. Floor 0.08.
- **growth** — `1 + clamp(change_7d, −60, 120) / 100 × 0.5`: TVL that is
  growing fast is worth more at the same size than TVL that is shrinking.
- **maturity** — `0.6 + min(age_days, 1095) / 1095 × 0.4`, where age is the time
  since DefiLlama first listed the protocol; unknown age counts as 365 days.
  A protocol that has run a long time with no token carries more pent-up
  launch value.
- **breadth** — `1 + 0.02 × min(chains − 1, 5)`: more chains means more farmers
  can reach the launch.

No protocol name is ever special-cased: the same function scores every row, and
the category multiples are computed from the snapshot at run time, so a future
snapshot re-prices the board on its own.

## Farm plans

Every row carries a 6–7 step farm plan built from that protocol's own record —
its category, chains, TVL and age: a category-specific main action with concrete
capital ($50–$250 by TVL) and gas cost, a weekly qualifying action, a second-chain
step for multi-chain protocols, a hold period of 30–60 days by age, a claim-safety
step and a farm-log step. Each step states its cost and time. The plan is a
starting point, not advice: "no token" means the snapshot records none, which is
DefiLlama's record, not proof — check the protocol's own page before farming,
never pay to claim an airdrop, never share a seed phrase.

## The dashboard

`dashboard/` is a static page with no network: `index.html` is the shell,
`app.js` renders everything from `data.js` beside it, `app.css` is the dark
theme. It shows the ranked board with search, category / chain / minimum-TVL
filters and sorting, a spotlight of the top three, the live-token protocols set
aside, the model panel with the formula and the category multiples, and a detail
drawer per protocol with the model's own inputs and its farm plan. The page
re-derives each row's implied value from the same four factors and checks it
against `board.json` — 0 mismatches across all 198 rows.

## Running it

Node 22, standard library only, no dependencies and no network at run time:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

`main.ts` reads the sealed snapshot, scores the board with the radar-3 model in
`lib/model.ts`, writes `board.json` and `data.js`, copies `dashboard/` and
`screenshots/` into the output, then reads `board.json` and `data.js` back off
the disk and checks them against the board in memory — a short or changed write
fails here, not in the grader — and finally seals `dossier.json` with the
kit's vendored `vendor/makefun-board.ts`. The output is deterministic: two runs
into separate directories write byte-identical files.

## Files

- `main.ts` — the entry program: snapshot in, board + dashboard + dossier out.
- `lib/model.ts` — the radar-3 model, the board builder, the farm-plan generator.
- `dashboard/` — the static page (`index.html`, `app.css`, `app.js`).
- `screenshots/` — the board, a detail view and a filtered view at 1440×900.
- `vendor/makefun-board.ts` — the kit's dossier builder, copied byte-for-byte.
- `LICENSE` — MIT.

## Validation

- Two runs into separate output directories produce byte-identical output.
- Board: 198 rows, ranks exactly 1–198, implied values strictly non-increasing,
  all 198 distinct, all slugs in the snapshot, watchlist 40/40 covered.
- Dashboard recompute: 0 mismatches across all 198 rows.
- Dossier: 754,470 bytes (< 1.5 MiB), text 36,194 bytes (< 65,536, nothing cut).

Implied values are this entry's model — an estimate of what a launch could be
worth at today's record, never a price and never a prediction that a token comes.
