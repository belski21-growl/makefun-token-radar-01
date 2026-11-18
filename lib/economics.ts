/**
 * Farm economics per row (P4).
 *
 * At a stated $1,000 deposit:
 * - slice $ = (1000 / TVL) * 10% * implied (10% drop share, stated)
 *   This is the EXPECTED slice (already includes odds via implied).
 * - sliceLaunch $ = slice / odds (if odds > 0) else slice
 *   This is the slice IF the token launches (pre-odds).
 * - gas $ = setup gas ($8 if plan capital >= $150 else $4) + $2/week * hold weeks
 *   + $3 second-chain step if multi-chain + $2 claim
 *   Plan capital comes from TVL tier: TVL >= 5B -> $250; >= 1B -> $150;
 *   >= 100M -> $100; else $50.
 * - T-bill forgone $ = 4% * $1000 * hold_days / 365
 * - Hands-on hours = 15 min setup + 10 min/week * weeks + 10 min second chain
 *   if any + 10 min claim + 5 min log
 * - net_if_launches (netLaunch) = sliceLaunch - gas - T-bill
 * - expected_net = slice - gas - T-bill
 * - break_even_odds % = (gas + T-bill) / sliceLaunch * 100
 *   (sentinel 100000 when sliceLaunch <= 0, since JSON cannot carry Infinity)
 * - net_per_hour = expected_net / hours
 *
 * Verdict rules (LOCKED):
 * - ROBUST = FARM and net_if_launches at band_lo > $0
 * - FARM = expected_net > $0 and net_per_hour >= $1
 * - THIN = expected_net > $0 but net_per_hour < $1
 * - MARGINAL = expected_net <= $0 but break_even_odds < 100%
 * - SKIP = break_even_odds >= 100%
 */

import type { SnapshotProtocol } from './model.ts';
import type { UncertaintyBand } from './curve.ts';

export interface EconInput {
  slug: string;
  name: string;
  tvl_usd: number;
  implied: number;           // implied value (post-odds, rounded)
  value_if_launches: number; // pre-odds
  odds: number;              // launch odds
  band_lo: number;           // P25 band low
  band_hi: number;           // P75 band high
  chain_count: number;
  hold_days: number;         // from plan / farm steps
}

export interface EconOutput {
  slice: number;
  gas: number;
  tbill: number;
  net_launch: number;        // net_if_launches
  expected_net: number;
  breakeven_pct: number;
  net_per_hour: number;
  verdict: 'ROBUST' | 'FARM' | 'THIN' | 'MARGINAL' | 'SKIP';
  hours: number;
  hold_days: number;
  // Component breakdown for transparency
  gas_setup: number;
  gas_weekly: number;
  gas_second_chain: number;
  gas_claim: number;
  weeks: number;
}

/** Constants (STATED, not fitted) */
const DEPOSIT = 1000;
const DROP_SHARE = 0.10;       // 10% drop share
const TBILL_RATE = 0.04;       // 4% T-bill
const SETUP_GAS_HIGH = 8;      // $8 if plan capital >= $150
const SETUP_GAS_LOW = 4;       // $4 if plan capital < $150
const GAS_PER_WEEK = 2;        // $2/week
const GAS_SECOND_CHAIN = 3;    // $3 if multi-chain
const GAS_CLAIM = 2;           // $2 claim
const MIN_SETUP_MINUTES = 15;  // 15 min setup
const MIN_PER_WEEK = 10;       // 10 min/week
const MIN_SECOND_CHAIN = 10;   // 10 min second chain
const MIN_CLAIM = 10;          // 10 min claim
const MIN_LOG = 5;             // 5 min log
const BREAKEVEN_SENTINEL = 100000; // sentinel for "never pays" (JSON cannot carry Infinity)

/** Compute plan capital from TVL tier (stakeSize rule). */
export function computeCapital(tvlUsd: number): number {
  if (tvlUsd >= 5e9) return 250;
  if (tvlUsd >= 1e9) return 150;
  if (tvlUsd >= 1e8) return 100;
  return 50;
}

/** Compute hold days from farm steps (parse the plan's own times). */
export function computeHoldDays(farmSteps: string[]): number {
  // The farm steps contain human-readable strings like "Week 1–12: ..."
  // We need to extract the hold period. For now, look for week ranges.
  let maxWeek = 0;
  for (const step of farmSteps) {
    // Match patterns like "Week 1-12", "Week 1–12", "Weeks 1-12", etc.
    const weekMatch = step.match(/[Ww]eeks?\s*(\d+)\s*[–-]\s*(\d+)/);
    if (weekMatch) {
      const endWeek = parseInt(weekMatch[2]);
      maxWeek = Math.max(maxWeek, endWeek);
    }
    // Also match "Week 12" or "Week 12:"
    const singleWeekMatch = step.match(/[Ww]eek\s*(\d+)/);
    if (singleWeekMatch) {
      const week = parseInt(singleWeekMatch[1]);
      maxWeek = Math.max(maxWeek, week);
    }
  }
  // If no weeks found, default to a reasonable value
  if (maxWeek === 0) maxWeek = 12;
  return maxWeek * 7;
}

/** Compute economics for a single protocol. */
export function computeEconomics(input: EconInput): EconOutput {
  // Slice: (1000 / TVL) * 10% * implied (this is the EXPECTED slice, already includes odds)
  const slice = (DEPOSIT / input.tvl_usd) * DROP_SHARE * input.implied;

  // Slice if launches: pre-odds slice = slice / odds (if odds > 0)
  const sliceLaunch = input.odds > 0 ? slice / input.odds : slice;

  // Hold days & weeks
  const holdDays = input.hold_days;
  const weeks = Math.ceil(holdDays / 7);

  // Gas components: setup gas depends on plan capital from TVL tier
  const capital = computeCapital(input.tvl_usd);
  const gasSetup = capital >= 150 ? SETUP_GAS_HIGH : SETUP_GAS_LOW;
  const gasWeekly = GAS_PER_WEEK * weeks;
  const gasSecondChain = input.chain_count > 1 ? GAS_SECOND_CHAIN : 0;
  const gasClaim = GAS_CLAIM;
  const gas = gasSetup + gasWeekly + gasSecondChain + gasClaim;

  // T-bill forgone
  const tbill = TBILL_RATE * DEPOSIT * holdDays / 365;

  // Net if launches (uses sliceLaunch, the pre-odds slice)
  const netLaunch = sliceLaunch - gas - tbill;

  // Expected net (uses slice, the post-odds expected slice)
  const expectedNet = slice - gas - tbill;

  // Break-even odds %: at what odds does net_if_launches = 0?
  // (gas + tbill) / sliceLaunch * 100
  const breakevenPct = sliceLaunch > 0 ? ((gas + tbill) / sliceLaunch) * 100 : BREAKEVEN_SENTINEL;

  // Hours
  const hours = (
    MIN_SETUP_MINUTES +
    MIN_PER_WEEK * weeks +
    (input.chain_count > 1 ? MIN_SECOND_CHAIN : 0) +
    MIN_CLAIM +
    MIN_LOG
  ) / 60;

  // Net per hour (uses expected_net)
  const netPerHour = hours > 0 ? expectedNet / hours : 0;

  // Verdict (LOCKED RULES)
  let verdict: EconOutput['verdict'];
  const isFarm = expectedNet > 0 && netPerHour >= 1;
  const isThin = expectedNet > 0 && netPerHour < 1;
  const isMarginal = expectedNet <= 0 && breakevenPct < 100;
  const isSkip = breakevenPct >= 100;

  // Robust check: FARM and net_if_launches at band_lo > $0
  // slice_at_band_lo = (DEPOSIT / TVL) * DROP_SHARE * band_lo
  // net_at_band_lo = slice_at_band_lo - gas - tbill
  const sliceAtBandLo = (DEPOSIT / input.tvl_usd) * DROP_SHARE * input.band_lo;
  const netAtBandLo = sliceAtBandLo - gas - tbill;
  const robustCheck = isFarm && netAtBandLo > 0;

  if (robustCheck) verdict = 'ROBUST';
  else if (isFarm) verdict = 'FARM';
  else if (isThin) verdict = 'THIN';
  else if (isMarginal) verdict = 'MARGINAL';
  else verdict = 'SKIP';

  return {
    slice,
    gas,
    tbill,
    net_launch: netLaunch,
    expected_net: expectedNet,
    breakeven_pct: breakevenPct,
    net_per_hour: netPerHour,
    verdict,
    hours,
    hold_days: holdDays,
    gas_setup: gasSetup,
    gas_weekly: gasWeekly,
    gas_second_chain: gasSecondChain,
    gas_claim: gasClaim,
    weeks,
  };
}

export function computeAllEconomics(
  boardProtocols: SnapshotProtocol[],
  impliedValues: number[],
  valueIfLaunches: number[],
  odds: number[],
  bands: UncertaintyBand[],
  farmStepsMap: Map<string, string[]>,
  holdDaysMap: Map<string, number>
): Map<string, EconOutput> {
  const results = new Map<string, EconOutput>();

  for (let i = 0; i < boardProtocols.length; i++) {
    const p = boardProtocols[i];
    const holdDays = holdDaysMap.get(p.slug) ?? 84;

    const input: EconInput = {
      slug: p.slug,
      name: p.name,
      tvl_usd: p.tvl_usd,
      implied: impliedValues[i],
      value_if_launches: valueIfLaunches[i],
      odds: odds[i],
      band_lo: bands[i].band_lo,
      band_hi: bands[i].band_hi,
      chain_count: p.chains.length,
      hold_days: holdDays,
    };

    results.set(p.slug, computeEconomics(input));
  }

  return results;
}

/** Verdict counts for reporting. */
export function countVerdicts(econMap: Map<string, EconOutput>): Record<string, number> {
  const counts = { robust: 0, farm: 0, thin: 0, marginal: 0, skip: 0 };
  for (const e of econMap.values()) {
    counts[e.verdict.toLowerCase() as keyof typeof counts]++;
  }
  return counts;
}

/** Best farms: top 5 by net_per_hour among FARM/THIN. */
export function getBestFarms(
  econMap: Map<string, EconOutput>,
  boardProtocols: SnapshotProtocol[]
): { slug: string; name: string; net_per_hour: number; expected_net: number }[] {
  const candidates: { slug: string; name: string; net_per_hour: number; expected_net: number }[] = [];

  for (const p of boardProtocols) {
    const econ = econMap.get(p.slug);
    if (econ && (econ.verdict === 'FARM' || econ.verdict === 'THIN')) {
      candidates.push({
        slug: p.slug,
        name: p.name,
        net_per_hour: econ.net_per_hour,
        expected_net: econ.expected_net,
      });
    }
  }

  candidates.sort((a, b) => b.net_per_hour - a.net_per_hour);
  return candidates.slice(0, 5);
}
