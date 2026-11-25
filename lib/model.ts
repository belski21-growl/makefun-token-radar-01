// Token Radar's scoring model (radar-3): a sealed snapshot goes in, a ranked board comes out.
//
// The board covers every pre-token protocol the snapshot can name. The 40
// watchlist slugs are the floor, never the ceiling: on top of them the board
// adds every other pre-token protocol below the floor that clears the same
// screen the house used when it picked the watchlist — no token, not wrapped,
// not staked, not versioned. A protocol counts as pre-token when its record
// shows no token anywhere: no market cap, no CoinGecko id, no symbol.
// Protocols whose token already trades are never ranked; they appear apart,
// priced at whatever the market says they are worth.
//
// Implied value comes only from the snapshot's own figures, in four factors:
//
//   comp     = the category's comparable multiple, built in three moves. The
//              median mcap_usd / tvl_usd of the category's live-token
//              protocols (at least 3 comparables, otherwise the global
//              median) is first drawn toward the global median — three
//              phantom comparables at the global rate keep a thin category's
//              noisy median from setting the price alone — then trimmed for
//              crowding, one percent per rankable pre-token protocol past the
//              third in the same category (a launch field split many ways is
//              worth less per protocol), and finally eased past the 0.80 cap
//              on a curve that approaches 1.00 without ever reaching it,
//              instead of stopping dead at the cap, so two rich categories no
//              longer tie at the cap. A launch is worth what the market
//              already pays per dollar of TVL for the same kind of protocol,
//              steadied, then split the way a crowded field splits it.
//   growth   = 1 + clamp(change_7d, -60, 120) / 100 * 0.5. A protocol whose
//              TVL is growing fast is worth more than one shrinking at the
//              same size.
//   maturity = 0.6 + min(age_days, 1095) / 1095 * 0.4. Age is the time since
//              DefiLlama first listed the protocol: how long it has run with
//              no token. Older, still-unlaunched protocols carry more
//              pent-up launch value; unknown age counts as 365 days.
//   breadth  = 1 + 0.02 * min(chains - 1, 5). A protocol live on more chains
//              reaches more farmers.
//
//   implied  = max(1, round(tvl_usd * comp * growth * maturity * breadth * odds))
//
//   odds     = sigmoid(a + b * log10(age_days) + c * log10(tvl_usd)), fitted
//              at run time from the snapshot itself by logistic regression:
//              a protocol counts as launched when the snapshot records a
//              token for it, pre-token when it records none. Age is the time
//              since DefiLlama first listed the protocol (unknown age counts
//              as 365 days, the model's own constant); TVL is the protocol's
//              own. A protocol whose token already trades needs no odds, so
//              its odds are 1. The board's implied value is therefore the
//              expected value: the value-if-it-launches times the odds it
//              launches at all. A giant that has run for years with no token
//              is worth less than the same TVL on a young protocol, because
//              the snapshot says old unlaunched protocols launch less often
//              — and the fit, the AUC and the base rate are printed at run
//              time so the claim can be checked, not trusted.
//
// No protocol name is ever special-cased: the same function scores every row,
// and the category multiples are computed from the snapshot at run time, so a
// future snapshot re-prices the board on its own. The dashboard recomputes
// each row from these same factors and checks the number board.json carries,
// so the page's code and the board's data are visibly the same arithmetic.

/** One protocol entry of the snapshot: exactly the ten fields the sealed input carries. */
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

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_per_chain: number;
  breadth_max_chains: number;
  comp_min: number;
  comp_max: number;
  comp_min_sample: number;
  /** Phantom comparables at the global rate that steady a thin category's median. */
  comp_shrink: number;
  /** Rankable pre-token protocols in a category before the crowding discount starts. */
  crowd_free: number;
  /** Discount per crowded protocol past the free count, as a fraction of the multiple. */
  crowd_step: number;
  /** Most crowded protocols the discount ever counts. */
  crowd_max_steps: number;
  /** How far past the cap the easing curve may rise, on top of the cap. */
  comp_soft_span: number;
  /** The multiple never passes this, however rich the category's median. */
  comp_ceiling: number;
}

export const MODEL: ModelConstants = {
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
  crowd_max_steps: 20,
  comp_soft_span: 0.2,
  comp_ceiling: 1.0,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-3';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  /** The fitted odds this protocol's token launches at all — the expected-value multiplier. */
  launch_odds: number;
  model: {
    comp_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with the farm plan carried from board.json. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  /** The fitted launch odds for this row (full precision; traded tokens carry 1). */
  odds: number;
  comp_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  comp_global: number;
  comp_by_category: Record<string, number>;
  /** The launch-odds fit, computed from the snapshot at run time. */
  odds_fit: LaunchOddsFit;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const MS_PER_DAY = 86_400_000;

/** `value` when it is a finite number, `fallback` otherwise. */
function numOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
}

/** The median of a non-empty list, else `fallback`. */
function middleValue(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[mid]!;
  return (ordered[mid - 1]! + ordered[mid]!) / 2;
}

/** Whole days from `from` to `to`, never below zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const listedMs = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(listedMs)) return null;
  return Math.max(0, Math.floor((asOfMs - listedMs) / MS_PER_DAY));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word wrapped, staked or staking anywhere in the name. */
const WRAPPED_TERM = /\b(wrapped|staked|staking)\b/i;
/** Exchange names a protocol name must not begin with (the house's watchlist rule). */
const EXCHANGE_LEAD = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const BLOCKED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol may be ranked: pre-token, and not a wrapped, staked or
 * bridged product of a token that already trades — the same screen the house
 * applied to the watchlist, minus the TVL floor and the parent-protocol record
 * (which the snapshot does not carry). A versioned pool, a bridge, a
 * liquid-staking receipt or an exchange's own product is not a protocol still
 * waiting on a launch of its own.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && BLOCKED_CATEGORIES.has(p.category)) return false;
  if (VERSION_MARKER.test(p.name)) return false;
  if (WRAPPED_TERM.test(p.name)) return false;
  if (EXCHANGE_LEAD.test(p.name)) return false;
  return true;
}

/** The snapshot's protocols, keyed by slug for the watchlist lookup. */
function slugIndex(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  const index = new Map<string, SnapshotProtocol>();
  for (const p of protocols) index.set(p.slug, p);
  return index;
}

/** How many rankable pre-token protocols crowd each category: the launch field's split. */
function crowdByCategory(snapshot: Snapshot): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of snapshot.protocols) {
    if (!isRankable(p)) continue;
    const cat = p.category ?? 'Other';
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  return counts;
}

/** Ease a multiple past `cap` on a curve that climbs toward `cap + span` and never arrives. */
function softCap(value: number, cap: number, span: number): number {
  if (value <= cap) return value;
  return cap + span * (1 - Math.exp(-(value - cap) / cap));
}

/**
 * The comparable multiples, radar-3: each category's median mcap/tvl over its
 * live-token protocols is steadied toward the global median (three phantom
 * comparables at the global rate, so a three-protocol median cannot set a
 * category's price on its own), discounted for how crowded its pre-token field
 * is, and eased past the cap instead of cut off at it, so two rich categories
 * keep their order above the cap instead of tying at 0.80. A category with
 * fewer than `comp_min_sample` live comparables still falls back to the global
 * median untouched. All of it is computed from the snapshot at run time.
 */
export function compMultiples(snapshot: Snapshot, model: ModelConstants): { global: number; byCategory: Map<string, number> } {
  const live = snapshot.protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.tvl_usd > 0);
  const allRatios = live.map((p) => p.mcap_usd! / p.tvl_usd);
  const globalRaw = middleValue(allRatios, 0.25);
  const global = Math.min(model.comp_max, Math.max(model.comp_min, globalRaw));
  const crowd = crowdByCategory(snapshot);
  const byCategory = new Map<string, number>();
  const cats = new Set(live.map((p) => p.category ?? 'Other'));
  for (const cat of cats) {
    const ratios = live.filter((p) => (p.category ?? 'Other') === cat).map((p) => p.mcap_usd! / p.tvl_usd);
    if (ratios.length < model.comp_min_sample) continue;
    const steadied = (ratios.length * middleValue(ratios, global) + model.comp_shrink * global) / (ratios.length + model.comp_shrink);
    const extra = Math.min(Math.max((crowd.get(cat) ?? 0) - model.crowd_free, 0), model.crowd_max_steps);
    const split = steadied * (1 - extra * model.crowd_step);
    const eased = softCap(split, model.comp_max, model.comp_soft_span);
    byCategory.set(cat, Math.max(model.comp_min, Math.min(model.comp_ceiling, eased)));
  }
  return { global, byCategory };
}

/** The four multipliers, the launch odds, and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  comp: number,
  odds: number = 1,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; breadthMult: number; age: number | null; odds: number } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = numOr(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extraChains = Math.min(Math.max(protocol.chains.length - 1, 0), model.breadth_max_chains);
  const breadthMult = 1 + extraChains * model.breadth_per_chain;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * comp * growthMult * maturityMult * breadthMult * odds));
  return { implied, growthPct, growthMult, maturityMult, breadthMult, age, odds };
}

/** The launch-odds fit: a logistic regression on the snapshot itself. */
export interface LaunchOddsFit {
  /** Intercept, on the raw log10(age) / log10(TVL) scale. */
  a: number;
  /** Slope on log10(age_days). */
  b: number;
  /** Slope on log10(tvl_usd). */
  c: number;
  /** Area under the ROC curve of the fitted odds on the snapshot's own protocols. */
  auc: number;
  /** Share of the snapshot's protocols that already record a token. */
  base_rate: number;
  /** Protocols the fit was trained on (the whole snapshot). */
  n: number;
  /** Of those, how many already record a token. */
  n_positive: number;
}

/** The logistic sigmoid, guarded against overflow at the extremes. */
function sigmoid(z: number): number {
  if (z > 700) return 1;
  if (z < -700) return 0;
  return 1 / (1 + Math.exp(-z));
}

/** Solve a 3x3 linear system by Gauss-Jordan elimination with partial pivoting. */
function solveLinear3(a: number[][], b: number[]): number[] {
  const m: number[][] = [];
  for (let i = 0; i < 3; i++) m.push([...a[i]!, b[i]!]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    const swapped = m[col]!;
    m[col] = m[pivot]!;
    m[pivot] = swapped;
    const pv = m[col]![col]!;
    for (let j = col; j < 4; j++) m[col]![j] = m[col]![j]! / pv;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r]![col]!;
      for (let j = col; j < 4; j++) m[r]![j] = m[r]![j]! - f * m[col]![j]!;
    }
  }
  return [m[0]![3]!, m[1]![3]!, m[2]![3]!];
}

/**
 * Fit the launch odds from the snapshot itself, at run time, deterministically:
 * logistic regression by Newton iterations (a fixed 25, stopping early only when
 * the step is below 1e-10), on standardised features so the iteration is stable.
 * The outcome is 1 when the snapshot records a token for the protocol (it already
 * trades, or at least has a token on record) and 0 when it records none. The
 * features are log10(age_days) — unknown age counts as the model's
 * `unknown_age_days`, and age is floored at 1 day so the logarithm is defined —
 * and log10(tvl_usd). The reported coefficients are converted back to the raw
 * log10 scale, so the dashboard can print the equation as it is actually used.
 * No randomness, no dates beyond the snapshot's own listed_at, no network.
 */
export function fitLaunchOdds(snapshot: Snapshot, model: ModelConstants = MODEL): LaunchOddsFit {
  const rows: { y: number; x1: number; x2: number }[] = [];
  for (const p of snapshot.protocols) {
    const age = ageDays(snapshot.as_of, p.listed_at) ?? model.unknown_age_days;
    rows.push({
      y: isPreToken(p) ? 0 : 1,
      x1: Math.log10(Math.max(age, 1)),
      x2: Math.log10(p.tvl_usd),
    });
  }
  const n = rows.length;
  let nPositive = 0;
  let sum1 = 0;
  let sum2 = 0;
  for (const r of rows) {
    nPositive += r.y;
    sum1 += r.x1;
    sum2 += r.x2;
  }
  const baseRate = nPositive / n;
  const mean1 = sum1 / n;
  const mean2 = sum2 / n;
  let sq1 = 0;
  let sq2 = 0;
  for (const r of rows) {
    sq1 += (r.x1 - mean1) ** 2;
    sq2 += (r.x2 - mean2) ** 2;
  }
  const std1 = Math.sqrt(sq1 / n);
  const std2 = Math.sqrt(sq2 / n);
  const xs: number[][] = [];
  for (const r of rows) xs.push([1, (r.x1 - mean1) / std1, (r.x2 - mean2) / std2]);
  let beta = [0, 0, 0];
  for (let iter = 0; iter < 25; iter++) {
    const grad = [0, 0, 0];
    const hess: number[][] = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let i = 0; i < n; i++) {
      const xi = xs[i]!;
      const z = beta[0]! * xi[0]! + beta[1]! * xi[1]! + beta[2]! * xi[2]!;
      const p = sigmoid(z);
      const residual = rows[i]!.y - p;
      const w = p * (1 - p);
      for (let a = 0; a < 3; a++) {
        grad[a] = grad[a]! + residual * xi[a]!;
        for (let b = 0; b < 3; b++) {
          hess[a]![b] = hess[a]![b]! + w * xi[a]! * xi[b]!;
        }
      }
    }
    const step = solveLinear3(hess, grad);
    beta = [beta[0]! + step[0]!, beta[1]! + step[1]!, beta[2]! + step[2]!];
    if (Math.max(Math.abs(step[0]!), Math.abs(step[1]!), Math.abs(step[2]!)) < 1e-10) break;
  }
  const a = beta[0]! - (beta[1]! * mean1) / std1 - (beta[2]! * mean2) / std2;
  const b = beta[1]! / std1;
  const c = beta[2]! / std2;
  const scores: { score: number; y: number }[] = [];
  for (const r of rows) scores.push({ score: sigmoid(a + b * r.x1 + c * r.x2), y: r.y });
  const positives = scores.filter((s) => s.y === 1);
  const negatives = scores.filter((s) => s.y === 0);
  let wins = 0;
  for (const pos of positives) {
    for (const neg of negatives) {
      if (pos.score > neg.score) wins += 1;
      else if (pos.score === neg.score) wins += 0.5;
    }
  }
  const auc = wins / (positives.length * negatives.length);
  return { a, b, c, auc, base_rate: baseRate, n, n_positive: nPositive };
}

/**
 * One protocol's launch odds under a fit: the sigmoid for a pre-token protocol,
 * and exactly 1 for a protocol whose token already trades — there is nothing
 * left to bet on a launch that has already happened.
 */
export function launchOddsFor(protocol: SnapshotProtocol, asOf: string, model: ModelConstants, fit: LaunchOddsFit): number {
  if (!isPreToken(protocol)) return 1;
  const age = ageDays(asOf, protocol.listed_at) ?? model.unknown_age_days;
  return sigmoid(fit.a + fit.b * Math.log10(Math.max(age, 1)) + fit.c * Math.log10(protocol.tvl_usd));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = slugIndex(snapshot.protocols);
  const { global, byCategory } = compMultiples(snapshot, model);
  const oddsFit = fitLaunchOdds(snapshot, model);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot,
  // but the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other pre-token protocol that passes the same screen, whatever its
  // TVL. Never a replacement for a watchlist row: a chosen protocol stays chosen.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored: { p: SnapshotProtocol; comp: number; implied: number; growthPct: number; growthMult: number; maturityMult: number; breadthMult: number; age: number | null; odds: number }[] = [];
  for (const p of chosen.values()) {
    const comp = byCategory.get(p.category ?? 'Other') ?? global;
    const odds = launchOddsFor(p, snapshot.as_of, model, oddsFit);
    const v = impliedValue(p, snapshot.as_of, model, comp, odds);
    scored.push({ p, comp, ...v });
  }
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardRow[] = [];
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i]!;
    board.push({
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      age_days: s.age,
      implied_value_usd: s.implied,
      launch_odds: s.odds,
      model: {
        comp_multiple: roundTo4(s.comp),
        growth_pct: s.growthPct,
        growth_multiplier: roundTo4(s.growthMult),
        maturity_multiplier: roundTo4(s.maturityMult),
        breadth_multiplier: roundTo4(s.breadthMult),
        age_days: s.age,
      },
      farm_steps: farmSteps(s.p, s.age).map(stepText),
    });
  }
  return board;
}

/** A number rounded to four decimal places. */
function roundTo4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
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
function stakeFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** One main-action rule: which categories it matches, and the sentence it writes. */
interface MainActionRule {
  match: (category: string) => boolean;
  write: (name: string, capital: number, chain: string) => string;
}

/** The category's main action, in the words a farmer can follow. First matching rule wins. */
function mainActionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const rules: MainActionRule[] = [
    { match: (x) => x.includes('lend') || x.includes('cdp') || x.includes('collateral'), write: (n, k, ch) => `Supply $${k} of USDC to ${n} on ${ch} and borrow $10 of stablecoin against it, then repay the borrow.` },
    { match: (x) => x.includes('dex') || x.includes('leveraged farm'), write: (n, k, ch) => `Provide $${k} of liquidity to ${n}'s main pool on ${ch} and make one swap through the pool each week.` },
    { match: (x) => x.includes('yield') || x.includes('curator') || x.includes('allocator'), write: (n, k, ch) => `Deposit $${k} into a ${n} vault on ${ch} and keep the vault shares for the whole hold period.` },
    { match: (x) => x.includes('bridge') || x.includes('cross chain'), write: (n, k, ch) => `Bridge $${k} of USDC to ${ch} through ${n} and use the bridged funds in the protocol's own app.` },
    { match: (x) => x.includes('staking') || x.includes('restak'), write: (n, k, ch) => `Stake $${k} of the chain's staking asset through ${n} and keep the receipt token in the same wallet.` },
    { match: (x) => x.includes('perpetual') || x.includes('derivative') || x.includes('options'), write: (n, k, ch) => `Deposit $${k} of USDC as margin on ${n} on ${ch} and open one small hedged position.` },
    { match: (x) => x.includes('prediction'), write: (n, k, ch) => `Fund $${k} on ${n} and place one small market position, then settle it before the market closes.` },
    { match: (x) => x.includes('stable'), write: (n, k, ch) => `Mint or deposit $${k} of the stable asset through ${n} on ${ch} and hold it in the farming wallet.` },
    { match: (x) => x.includes('rwa'), write: (n, k, ch) => `Mint $${k} of the protocol's yield-bearing asset on ${ch} and hold it for the whole period.` },
    { match: (x) => x.includes('insurance'), write: (n, k, ch) => `Buy $${k} of cover from ${n} on ${ch} and keep the policy active for the whole hold.` },
    { match: (x) => x.includes('privacy'), write: (n, k, ch) => `Deposit $${k} through ${n} on ${ch} and make one private transfer each week.` },
    { match: (x) => x.includes('ai agent') || x.includes('ai'), write: (n, k, ch) => `Deposit $${k} into ${n} on ${ch} and run one agent action through its app each week.` },
    { match: (x) => x.includes('farm'), write: (n, k, ch) => `Deposit $${k} into ${n}'s farm on ${ch} and harvest the rewards once a week.` },
  ];
  for (const rule of rules) {
    if (rule.match(c)) return rule.write(name, capital, chain);
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open for the whole hold.`;
}

/** One weekly-action rule: which categories it matches, and the sentence it writes. */
interface WeeklyActionRule {
  match: (category: string) => boolean;
  write: (name: string, chain: string) => string;
}

/** The category's second, qualifying action: a different kind of activity from the main one. */
function weeklyActionFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const rules: WeeklyActionRule[] = [
    { match: (x) => x.includes('lend') || x.includes('cdp') || x.includes('collateral'), write: (n) => `Each week, adjust the position once on ${n}: add $5 of collateral, repay a little of the borrow, or switch the supplied asset.` },
    { match: (x) => x.includes('dex') || x.includes('leveraged farm'), write: (n, ch) => `Each week, swap $10 through ${n} on ${ch} in a different pair from the liquidity pool.` },
    { match: (x) => x.includes('yield') || x.includes('curator') || x.includes('allocator'), write: (n) => `Each week, check the vault's points page on ${n} and deposit $5 more when the vault opens a new strategy.` },
    { match: (x) => x.includes('perpetual') || x.includes('derivative') || x.includes('options'), write: (n) => `Each week, close and reopen the hedge on ${n} once, keeping the position size the same.` },
    { match: (x) => x.includes('rwa'), write: (n) => `Each week, open ${n}'s rewards page and record the accrued yield so the position stays visible in the farm log.` },
    { match: (x) => x.includes('prediction'), write: (n) => `Each week, place one more small market position on ${n} on a different outcome from the first.` },
  ];
  for (const rule of rules) {
    if (rule.match(c)) return rule.write(name, chain);
  }
  return `Each week, make one more qualifying action on ${name}, such as a deposit, a swap, a vote or a claim.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names. Multi-chain protocols get a step on a second chain; young protocols get a longer hold.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const second = nextChain(p);
  const capital = stakeFor(p);
  const hold = holdFor(age);
  const gas = capital >= 150 ? 8 : 4;
  const steps: FarmStep[] = [];
  steps.push({
    text: `Use a fresh wallet that holds only the funds you plan to farm with, and keep its seed phrase offline on paper.`,
    cost: 'under $3 of gas for the first transaction',
    time: '5 minutes',
  });
  steps.push({
    text: mainActionFor(p, capital, chain),
    cost: `$${capital} of capital and about $${gas} of gas`,
    time: '15 minutes to set up',
  });
  steps.push({
    text: weeklyActionFor(p, chain),
    cost: 'about $2 of gas a week',
    time: '10 minutes a week',
  });
  if (second !== null) {
    steps.push({
      text: `Repeat the main position with $25 on ${second} as well, so the farm is visible on two chains instead of one.`,
      cost: '$25 of capital and about $3 of gas',
      time: '10 minutes',
    });
  }
  steps.push({
    text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
    cost: `the $${capital} stays in the position`,
    time: `${hold} days`,
  });
  steps.push({
    text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
    cost: 'no fee to check, and never pay to claim',
    time: '10 minutes',
  });
  steps.push({
    text: `Write the wallet, the dates and every transaction hash in a farm log so you can repeat the position or unwind it.`,
    cost: 'nothing but the log',
    time: '5 minutes',
  });
  return steps;
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const traded = snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX');
  traded.sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd);
  return traded.slice(0, LIVE_ROWS).map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    change_7d: p.change_7d,
  }));
}

/** A board row's compact form for data.js, with the farm plan carried from board.json. The comp
 * multiple here is full precision (board.json carries it rounded to 4 places), so the page's
 * recomputation of the implied value lands on the board's exact number. */
export function radarRow(row: BoardRow, comp: number): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    odds: row.launch_odds,
    comp_multiple: comp,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const { global, byCategory } = compMultiples(snapshot, model);
  const compOf = (row: BoardRow): number => byCategory.get(row.category ?? 'Other') ?? global;
  let early = 0;
  for (const r of board) {
    if (!snapshot.watchlist.includes(r.slug)) early++;
  }
  const compEntries: [string, number][] = [];
  for (const [k, v] of byCategory.entries()) compEntries.push([k, roundTo4(v)]);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    comp_global: roundTo4(global),
    comp_by_category: Object.fromEntries(compEntries),
    odds_fit: fitLaunchOdds(snapshot, model),
    rows: board.map((r) => radarRow(r, compOf(r))),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols: SnapshotProtocol[] = [];
  for (let i = 0; i < o.protocols.length; i++) {
    const v = o.protocols[i];
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    protocols.push({
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    });
  }
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
