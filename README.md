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
and they are the comparables the model prices the board from.

## The top of the board (radar-4)

| Rank | Protocol | Implied value |
| --- | --- | --- |
| 1 | Sentora Curator | $30.2M |
| 2 | Steakhouse Financial | $30.2M |
| 3 | Gauntlet | $23.0M |
| 4 | Veda | $22.9M |
| 5 | Polymarket | $21.1M |

## How a row is priced (model radar-4)

A protocol is rankable when the snapshot records no token for it at all — no
market cap, no CoinGecko id, no symbol — and it passes the watchlist screen:
not a bridge, liquid-staking or restaking product, no whole word `wrapped`,
`staked` or `staking` in the name, no version marker, no exchange-name prefix.

Implied value is derived in three stages:

1. **Fitted curve** — `value_if_launches = 10^(a + b·log₁₀(TVL)) × family_offset × ∏kept_terms`
   - `a = 3.2610`, `b = 0.4903` (Huber-robust fit on 119 live-token comparables, R² = 0.1428)
   - `family_offset` — shrunken category offset (dropped by ablation; = 1.0 here)
   - `kept_terms` — extra terms (growth, seasoning, breadth) that pass dual LOO+WF gate (none kept)

2. **Launch odds** — age-bucket odds from the snapshot (AUC 0.707, base rate 50.7%):
   - `<180d`: 27.8% | `180–365d`: 39.9% | `365–730d`: 38.9% | `730–1095d`: 54.6% | `>1095d`: 78.3%

3. **Implied value** — `implied = max(1, round(value_if_launches × odds))`

No protocol name is ever special-cased: the same function scores every row, and
the curve parameters are fitted from the snapshot at run time, so a future
snapshot re-prices the board on its own.

### Farm economics & verdicts (at $1,000 deposit)

- **Expected slice** = (1000 / TVL) × 10% × implied (already includes odds)
- **Slice if launches** = slice / odds
- **Gas** = setup ($8 if plan capital ≥ $150 else $4) + $2/week × weeks + $3 second-chain + $2 claim
- **T-bill** = 4% × $1000 × hold_days / 365 (hold days by age: 30/45/60)
- **Net if launches** = sliceLaunch − gas − T-bill
- **Expected net** = slice − gas − T-bill
- **Break-even odds %** = (gas + T-bill) / sliceLaunch × 100 (sentinel 100,000% if never pays)
- **Hours** = 15 min setup + 10 min/week × weeks + 10 min second-chain + 10 min claim + 5 min log
- **Net/hour** = expected net / hours

**Verdict rules (locked):**
- **ROBUST** = FARM and net at band_lo > $0
- **FARM** = expected net > $0 and net/hour ≥ $1
- **THIN** = expected net > $0 and net/hour < $1
- **MARGINAL** = expected net ≤ $0 and break-even odds < 100%
- **SKIP** = break-even odds ≥ 100%

Current verdict counts: ROBUST 0, FARM 25, THIN 3, MARGINAL 101, SKIP 69 (sum 198).

### Validation (radar-4)

- LOO: curve miss 3.33× vs flat 4.88× | within 3×: 43.7% vs 34.5%
- Walk-forward (cut 2024-02-28, n=44/43): curve 2.43× vs flat 5.03×
- Band-hold: P25–P75 49.6% (nominal 50%), P10–P90 79.8% (nominal 80%)
- Ablation: 7 steps — flat → OLS → Huber (kept) → family offsets (dropped) → +growth (dropped) → +seasoning (dropped) → +breadth (dropped)
- Bootstrap rank ranges: 200 refits, fixed seed 0x52414441 ("RADA")

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
theme. It shows the ranked board with search, category / chain / verdict /
minimum-TVL filters and sorting (implied, expected net, net/hour), a spotlight
of the top three, the live-token protocols set aside, the method & validation
panel with the fitted equation, LOO/WF/band-hold/ablation/odds tables, a
KPI strip, a "Best Farms Next" strip (top 5 FARM/THIN by net/hour), the
category multiples panel, and a detail drawer per protocol with the waterfall
(curve → family_offset → kept_terms → value_if_launches → × odds → implied),
nearest 3 comparables, uncertainty bands + bootstrap rank range, and the farm
economics box (slice, gas, T-bill, net if launches, expected net, break-even
odds %, hours, net/hour, verdict). The page recomputes each row's implied
value from the radar-4 formula and checks it against `board.json` — 0 mismatches
across all 198 rows.

## Running it

Node 22, standard library only, no dependencies and no network at run time:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

`main.ts` reads the sealed snapshot, scores the board with the radar-4 model in
`lib/model.ts`, writes `board.json` and `data.js`, copies `dashboard/` and
`screenshots/` into the output, then reads `board.json` and `data.js` back off
the disk and checks them against the board in memory — a short or changed write
fails here, not in the grader — and finally seals `dossier.json` with the
kit's vendored `vendor/makefun-board.ts`. The output is deterministic: two runs
into separate directories write byte-identical files.

## Files

- `main.ts` — the entry program: snapshot in, board + dashboard + dossier out.
- `lib/model.ts` — the radar-4 model, the board builder, the farm-plan generator.
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
