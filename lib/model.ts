// Token Radar's model (radar-3f), second draft: one sealed snapshot in, one
// ranked board out.
//
// The board ranks every pre-token protocol the snapshot can name: the 40
// watchlist slugs (the floor, never a ceiling) plus every other pre-token
// protocol below the floor that passes the same no-token / not-wrapped /
// not-staked / not-versioned screen the house used for the watchlist. A
// protocol is pre-token when its record carries no token at all: no market
// cap, no CoinGecko id, no symbol. Live-token protocols are never ranked;
// they are shown apart, at their market's own value.
//
// Implied value comes only from the snapshot's own figures. The size term is
// no longer a hand-set multiple per category: it is a curve fitted to the
// traded tokens in this very snapshot at run time, by ordinary least squares
// in log space,
//
//   log10(mcap_usd) = a + b * log10(tvl_usd),
//
// over every protocol that already trades (mcap_usd > 0 and tvl_usd > 0). On
// this snapshot that is 128 comparables; the 15 protocols that record a
// market cap of exactly zero are excluded, because log10(0) is undefined and
// a zero cap is a record with no price in it, not a price of zero. The fit's
// slope lands well below one, so value grows sub-linearly with size: ten
// times the TVL is worth only a few times the value, not ten times. Three
// smaller terms, unchanged from the earlier linear model, adjust the curve
// value:
//
//   growth   = 1 + clamp(change_7d, -60, 120) / 100 * 0.5. A protocol whose
//              TVL is growing fast is worth more than one shrinking at the
//              same size.
//   maturity = 0.6 + min(age_days, 1095) / 1095 * 0.4. Age is the time since
//              DefiLlama first listed the protocol: how long it has run with
//              no token. Older, still-unlaunched protocols carry more pent-up
//              launch value; unknown age counts as 365 days.
//   breadth  = 1 + 0.02 * min(chains - 1, 5). A protocol live on more chains
//              reaches more farmers.
//
//   implied  = max(1, round(10 ^ (a + b * log10(tvl_usd)) * growth * maturity * breadth))
//
// No protocol name is ever special-cased: the same function scores every row,
// and the curve is fitted from the snapshot at run time, so a future snapshot
// re-prices the board on its own. The dashboard recomputes each row from
// these same factors and checks the number board.json carries, so the page's
// code and the board's data are visibly the same arithmetic.

/** A protocol entry of the snapshot: exactly the ten fields the sealed input carries. */
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

/** The model's constants, as the dashboard states them. The size term has no
 * constants any more: the curve is fitted, not set by hand. */
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
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-3f';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The fitted size curve, and the count of the comparables it was fitted on. */
export interface CurveFit {
  /** Intercept of log10(mcap) = a + b * log10(tvl). */
  intercept: number;
  /** Slope of log10(mcap) = a + b * log10(tvl). */
  slope: number;
  /** R-squared of the fit, on the log scale. */
  r_squared: number;
  /** Traded protocols the fit ran on (mcap > 0 and TVL > 0). */
  n_comps: number;
  /** Protocols that record a market cap of exactly zero, excluded from the fit. */
  zero_mcap_excluded: number;
}

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
  model: {
    curve_value_usd: number;
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
  curve_value_usd: number;
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

/** Everything the dashboard needs: the board, the live set, the fitted curve and the model. */
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
  fit: CurveFit;
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

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Round to four decimals. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(`${asOf}T00:00:00Z`);
  const end = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((start - end) / DAY_MS));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word wrapped, staked or staking anywhere in the name. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** Exchange names a protocol name must not begin with (the house's watchlist rule). */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol may be ranked: pre-token, and not a wrapped, staked or
 * bridged product of a token that already trades — the same screen the house
 * applied to the watchlist, minus the TVL floor and the parent-protocol
 * record (which the snapshot does not carry). A versioned pool, a bridge, a
 * liquid-staking receipt or an exchange's own product is not a protocol still
 * waiting on a launch of its own.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (VERSIONED.test(p.name)) return false;
  if (!isPreToken(p)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/**
 * The traded comparables the size curve is fitted on: every protocol that
 * already trades with a positive market cap and a positive TVL. A protocol
 * that records a market cap of exactly zero is counted apart and left out —
 * log10(0) has no value, and a zero cap is a record with no price in it, not
 * a price of zero. A protocol with no market cap at all is pre-token and is
 * never a comparable in the first place.
 */
export function tradedComps(snapshot: Snapshot): { comps: SnapshotProtocol[]; zeroMcapExcluded: number } {
  const comps: SnapshotProtocol[] = [];
  let zeroMcapExcluded = 0;
  for (let i = 0; i < snapshot.protocols.length; i++) {
    const p = snapshot.protocols[i]!;
    if (p.mcap_usd === 0) {
      zeroMcapExcluded += 1;
      continue;
    }
    if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0) comps.push(p);
  }
  return { comps, zeroMcapExcluded };
}

/**
 * Fit the size curve by ordinary least squares in log space: log10(mcap) = a
 * + b * log10(tvl). The fit is computed from the snapshot at run time — no
 * coefficient is hard-coded, and the same snapshot always yields the same
 * fit. R-squared is computed on the log scale, against the mean log market
 * cap of the comparables. A fit needs at least two comparables with distinct
 * TVLs; fewer than that is a snapshot this model cannot price, and the run
 * fails loudly.
 */
export function fitCurve(snapshot: Snapshot): CurveFit {
  const { comps, zeroMcapExcluded } = tradedComps(snapshot);
  if (comps.length < 2) {
    throw new SnapshotError(`size curve needs at least 2 traded comparables, the snapshot has ${comps.length}`);
  }
  const logTvl: number[] = [];
  const logMcap: number[] = [];
  for (const p of comps) {
    logTvl.push(Math.log10(p.tvl_usd));
    logMcap.push(Math.log10(p.mcap_usd!));
  }
  const n = logTvl.length;
  let meanLogTvl = 0;
  let meanLogMcap = 0;
  for (const x of logTvl) meanLogTvl += x;
  for (const y of logMcap) meanLogMcap += y;
  meanLogTvl /= n;
  meanLogMcap /= n;
  let sumDxDy = 0;
  let sumDx2 = 0;
  let sumDy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = logTvl[i]! - meanLogTvl;
    const dy = logMcap[i]! - meanLogMcap;
    sumDxDy += dx * dy;
    sumDx2 += dx * dx;
    sumDy2 += dy * dy;
  }
  if (sumDx2 === 0) {
    throw new SnapshotError('size curve cannot be fitted: every traded comparable has the same TVL');
  }
  const slope = sumDxDy / sumDx2;
  const intercept = meanLogMcap - slope * meanLogTvl;
  let sumResid2 = 0;
  for (let i = 0; i < n; i++) {
    const resid = logMcap[i]! - (intercept + slope * logTvl[i]!);
    sumResid2 += resid * resid;
  }
  const rSquared = sumDy2 === 0 ? 1 : 1 - sumResid2 / sumDy2;
  return { intercept, slope, r_squared: rSquared, n_comps: n, zero_mcap_excluded: zeroMcapExcluded };
}

/** The curve's value at a TVL: what the fitted market line says that much TVL is worth. */
export function curveValue(tvlUsd: number, fit: CurveFit): number {
  return Math.pow(10, fit.intercept + fit.slope * Math.log10(tvlUsd));
}

/** The multipliers and the implied value one protocol gets under `model` and `fit`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  fit: CurveFit,
): { implied: number; curve: number; growthPct: number; growthMult: number; maturityMult: number; breadthMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const curve = curveValue(protocol.tvl_usd, fit);
  const extraChains = Math.min(Math.max(protocol.chains.length - 1, 0), model.breadth_max_chains);
  const breadthMult = 1 + extraChains * model.breadth_per_chain;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const growthRaw = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, growthRaw));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const implied = Math.max(1, Math.round(curve * growthMult * maturityMult * breadthMult));
  return { implied, curve, growthPct, growthMult, maturityMult, breadthMult, age };
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; fit: CurveFit } {
  const fit = fitCurve(snapshot);
  const lookup = bySlug(snapshot.protocols);
  const picked = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot,
  // but the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = lookup.get(slug);
    if (p !== undefined) picked.set(slug, p);
  }
  // The early radar: every other pre-token protocol that passes the same screen, whatever its
  // TVL. Never a replacement for a watchlist row: a chosen protocol stays chosen.
  for (let i = 0; i < snapshot.protocols.length; i++) {
    const p = snapshot.protocols[i]!;
    if (!picked.has(p.slug) && isRankable(p)) picked.set(p.slug, p);
  }

  const valued: Array<{ p: SnapshotProtocol; implied: number; curve: number; growthPct: number; growthMult: number; maturityMult: number; breadthMult: number; age: number | null }> = [];
  for (const p of picked.values()) {
    const v = impliedValue(p, snapshot.as_of, model, fit);
    valued.push({ p, ...v });
  }
  valued.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardRow[] = [];
  for (let i = 0; i < valued.length; i++) {
    const item = valued[i]!;
    board.push({
      rank: i + 1,
      slug: item.p.slug,
      name: item.p.name,
      category: item.p.category,
      chains: item.p.chains,
      tvl_usd: item.p.tvl_usd,
      change_7d: item.p.change_7d,
      mcap_usd: item.p.mcap_usd,
      listed_at: item.p.listed_at,
      gecko_id: item.p.gecko_id,
      symbol: item.p.symbol,
      token_status: 'pre-token' as const,
      age_days: item.age,
      implied_value_usd: item.implied,
      model: {
        curve_value_usd: Math.round(item.curve),
        growth_pct: item.growthPct,
        growth_multiplier: round4(item.growthMult),
        maturity_multiplier: round4(item.maturityMult),
        breadth_multiplier: round4(item.breadthMult),
        age_days: item.age,
      },
      farm_steps: farmSteps(item.p, item.age).map(stepText),
    });
  }
  return { board, fit };
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** A second chain when the protocol runs on more than one, else null. */
function secondChainOf(p: SnapshotProtocol): string | null {
  return p.chains.length > 1 ? p.chains[1]! : null;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) {
    return 250;
  }
  if (p.tvl_usd >= 1_000_000_000) {
    return 150;
  }
  if (p.tvl_usd >= 100_000_000) {
    return 100;
  }
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) {
    return 30;
  }
  if (age < 180) {
    return 60;
  }
  if (age < 365) {
    return 45;
  }
  return 30;
}

/** The category's main action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const cat = (p.category ?? '').toLowerCase();
  const title = p.name;
  let line: string;
  if (cat.includes('lend') || cat.includes('cdp') || cat.includes('collateral')) {
    line = `Supply $${capital} of USDC to ${title} on ${chain} and borrow $10 of stablecoin against it, then repay the borrow.`;
  } else if (cat.includes('dex') || cat.includes('leveraged farm')) {
    line = `Provide $${capital} of liquidity to ${title}'s main pool on ${chain} and make one swap through the pool each week.`;
  } else if (cat.includes('yield') || cat.includes('curator') || cat.includes('allocator')) {
    line = `Deposit $${capital} into a ${title} vault on ${chain} and keep the vault shares for the whole hold period.`;
  } else if (cat.includes('bridge') || cat.includes('cross chain')) {
    line = `Bridge $${capital} of USDC to ${chain} through ${title} and use the bridged funds in the protocol's own app.`;
  } else if (cat.includes('staking') || cat.includes('restak')) {
    line = `Stake $${capital} of the chain's staking asset through ${title} and keep the receipt token in the same wallet.`;
  } else if (cat.includes('perpetual') || cat.includes('derivative') || cat.includes('options')) {
    line = `Deposit $${capital} of USDC as margin on ${title} on ${chain} and open one small hedged position.`;
  } else if (cat.includes('prediction')) {
    line = `Fund $${capital} on ${title} and place one small market position, then settle it before the market closes.`;
  } else if (cat.includes('stable')) {
    line = `Mint or deposit $${capital} of the stable asset through ${title} on ${chain} and hold it in the farming wallet.`;
  } else if (cat.includes('rwa')) {
    line = `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it for the whole period.`;
  } else if (cat.includes('insurance')) {
    line = `Buy $${capital} of cover from ${title} on ${chain} and keep the policy active for the whole hold.`;
  } else if (cat.includes('privacy')) {
    line = `Deposit $${capital} through ${title} on ${chain} and make one private transfer each week.`;
  } else if (cat.includes('ai agent') || cat.includes('ai')) {
    line = `Deposit $${capital} into ${title} on ${chain} and run one agent action through its app each week.`;
  } else if (cat.includes('farm')) {
    line = `Deposit $${capital} into ${title}'s farm on ${chain} and harvest the rewards once a week.`;
  } else {
    line = `Deposit $${capital} of USDC into ${title} on ${chain} and keep the position open for the whole hold.`;
  }
  return line;
}

/** The category's second, qualifying action: a different kind of activity from the main one. */
function secondActionFor(p: SnapshotProtocol, chain: string): string {
  const cat = (p.category ?? '').toLowerCase();
  const title = p.name;
  let line: string;
  if (cat.includes('lend') || cat.includes('cdp') || cat.includes('collateral')) {
    line = `Each week, adjust the position once on ${title}: add $5 of collateral, repay a little of the borrow, or switch the supplied asset.`;
  } else if (cat.includes('dex') || cat.includes('leveraged farm')) {
    line = `Each week, swap $10 through ${title} on ${chain} in a different pair from the liquidity pool.`;
  } else if (cat.includes('yield') || cat.includes('curator') || cat.includes('allocator')) {
    line = `Each week, check the vault's points page on ${title} and deposit $5 more when the vault opens a new strategy.`;
  } else if (cat.includes('perpetual') || cat.includes('derivative') || cat.includes('options')) {
    line = `Each week, close and reopen the hedge on ${title} once, keeping the position size the same.`;
  } else if (cat.includes('rwa')) {
    line = `Each week, open ${title}'s rewards page and record the accrued yield so the position stays visible in the farm log.`;
  } else if (cat.includes('prediction')) {
    line = `Each week, place one more small market position on ${title} on a different outcome from the first.`;
  } else {
    line = `Each week, make one more qualifying action on ${title}, such as a deposit, a swap, a vote or a claim.`;
  }
  return line;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time.
 * The plan is derived from the protocol's own record (category, chains, TVL,
 * age), never from a hand-written list of names. Multi-chain protocols get a
 * step on a second chain; young protocols get a longer hold.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const firstChain = chainOf(p);
  const second = secondChainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gasUsd = capital >= 150 ? 8 : 4;
  const steps: FarmStep[] = [];
  steps.push({
    text: `Use a fresh wallet that holds only the funds you plan to farm with, and keep its seed phrase offline on paper.`,
    cost: 'under $3 of gas for the first transaction',
    time: '5 minutes',
  });
  steps.push({
    text: actionFor(p, capital, firstChain),
    cost: `$${capital} of capital and about $${gasUsd} of gas`,
    time: '15 minutes to set up',
  });
  steps.push({
    text: secondActionFor(p, firstChain),
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
  const top = traded.slice(0, LIVE_ROWS);
  const out: LiveRow[] = [];
  for (const p of top) {
    out.push({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    });
  }
  return out;
}

/**
 * A board row's compact form for data.js, with the farm plan carried from
 * board.json. The curve value here is full precision (board.json carries it
 * rounded to whole dollars), so the page's recomputation of the implied value
 * lands on the board's exact number.
 */
export function radarRow(row: BoardRow, curve: number): RadarRow {
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
    curve_value_usd: curve,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData; fit: CurveFit } {
  const { board, fit } = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const curveOf = (row: BoardRow): number => curveValue(row.tvl_usd, fit);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const compactRows: RadarRow[] = [];
  for (const r of board) compactRows.push(radarRow(r, curveOf(r)));
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
    fit,
    rows: compactRows,
    live,
  };
  return { board, radar, fit };
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
  const doc = raw as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof doc.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof doc.floor_usd !== 'number' || !Number.isSafeInteger(doc.floor_usd) || doc.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(doc.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols: SnapshotProtocol[] = [];
  for (let idx = 0; idx < doc.protocols.length; idx++) {
    const entry = doc.protocols[idx]!;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new SnapshotError(`snapshot.json's protocol ${idx} is not an object`);
    const rec = entry as Record<string, unknown>;
    if (typeof rec.slug !== 'string' || typeof rec.name !== 'string' || typeof rec.tvl_usd !== 'number' || !Number.isFinite(rec.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${idx} lacks a slug, a name or a TVL`);
    }
    protocols.push({
      slug: rec.slug,
      name: rec.name,
      category: typeof rec.category === 'string' ? rec.category : null,
      chains: Array.isArray(rec.chains) ? rec.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: rec.tvl_usd,
      change_7d: typeof rec.change_7d === 'number' && Number.isFinite(rec.change_7d) ? rec.change_7d : null,
      mcap_usd: typeof rec.mcap_usd === 'number' && Number.isFinite(rec.mcap_usd) ? rec.mcap_usd : null,
      listed_at: typeof rec.listed_at === 'string' ? rec.listed_at : null,
      gecko_id: typeof rec.gecko_id === 'string' ? rec.gecko_id : null,
      symbol: typeof rec.symbol === 'string' ? rec.symbol : null,
    });
  }
  return {
    as_of: doc.as_of,
    source: doc.source,
    floor_usd: doc.floor_usd,
    protocols,
    watchlist: doc.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const onBoard = new Set(board.map((r) => r.slug));
  const absent = snapshot.watchlist.filter((s) => !onBoard.has(s));
  if (absent.length > 0) return `the board misses ${absent.length} watchlist slug${absent.length === 1 ? '' : 's'}: ${absent.slice(0, 5).join(', ')}`;
  const rankList = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < rankList.length; i++) if (rankList[i] !== i + 1) return `rank ${i + 1} is ${rankList[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const row of board) {
    const steps = row.farm_steps;
    if (steps.length < 3 || steps.length > 12) {
      return `${row.slug} has ${steps.length} farm steps`;
    }
    for (let k = 0; k < steps.length; k++) {
      const s = steps[k]!;
      if (s.length < 20 || s.length > 600) {
        return `${row.slug} has a farm step of ${s.length} characters`;
      }
    }
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      return `${row.slug} has implied value ${row.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
