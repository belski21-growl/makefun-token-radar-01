// Token Radar — the scoring model (radar-3), re-authored for the probe-B entry.
//
// One sealed snapshot goes in; one ranked board comes out. The board covers
// every pre-token protocol the snapshot can name: the 40 slugs on the house
// watchlist (a floor, not a ceiling) plus any other pre-token protocol below
// that floor that clears the same screen the house used for the watchlist —
// no token, not wrapped, not staked, not versioned. A protocol counts as
// pre-token when its record carries no token at all: no market cap, no
// CoinGecko id, no symbol. Protocols that already trade are never ranked;
// they sit apart at their market's own value.
//
// A row's implied value comes only from the snapshot's own figures, in four
// factors:
//
//   comp     — the category's comparable multiple, in three moves. First the
//              median mcap_usd / tvl_usd of the category's live-token
//              protocols (three comparables at least, else the global
//              median) is pulled toward the global median: three phantom
//              comparables at the global rate steady a thin category's
//              noisy median. Then it is discounted for crowding, one
//              percent per rankable pre-token protocol past the third in
//              the same category — a launch field split many ways is worth
//              less per protocol. Finally it is eased past the 0.80 cap on
//              a curve that approaches 1.00 without ever reaching it,
//              instead of stopping dead at the cap, so two rich categories
//              no longer tie.
//   growth   — 1 + clamp(change_7d, -60, 120) / 100 * 0.5. TVL growing
//              fast is worth more than TVL shrinking at the same size.
//   maturity — 0.6 + min(age_days, 1095) / 1095 * 0.4. Age is the time
//              since DefiLlama first listed the protocol: how long it has
//              run with no token. Older, still-unlaunched protocols carry
//              more pent-up launch value; unknown age counts as 365 days.
//   breadth  — 1 + 0.02 * min(chains - 1, 5). A protocol live on more
//              chains reaches more farmers.
//
//   implied  — max(1, round(tvl_usd * comp * growth * maturity * breadth))
//
// No protocol name is ever special-cased: the same function scores every
// row, and the category multiples are computed from the snapshot at run
// time, so a future snapshot re-prices the board on its own. The dashboard
// recomputes each row from these same factors and checks the number
// board.json carries, so the page's code and the board's data are visibly
// the same arithmetic.

/** One protocol entry in the snapshot: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string; source: string; floor_usd: number;
  protocols: SnapshotProtocol[]; watchlist: string[];
}

/** One farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string; cost: string; time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number; slug: string; name: string; category: string | null;
  chains: string[]; tvl_usd: number; change_7d: number | null;
  mcap_usd: number | null; listed_at: string | null;
  gecko_id: string | null; symbol: string | null;
  token_status: 'pre-token'; age_days: number | null;
  implied_value_usd: number;
  model: {
    comp_multiple: number; growth_pct: number; growth_multiplier: number;
    maturity_multiplier: number; breadth_multiplier: number; age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with the farm plan carried from board.json. */
export interface RadarRow {
  rank: number; slug: string; name: string; category: string | null;
  chains: string[]; tvl_usd: number; change_7d: number | null;
  mcap_usd: number | null; listed_at: string | null; age_days: number | null;
  implied_value_usd: number; comp_multiple: number; growth_multiplier: number;
  maturity_multiplier: number; breadth_multiplier: number; farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; mcap_usd: number | null; change_7d: number | null;
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  growth_weight: number; growth_floor: number; growth_cap: number;
  maturity_floor: number; maturity_range: number; maturity_days: number;
  unknown_age_days: number; breadth_per_chain: number; breadth_max_chains: number;
  comp_min: number; comp_max: number; comp_min_sample: number;
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
  growth_weight: 0.5, growth_floor: -60, growth_cap: 120,
  maturity_floor: 0.6, maturity_range: 0.4, maturity_days: 1095,
  unknown_age_days: 365, breadth_per_chain: 0.02, breadth_max_chains: 5,
  comp_min: 0.08, comp_max: 0.8, comp_min_sample: 3,
  comp_shrink: 3, crowd_free: 3, crowd_step: 0.01, crowd_max_steps: 20,
  comp_soft_span: 0.2, comp_ceiling: 1.0,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-3';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string; source: string; floor_usd: number;
  model: ModelConstants; model_version: string;
  watchlist_size: number; board_size: number; early_size: number; live_size: number;
  comp_global: number; comp_by_category: Record<string, number>;
  rows: RadarRow[]; live: LiveRow[];
  /** Out-of-sample validation of the model, printed — never an input to any value. */
  validation: ModelValidation;
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** Round to four decimals. */
const to4dp = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function numOrFallback(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
}

/** The median of a non-empty list, else `fallback`. */
function middle(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[mid]!;
  return (ordered[mid - 1]! + ordered[mid]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(asOf + 'T00:00:00Z');
  const listed = Date.parse(listedAt + 'T00:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(listed)) return null;
  const span = Math.floor((start - listed) / DAY_MS);
  return span < 0 ? 0 : span;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSION_MARK = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word wrapped, staked or staking anywhere in the name. */
const WRAPPED_TERM = /\b(wrapped|staked|staking)\b/i;
/** Exchange names a protocol name must not begin with (the house's watchlist rule). */
const EXCHANGE_LEAD = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const SCREENED_OUT_CATS = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking',
  'Liquid Restaking', 'Restaked BTC', 'CEX',
]);

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol may be ranked: pre-token, and not a wrapped, staked or bridged product of a
 * token that already trades — the same screen the house applied to the watchlist, minus the TVL
 * floor and the parent-protocol record (which the snapshot does not carry). A versioned pool, a
 * bridge, a liquid-staking receipt or an exchange's own product is not a protocol still waiting
 * on a launch of its own.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && SCREENED_OUT_CATS.has(p.category)) return false;
  if (VERSION_MARK.test(p.name)) return false;
  if (WRAPPED_TERM.test(p.name)) return false;
  if (EXCHANGE_LEAD.test(p.name)) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function slugIndex(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  const index = new Map<string, SnapshotProtocol>();
  for (const p of protocols) index.set(p.slug, p);
  return index;
}

/** How many rankable pre-token protocols crowd each category: the launch field's split. */
function crowdPerCategory(snapshot: Snapshot): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of snapshot.protocols) {
    if (!isRankable(p)) continue;
    const cat = p.category === null ? 'Other' : p.category;
    const prev = counts.get(cat);
    counts.set(cat, prev === undefined ? 1 : prev + 1);
  }
  return counts;
}

/** Ease a multiple past `cap` on a curve that climbs toward `cap + span` and never arrives. */
function softenPastCap(value: number, cap: number, span: number): number {
  if (value <= cap) return value;
  const over = (value - cap) / cap;
  return cap + span * (1 - Math.exp(-over));
}

/**
 * The comparable multiples, radar-3: each category's median mcap/tvl over its live-token
 * protocols is steadied toward the global median (three phantom comparables at the global
 * rate, so a three-protocol median cannot set a category's price on its own), discounted for
 * how crowded its pre-token field is, and eased past the cap instead of cut off at it, so
 * two rich categories keep their order above the cap instead of tying at 0.80. A category
 * with fewer than `comp_min_sample` live comparables still falls back to the global median
 * untouched. All of it is computed from the snapshot at run time.
 */
export function compMultiples(
  snapshot: Snapshot,
  model: ModelConstants,
): { global: number; byCategory: Map<string, number> } {
  const live = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0 && !isPreToken(p));
  const ratios = live.map((p) => (p.mcap_usd as number) / p.tvl_usd);
  const globalRaw = middle(ratios, 0.25);
  const capped = Math.max(model.comp_min, globalRaw);
  const global = Math.min(model.comp_max, capped);
  const crowd = crowdPerCategory(snapshot);
  const byCategory = new Map<string, number>();
  const cats = new Set(live.map((p) => (p.category === null ? 'Other' : p.category)));
  for (const cat of cats) {
    const catRatios = live
      .filter((p) => (p.category === null ? 'Other' : p.category) === cat)
      .map((p) => (p.mcap_usd as number) / p.tvl_usd);
    if (catRatios.length < model.comp_min_sample) continue;
    const catMedian = middle(catRatios, global);
    const n = catRatios.length;
    const steadied = (n * catMedian + model.comp_shrink * global) / (n + model.comp_shrink);
    const crowded = crowd.get(cat) === undefined ? 0 : (crowd.get(cat) as number);
    const overFree = crowded - model.crowd_free;
    const extra = Math.min(overFree < 0 ? 0 : overFree, model.crowd_max_steps);
    const split = steadied * (1 - extra * model.crowd_step);
    const eased = softenPastCap(split, model.comp_max, model.comp_soft_span);
    const floored = Math.max(model.comp_min, eased);
    byCategory.set(cat, Math.min(model.comp_ceiling, floored));
  }
  return { global, byCategory };
}

/** The four multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  comp: number,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; breadthMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = numOrFallback(protocol.change_7d, 0);
  const clamped = Math.max(model.growth_floor, rawGrowth);
  const growthPct = Math.min(model.growth_cap, clamped);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age === null ? model.unknown_age_days : age;
  const boundedAge = Math.max(ageForModel, 0);
  const cappedAge = Math.min(boundedAge, model.maturity_days);
  const maturityMult = model.maturity_floor + (cappedAge / model.maturity_days) * model.maturity_range;
  const chainCount = protocol.chains.length - 1;
  const extraChains = Math.min(chainCount < 0 ? 0 : chainCount, model.breadth_max_chains);
  const breadthMult = 1 + extraChains * model.breadth_per_chain;
  const raw = protocol.tvl_usd * comp * growthMult * maturityMult * breadthMult;
  const implied = Math.max(1, Math.round(raw));
  return { implied, growthPct, growthMult, maturityMult, breadthMult, age };
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = slugIndex(snapshot.protocols);
  const multiples = compMultiples(snapshot, model);
  const global = multiples.global;
  const byCategory = multiples.byCategory;
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot,
  // but the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const found = index.get(slug);
    if (found !== undefined) chosen.set(slug, found);
  }
  // The early radar: every other pre-token protocol that passes the same screen, whatever its
  // TVL. Never a replacement for a watchlist row: a chosen protocol stays chosen.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const cat = p.category === null ? 'Other' : p.category;
    const comp = byCategory.get(cat) === undefined ? global : (byCategory.get(cat) as number);
    const v = impliedValue(p, snapshot.as_of, model, comp);
    return { p, comp, implied: v.implied, growthPct: v.growthPct, growthMult: v.growthMult, maturityMult: v.maturityMult, breadthMult: v.breadthMult, age: v.age };
  });
  scored.sort((a, b) => {
    const byValue = b.implied - a.implied;
    if (byValue !== 0) return byValue;
    if (a.p.slug < b.p.slug) return -1;
    if (a.p.slug > b.p.slug) return 1;
    return 0;
  });
  return scored.map((s, i) => ({
    rank: i + 1, slug: s.p.slug, name: s.p.name, category: s.p.category,
    chains: s.p.chains, tvl_usd: s.p.tvl_usd, change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd, listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id, symbol: s.p.symbol,
    token_status: 'pre-token', age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      comp_multiple: to4dp(s.comp), growth_pct: s.growthPct,
      growth_multiplier: to4dp(s.growthMult), maturity_multiplier: to4dp(s.maturityMult),
      breadth_multiplier: to4dp(s.breadthMult), age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = step.text + " Cost: " + step.cost + ". Time: " + step.time + ".";
  if (s.length > 600) s = s.slice(0, 596) + "...";
  if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(p: SnapshotProtocol): string {
  if (p.chains.length > 0) return p.chains[0] as string;
  return 'its main chain';
}

/** A second chain when the protocol runs on more than one, else null. */
function nextChain(p: SnapshotProtocol): string | null {
  if (p.chains.length > 1) return p.chains[1] as string;
  return null;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function stakeFor(p: SnapshotProtocol): number {
  const tvl = p.tvl_usd;
  if (tvl >= 5_000_000_000) return 250;
  if (tvl >= 1_000_000_000) return 150;
  if (tvl >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's main action, in the words a farmer can follow. */
function mainAction(proto: SnapshotProtocol, stake: number, primary: string): string {
  const kind = (proto.category === null ? '' : proto.category).toLowerCase();
  const title = proto.name;
  if (kind.includes('lend') || kind.includes('cdp') || kind.includes('collateral')) return `Supply $${stake} of USDC to ${title} on ${primary} and borrow $10 of stablecoin against it, then repay the borrow.`;
  if (kind.includes('dex') || kind.includes('leveraged farm')) return `Provide $${stake} of liquidity to ${title}'s main pool on ${primary} and make one swap through the pool each week.`;
  if (kind.includes('yield') || kind.includes('curator') || kind.includes('allocator')) return `Deposit $${stake} into a ${title} vault on ${primary} and keep the vault shares for the whole hold period.`;
  if (kind.includes('bridge') || kind.includes('cross chain')) return `Bridge $${stake} of USDC to ${primary} through ${title} and use the bridged funds in the protocol's own app.`;
  if (kind.includes('staking') || kind.includes('restak')) return `Stake $${stake} of the chain's staking asset through ${title} and keep the receipt token in the same wallet.`;
  if (kind.includes('perpetual') || kind.includes('derivative') || kind.includes('options')) return `Deposit $${stake} of USDC as margin on ${title} on ${primary} and open one small hedged position.`;
  if (kind.includes('prediction')) return `Fund $${stake} on ${title} and place one small market position, then settle it before the market closes.`;
  if (kind.includes('stable')) return `Mint or deposit $${stake} of the stable asset through ${title} on ${primary} and hold it in the farming wallet.`;
  if (kind.includes('rwa')) return `Mint $${stake} of the protocol's yield-bearing asset on ${primary} and hold it for the whole period.`;
  if (kind.includes('insurance')) return `Buy $${stake} of cover from ${title} on ${primary} and keep the policy active for the whole hold.`;
  if (kind.includes('privacy')) return `Deposit $${stake} through ${title} on ${primary} and make one private transfer each week.`;
  if (kind.includes('ai agent') || kind.includes('ai')) return `Deposit $${stake} into ${title} on ${primary} and run one agent action through its app each week.`;
  if (kind.includes('farm')) return `Deposit $${stake} into ${title}'s farm on ${primary} and harvest the rewards once a week.`;
  return `Deposit $${stake} of USDC into ${title} on ${primary} and keep the position open for the whole hold.`;
}

/** The category's second, qualifying action: a different kind of activity from the main one. */
function weeklyAction(proto: SnapshotProtocol, primary: string): string {
  const kind = (proto.category === null ? '' : proto.category).toLowerCase();
  const title = proto.name;
  if (kind.includes('lend') || kind.includes('cdp') || kind.includes('collateral')) return `Each week, adjust the position once on ${title}: add $5 of collateral, repay a little of the borrow, or switch the supplied asset.`;
  if (kind.includes('dex') || kind.includes('leveraged farm')) return `Each week, swap $10 through ${title} on ${primary} in a different pair from the liquidity pool.`;
  if (kind.includes('yield') || kind.includes('curator') || kind.includes('allocator')) return `Each week, check the vault's points page on ${title} and deposit $5 more when the vault opens a new strategy.`;
  if (kind.includes('perpetual') || kind.includes('derivative') || kind.includes('options')) return `Each week, close and reopen the hedge on ${title} once, keeping the position size the same.`;
  if (kind.includes('rwa')) return `Each week, open ${title}'s rewards page and record the accrued yield so the position stays visible in the farm log.`;
  if (kind.includes('prediction')) return `Each week, place one more small market position on ${title} on a different outcome from the first.`;
  return `Each week, make one more qualifying action on ${title}, such as a deposit, a swap, a vote or a claim.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names. Multi-chain protocols get a step on a second chain; young protocols get a longer hold.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const primary = firstChain(p);
  const second = nextChain(p);
  const stake = stakeFor(p);
  const hold = holdFor(age);
  const gas = stake >= 150 ? 8 : 4;
  const steps: FarmStep[] = [];
  steps.push({
    text: 'Use a fresh wallet that holds only the funds you plan to farm with, and keep its seed phrase offline on paper.',
    cost: 'under $3 of gas for the first transaction',
    time: '5 minutes',
  });
  steps.push({
    text: mainAction(p, stake, primary),
    cost: `$${stake} of capital and about $${gas} of gas`,
    time: '15 minutes to set up',
  });
  steps.push({
    text: weeklyAction(p, primary),
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
    cost: `the $${stake} stays in the position`,
    time: `${hold} days`,
  });
  steps.push({
    text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.",
    cost: 'no fee to check, and never pay to claim',
    time: '10 minutes',
  });
  steps.push({
    text: 'Write the wallet, the dates and every transaction hash in a farm log so you can repeat the position or unwind it.',
    cost: 'nothing but the log',
    time: '5 minutes',
  });
  return steps;
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const traded = snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX');
  traded.sort((a, b) => {
    const byCap = (b.mcap_usd === null ? 0 : b.mcap_usd) - (a.mcap_usd === null ? 0 : a.mcap_usd);
    if (byCap !== 0) return byCap;
    return b.tvl_usd - a.tvl_usd;
  });
  return traded.slice(0, LIVE_ROWS).map((p) => ({
    slug: p.slug, name: p.name, category: p.category, chains: p.chains,
    tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d,
  }));
}

/** A board row's compact form for data.js, with the farm plan carried from board.json. The comp
 * multiple here is full precision (board.json carries it rounded to 4 places), so the page's
 * recomputation of the implied value lands on the board's exact number. */
export function radarRow(row: BoardRow, comp: number): RadarRow {
  return {
    rank: row.rank, slug: row.slug, name: row.name, category: row.category,
    chains: row.chains, tvl_usd: row.tvl_usd, change_7d: row.change_7d,
    mcap_usd: row.mcap_usd, listed_at: row.listed_at, age_days: row.age_days,
    implied_value_usd: row.implied_value_usd, comp_multiple: comp,
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
  const multiples = compMultiples(snapshot, model);
  const compOf = (row: BoardRow): number => {
    const cat = row.category === null ? 'Other' : row.category;
    const hit = multiples.byCategory.get(cat);
    return hit === undefined ? multiples.global : hit;
  };
  const early = board.filter((r) => snapshot.watchlist.includes(r.slug) === false).length;
  const radar: RadarData = {
    as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd,
    model, model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length, board_size: board.length,
    early_size: early, live_size: live.length,
    comp_global: to4dp(multiples.global),
    comp_by_category: Object.fromEntries([...multiples.byCategory.entries()].map(([k, v]) => [k, to4dp(v)])),
    rows: board.map((r) => radarRow(r, compOf(r))),
    live,
    validation: validateModel(snapshot, model),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError("snapshot.json is not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SnapshotError("snapshot.json is not a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const dateOk = typeof o.as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.as_of);
  if (!dateOk) throw new SnapshotError("snapshot.json has no as_of date");
  if (typeof o.source !== "string") throw new SnapshotError("snapshot.json has no source");
  const floorOk = typeof o.floor_usd === "number" && Number.isSafeInteger(o.floor_usd) && (o.floor_usd as number) > 0;
  if (!floorOk) throw new SnapshotError("snapshot.json has no floor_usd");
  if (!Array.isArray(o.protocols)) throw new SnapshotError("snapshot.json has no protocols array");
  const listOk = Array.isArray(o.watchlist) && (o.watchlist as unknown[]).every((s) => typeof s === "string");
  if (!listOk) throw new SnapshotError("snapshot.json has no watchlist of slugs");
  const protocols = (o.protocols as unknown[]).map((v, i) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    const shapeOk = typeof p.slug === "string" && typeof p.name === "string" && typeof p.tvl_usd === "number" && Number.isFinite(p.tvl_usd as number);
    if (!shapeOk) throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    const numOrNull = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? (x as number) : null);
    const strOrNull = (x: unknown): string | null => (typeof x === "string" ? (x as string) : null);
    const chainList = Array.isArray(p.chains) ? (p.chains as unknown[]).filter((c): c is string => typeof c === "string") : [];
    return {
      slug: p.slug as string,
      name: p.name as string,
      category: typeof p.category === "string" ? (p.category as string) : null,
      chains: chainList,
      tvl_usd: p.tvl_usd as number,
      change_7d: numOrNull(p.change_7d),
      mcap_usd: numOrNull(p.mcap_usd),
      listed_at: strOrNull(p.listed_at),
      gecko_id: strOrNull(p.gecko_id),
      symbol: strOrNull(p.symbol),
    };
  });
  return {
    as_of: o.as_of as string,
    source: o.source as string,
    floor_usd: o.floor_usd as number,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => slugs.has(s) === false);
  if (missing.length > 0) {
    const plural = missing.length === 1 ? "" : "s";
    return `the board misses ${missing.length} watchlist slug${plural}: ${missing.slice(0, 5).join(", ")}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if ((board[i] as BoardRow).implied_value_usd > (board[i - 1] as BoardRow).implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (board.length >= 2) {
    const first = (board[0] as BoardRow).implied_value_usd;
    const last = (board[board.length - 1] as BoardRow).implied_value_usd;
    if (first === last) return `all ${board.length} rows share the same implied value $${first}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
    const valueOk = Number.isSafeInteger(r.implied_value_usd) && r.implied_value_usd > 0;
    if (!valueOk) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return "window.RADAR=" + JSON.stringify(radar) + ";\n";
}

/** ---- Out-of-sample validation (probe B): printed only, never fed back ---- */

/** One miss summary: how far predictions land from real market caps. */
export interface MissSummary {
  /** Held-out protocols scored. */
  n: number;
  /** Median max(pred/real, real/pred): the headline — robust to outliers. */
  median_miss: number;
  /** Mean miss, for the record: a few extreme comps dominate it. */
  mean_miss: number;
  /** Share of predictions within 2x of the real market cap, in percent. */
  within_2x_pct: number;
  /** Share within 3x, in percent. */
  within_3x_pct: number;
}

/** Walk-forward summary: a miss summary plus its time split. */
export interface WalkForwardSummary extends MissSummary {
  /** Fit-set protocols listed on or before the split date. */
  n_train: number;
  /** The split date: the median listed_at of the valued comps. */
  split_date: string;
  /** Fit-set protocols with no listed date, excluded from walk-forward. */
  excluded_no_date: number;
}

/** The whole printed validation: leave-one-out plus walk-forward. */
export interface ModelValidation {
  loo: MissSummary;
  loo_comp_only: MissSummary;
  loo_flat: MissSummary;
  walk_forward: WalkForwardSummary;
  walk_forward_comp_only: MissSummary;
  walk_forward_flat: MissSummary;
}

/** The median of a non-empty list (validation-local: never touches the model). */
function valMedian(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[mid] as number;
  return ((ordered[mid - 1] as number) + (ordered[mid] as number)) / 2;
}

/** Ease a multiple past `cap` toward `cap + span`, never arriving (validation-local). */
function valSoften(value: number, cap: number, span: number): number {
  if (value <= cap) return value;
  return cap + span * (1 - Math.exp(-(value - cap) / cap));
}

/** Rankable pre-token protocols per category (validation-local crowd count). */
function valCrowd(snapshot: Snapshot): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of snapshot.protocols) {
    if (!isRankable(p)) continue;
    const cat = p.category === null ? 'Other' : p.category;
    const prev = counts.get(cat);
    counts.set(cat, prev === undefined ? 1 : prev + 1);
  }
  return counts;
}

/**
 * The comparable multiples fitted on `train` only — the model's own rule,
 * restated, not reused: the live set is every non-pre-token protocol with a
 * recorded market cap and a positive TVL, INCLUDING the zero-mcap records
 * (ratio 0); each category's median is steadied toward the global median
 * with `comp_shrink` phantom comparables, discounted for crowding, eased
 * past the cap, and clamped. The crowd counts come from the full snapshot:
 * crowding is a property of the board's field, not of the training split.
 */
function valMultiples(
  train: SnapshotProtocol[],
  snapshot: Snapshot,
  model: ModelConstants,
): { global: number; byCategory: Map<string, number> } {
  const live = train.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0 && !isPreToken(p));
  const ratios = live.map((p) => (p.mcap_usd as number) / p.tvl_usd);
  const globalRaw = valMedian(ratios);
  const global = Math.min(model.comp_max, Math.max(model.comp_min, globalRaw));
  const crowd = valCrowd(snapshot);
  const ratiosByCat = new Map<string, number[]>();
  for (const p of live) {
    const cat = p.category === null ? 'Other' : p.category;
    const list = ratiosByCat.get(cat);
    if (list === undefined) ratiosByCat.set(cat, [(p.mcap_usd as number) / p.tvl_usd]);
    else list.push((p.mcap_usd as number) / p.tvl_usd);
  }
  const byCategory = new Map<string, number>();
  for (const [cat, catRatios] of ratiosByCat) {
    if (catRatios.length < model.comp_min_sample) continue;
    const catMedian = valMedian(catRatios);
    const n = catRatios.length;
    const steadied = (n * catMedian + model.comp_shrink * global) / (n + model.comp_shrink);
    const crowded = crowd.get(cat) === undefined ? 0 : (crowd.get(cat) as number);
    const overFree = crowded - model.crowd_free;
    const extra = Math.min(overFree < 0 ? 0 : overFree, model.crowd_max_steps);
    const split = steadied * (1 - extra * model.crowd_step);
    const eased = valSoften(split, model.comp_max, model.comp_soft_span);
    const floored = Math.max(model.comp_min, eased);
    byCategory.set(cat, Math.min(model.comp_ceiling, floored));
  }
  return { global, byCategory };
}

/** The growth / maturity / breadth factors one protocol gets (validation-local). */
function valFactors(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { growth: number; maturity: number; breadth: number } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = typeof protocol.change_7d === 'number' && Number.isFinite(protocol.change_7d) ? protocol.change_7d : 0;
  const clamped = Math.max(model.growth_floor, rawGrowth);
  const growthPct = Math.min(model.growth_cap, clamped);
  const growth = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age === null ? model.unknown_age_days : age;
  const boundedAge = Math.max(ageForModel, 0);
  const cappedAge = Math.min(boundedAge, model.maturity_days);
  const maturity = model.maturity_floor + (cappedAge / model.maturity_days) * model.maturity_range;
  const chainCount = protocol.chains.length - 1;
  const extraChains = Math.min(chainCount < 0 ? 0 : chainCount, model.breadth_max_chains);
  const breadth = 1 + extraChains * model.breadth_per_chain;
  return { growth, maturity, breadth };
}

/** A held-out protocol's predicted market cap under fitted multiples. */
function valPredict(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  global: number,
  byCategory: Map<string, number>,
  full: boolean,
): number {
  const cat = protocol.category === null ? 'Other' : protocol.category;
  const hit = byCategory.get(cat);
  const comp = hit === undefined ? global : hit;
  if (!full) return protocol.tvl_usd * comp;
  const factors = valFactors(protocol, asOf, model);
  return protocol.tvl_usd * comp * factors.growth * factors.maturity * factors.breadth;
}

/** One miss: the factor by which a prediction is off, either direction. */
function valMiss(predicted: number, real: number): number {
  const over = predicted / real;
  const under = real / predicted;
  return over > under ? over : under;
}

/** A miss list summarised; numbers rounded to 4 decimals for stable bytes. */
function valSummarize(misses: number[]): MissSummary {
  const ordered = [...misses].sort((a, b) => a - b);
  const n = ordered.length;
  const mid = Math.floor(n / 2);
  const med = n % 2 === 1 ? (ordered[mid] as number) : ((ordered[mid - 1] as number) + (ordered[mid] as number)) / 2;
  const q4 = (x: number): number => Math.round(x * 1e4) / 1e4;
  const total = misses.reduce((a, b) => a + b, 0);
  const within2 = misses.filter((m) => m <= 2).length;
  const within3 = misses.filter((m) => m <= 3).length;
  return {
    n,
    median_miss: q4(med),
    mean_miss: q4(total / n),
    within_2x_pct: q4((within2 / n) * 100),
    within_3x_pct: q4((within3 / n) * 100),
  };
}

/**
 * Leave-one-out + walk-forward validation of the radar model, computed from
 * the same snapshot at run time. Deterministic: no randomness, no dates
 * beyond the snapshot's own listed_at. The result is a read-out only — it
 * is never passed to buildBoard, impliedValue, or any multiple, so no board
 * value can move because the validation exists.
 */
export function validateModel(snapshot: Snapshot, model: ModelConstants = MODEL): ModelValidation {
  const fitSet = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0 && !isPreToken(p));
  const valued = fitSet.filter((p) => (p.mcap_usd as number) > 0);
  const zeros = fitSet.filter((p) => p.mcap_usd === 0);
  const looFull: number[] = [];
  const looComp: number[] = [];
  const looFlat: number[] = [];
  for (let i = 0; i < valued.length; i++) {
    const held = valued[i] as SnapshotProtocol;
    const train = [...valued.slice(0, i), ...valued.slice(i + 1), ...zeros];
    const fitted = valMultiples(train, snapshot, model);
    const real = held.mcap_usd as number;
    looFull.push(valMiss(valPredict(held, snapshot.as_of, model, fitted.global, fitted.byCategory, true), real));
    looComp.push(valMiss(valPredict(held, snapshot.as_of, model, fitted.global, fitted.byCategory, false), real));
    looFlat.push(valMiss(held.tvl_usd * fitted.global, real));
  }
  const dated = valued.filter((p) => p.listed_at !== null);
  const dates = dated.map((p) => p.listed_at as string).sort();
  const split = dates[Math.floor(dates.length / 2)] as string;
  const train = fitSet.filter((p) => p.listed_at !== null && (p.listed_at as string) <= split);
  const test = dated.filter((p) => (p.listed_at as string) > split);
  const excluded = fitSet.length - train.length - test.length;
  const wfFitted = valMultiples(train, snapshot, model);
  const wfFull: number[] = [];
  const wfComp: number[] = [];
  const wfFlat: number[] = [];
  for (const held of test) {
    const real = held.mcap_usd as number;
    wfFull.push(valMiss(valPredict(held, snapshot.as_of, model, wfFitted.global, wfFitted.byCategory, true), real));
    wfComp.push(valMiss(valPredict(held, snapshot.as_of, model, wfFitted.global, wfFitted.byCategory, false), real));
    wfFlat.push(valMiss(held.tvl_usd * wfFitted.global, real));
  }
  return {
    loo: valSummarize(looFull),
    loo_comp_only: valSummarize(looComp),
    loo_flat: valSummarize(looFlat),
    walk_forward: { ...valSummarize(wfFull), n_train: train.length, split_date: split, excluded_no_date: excluded },
    walk_forward_comp_only: valSummarize(wfComp),
    walk_forward_flat: valSummarize(wfFlat),
  };
}
