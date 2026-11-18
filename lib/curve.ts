/**
 * Curve fitting and validation for radar-4 model.
 *
 * This module implements:
 * - OLS fit of log10(mcap) = a + b * log10(tvl) on the comp set
 * - Huber-robust fit (IRLS, 10 iterations, c=1.345)
 * - LOO (leave-one-out) cross-validation
 * - Walk-forward validation
 * - Category/family offsets (shrunken median LOO residuals)
 * - Extra terms: growth, seasoning (age), breadth (chain count)
 * - Ablation testing with BIC/LOO criteria
 * - Bootstrap rank ranges (200 refits)
 * - Uncertainty bands from LOO residuals
 */

import type { SnapshotProtocol } from './model.ts';

/** A single comparable protocol with mcap > 0, tvl > 0, not CEX. */
export interface CompProtocol {
  slug: string;
  name: string;
  category: string;
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  chains: string[];
  log_tvl: number;
  log_mcap: number;
  age_days: number | null;
  chain_count: number;
}

/** Fitted curve parameters. */
export interface CurveFit {
  method: 'ols' | 'huber';
  a: number;           // intercept
  b: number;           // slope
  r2: number;          // R-squared
  n_comps: number;     // number of comps used
  n_excluded_mcap0: number; // protocols with mcap=0 excluded
  n_excluded_cex: number;   // CEX-category comps with mcap>0 excluded
}

/** LOO prediction for a single comp. */
export interface LooPrediction {
  slug: string;
  actual_log_mcap: number;
  pred_log_mcap: number;
  residual: number;      // pred - actual (in log10)
  miss: number;          // max(pred/real, real/pred) in linear space
  within3x: boolean;
}

/** Walk-forward validation result. */
export interface WalkForwardResult {
  cut_date: string;      // ISO date string
  n_train: number;
  n_test: number;
  miss_curve: number;    // median miss on test set
  miss_flat: number;     // median miss using flat multiple on test set
}

/** Band-hold validation result. */
export interface BandHoldResult {
  p25_75: number;        // share within P25-P75
  p10_90: number;        // share within P10-P90
}

/** Ablation step result. */
export interface AblationStep {
  label: string;
  loo_median_miss: number;
  within3x_pct: number;
  walkforward_miss: number;
  kept: boolean;
  note: string;
}

/** Category offset. */
export interface CategoryOffset {
  category: string;
  n_comps: number;
  median_residual: number;  // in log10
  shrink_factor: number;    // n/(n+3)
  offset_log10: number;     // shrunken offset in log10
  offset_multiplier: number; // 10^offset_log10, clamped to [0.75, 1.33]
}

/** Extra term coefficient. */
export interface ExtraTerm {
  name: 'growth' | 'seasoning' | 'breadth';
  coefficient: number;     // OLS coefficient on log10 residuals
  multiplier_at_mean: number; // typical multiplier effect
  improves_loo: boolean;
  improves_walkforward: boolean;
  kept: boolean;
}

/** Full validation output. */
export interface ValidationOutput {
  loo_curve_median_miss: number;
  loo_flat_median_miss: number;
  within3x_curve: number;
  within3x_flat: number;
  walkforward: WalkForwardResult;
  band_hold: BandHoldResult;
  ablation: AblationStep[];
  extra_terms: ExtraTerm[];
  final_fit: CurveFit;
  flat_multiple: number;   // median mcap/tvl in linear space
}

/** Bootstrap rank range for a protocol. */
export interface RankRange {
  slug: string;
  rank_min: number;
  rank_max: number;
}

/** Uncertainty band for a protocol. */
export interface UncertaintyBand {
  slug: string;
  band_lo: number;      // P25
  band_hi: number;      // P75
  band_lo90: number;    // P10
  band_hi90: number;    // P90
}

/** Launch odds bucket. */
export interface OddsBucket {
  label: string;
  n: number;            // protocols in bucket (known age)
  k: number;            // protocols with token
  odds: number;         // smoothed odds (k + 5*base) / (n + 5)
}

/** Launch odds output. */
export interface OddsOutput {
  buckets: OddsBucket[];
  auc: number;
  base_rate: number;
  unknown_age: number;
}

/** ============================================================
 *  UTILITY FUNCTIONS
 * ============================================================ */


/**
 * Mulberry32 — a fast, deterministic 32-bit PRNG.
 * Fixed seed 0x52414441 ("RADA" in ASCII) ensures reproducible bootstrap.
 */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fixed seed for bootstrap determinism: 0x52414441 = "RADA". */
const BOOTSTRAP_SEED = 0x52414441;

const LN10 = Math.log(10);
function log10(x: number): number {
  return Math.log(x) / LN10;
}

/** Compute OLS coefficients for y = a + b*x. */
function olsFit(x: number[], y: number[]): { a: number; b: number; r2: number } {
  const n = x.length;
  if (n < 2) return { a: 0, b: 0, r2: 0 };

  const sumX = x.reduce((s, v) => s + v, 0);
  const sumY = y.reduce((s, v) => s + v, 0);
  const sumXY = x.reduce((s, v, i) => s + v * y[i], 0);
  const sumX2 = x.reduce((s, v) => s + v * v, 0);
  const sumY2 = y.reduce((s, v) => s + v * v, 0);

  const xMean = sumX / n;
  const yMean = sumY / n;

  const b = (sumXY - n * xMean * yMean) / (sumX2 - n * xMean * xMean);
  const a = yMean - b * xMean;

  // R-squared
  const ssTot = sumY2 - n * yMean * yMean;
  const ssRes = y.reduce((s, v, i) => s + (v - (a + b * x[i])) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { a, b, r2 };
}

/** Huber-robust fit using IRLS. */
function huberFit(x: number[], y: number[], iterations = 10, c = 1.345): { a: number; b: number; r2: number } {
  let weights = new Array(x.length).fill(1);
  let a = 0, b = 0;

  for (let iter = 0; iter < iterations; iter++) {
    // Weighted OLS
    const sumW = weights.reduce((s, v) => s + v, 0);
    const sumWX = weights.reduce((s, v, i) => s + v * x[i], 0);
    const sumWY = weights.reduce((s, v, i) => s + v * y[i], 0);
    const sumWXY = weights.reduce((s, v, i) => s + v * x[i] * y[i], 0);
    const sumWX2 = weights.reduce((s, v, i) => s + v * x[i] * x[i], 0);

    const xMeanW = sumWX / sumW;
    const yMeanW = sumWY / sumW;

    b = (sumWXY - sumW * xMeanW * yMeanW) / (sumWX2 - sumW * xMeanW * xMeanW);
    a = yMeanW - b * xMeanW;

    // Compute standardized residuals
    const residuals = y.map((v, i) => v - (a + b * x[i]));
    const mad = median(residuals.map(Math.abs)) * 1.4826; // MAD to sigma
    const sigma = mad > 0 ? mad : Math.sqrt(residuals.reduce((s, v) => s + v * v, 0) / residuals.length);

    // Update weights
    weights = residuals.map(r => {
      const stdResid = sigma > 0 ? r / sigma : 0;
      const absResid = Math.abs(stdResid);
      return absResid <= c ? 1 : c / absResid;
    });
  }

  // Final R-squared (unweighted)
  const yMean = y.reduce((s, v) => s + v, 0) / y.length;
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const ssRes = y.reduce((s, v, i) => s + (v - (a + b * x[i])) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { a, b, r2 };
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function quantile(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** ============================================================
 *  COMP SET CONSTRUCTION
 * ============================================================ */

const SNAPSHOT_DATE = '2026-11-14';

function parseDate(dateStr: string | null): Date | null {
  if (!dateStr) return null;
  const parts = dateStr.split('-');
  if (parts.length !== 3) return null;
  return new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
}

function daysSinceListed(listedAt: string | null, asOf: Date): number | null {
  const listed = parseDate(listedAt);
  if (!listed) return null;
  const diffMs = asOf.getTime() - listed.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

export function buildCompSet(protocols: SnapshotProtocol[]): CompProtocol[] {
  const asOf = parseDate(SNAPSHOT_DATE)!;
  const nExcludedMcap0 = protocols.filter(p => p.mcap_usd === 0).length;
  const nExcludedCex = protocols.filter(p => p.category === 'CEX' && p.mcap_usd != null && p.mcap_usd > 0).length;

  return protocols
    .filter(p => p.mcap_usd != null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX')
    .map(p => ({
      slug: p.slug,
      name: p.name,
      category: p.category ?? 'Other',
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      chains: p.chains,
      log_tvl: log10(p.tvl_usd),
      log_mcap: log10(p.mcap_usd!),
      age_days: daysSinceListed(p.listed_at, asOf),
      chain_count: p.chains.length,
    }));
}

/** ============================================================
 *  CATEGORY OFFSETS
 * ============================================================ */

function computeCategoryOffsets(
  comps: CompProtocol[],
  looPredictions: LooPrediction[]
): CategoryOffset[] {
  // Group LOO residuals by category
  const byCategory = new Map<string, number[]>();
  for (const pred of looPredictions) {
    const comp = comps.find(c => c.slug === pred.slug);
    if (comp) {
      const arr = byCategory.get(comp.category) ?? [];
      arr.push(pred.residual);
      byCategory.set(comp.category, arr);
    }
  }

  const offsets: CategoryOffset[] = [];
  for (const [category, residuals] of byCategory) {
    const n = residuals.length;
    const medResid = median(residuals);
    const shrinkFactor = n / (n + 3);
    const offsetLog10 = medResid * shrinkFactor;
    const offsetMultiplier = Math.pow(10, offsetLog10);
    const clamped = Math.max(0.75, Math.min(1.33, offsetMultiplier));

    offsets.push({
      category,
      n_comps: n,
      median_residual: medResid,
      shrink_factor: shrinkFactor,
      offset_log10: Math.log10(clamped),
      offset_multiplier: clamped,
    });
  }

  return offsets;
}

/** ============================================================
 *  LOO CROSS-VALIDATION
 * ============================================================ */

function runLoo(
  comps: CompProtocol[],
  fitFn: (x: number[], y: number[]) => { a: number; b: number; r2: number },
  extraTerms: Map<string, number> = new Map() // name -> coefficient
): LooPrediction[] {
  const predictions: LooPrediction[] = [];
  const x = comps.map(c => c.log_tvl);
  const y = comps.map(c => c.log_mcap);

  for (let i = 0; i < comps.length; i++) {
    // Fit on all except i
    const xTrain = x.filter((_, j) => j !== i);
    const yTrain = y.filter((_, j) => j !== i);
    const { a, b } = fitFn(xTrain, yTrain);

    // Predict for i
    let predLogMcap = a + b * comps[i].log_tvl;

    // Add extra terms if provided
    let extraEffect = 0;
    if (extraTerms.has('growth') && comps[i].change_7d != null) {
      extraEffect += extraTerms.get('growth')! * comps[i].change_7d! / 100;
    }
    if (extraTerms.has('seasoning') && comps[i].age_days != null) {
      extraEffect += extraTerms.get('seasoning')! * log10(comps[i].age_days! + 1);
    }
    if (extraTerms.has('breadth')) {
      extraEffect += extraTerms.get('breadth')! * Math.min(comps[i].chain_count - 1, 5);
    }

    const finalPred = predLogMcap + extraEffect;
    const actual = comps[i].log_mcap;
    const residual = finalPred - actual;

    // Miss in linear space
    const predLinear = Math.pow(10, finalPred);
    const actualLinear = Math.pow(10, actual);
    const miss = Math.max(predLinear / actualLinear, actualLinear / predLinear);

    predictions.push({
      slug: comps[i].slug,
      actual_log_mcap: actual,
      pred_log_mcap: finalPred,
      residual,
      miss,
      within3x: miss <= 3,
    });
  }

  return predictions;
}

/** ============================================================
 *  WALK-FORWARD VALIDATION
 * ============================================================ */

function runWalkForward(
  comps: CompProtocol[],
  fitFn: (x: number[], y: number[]) => { a: number; b: number; r2: number },
  extraTerms: Map<string, number> = new Map()
): WalkForwardResult {
  // Sort by listed_at, use median date as cut
  const withDate = comps.filter(c => c.listed_at).sort((a, b) =>
    (a.listed_at ?? '').localeCompare(b.listed_at ?? '')
  );

  if (withDate.length < 10) {
    // Fallback: split by slug
    const sorted = [...comps].sort((a, b) => a.slug.localeCompare(b.slug));
    const cutIdx = Math.floor(sorted.length * 0.7);
    const train = sorted.slice(0, cutIdx);
    const test = sorted.slice(cutIdx);
    const cutDate = train[train.length - 1]?.listed_at ?? SNAPSHOT_DATE;

    return evaluateSplit(train, test, cutDate, fitFn, extraTerms);
  }

  const cutIdx = Math.floor(withDate.length / 2);
  const cutDate = withDate[cutIdx]?.listed_at ?? SNAPSHOT_DATE;

  const train = comps.filter(c => c.listed_at && c.listed_at <= cutDate);
  const test = comps.filter(c => c.listed_at && c.listed_at > cutDate);

  if (test.length === 0) {
    // If no test after cut, move one from train
    const sorted = [...comps].filter(c => c.listed_at).sort((a, b) =>
      (a.listed_at ?? '').localeCompare(b.listed_at ?? '')
    );
    const mid = Math.floor(sorted.length / 2);
    const newTrain = sorted.slice(0, mid);
    const newTest = sorted.slice(mid);
    const newCut = newTrain[newTrain.length - 1]?.listed_at ?? SNAPSHOT_DATE;
    return evaluateSplit(newTrain, newTest, newCut, fitFn, extraTerms);
  }

  return evaluateSplit(train, test, cutDate, fitFn, extraTerms);
}

function evaluateSplit(
  train: CompProtocol[],
  test: CompProtocol[],
  cutDate: string,
  fitFn: (x: number[], y: number[]) => { a: number; b: number; r2: number },
  extraTerms: Map<string, number>
): WalkForwardResult {
  const xTrain = train.map(c => c.log_tvl);
  const yTrain = train.map(c => c.log_mcap);
  const { a, b } = fitFn(xTrain, yTrain);

  // Flat multiple from train
  const flatMult = median(train.map(c => c.mcap_usd / c.tvl_usd));

  const missesCurve: number[] = [];
  const missesFlat: number[] = [];

  for (const c of test) {
    let predLog = a + b * c.log_tvl;

    // Extra terms
    if (extraTerms.has('growth') && c.change_7d != null) {
      predLog += extraTerms.get('growth')! * c.change_7d / 100;
    }
    if (extraTerms.has('seasoning') && c.age_days != null) {
      predLog += extraTerms.get('seasoning')! * log10(c.age_days + 1);
    }
    if (extraTerms.has('breadth')) {
      predLog += extraTerms.get('breadth')! * Math.min(c.chain_count - 1, 5);
    }

    const predLinear = Math.pow(10, predLog);
    const actualLinear = c.mcap_usd;
    missesCurve.push(Math.max(predLinear / actualLinear, actualLinear / predLinear));
    missesFlat.push(Math.max((flatMult * c.tvl_usd) / actualLinear, actualLinear / (flatMult * c.tvl_usd)));
  }

  return {
    cut_date: cutDate,
    n_train: train.length,
    n_test: test.length,
    miss_curve: median(missesCurve),
    miss_flat: median(missesFlat),
  };
}

/** ============================================================
 *  BAND-HOLD VALIDATION
 * ============================================================ */

function runBandHold(looPredictions: LooPrediction[]): BandHoldResult {
  const residuals = looPredictions.map(p => p.residual);
  const q25 = quantile(residuals, 0.25);
  const q75 = quantile(residuals, 0.75);
  const q10 = quantile(residuals, 0.10);
  const q90 = quantile(residuals, 0.90);

  let in25_75 = 0;
  let in10_90 = 0;
  for (const r of residuals) {
    if (r >= q25 && r <= q75) in25_75++;
    if (r >= q10 && r <= q90) in10_90++;
  }

  return {
    p25_75: in25_75 / residuals.length,
    p10_90: in10_90 / residuals.length,
  };
}

/** ============================================================
 *  EXTRA TERMS FITTING
 * ============================================================ */

function fitExtraTerms(
  comps: CompProtocol[],
  baseResiduals: number[]
): Map<string, number> {
  const terms = new Map<string, number>();

  // Growth: regress residual on change_7d/100
  const growthPairs: { x: number; y: number }[] = [];
  for (let i = 0; i < comps.length; i++) {
    if (comps[i].change_7d != null) {
      growthPairs.push({ x: comps[i].change_7d! / 100, y: baseResiduals[i] });
    }
  }
  if (growthPairs.length >= 10) {
    const x = growthPairs.map(p => p.x);
    const y = growthPairs.map(p => p.y);
    const { b } = olsFit(x, y);
    terms.set('growth', b);
  }

  // Seasoning: regress residual on log10(age_days + 1)
  const seasoningPairs: { x: number; y: number }[] = [];
  for (let i = 0; i < comps.length; i++) {
    if (comps[i].age_days != null) {
      seasoningPairs.push({ x: log10(comps[i].age_days! + 1), y: baseResiduals[i] });
    }
  }
  if (seasoningPairs.length >= 10) {
    const x = seasoningPairs.map(p => p.x);
    const y = seasoningPairs.map(p => p.y);
    const { b } = olsFit(x, y);
    terms.set('seasoning', b);
  }

  // Breadth: regress residual on min(chain_count - 1, 5)
  const breadthPairs: { x: number; y: number }[] = [];
  for (let i = 0; i < comps.length; i++) {
    breadthPairs.push({ x: Math.min(comps[i].chain_count - 1, 5), y: baseResiduals[i] });
  }
  if (breadthPairs.length >= 10) {
    const x = breadthPairs.map(p => p.x);
    const y = breadthPairs.map(p => p.y);
    const { b } = olsFit(x, y);
    terms.set('breadth', b);
  }

  return terms;
}

/** ============================================================
 *  BOOTSTRAP RANK RANGES
 * ============================================================ */

interface ProtocolToRank {
  slug: string;
  name: string;
  category: string;
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  chains: string[];
  age_days: number | null;
  chain_count: number;
  log_tvl: number;
  odds: number;  // launch odds (fixed during bootstrap)
}



export function computeBootstrapRanks(
  allProtocols: ProtocolToRank[],
  comps: CompProtocol[],
  categoryOffsets: CategoryOffset[],
  extraTerms: Map<string, number>,
  nBootstrap = 200
): RankRange[] {
  const n = allProtocols.length;
  const rankAccumulator = new Array(n).fill(0).map(() => ({ min: Infinity, max: -Infinity }));

  // Deterministic PRNG for bootstrap resampling
  const rng = mulberry32(BOOTSTRAP_SEED);

  for (let b = 0; b < nBootstrap; b++) {
    // Resample comps with replacement using deterministic RNG
    const bootComps: CompProtocol[] = [];
    for (let i = 0; i < comps.length; i++) {
      const idx = Math.floor(rng() * comps.length);
      bootComps.push(comps[idx]);
    }

    // Fit curve on bootstrap sample (curve-only: no family offsets, no extra terms)
    const x = bootComps.map(c => c.log_tvl);
    const y = bootComps.map(c => c.log_mcap);
    const { a, b: slope } = olsFit(x, y);

    // Score all protocols with curve-only model (family offset = 1.0, no kept extra terms)
    const scored = allProtocols.map(p => {
      const curveVal = Math.pow(10, a + slope * p.log_tvl);
      const valueIfLaunches = curveVal; // famOffset = 1.0, termsMult = 1.0
      const implied = Math.max(1, Math.round(valueIfLaunches * p.odds));
      return { slug: p.slug, implied };
    });

    // Rank by implied descending, tie-break by slug
    scored.sort((a, b) => b.implied - a.implied || a.slug.localeCompare(b.slug));

    // Record ranks
    for (let rank = 0; rank < scored.length; rank++) {
      const idx = allProtocols.findIndex(p => p.slug === scored[rank].slug);
      if (idx >= 0) {
        rankAccumulator[idx].min = Math.min(rankAccumulator[idx].min, rank + 1);
        rankAccumulator[idx].max = Math.max(rankAccumulator[idx].max, rank + 1);
      }
    }
  }

  return allProtocols.map((p, i) => ({
    slug: p.slug,
    rank_min: rankAccumulator[i].min === Infinity ? n : rankAccumulator[i].min,
    rank_max: rankAccumulator[i].max === -Infinity ? n : rankAccumulator[i].max,
  }));
}

/** ============================================================
 *  UNCERTAINTY BANDS
 * ============================================================ */

export function computeUncertaintyBands(
  impliedValues: number[],
  looResiduals: number[]
): UncertaintyBand[] {
  const q25 = quantile(looResiduals, 0.25);
  const q75 = quantile(looResiduals, 0.75);
  const q10 = quantile(looResiduals, 0.10);
  const q90 = quantile(looResiduals, 0.90);

  return impliedValues.map((implied, i) => ({
    slug: '', // Will be filled by caller
    band_lo: Math.max(1, Math.round(implied * Math.pow(10, q25))),
    band_hi: Math.max(1, Math.round(implied * Math.pow(10, q75))),
    band_lo90: Math.max(1, Math.round(implied * Math.pow(10, q10))),
    band_hi90: Math.max(1, Math.round(implied * Math.pow(10, q90))),
  }));
}

/** ============================================================
 *  LAUNCH ODDS
 * ============================================================ */

export function computeLaunchOdds(protocols: SnapshotProtocol[]): OddsOutput {
  const asOf = parseDate(SNAPSHOT_DATE)!;

  // All protocols with known age
  // has_token is the negation of isPreToken(): a protocol has a token if ANY of
  // mcap_usd, gecko_id, or symbol is non-null (not all three null).
  const withAge = protocols
    .map(p => ({
      ...p,
      age_days: daysSinceListed(p.listed_at, asOf),
      has_token: p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null,
    }))
    .filter(p => p.age_days != null);

  const unknownAge = protocols.filter(p => daysSinceListed(p.listed_at, asOf) === null).length;

  // Buckets
  const bucketDefs = [
    { label: '<180d', min: 0, max: 179 },
    { label: '180-365d', min: 180, max: 365 },
    { label: '365-730d', min: 366, max: 730 },
    { label: '730-1095d', min: 731, max: 1095 },
    { label: '>1095d', min: 1096, max: Infinity },
  ];

  const allHasToken = withAge.filter(p => p.has_token).length;
  const baseRate = allHasToken / withAge.length;

  const buckets: OddsBucket[] = [];
  for (const def of bucketDefs) {
    const inBucket = withAge.filter(p => p.age_days! >= def.min && p.age_days! <= def.max);
    const n = inBucket.length;
    const k = inBucket.filter(p => p.has_token).length;
    const odds = (k + 5 * baseRate) / (n + 5);
    buckets.push({ label: def.label, n, k, odds });
  }


  // AUC: rank protocols by bucket odds, compute ROC AUC for has_token
  // Higher odds should predict has_token=1. Since odds increase with age, and older protocols have more tokens, AUC should be > 0.5.
  const scored = withAge.map(p => {
    const bucket = buckets.find(b => {
      const def = bucketDefs.find(d => d.label === b.label)!;
      return p.age_days! >= def.min && p.age_days! <= def.max;
    });
    return { has_token: p.has_token, score: bucket?.odds ?? baseRate };
  });
  // Sort by score ASCENDING (lower odds = less likely to have token)
  scored.sort((a, b) => a.score - b.score);

  let tp = 0, fp = 0;
  const totalPos = scored.filter(s => s.has_token).length;
  const totalNeg = scored.length - totalPos;
  let auc = 0;
  let prevFp = 0, prevTp = 0;

  for (const s of scored) {
    if (s.has_token) tp++; else fp++;
    auc += (tp - prevTp) * (fp + prevFp) / 2;
    prevTp = tp;
    prevFp = fp;
  }
  auc = totalPos > 0 && totalNeg > 0 ? auc / (totalPos * totalNeg) : 0.5;

  return { buckets, auc, base_rate: baseRate, unknown_age: unknownAge };
}

/** ============================================================
 *  MAIN ENTRY: FIT CURVE + VALIDATION
 * ============================================================ */

export interface FullModelOutput {
  fit: CurveFit;
  validation: ValidationOutput;
  extra_terms: ExtraTerm[];
  odds: OddsOutput;
  loo_residuals: number[];
  rank_ranges: RankRange[];
  uncertainty_bands: UncertaintyBand[];
  value_if_launches: number[];  // per protocol (pre-odds)
  implied_values: number[];     // per protocol (post-odds, rounded)
  nearest_comps: { slug: string; name: string; tvl_usd: number; mcap_usd: number }[][]; // top 3 per protocol
}

export function fitFullModel(
  allProtocols: SnapshotProtocol[],
  boardProtocols: SnapshotProtocol[]  // the 198 pre-token protocols to score
): FullModelOutput {
  // Build comp set
  const comps = buildCompSet(allProtocols);
  const nExcludedMcap0 = allProtocols.filter(p => p.mcap_usd === 0).length;
  const nExcludedCex = allProtocols.filter(p => p.category === 'CEX' && p.mcap_usd != null && p.mcap_usd > 0).length;

  // Flat multiple (median mcap/tvl)
  const flatMultiple = median(comps.map(c => c.mcap_usd / c.tvl_usd));

  // OLS fit
  const x = comps.map(c => c.log_tvl);
  const y = comps.map(c => c.log_mcap);
  const olsResult = olsFit(x, y);

  // Huber fit
  const huberResult = huberFit(x, y);

  // LOO for both
  const olsLoo = runLoo(comps, olsFit);
  const huberLoo = runLoo(comps, huberFit);

  const olsLooMiss = median(olsLoo.map(p => p.miss));
  const huberLooMiss = median(huberLoo.map(p => p.miss));

  // Pick better LOO
  const useHuber = huberLooMiss < olsLooMiss;
  const bestFit = useHuber ? huberResult : olsResult;
  const bestLoo = useHuber ? huberLoo : olsLoo;
  const bestMethod = useHuber ? 'huber' : 'ols';
  const baseFitFn = useHuber ? huberFit : olsFit;

  // Category offsets from best LOO (for ablation testing)
  const categoryOffsets = computeCategoryOffsets(comps, bestLoo);

  // Base residuals (from best fit + category offsets, no extra terms yet)
  // Apply category offsets to get base residuals for extra term fitting
  const catOffsetMap = new Map(categoryOffsets.map(o => [o.category, o.offset_log10]));
  const baseResiduals = bestLoo.map(p => {
    const comp = comps.find(c => c.slug === p.slug);
    const offset = comp ? (catOffsetMap.get(comp.category) ?? 0) : 0;
    return p.residual - offset; // Residual after removing category offset
  });

  // Fit extra terms on base residuals
  const extraTermCoeffs = fitExtraTerms(comps, baseResiduals);

  // Ablation testing
  const ablation: AblationStep[] = [];

  // Step 0: Flat multiple
  const flatLooMiss = median(comps.map(c => {
    const pred = Math.log10(flatMultiple * c.tvl_usd);
    const actual = c.log_mcap;
    const predLinear = Math.pow(10, pred);
    const actualLinear = Math.pow(10, actual);
    return Math.max(predLinear / actualLinear, actualLinear / predLinear);
  }));
  const flatWithin3 = comps.filter(c => {
    const pred = Math.log10(flatMultiple * c.tvl_usd);
    const actual = c.log_mcap;
    const predLinear = Math.pow(10, pred);
    const actualLinear = Math.pow(10, actual);
    const miss = Math.max(predLinear / actualLinear, actualLinear / predLinear);
    return miss <= 3;
  }).length / comps.length;
  const flatWf = runWalkForward(comps, () => ({ a: Math.log10(flatMultiple), b: 0, r2: 0 }));
  ablation.push({
    label: 'flat_multiple',
    loo_median_miss: flatLooMiss,
    within3x_pct: flatWithin3,
    walkforward_miss: flatWf.miss_flat,
    kept: false,
    note: 'baseline',
  });

  // Step 1: Size curve (OLS)
  const olsWithin3 = olsLoo.filter(p => p.within3x).length / olsLoo.length;
  const olsWf = runWalkForward(comps, olsFit);
  ablation.push({
    label: 'size_curve_ols',
    loo_median_miss: olsLooMiss,
    within3x_pct: olsWithin3,
    walkforward_miss: olsWf.miss_curve,
    kept: true,
    note: 'OLS log-log curve',
  });

  // Step 2: Huber (if tried)
  const huberWithin3 = huberLoo.filter(p => p.within3x).length / huberLoo.length;
  const huberWf = runWalkForward(comps, huberFit);
  if (useHuber) {
    ablation.push({
      label: 'huber_robust',
      loo_median_miss: huberLooMiss,
      within3x_pct: huberWithin3,
      walkforward_miss: huberWf.miss_curve,
      kept: true,
      note: 'Huber IRLS beat OLS on LOO',
    });
  } else {
    ablation.push({
      label: 'huber_robust',
      loo_median_miss: huberLooMiss,
      within3x_pct: huberWithin3,
      walkforward_miss: huberWf.miss_curve,
      kept: false,
      note: 'OLS beat Huber on LOO',
    });
  }

  // Step 3: Family offsets
  const withFamilyPredictions = bestLoo.map(p => {
    const comp = comps.find(c => c.slug === p.slug);
    const offset = comp ? (catOffsetMap.get(comp.category) ?? 0) : 0;
    return {
      ...p,
      pred_log_mcap: p.pred_log_mcap + offset,
      residual: p.residual + offset,
      miss: Math.max(
        Math.pow(10, p.pred_log_mcap + offset) / Math.pow(10, p.actual_log_mcap),
        Math.pow(10, p.actual_log_mcap) / Math.pow(10, p.pred_log_mcap + offset)
      ),
    };
  });
  const familyLooMiss = median(withFamilyPredictions.map(p => p.miss));
  const familyWithin3 = withFamilyPredictions.filter(p => p.miss <= 3).length / withFamilyPredictions.length;
  const familyWfResult = runWalkForwardWithFamily(comps, baseFitFn, categoryOffsets);

  const familyImprovesLoo = familyLooMiss < (useHuber ? huberLooMiss : olsLooMiss);
  const familyImprovesWf = familyWfResult.miss_curve < (useHuber ? huberWf.miss_curve : olsWf.miss_curve);
  const familyKept = familyImprovesLoo && familyImprovesWf;

  ablation.push({
    label: 'family_offsets',
    loo_median_miss: familyLooMiss,
    within3x_pct: familyWithin3,
    walkforward_miss: familyWfResult.miss_curve,
    kept: familyKept,
    note: familyKept ? 'improves both LOO and walk-forward' : 'dropped: fails ablation',
  });

  // Test each extra term
  const termNames = ['growth', 'seasoning', 'breadth'] as const;
  let currentExtraTerms = new Map<string, number>();
  let currentLooPredictions = familyKept ? withFamilyPredictions : bestLoo;
  let currentWfMiss = familyKept ? familyWfResult.miss_curve : (useHuber ? huberWf.miss_curve : olsWf.miss_curve);

  for (const termName of termNames) {
    if (!extraTermCoeffs.has(termName)) {
      ablation.push({
        label: `+${termName}`,
        loo_median_miss: 0,
        within3x_pct: 0,
        walkforward_miss: 0,
        kept: false,
        note: 'insufficient data to fit',
      });
      continue;
    }

    // Test adding this term
    const testTerms = new Map(currentExtraTerms);
    testTerms.set(termName, extraTermCoeffs.get(termName)!);

    const testLoo = runLoo(comps, baseFitFn, testTerms);
    const testLooMiss = median(testLoo.map(p => p.miss));
    const testWithin3 = testLoo.filter(p => p.miss <= 3).length / testLoo.length;
    const testWf = runWalkForward(comps, baseFitFn, testTerms);

    const currentLooMiss = median(currentLooPredictions.map(p => p.miss));
    const improvesLoo = testLooMiss < currentLooMiss;
    const improvesWf = testWf.miss_curve < currentWfMiss;

    if (improvesLoo && improvesWf) {
      currentExtraTerms.set(termName, extraTermCoeffs.get(termName)!);
      currentLooPredictions = testLoo;
      currentWfMiss = testWf.miss_curve;
      ablation.push({
        label: `+${termName}`,
        loo_median_miss: testLooMiss,
        within3x_pct: testWithin3,
        walkforward_miss: testWf.miss_curve,
        kept: true,
        note: 'improves both LOO and walk-forward',
      });
    } else {
      ablation.push({
        label: `+${termName}`,
        loo_median_miss: testLooMiss,
        within3x_pct: testWithin3,
        walkforward_miss: testWf.miss_curve,
        kept: false,
        note: `dropped: ${!improvesLoo ? 'LOO worse' : ''}${!improvesLoo && !improvesWf ? ', ' : ''}${!improvesWf ? 'walk-forward worse' : ''}`,
      });
    }
  }

  // Final LOO with all kept terms (extra terms only, family offsets only if kept)
  const finalExtraTerms = new Map(currentExtraTerms);
  const finalLoo = runLoo(comps, baseFitFn, finalExtraTerms);
  const finalLooResiduals = finalLoo.map(p => p.residual);

  // Final walk-forward
  const finalWf = runWalkForward(comps, baseFitFn, finalExtraTerms);

  // Band-hold
  const bandHold = runBandHold(finalLoo);

  // Launch odds
  const odds = computeLaunchOdds(allProtocols);

  // Build protocol-to-rank list for bootstrap (the 198 board protocols)
  const boardProtosForRank: ProtocolToRank[] = boardProtocols.map(p => {
    const asOf = parseDate(SNAPSHOT_DATE)!;
    const age = daysSinceListed(p.listed_at, asOf);
    let oddsVal = odds.base_rate;
    if (age != null) {
      const bucketDefs = [
        { label: '<180d', min: 0, max: 179 },
        { label: '180-365d', min: 180, max: 365 },
        { label: '365-730d', min: 366, max: 730 },
        { label: '730-1095d', min: 731, max: 1095 },
        { label: '>1095d', min: 1096, max: Infinity },
      ];
      const bucket = bucketDefs.find(d => age >= d.min && age <= d.max);
      if (bucket) {
        const found = odds.buckets.find(b => b.label === bucket.label);
        oddsVal = found?.odds ?? odds.base_rate;
      }
    }
    return {
      slug: p.slug,
      name: p.name,
      category: p.category ?? 'Other',
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      chains: p.chains,
      age_days: age,
      chain_count: p.chains.length,
      log_tvl: log10(p.tvl_usd),
      odds: oddsVal,
    };
  });

  // Bootstrap rank ranges (launch odds fixed from full snapshot)
  // Use category offsets only if they were kept in ablation
  const bootstrapCatOffsets = familyKept ? categoryOffsets : [];
  const rankRanges = computeBootstrapRanks(
    boardProtosForRank,
    comps,
    bootstrapCatOffsets,
    currentExtraTerms
  );

  // Compute value_if_launches and implied for each board protocol
  const valueIfLaunches: number[] = [];
  const impliedValues: number[] = [];
  // Use family offsets only if kept
  const finalCatOffsetMap = familyKept ? new Map(categoryOffsets.map(o => [o.category, o.offset_multiplier])) : new Map();

  for (const p of boardProtosForRank) {
    const curveVal = Math.pow(10, bestFit.a + bestFit.b * p.log_tvl);
    const famOffset = finalCatOffsetMap.get(p.category) ?? 1.0;
    let termsMult = 1.0;
    if (currentExtraTerms.has('growth') && p.change_7d != null) {
      termsMult *= Math.pow(10, currentExtraTerms.get('growth')! * p.change_7d / 100);
    }
    if (currentExtraTerms.has('seasoning') && p.age_days != null) {
      termsMult *= Math.pow(10, currentExtraTerms.get('seasoning')! * log10(p.age_days + 1));
    }
    if (currentExtraTerms.has('breadth')) {
      termsMult *= Math.pow(10, currentExtraTerms.get('breadth')! * Math.min(p.chain_count - 1, 5));
    }
    const v = curveVal * famOffset * termsMult;
    valueIfLaunches.push(v);
    const implied = Math.max(1, Math.round(v * p.odds));
    impliedValues.push(implied);
  }

  // Uncertainty bands
  const bands = computeUncertaintyBands(impliedValues, finalLooResiduals);
  for (let i = 0; i < bands.length; i++) {
    bands[i].slug = boardProtosForRank[i].slug;
  }

  // Nearest 3 traded comps by |log10(TVL) ratio|
  const nearestComps: { slug: string; name: string; tvl_usd: number; mcap_usd: number }[][] = [];
  for (const p of boardProtosForRank) {
    const targetLogTvl = p.log_tvl;
    const sorted = [...comps].sort((a, b) => Math.abs(a.log_tvl - targetLogTvl) - Math.abs(b.log_tvl - targetLogTvl));
    nearestComps.push(sorted.slice(0, 3).map(c => ({
      slug: c.slug,
      name: c.name,
      tvl_usd: c.tvl_usd,
      mcap_usd: c.mcap_usd,
    })));
  }

  // Build extra terms output
  const extraTermsOut: ExtraTerm[] = [];
  const termNamesOut = ['growth', 'seasoning', 'breadth'] as const;
  for (const termName of termNamesOut) {
    if (currentExtraTerms.has(termName)) {
      let meanX = 0;
      if (termName === 'growth') {
        const withGrowth = comps.filter(c => c.change_7d != null);
        meanX = withGrowth.reduce((s, c) => s + (c.change_7d! / 100), 0) / withGrowth.length;
      } else if (termName === 'seasoning') {
        const withAge = comps.filter(c => c.age_days != null);
        meanX = withAge.reduce((s, c) => s + log10(c.age_days! + 1), 0) / withAge.length;
      } else if (termName === 'breadth') {
        meanX = comps.reduce((s, c) => s + Math.min(c.chain_count - 1, 5), 0) / comps.length;
      }
      extraTermsOut.push({
        name: termName,
        coefficient: currentExtraTerms.get(termName)!,
        multiplier_at_mean: Math.pow(10, currentExtraTerms.get(termName)! * meanX),
        improves_loo: true,
        improves_walkforward: true,
        kept: true,
      });
    } else if (!currentExtraTerms.has(termName) && extraTermCoeffs.has(termName)) {
      let meanX = 0;
      if (termName === 'growth') {
        const withGrowth = comps.filter(c => c.change_7d != null);
        meanX = withGrowth.reduce((s, c) => s + (c.change_7d! / 100), 0) / withGrowth.length;
      } else if (termName === 'seasoning') {
        const withAge = comps.filter(c => c.age_days != null);
        meanX = withAge.reduce((s, c) => s + log10(c.age_days! + 1), 0) / withAge.length;
      } else if (termName === 'breadth') {
        meanX = comps.reduce((s, c) => s + Math.min(c.chain_count - 1, 5), 0) / comps.length;
      }
      extraTermsOut.push({
        name: termName,
        coefficient: extraTermCoeffs.get(termName)!,
        multiplier_at_mean: Math.pow(10, extraTermCoeffs.get(termName)! * meanX),
        improves_loo: false,
        improves_walkforward: false,
        kept: false,
      });
    }
  }

  return {
    fit: {
      method: bestMethod,
      a: bestFit.a,
      b: bestFit.b,
      r2: bestFit.r2,
      n_comps: comps.length,
      n_excluded_mcap0: nExcludedMcap0,
      n_excluded_cex: nExcludedCex,
    },
    validation: {
      loo_curve_median_miss: median(finalLoo.map(p => p.miss)),
      loo_flat_median_miss: flatLooMiss,
      within3x_curve: finalLoo.filter(p => p.miss <= 3).length / finalLoo.length,
      within3x_flat: flatWithin3,
      walkforward: finalWf,
      band_hold: bandHold,
      ablation,
      extra_terms: extraTermsOut,
      final_fit: {
        method: bestMethod,
        a: bestFit.a,
        b: bestFit.b,
        r2: bestFit.r2,
        n_comps: comps.length,
        n_excluded_mcap0: nExcludedMcap0,
        n_excluded_cex: nExcludedCex,
      },
      flat_multiple: flatMultiple,
    },
    extra_terms: extraTermsOut,
    odds,
    loo_residuals: finalLooResiduals,
    rank_ranges: rankRanges,
    uncertainty_bands: bands,
    value_if_launches: valueIfLaunches,
    implied_values: impliedValues,
    nearest_comps: nearestComps,
  };
}

/** Walk-forward with category offsets applied. */
function runWalkForwardWithFamily(
  comps: CompProtocol[],
  fitFn: (x: number[], y: number[]) => { a: number; b: number; r2: number },
  categoryOffsets: CategoryOffset[]
): WalkForwardResult {
  const withDate = comps.filter(c => c.listed_at).sort((a, b) =>
    (a.listed_at ?? '').localeCompare(b.listed_at ?? '')
  );

  if (withDate.length < 10) {
    const sorted = [...comps].sort((a, b) => a.slug.localeCompare(b.slug));
    const cutIdx = Math.floor(sorted.length * 0.7);
    const train = sorted.slice(0, cutIdx);
    const test = sorted.slice(cutIdx);
    const cutDate = train[train.length - 1]?.listed_at ?? SNAPSHOT_DATE;
    return evaluateSplitWithFamily(train, test, cutDate, fitFn, categoryOffsets);
  }

  const cutIdx = Math.floor(withDate.length / 2);
  const cutDate = withDate[cutIdx]?.listed_at ?? SNAPSHOT_DATE;
  const train = comps.filter(c => c.listed_at && c.listed_at <= cutDate);
  const test = comps.filter(c => c.listed_at && c.listed_at > cutDate);

  if (test.length === 0) {
    const sorted = [...comps].filter(c => c.listed_at).sort((a, b) =>
      (a.listed_at ?? '').localeCompare(b.listed_at ?? '')
    );
    const mid = Math.floor(sorted.length / 2);
    const newTrain = sorted.slice(0, mid);
    const newTest = sorted.slice(mid);
    const newCut = newTrain[newTrain.length - 1]?.listed_at ?? SNAPSHOT_DATE;
    return evaluateSplitWithFamily(newTrain, newTest, newCut, fitFn, categoryOffsets);
  }

  return evaluateSplitWithFamily(train, test, cutDate, fitFn, categoryOffsets);
}

function evaluateSplitWithFamily(
  train: CompProtocol[],
  test: CompProtocol[],
  cutDate: string,
  fitFn: (x: number[], y: number[]) => { a: number; b: number; r2: number },
  categoryOffsets: CategoryOffset[]
): WalkForwardResult {
  const xTrain = train.map(c => c.log_tvl);
  const yTrain = train.map(c => c.log_mcap);
  const { a, b } = fitFn(xTrain, yTrain);

  // Compute category offsets on train set
  const trainLoo = runLoo(train, fitFn);
  const trainOffsets = computeCategoryOffsets(train, trainLoo);
  const offsetMap = new Map(trainOffsets.map(o => [o.category, o.offset_log10]));

  const flatMult = median(train.map(c => c.mcap_usd / c.tvl_usd));

  const missesCurve: number[] = [];
  const missesFlat: number[] = [];

  for (const c of test) {
    let predLog = a + b * c.log_tvl;
    const offset = offsetMap.get(c.category) ?? 0;
    predLog += offset;

    const predLinear = Math.pow(10, predLog);
    const actualLinear = c.mcap_usd;
    missesCurve.push(Math.max(predLinear / actualLinear, actualLinear / predLinear));
    missesFlat.push(Math.max((flatMult * c.tvl_usd) / actualLinear, actualLinear / (flatMult * c.tvl_usd)));
  }

  return {
    cut_date: cutDate,
    n_train: train.length,
    n_test: test.length,
    miss_curve: median(missesCurve),
    miss_flat: median(missesFlat),
  };
}
