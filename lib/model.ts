/**
 * Token Radar — the radar-4 model (round 3).
 *
 * New model core: RUNTIME-FITTED log-log curve
 *   implied = round(value_if_launches x launch_odds)
 *   value_if_launches = curve(TVL) x family_offset x kept_terms
 *
 * Where:
 * - curve(TVL) = 10^(a + b*log10(TVL)) fitted via OLS (or Huber if better LOO)
 * - family_offset = median LOO residual per category, shrunk by n/(n+3), clamped to [0.75, 1.33]
 * - kept_terms = extra terms (growth, seasoning, breadth) that pass ablation (improve BOTH LOO and walk-forward)
 * - launch_odds = from P5 bucket odds (smoothed toward base rate)
 *
 * Validation (P2): LOO, walk-forward, band-hold, ablation table
 * Uncertainty (P3): P25-P75/P10-P90 bands from LOO residuals, bootstrap rank ranges (200 refits)
 * Farm economics (P4): slice, gas, tbill, net, verdict at $1000 deposit
 * Launch odds (P5): age-bucket odds from snapshot, AUC reported
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fitFullModel,
  type FullModelOutput,
  type ValidationOutput,
  type CurveFit,
  type ExtraTerm,
  type OddsOutput,
  type AblationStep,
  type RankRange,
  type UncertaintyBand,
  computeLaunchOdds,
} from './curve.ts';
import {
  computeAllEconomics,
  computeCapital,
  type EconOutput,
  type EconInput,
  countVerdicts,
  getBestFarms,
} from './economics.ts';

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Board row (output JSON) — extended with radar-4 fields. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  change_7d: number | null;
  implied_value_usd: number;
  chains: string[];
  model_version: string;
  chains: string[];
  // Radar-4 new fields
  value_if_launches: number;
  odds: number;
  curve_value: number;
  family_offset: number;
  kept_terms: Record<string, number>;  // only kept terms with their multipliers
  band_lo: number;
  band_hi: number;
  band_lo90: number;
  band_hi90: number;
  rank_lo: number;
  rank_hi: number;
  farm_steps: string[];
  econ: {
    slice: number;
    gas: number;
    tbill: number;
    net_launch: number;
    expected_net: number;
    breakeven_pct: number;
    net_per_hour: number;
    verdict: 'ROBUST' | 'FARM' | 'THIN' | 'MARGINAL' | 'SKIP';
    hours: number;
    hold_days: number;
    gas_setup: number;
    gas_weekly: number;
    gas_second_chain: number;
    gas_claim: number;
    weeks: number;
  };
  nearest: Array<{ slug: string; name: string; tvl_usd: number; mcap_usd: number }>;
}

/** Live protocol row (traded, shown separately). */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
}

/** Radar data for data.js (dashboard) — extended with radar-4 fields. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: Record<string, number>;
  model_version: string;
  chains: string[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  comp_global: number;
  comp_by_category: Record<string, number>;
  comp_by_category_detail: Record<string, {
    multiple: number;
    comparables: number;
    fallback_global: boolean;
    crowd: number;
  }>;
  rows: RadarRow[];
  live: LiveRow[];
  // Radar-4 new fields
  fit: CurveFit;
  validation: ValidationOutput;
  ablation: AblationStep[];
  odds: OddsOutput;
  verdict_counts: { farm: number; thin: number; marginal: number; skip: number; robust: number };
  best_farms: Array<{ slug: string; name: string; net_per_hour: number; expected_net: number }>;
}

/** Radar row for data.js — extended with radar-4 fields. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  change_7d: number | null;
  implied_value_usd: number;
  chains: string[];
  // Radar-4 new
  value_if_launches: number;
  odds: number;
  curve_value: number;
  family_offset: number;
  kept_terms: Record<string, number>;
  band_lo: number;
  band_hi: number;
  band_lo90: number;
  band_hi90: number;
  rank_lo: number;
  rank_hi: number;
  farm_steps: string[];
  econ: {
    slice: number;
    gas: number;
    tbill: number;
    net_launch: number;
    expected_net: number;
    breakeven_pct: number;
    net_per_hour: number;
    verdict: 'ROBUST' | 'FARM' | 'THIN' | 'MARGINAL' | 'SKIP';
    hours: number;
    hold_days: number;
    gas_setup: number;
    gas_weekly: number;
    gas_second_chain: number;
    gas_claim: number;
    weeks: number;
  };
  nearest: Array<{ slug: string; name: string; tvl_usd: number; mcap_usd: number }>;
}

/** Model version label. */
const MODEL_VERSION = 'radar-4';

/** Round to 4 decimal places. */
function round4dp(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/** Median helper. */
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** ============================================================
 *  PRE-TOKEN / RANKABLE FILTERS (from radar-3)
 * ============================================================ */

/** Whether a protocol records no token at all. */
function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word wrapped, staked or staking anywhere in the name. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** Exchange names a protocol name must not begin with (the house's watchlist rule). */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/**
 * Whether a protocol may be ranked: pre-token, and not a wrapped, staked or bridged product of a
 * token that already trades — the same screen the house applied to the watchlist.
 */
function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** ============================================================
 *  FARM STEPS GENERATION (restored from radar-3, category-specific)
 * ============================================================ */

/** A single farm step with text, cost, and time. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** Convert a FarmStep to the dashboard string format: "text Cost: X. Time: Y." */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** A second chain when the protocol runs on more than one, else null. */
function nextChain(p: SnapshotProtocol): string | null {
  return p.chains.length > 1 ? p.chains[1]! : null;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function stakeSize(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
export function holdLength(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's main action, in the words a farmer can follow. */
function mainAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and borrow $10 of stablecoin against it, then repay the borrow.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and make one swap through the pool each week.`;
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares for the whole hold period.`;
  if (c.includes('bridge') || c.includes('cross chain')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in the protocol's own app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token in the same wallet.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${name} and place one small market position, then settle it before the market closes.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it in the farming wallet.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it for the whole period.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for the whole hold.`;
  if (c.includes('privacy')) return `Deposit $${capital} through ${name} on ${chain} and make one private transfer each week.`;
  if (c.includes('ai agent') || c.includes('ai')) return `Deposit $${capital} into ${name} on ${chain} and run one agent action through its app each week.`;
  if (c.includes('farm')) return `Deposit $${capital} into ${name}'s farm on ${chain} and harvest the rewards once a week.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open for the whole hold.`;
}

/** The category's second, qualifying action: a different kind of activity from the main one. */
function weeklyAction(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Each week, adjust the position once on ${name}: add $5 of collateral, repay a little of the borrow, or switch the supplied asset.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Each week, swap $10 through ${name} on ${chain} in a different pair from the liquidity pool.`;
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator')) return `Each week, check the vault's points page on ${name} and deposit $5 more when the vault opens a new strategy.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Each week, close and reopen the hedge on ${name} once, keeping the position size the same.`;
  if (c.includes('rwa')) return `Each week, open ${name}'s rewards page and record the accrued yield so the position stays visible in the farm log.`;
  if (c.includes('prediction')) return `Each week, place one more small market position on ${name} on a different outcome from the first.`;
  return `Each week, make one more qualifying action on ${name}, such as a deposit, a swap, a vote or a claim.`;
}

/**
 * The farm plan's first step: a fresh wallet, seed phrase offline — written for
 * this protocol's own kind of farming and age. A young or age-unknown protocol
 * gets a start-small warning; an older one keeps the plain safety line.
 */
function safetyFirstStep(p: SnapshotProtocol, age: number | null, chain: string): FarmStep {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  let purpose: string;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) purpose = `lend through ${name} on ${chain}`;
  else if (c.includes('dex') || c.includes('leveraged farm')) purpose = `provide liquidity on ${name} on ${chain}`;
  else if (c.includes('yield') || c.includes('curator') || c.includes('allocator')) purpose = `deposit into a ${name} vault on ${chain}`;
  else if (c.includes('bridge') || c.includes('cross chain')) purpose = `bridge through ${name} to ${chain}`;
  else if (c.includes('staking') || c.includes('restak')) purpose = `stake through ${name} on ${chain}`;
  else if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) purpose = `trade on ${name} on ${chain}`;
  else if (c.includes('prediction')) purpose = `fund a market position on ${name}`;
  else if (c.includes('stable')) purpose = `mint or deposit the stable asset through ${name} on ${chain}`;
  else if (c.includes('rwa')) purpose = `mint the yield-bearing asset of ${name} on ${chain}`;
  else if (c.includes('insurance')) purpose = `buy cover from ${name} on ${chain}`;
  else if (c.includes('privacy')) purpose = `deposit through ${name} on ${chain}`;
  else if (c.includes('ai agent') || c.includes('ai')) purpose = `run an agent action on ${name} on ${chain}`;
  else if (c.includes('farm')) purpose = `farm on ${name} on ${chain}`;
  else purpose = `farm on ${name} on ${chain}`;
  const ageNote =
    age === null
      ? ` Its listing age is unknown on the record, so start with the smallest position and check the protocol's own page first.`
      : age < 180
        ? ` It has been listed ${age} days, so start with the smallest position and check the protocol's own page first.`
        : '';
  return {
    text: `Use a fresh wallet that holds only the funds you plan to ${purpose}, and keep its seed phrase offline on paper.${ageNote}`,
    cost: 'under $3 of gas for the first transaction',
    time: '5 minutes',
  };
}

/**
 * A protocol's farm plan: 6-8 steps, each an action with a cost and a time.
 * The plan is derived from the protocol's own record (category, chains, TVL, age),
 * never from a hand-written list of names. Multi-chain protocols get a step on a
 * second chain; young protocols get a longer hold.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const second = nextChain(p);
  const capital = stakeSize(p);
  const hold = holdLength(age);
  const gas = capital >= 150 ? 8 : 4;
  const steps: FarmStep[] = [
    safetyFirstStep(p, age, chain),
    {
      text: mainAction(p, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyAction(p, chain),
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
  ];
  if (second !== null) {
    steps.push({
      text: `Repeat the main position with $25 on ${second} as well, so the farm is visible on two chains instead of one.`,
      cost: '$25 of capital and about $3 of gas',
      time: '10 minutes',
    });
  }
  steps.push(
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction hash in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  );
  return steps;
}

function buildFarmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const steps = farmSteps(p, age);
  return steps.map(stepText);
}

/** ============================================================
 *  CORE MODEL: BUILD RADAR
 * ============================================================ */

/** Parse snapshot from JSON text. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new Error('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new Error('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new Error('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new Error('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new Error('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new Error(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.map((c) => String(c)) : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist,
  };
}

/** Compute protocol age in days from snapshot's as_of date. */
function computeAgeDays(protocol: SnapshotProtocol, asOfDate: Date): number | null {
  if (!protocol.listed_at) return null;
  const listed = new Date(protocol.listed_at + 'T00:00:00Z');
  const age = Math.max(0, Math.floor((asOfDate.getTime() - listed.getTime()) / (1000 * 60 * 60 * 24)));
  return age;
}

/** Build the radar model from a parsed snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const asOfDate = new Date(snapshot.as_of + 'T00:00:00Z');

  // Board candidates: rankable pre-token protocols
  const boardCandidates = snapshot.protocols.filter(isRankable);

  // Live protocols: traded, mcap > 0, not CEX
  const live = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX' && p.mcap_usd != null && p.mcap_usd > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd);

  // Fit the full model (curve + family offsets + extra terms + odds)
  const modelOutput = fitFullModel(snapshot.protocols, boardCandidates);

  // Watchlist for gate check
  const watchlistSet = new Set(snapshot.watchlist);

  // Compute odds for each board candidate using snapshot's as_of date
  const oddsList = boardCandidates.map(p => {
    const age = computeAgeDays(p, asOfDate);
    const bucketDefs = [
      { label: '<180d', min: 0, max: 179 },
      { label: '180-365d', min: 180, max: 365 },
      { label: '365-730d', min: 366, max: 730 },
      { label: '730-1095d', min: 731, max: 1095 },
      { label: '>1095d', min: 1096, max: Infinity },
    ];
    let odds = modelOutput.odds.base_rate;
    if (age != null) {
      const bucket = bucketDefs.find(d => age >= d.min && age <= d.max);
      if (bucket) {
        const found = modelOutput.odds.buckets.find(b => b.label === bucket.label);
        odds = found?.odds ?? modelOutput.odds.base_rate;
      }
    }
    return odds;
  });

  // Build farm steps for all board candidates with age-derived hold days
  const farmStepsMap = new Map<string, string[]>();
  const holdDaysMap = new Map<string, number>();
  for (const p of boardCandidates) {
    const age = computeAgeDays(p, asOfDate);
    const holdDays = holdLength(age);
    holdDaysMap.set(p.slug, holdDays);
    farmStepsMap.set(p.slug, buildFarmSteps(p, age));
  }

  // Compute economics with per-protocol hold_days
  const econMap = computeAllEconomics(
    boardCandidates,
    modelOutput.implied_values,
    modelOutput.value_if_launches,
    oddsList,
    modelOutput.uncertainty_bands,
    farmStepsMap,
    holdDaysMap
  );

  // Verdict counts
  const verdictCounts = countVerdicts(econMap);

  // Best farms
  const bestFarms = getBestFarms(econMap, boardCandidates);

  // Family offsets are no longer applied (ablation dropped them)
  const familyOffsetsKept = false;

  // Build board rows with all fields (unsorted first)
  const unsortedBoard: Omit<BoardRow, 'rank'>[] = boardCandidates.map((p, i) => {
    const econ = econMap.get(p.slug)!;
    const bands = modelOutput.uncertainty_bands[i];
    const rankRange = modelOutput.rank_ranges[i];
    const nearest = modelOutput.nearest_comps[i];
    const keptTerms: Record<string, number> = {};
    for (const term of modelOutput.extra_terms) {
      if (term.kept) {
        keptTerms[term.name] = term.multiplier_at_mean;
      }
    }

    // Category multiple for compat (from radar-3 style) — family offset is 1.0 since ablation dropped it
    const familyOffset = 1.0;
    const curveValue = Math.pow(10, modelOutput.fit.a + modelOutput.fit.b * Math.log10(p.tvl_usd));
    const compMultiple = curveValue * familyOffset / p.tvl_usd;

    return {
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      implied_value_usd: modelOutput.implied_values[i],
      model_version: MODEL_VERSION,
      // Radar-4 new
      value_if_launches: Math.round(modelOutput.value_if_launches[i]),
      odds: oddsList[i],
      curve_value: Math.round(curveValue),
      family_offset: round4dp(familyOffset),
      kept_terms: keptTerms,
      band_lo: bands.band_lo,
      band_hi: bands.band_hi,
      band_lo90: bands.band_lo90,
      band_hi90: bands.band_hi90,
      rank_lo: rankRange.rank_min,
      rank_hi: rankRange.rank_max,
      farm_steps: farmStepsMap.get(p.slug)!,
      econ: {
        slice: round4dp(econ.slice),
        gas: round4dp(econ.gas),
        tbill: round4dp(econ.tbill),
        net_launch: round4dp(econ.net_launch),
        expected_net: round4dp(econ.expected_net),
        breakeven_pct: round4dp(econ.breakeven_pct),
        net_per_hour: round4dp(econ.net_per_hour),
        verdict: econ.verdict,
        hours: round4dp(econ.hours),
        hold_days: econ.hold_days,
        gas_setup: round4dp(econ.gas_setup),
        gas_weekly: round4dp(econ.gas_weekly),
        gas_second_chain: round4dp(econ.gas_second_chain),
        gas_claim: round4dp(econ.gas_claim),
        weeks: econ.weeks,
      },
      nearest,
    };
  });

  // Sort by implied_value_usd descending, tie-break by slug
  unsortedBoard.sort((a, b) => b.implied_value_usd - a.implied_value_usd || a.slug.localeCompare(b.slug));

  // Assign ranks
  const board: BoardRow[] = unsortedBoard.map((r, i) => ({ ...r, rank: i + 1 }));

  // Live rows (top 24 by mcap for compat)
  const liveRows: LiveRow[] = live.slice(0, 24).map(p => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
      chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd!,
    multiple: round4dp(p.mcap_usd! / p.tvl_usd),
  }));

  // Category multiples from live comparables (for dashboard display)
  const liveByCategory = new Map<string, number[]>();
  for (const p of live) {
    if (p.category && p.mcap_usd != null && p.mcap_usd > 0 && p.tvl_usd > 0) {
      const m = p.mcap_usd / p.tvl_usd;
      if (!liveByCategory.has(p.category)) liveByCategory.set(p.category, []);
      liveByCategory.get(p.category)!.push(m);
    }
  }
  const globalMultiple = live.length > 0 ? median(live.map(p => p.mcap_usd! / p.tvl_usd)) : 1;
  const compByCategory: Record<string, number> = {};
  const compByCategoryDetail: Record<string, { multiple: number; comparables: number; fallback_global: boolean; crowd: number }> = {};

  // Get all categories that appear in board (for detail completeness)
  const boardCategories = new Set(boardCandidates.map(p => p.category ?? 'Other').filter(Boolean));

  for (const cat of boardCategories) {
    const multiples = liveByCategory.get(cat) ?? [];
    const n = multiples.length;
    const catMedian = n > 0 ? median(multiples) : globalMultiple;
    const shrunk = n >= 3 ? catMedian : globalMultiple;
    const fallback = n < 3;
    // Crowd: count of rankable pre-token in this category
    const crowd = boardCandidates.filter(p => p.category === cat).length;
    const crowdedMultiple = shrunk * Math.max(0, 1 - Math.max(0, crowd - 3) * 0.01);
    const capped = Math.min(0.8 + 0.2 * (1 - Math.exp(-crowdedMultiple / 0.8)), 1.0); // soft cap
    compByCategory[cat] = round4dp(capped);
    compByCategoryDetail[cat] = {
      multiple: round4dp(capped),
      comparables: n,
      fallback_global: fallback,
      crowd,
    };
  }

  // Radar data for data.js
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: {
      // Radar-3 compat constants (for dashboard display)
      growth_weight: 0.5,
      growth_floor: -60,
      growth_cap: 120,
      maturity_floor: 0.6,
      maturity_range: 0.4,
      maturity_days: 1095,
      unknown_age_days: 365,
      breadth_per_chain: 0.02,
      breadth_max_chains: 5,
      comp_min: 0.08,
      comp_max: 0.8,
      comp_min_sample: 3,
      comp_shrink: 3,
      crowd_free: 3,
      crowd_step: 0.01,
      crowd_max_steps: 100,
      comp_soft_span: 0.2,
      comp_ceiling: 1.0,
    },
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: boardCandidates.filter(p => !watchlistSet.has(p.slug)).length,
    live_size: live.length,
    comp_global: round4dp(globalMultiple),
    comp_by_category: compByCategory,
    comp_by_category_detail: compByCategoryDetail,
    rows: board.map(r => radarRow(r)),
    live: liveRows,
    // Radar-4 new
    fit: modelOutput.fit,
    validation: modelOutput.validation,
    ablation: modelOutput.validation.ablation,
    odds: modelOutput.odds,
    verdict_counts: verdictCounts,
    best_farms: bestFarms,
  };

  return { board, radar };
}

/** Convert BoardRow to RadarRow (subset for data.js). */
function radarRow(r: BoardRow): RadarRow {
  return {
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    implied_value_usd: r.implied_value_usd,
    chains: r.chains,
    value_if_launches: r.value_if_launches,
    odds: r.odds,
    curve_value: r.curve_value,
    family_offset: r.family_offset,
    kept_terms: r.kept_terms,
    band_lo: r.band_lo,
    band_hi: r.band_hi,
    band_lo90: r.band_lo90,
    band_hi90: r.band_hi90,
    rank_lo: r.rank_lo,
    rank_hi: r.rank_hi,
    farm_steps: r.farm_steps,
    econ: r.econ,
    nearest: r.nearest,
  };
}

/** ============================================================
 *  BOARD VALIDATION (gate checks)
 * ============================================================ */

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map(r => r.slug));
  const missing = snapshot.watchlist.filter(s => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map(r => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** Compact data.js for dashboard. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
