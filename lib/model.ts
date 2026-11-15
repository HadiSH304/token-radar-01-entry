// Token Radar v3 model: a cross-validated multi-feature fit over a
// launch-candidate universe.
//
// The board ranks launch candidates only, not every pre-token protocol:
// CEX, Bridge and Canonical Bridge rows are excluded (venues and asset
// movers whose tokens already exist, or claims on existing assets), and of
// the rest a protocol makes the board when its category holds at least 3
// live comps, when it sits on the snapshot watchlist, or when its TVL is
// at least $20M. Every watchlist slug still lands on the board.
//
// Prices come from an ensemble-style robust regression fitted on the
// snapshot's live-token protocols (the comps pool):
//
//   log(mcap) = b0 + b1 x log(TVL) + [age term] + category offset + shift
//
// - The regression is fitted with Huber weights, then refitted twice on
//   the points inside 2.2 median-absolute-deviation sigmas (a hard trim),
//   so a handful of outsized listings cannot bend the surface.
// - The category offset is the category's median residual, shrunk toward
//   zero by n/(n+k): a category with few comps borrows the global fit.
// - The shift is a calibration constant: the log-space constant that
//   zeroes the median signed percentage error of the pipeline's own
//   out-of-fold predictions on its training pool, which centres the
//   median signed error near zero on held-out protocols.
// - The feature set and the shrinkage k are not hand-picked constants:
//   eight candidate pipelines (the default first) are scored by 5-fold
//   cross-validation on the comps pool, and a challenger replaces the
//   incumbent only when it scores better by more than the margin in
//   CONFIG. Candidate features are drawn only from snapshot fields:
//   log TVL, log age, age as a fraction of four years, and an
//   age-missing flag. Two fields were tested during development and are
//   deliberately absent: 7-day TVL growth and chain count both scored
//   worse under cross-validation, so the model does not use them.
//
// The model also backtests itself, leave-one-out, on the snapshot's
// listed protocols: each live protocol's market cap is predicted by the
// full procedure (selection, calibration, fit) run on the rest of the
// pool, and the board reports the median absolute percentage error
// (MdAPE) and the median signed percentage error next to the previous
// models' figures (v2 size fit 84.65%, v1 category medians 91.81%).
// Farm plans are built per row from the protocol's own category, chains
// and TVL tier, so two rows never share the same plan text with names
// swapped.

/** Every scoring weight and multiplier, in one block. Retune here only. */
export const CONFIG = {
  huber_k: 1.345,
  huber_iterations: 4,
  trim_sigma: 2.2,
  trim_rounds: 2,
  trim_min_points: 40,
  cv_folds: 5,
  selection_margin_pct: 1.5,
  universe_excluded_categories: ['CEX', 'Bridge', 'Canonical Bridge'],
  universe_min_category_comps: 3,
  universe_min_tvl_usd: 20_000_000,
  previous_mdape_pct: 84.65,
  first_mdape_pct: 91.81,
  airdrop_default_pct: 0.1,
  airdrop_high_pct: 0.15,
  airdrop_low_pct: 0.05,
  airdrop_high_cats: ['Dexs', 'Lending', 'Yield', 'Yield Aggregator'],
  airdrop_low_cats: ['CEX'],
  // Rough active-wallet counts by TVL tier, used only for the indicative
  // per-wallet figure in the detail view. Stated in the dashboard as the
  // entry's own assumption, never a promise.
  wallets_by_tvl_tier: [250_000, 100_000, 40_000, 15_000],
  farm_weeks: 12,
} as const;

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-ensemble-v3';

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

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Median of a sorted-ascending copy. Assumes at least one value. */
function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is a usable live comp: a recorded market cap over a positive TVL. */
export function isLiveComp(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0;
}

export interface PeerComp {
  name: string;
  ratio: number;
  mcap_usd: number;
}

export interface CompStats {
  /** Live comps actually used (mcap>0 and tvl>0). */
  pool_size: number;
  /** Median mcap/tvl over the whole pool. */
  global_median: number;
  /** Categories that hold at least one live comp. */
  categories_with_comps: number;
  /** Per-category comp counts and top-3 peers by market cap. */
  by_category: Record<string, { count: number; multiple: number; peers: PeerComp[] }>;
}

/** Build the comp pool statistics from the snapshot's live-token protocols. */
export function buildComps(snapshot: Snapshot): CompStats {
  const live = snapshot.protocols.filter(isLiveComp);
  const allRatios = live.map((p) => p.mcap_usd! / p.tvl_usd);
  const globalMedian = medianOf(allRatios);
  const byCat = new Map<string, SnapshotProtocol[]>();
  for (const p of live) {
    const key = p.category ?? 'Other';
    const list = byCat.get(key) ?? [];
    list.push(p);
    byCat.set(key, list);
  }
  const by_category: CompStats['by_category'] = {};
  for (const [cat, list] of [...byCat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const ratios = list.map((p) => p.mcap_usd! / p.tvl_usd);
    const peers = [...list]
      .sort((a, b) => b.mcap_usd! - a.mcap_usd!)
      .slice(0, 3)
      .map((p) => ({ name: p.name, ratio: round4(p.mcap_usd! / p.tvl_usd), mcap_usd: p.mcap_usd! }));
    by_category[cat] = { count: list.length, multiple: round4(medianOf(ratios)), peers };
  }
  return { pool_size: live.length, global_median: round4(globalMedian), categories_with_comps: byCat.size, by_category };
}

// ---------------------------------------------------------------------------
// Multi-feature robust fit with cross-validated selection and calibration
// ---------------------------------------------------------------------------

/** The optional features a candidate pipeline may add to the size term. */
export type FeatureName = 'lage' | 'agefrac' | 'agemiss';

export interface Candidate {
  id: string;
  label: string;
  features: FeatureName[];
  /** Category-offset shrinkage: offset weight is n/(n+cat_k). */
  cat_k: number;
  /** Whether the fit is refitted on the hard-trimmed point set. */
  trim: boolean;
}

/** The candidate pipelines, default first. Selection may only move to a
 *  challenger that beats the incumbent by more than the margin. */
export const CANDIDATES: Candidate[] = [
  { id: 'lage-k4-trim', label: 'log TVL + log age, offset k=4, trimmed', features: ['lage'], cat_k: 4, trim: true },
  { id: 'agefrac-k4-trim', label: 'log TVL + age fraction, offset k=4, trimmed', features: ['agefrac'], cat_k: 4, trim: true },
  { id: 'lage-agemiss-k4-trim', label: 'log TVL + log age + age-missing flag, offset k=4, trimmed', features: ['lage', 'agemiss'], cat_k: 4, trim: true },
  { id: 'lage-k3-trim', label: 'log TVL + log age, offset k=3, trimmed', features: ['lage'], cat_k: 3, trim: true },
  { id: 'lage-k6-trim', label: 'log TVL + log age, offset k=6, trimmed', features: ['lage'], cat_k: 6, trim: true },
  { id: 'lage-k4-notrim', label: 'log TVL + log age, offset k=4, untrimmed', features: ['lage'], cat_k: 4, trim: false },
  { id: 'plain-k4-trim', label: 'log TVL only, offset k=4, trimmed', features: [], cat_k: 4, trim: true },
  { id: 'agefrac-k3-trim', label: 'log TVL + age fraction, offset k=3, trimmed', features: ['agefrac'], cat_k: 3, trim: true },
];

/** Raw feature values for one protocol under one candidate. Age is taken
 *  against the snapshot date; a missing age is imputed at the pool median
 *  by the caller through `medianAge`. */
function rawFeatures(p: SnapshotProtocol, asOf: string, medianAge: number, features: FeatureName[]): number[] {
  const age = ageDays(asOf, p.listed_at);
  const out: number[] = [Math.log(Math.max(p.tvl_usd, 1))];
  for (const f of features) {
    if (f === 'lage') out.push(Math.log(1 + (age ?? medianAge)));
    else if (f === 'agefrac') out.push(Math.min(age ?? medianAge, 1460) / 1460);
    else out.push(age === null ? 1 : 0);
  }
  return out;
}

interface Design {
  /** Column means of the non-intercept features, for centring. */
  means: number[];
  /** Indices of feature columns with real spread; constant columns are dropped from the solve. */
  active: number[];
  /** Centred design rows (active columns only). */
  rows: number[][];
}

function buildDesign(pool: SnapshotProtocol[], asOf: string, medianAge: number, features: FeatureName[]): Design {
  const raw = pool.map((p) => rawFeatures(p, asOf, medianAge, features));
  const cols = raw.length > 0 ? raw[0]!.length : 0;
  const means: number[] = [];
  const active: number[] = [];
  for (let j = 0; j < cols; j++) {
    let mean = 0;
    for (const r of raw) mean += r[j]!;
    mean = raw.length > 0 ? mean / raw.length : 0;
    means.push(mean);
    let spread = 0;
    for (const r of raw) spread = Math.max(spread, Math.abs(r[j]! - mean));
    if (spread > 1e-9) active.push(j);
  }
  const rows = raw.map((r) => active.map((j) => r[j]! - means[j]!));
  return { means, active, rows };
}

/** Solve (X'X) beta = X'y by Gaussian elimination with partial pivoting. */
function solveNormal(xtx: number[][], xty: number[]): number[] | null {
  const n = xty.length;
  const a = xtx.map((row, i) => [...row, xty[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    if (Math.abs(a[piv]![col]!) < 1e-12) return null;
    if (piv !== col) {
      const tmp = a[col]!;
      a[col] = a[piv]!;
      a[piv] = tmp;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r]![col]! / a[col]![col]!;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) a[r]![c] = a[r]![c]! - factor * a[col]![c]!;
    }
  }
  return a.map((row, i) => row[n]! / row[i]!);
}

/** Weighted least squares on a centred design with an unpenalised intercept. */
function wls(design: Design, y: number[], weights: number[] | null): number[] | null {
  const p = design.active.length;
  const xtx: number[][] = Array.from({ length: p + 1 }, () => new Array<number>(p + 1).fill(0));
  const xty: number[] = new Array<number>(p + 1).fill(0);
  let sw = 0;
  let sy = 0;
  for (let i = 0; i < y.length; i++) {
    const w = weights === null ? 1 : weights[i]!;
    sw += w;
    sy += w * y[i]!;
  }
  const yMean = sw > 0 ? sy / sw : 0;
  for (let i = 0; i < y.length; i++) {
    const w = weights === null ? 1 : weights[i]!;
    if (w === 0) continue;
    const row = design.rows[i]!;
    const yc = y[i]! - yMean;
    for (let a = 0; a < p; a++) {
      xty[a + 1] += w * row[a]! * yc;
      for (let b = a; b < p; b++) xtx[a + 1]![b + 1] += w * row[a]! * row[b]!;
    }
  }
  for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) xtx[a + 1]![b + 1] = xtx[b + 1]![a + 1]!;
  xtx[0]![0] = 1;
  xty[0] = yMean;
  const beta = solveNormal(xtx, xty);
  if (beta === null) return null;
  // beta[0] is the centred intercept (prediction at the pool-mean profile).
  return beta;
}

/** Huber IRLS on a centred design: residuals scaled by their own MAD. */
function huberFit(design: Design, y: number[]): number[] {
  let beta = wls(design, y, null) ?? new Array<number>(design.active.length + 1).fill(0);
  for (let iter = 0; iter < CONFIG.huber_iterations; iter++) {
    const residuals = y.map((yi, i) => yi - predictCentered(design, beta, i));
    const centre = medianOf(residuals);
    const sigma = 1.4826 * medianOf(residuals.map((r) => Math.abs(r - centre)));
    if (!Number.isFinite(sigma) || sigma <= 0) break;
    const cap = CONFIG.huber_k * sigma;
    const weights = residuals.map((r) => {
      const dd = Math.abs(r);
      return dd <= cap ? 1 : cap / dd;
    });
    const next = wls(design, y, weights);
    if (next === null) break;
    beta = next;
  }
  return beta;
}

function predictCentered(design: Design, beta: number[], rowIndex: number): number {
  let v = beta[0]!;
  const row = design.rows[rowIndex]!;
  for (let a = 0; a < row.length; a++) v += beta[a + 1]! * row[a]!;
  return v;
}

export interface FittedModel {
  candidate: Candidate;
  /** Median age of the training pool, the imputation point for unknown ages. */
  median_age: number;
  /** Column means of the design (feature order: log TVL, then candidate features). */
  means: number[];
  active: number[];
  /** beta[0] = prediction at the pool-mean profile; beta[j+1] per active column. */
  beta: number[];
  /** Per-category shrunk median residual, with its weight n/(n+k). */
  offsets: Map<string, { offset: number; weight: number; count: number }>;
  /** Calibration shift in log space, from out-of-fold residuals. */
  shift: number;
  /** How many training points the hard trim dropped. */
  trimmed_count: number;
  /** Median TVL of the training pool, the pricing point for a row with no positive TVL. */
  median_tvl: number;
  /** Per-category median TVL of the training pool. */
  category_median_tvl: Map<string, number>;
}

/** Fit one candidate pipeline on a pool, without calibration. */
function fitCore(pool: SnapshotProtocol[], asOf: string, candidate: Candidate): FittedModel {
  const ages = pool.map((p) => ageDays(asOf, p.listed_at)).filter((a): a is number => a !== null);
  const medianAge = ages.length > 0 ? medianOf(ages) : 0;
  const design = buildDesign(pool, asOf, medianAge, candidate.features);
  const y = pool.map((p) => Math.log(p.mcap_usd!));
  let beta = huberFit(design, y);
  let kept = pool.map((_, i) => i);
  if (candidate.trim) {
    for (let round = 0; round < CONFIG.trim_rounds; round++) {
      const residuals = y.map((yi, i) => yi - predictCentered(design, beta, i));
      const centre = medianOf(residuals);
      const sigma = 1.4826 * medianOf(residuals.map((r) => Math.abs(r - centre)));
      if (!Number.isFinite(sigma) || sigma <= 0) break;
      const inside = pool.map((_, i) => i).filter((i) => Math.abs(residuals[i]! - centre) <= CONFIG.trim_sigma * sigma);
      if (inside.length < CONFIG.trim_min_points) break;
      kept = inside;
      const subDesign: Design = { means: design.means, active: design.active, rows: kept.map((i) => design.rows[i]!) };
      beta = huberFit(subDesign, kept.map((i) => y[i]!));
    }
  }
  const residuals = y.map((yi, i) => yi - predictCentered(design, beta, i));
  const byCat = new Map<string, number[]>();
  pool.forEach((p, i) => {
    const key = p.category ?? 'Other';
    const list = byCat.get(key) ?? [];
    list.push(residuals[i]!);
    byCat.set(key, list);
  });
  const offsets = new Map<string, { offset: number; weight: number; count: number }>();
  for (const [cat, list] of byCat) {
    offsets.set(cat, { offset: medianOf(list), weight: list.length / (list.length + candidate.cat_k), count: list.length });
  }
  const catTvl = new Map<string, number[]>();
  for (const p of pool) {
    const key = p.category ?? 'Other';
    const list = catTvl.get(key) ?? [];
    list.push(p.tvl_usd);
    catTvl.set(key, list);
  }
  const category_median_tvl = new Map<string, number>();
  for (const [cat, list] of catTvl) category_median_tvl.set(cat, medianOf(list));
  return {
    candidate,
    median_age: medianAge,
    means: design.means,
    active: design.active,
    beta,
    offsets,
    shift: 0,
    trimmed_count: pool.length - kept.length,
    median_tvl: pool.length > 0 ? medianOf(pool.map((p) => p.tvl_usd)) : 0,
    category_median_tvl,
  };
}

/** Deterministic folds: the pool sorted by slug, dealt round-robin. */
function foldsOf(pool: SnapshotProtocol[], k: number): SnapshotProtocol[][] {
  const sorted = [...pool].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const folds: SnapshotProtocol[][] = Array.from({ length: k }, () => []);
  sorted.forEach((p, i) => folds[i % k]!.push(p));
  return folds;
}

/** Out-of-fold log predictions of an uncalibrated pipeline on its own pool.
 *  `foldCount` defaults to CONFIG.cv_folds; a count at or above the pool
 *  size gives leave-one-out folds. */
function outOfFold(pool: SnapshotProtocol[], asOf: string, candidate: Candidate, foldCount: number = CONFIG.cv_folds): Map<string, number> {
  const out = new Map<string, number>();
  for (const fold of foldsOf(pool, Math.min(foldCount, pool.length))) {
    const inFold = new Set(fold.map((p) => p.slug));
    const train = pool.filter((p) => !inFold.has(p.slug));
    if (train.length < 4) continue;
    const model = fitCore(train, asOf, candidate);
    for (const p of fold) out.set(p.slug, predictLog(model, p, asOf));
  }
  return out;
}

/** The calibration shift: the log-space constant that zeroes the median
 *  signed percentage error of the pipeline's own out-of-fold predictions
 *  (5-fold) on its training pool, found by a fine scan. Centring in
 *  percent space — the space the backtest reports — puts the median
 *  signed error on held-out protocols close to zero. */
function calibrationShift(pool: SnapshotProtocol[], asOf: string, candidate: Candidate): number {
  const oof = outOfFold(pool, asOf, candidate);
  const points: { pred: number; actual: number }[] = [];
  for (const p of pool) {
    const pred = oof.get(p.slug);
    if (pred !== undefined) points.push({ pred, actual: p.mcap_usd! });
  }
  if (points.length === 0) return 0;
  let best = 0;
  let bestAbs = Number.POSITIVE_INFINITY;
  for (let s = -0.3; s <= 0.3001; s += 0.005) {
    const signed = points.map((pt) => (Math.exp(pt.pred + s) - pt.actual) / pt.actual);
    const abs = Math.abs(medianOf(signed));
    if (abs < bestAbs - 1e-12 || (Math.abs(abs - bestAbs) <= 1e-12 && Math.abs(s) < Math.abs(best))) {
      bestAbs = abs;
      best = s;
    }
  }
  return Math.round(best * 1000) / 1000;
}

/** Fit a candidate with its calibration shift applied. */
function fitCalibrated(pool: SnapshotProtocol[], asOf: string, candidate: Candidate): FittedModel {
  const model = fitCore(pool, asOf, candidate);
  model.shift = calibrationShift(pool, asOf, candidate);
  return model;
}

/** The 5-fold cross-validation MdAPE of a candidate on a pool, in percent. */
function cvScore(pool: SnapshotProtocol[], asOf: string, candidate: Candidate): number {
  const oof = outOfFold(pool, asOf, candidate);
  const apes: number[] = [];
  for (const p of pool) {
    const pred = oof.get(p.slug);
    if (pred !== undefined) apes.push(Math.abs(Math.exp(pred) - p.mcap_usd!) / p.mcap_usd!);
  }
  return apes.length > 0 ? medianOf(apes) * 100 : Number.POSITIVE_INFINITY;
}

export interface Selection {
  chosen: Candidate;
  scores: { id: string; label: string; cv_mdape_pct: number }[];
}

/** Score every candidate by cross-validation; a challenger must beat the
 *  incumbent by more than the margin to take its place. */
export function selectCandidate(pool: SnapshotProtocol[], asOf: string): Selection {
  const scores = CANDIDATES.map((c) => ({ id: c.id, label: c.label, cv_mdape_pct: round4(cvScore(pool, asOf, c)) }));
  let best = 0;
  for (let i = 1; i < CANDIDATES.length; i++) {
    if (scores[i]!.cv_mdape_pct < scores[best]!.cv_mdape_pct - CONFIG.selection_margin_pct) best = i;
  }
  return { chosen: CANDIDATES[best]!, scores };
}

/** The fitted log market cap of one protocol under a fitted model. */
export function predictLog(model: FittedModel, p: SnapshotProtocol, asOf: string): number {
  const key = p.category ?? 'Other';
  const floor = !(p.tvl_usd > 0);
  const tvlPoint = floor ? (model.category_median_tvl.get(key) ?? model.median_tvl) : p.tvl_usd;
  const probe: SnapshotProtocol = floor ? { ...p, tvl_usd: Math.max(tvlPoint, 1) } : p;
  const raw = rawFeatures(probe, asOf, model.median_age, model.candidate.features);
  let v = model.beta[0]! + model.shift;
  model.active.forEach((col, a) => {
    v += model.beta[a + 1]! * (raw[col]! - model.means[col]!);
  });
  const off = model.offsets.get(key);
  if (off !== undefined) v += off.weight * off.offset;
  return v;
}

export interface FactorContribution {
  label: string;
  /** Multiplicative contribution to the fitted value, vs the pool-mean profile. */
  factor: number;
}

export interface FittedValue {
  /** exp(fitted log mcap): the model's price before rounding. */
  base_usd: number;
  /** base_usd over TVL (over the category median TVL for a floor row). */
  fitted_multiple: number;
  /** 'category' when the category offset carries at least half weight, else 'global'. */
  fit_source: 'category' | 'global';
  /** The category offset weight n/(n+k); 0 when the category holds no comps. */
  fit_weight: number;
  comp_count: number;
  floor_estimate: boolean;
  /** Top contributing factors, strongest first, at most 3. */
  factors: FactorContribution[];
  /** The calibration multiplier exp(shift). */
  calibration_factor: number;
  /** The category offset multiplier exp(weight x offset); 1 when no offset. */
  category_factor: number;
}

/** Price one protocol off a fitted model, with its audit factors. */
export function fittedValue(p: SnapshotProtocol, model: FittedModel, asOf: string): FittedValue {
  const key = p.category ?? 'Other';
  const floor = !(p.tvl_usd > 0);
  const tvlPoint = floor ? (model.category_median_tvl.get(key) ?? model.median_tvl) : p.tvl_usd;
  const probe: SnapshotProtocol = floor ? { ...p, tvl_usd: Math.max(tvlPoint, 1) } : p;
  const raw = rawFeatures(probe, asOf, model.median_age, model.candidate.features);
  const labels = ['Protocol size (log TVL)', ...model.candidate.features.map((f) => (f === 'lage' ? 'Protocol age (log)' : f === 'agefrac' ? 'Protocol age (fraction of 4y)' : 'Age on record (missing flag)'))];
  const contribs: FactorContribution[] = [];
  model.active.forEach((col, a) => {
    const logPart = model.beta[a + 1]! * (raw[col]! - model.means[col]!);
    if (Math.abs(logPart) > 1e-9) contribs.push({ label: labels[col]!, factor: round4(Math.exp(logPart)) });
  });
  const off = model.offsets.get(key);
  const categoryFactor = off !== undefined ? Math.exp(off.weight * off.offset) : 1;
  if (off !== undefined && Math.abs(off.weight * off.offset) > 1e-9) {
    contribs.push({ label: `Category offset (${key})`, factor: round4(categoryFactor) });
  }
  if (Math.abs(model.shift) > 1e-9) contribs.push({ label: 'Cross-validated calibration', factor: round4(Math.exp(model.shift)) });
  contribs.sort((a, b) => Math.abs(Math.log(b.factor)) - Math.abs(Math.log(a.factor)));
  let base = Math.exp(predictLog(model, p, asOf));
  if (!Number.isFinite(base) || base <= 0) base = 1;
  return {
    base_usd: base,
    fitted_multiple: round4(base / Math.max(tvlPoint, 1)),
    fit_source: off !== undefined && off.weight >= 0.5 ? 'category' : 'global',
    fit_weight: round4(off?.weight ?? 0),
    comp_count: off?.count ?? 0,
    floor_estimate: floor,
    factors: contribs.slice(0, 3),
    calibration_factor: round4(Math.exp(model.shift)),
    category_factor: round4(categoryFactor),
  };
}

/** The top-3 peer comps for a row: live comps nearest in log TVL, same
 *  category first, filled from the global pool when the category is thin. */
export function peerCompsFor(p: SnapshotProtocol, pool: SnapshotProtocol[]): PeerComp[] {
  const target = Math.log(Math.max(p.tvl_usd, 1));
  const byDistance = (a: SnapshotProtocol, b: SnapshotProtocol) =>
    Math.abs(Math.log(Math.max(a.tvl_usd, 1)) - target) - Math.abs(Math.log(Math.max(b.tvl_usd, 1)) - target);
  const sameCat = pool.filter((q) => (q.category ?? 'Other') === (p.category ?? 'Other') && q.slug !== p.slug).sort(byDistance);
  const rest = pool.filter((q) => (q.category ?? 'Other') !== (p.category ?? 'Other')).sort(byDistance);
  return [...sameCat, ...rest]
    .slice(0, 3)
    .map((q) => ({ name: q.name, ratio: round4(q.mcap_usd! / q.tvl_usd), mcap_usd: q.mcap_usd! }));
}

/**
 * The leave-one-out self-backtest of the whole procedure: each live
 * protocol's market cap is predicted by selection + calibration + fit
 * run on the rest of the pool.
 */
export function backtest(snapshot: Snapshot): { tested: number; mdape_pct: number; median_signed_pct: number } {
  const live = snapshot.protocols.filter(isLiveComp);
  const absolute: number[] = [];
  const signed: number[] = [];
  for (const p of live) {
    const pool = live.filter((q) => q.slug !== p.slug);
    if (pool.length < 8) continue;
    const selection = selectCandidate(pool, snapshot.as_of);
    const model = fitCalibrated(pool, snapshot.as_of, selection.chosen);
    const predicted = Math.exp(predictLog(model, p, snapshot.as_of));
    absolute.push(Math.abs(predicted - p.mcap_usd!) / p.mcap_usd!);
    signed.push((predicted - p.mcap_usd!) / p.mcap_usd!);
  }
  if (absolute.length === 0) return { tested: 0, mdape_pct: 0, median_signed_pct: 0 };
  return { tested: absolute.length, mdape_pct: round4(medianOf(absolute) * 100), median_signed_pct: round4(medianOf(signed) * 100) };
}

// ---------------------------------------------------------------------------
// Gas tiers and farm plans
// ---------------------------------------------------------------------------

export interface GasTier {
  tier: 'expensive' | 'l2' | 'solana' | 'low' | 'other';
  cost_label: string;
  /** Midpoint cost per transaction, USD. */
  cost_per_tx_usd: number;
  /** Qualifying actions per week the plan asks for. */
  actions_per_week: number;
  /** Minutes of work per week the cadence step assumes. */
  minutes_per_week: number;
}

/** Primary-chain gas tier: chains[0] decides, per-chain TVL is not in the snapshot. */
export function gasTierFor(chain: string): GasTier {
  if (chain === 'Ethereum') return { tier: 'expensive', cost_label: '$6–$20', cost_per_tx_usd: 13, actions_per_week: 1, minutes_per_week: 8 };
  if (chain === 'Solana') return { tier: 'solana', cost_label: 'about $0.05', cost_per_tx_usd: 0.05, actions_per_week: 4, minutes_per_week: 10 };
  if (['Arbitrum', 'Base', 'Optimism', 'Scroll', 'Linea'].includes(chain)) {
    return { tier: 'l2', cost_label: 'under $0.50', cost_per_tx_usd: 0.1, actions_per_week: 4, minutes_per_week: 15 };
  }
  if (['Binance', 'Polygon', 'Avalanche'].includes(chain)) {
    return { tier: 'low', cost_label: '$0.10–$1', cost_per_tx_usd: 0.5, actions_per_week: 3, minutes_per_week: 15 };
  }
  return { tier: 'other', cost_label: '$0.10–$2', cost_per_tx_usd: 1, actions_per_week: 2, minutes_per_week: 15 };
}

/** Minimum capital range by TVL tier. */
export function capitalRangeFor(tvl: number): string {
  if (tvl >= 500_000_000) return '$2,000–$5,000';
  if (tvl >= 100_000_000) return '$1,000–$2,500';
  if (tvl >= 25_000_000) return '$500–$1,500';
  return '$250–$750';
}

/** TVL tier index 0..3, matching CONFIG.wallets_by_tvl_tier. */
export function tvlTier(tvl: number): number {
  if (tvl >= 500_000_000) return 0;
  if (tvl >= 100_000_000) return 1;
  if (tvl >= 25_000_000) return 2;
  return 3;
}

type Playbook =
  | 'lending' | 'dex' | 'staking' | 'bridge' | 'yield' | 'derivatives'
  | 'cdp' | 'rwa' | 'cex' | 'vault' | 'insurance' | 'generic';

function playbookFor(category: string | null): Playbook {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('collateral market')) return 'lending';
  if (c.includes('dex')) return 'dex';
  if (c.includes('stak') || c.includes('restak') || c.includes('anchor btc') || c.includes('decentralized btc')) return 'staking';
  if (c.includes('bridge')) return 'bridge';
  if (c.includes('yield') || c.includes('farm')) return 'yield';
  if (c.includes('derivative') || c.includes('basis trad') || c.includes('leveraged') || c.includes('options')) return 'derivatives';
  if (c.includes('cdp') || c.includes('stablecoin')) return 'cdp';
  if (c.includes('rwa')) return 'rwa';
  if (c === 'cex' || c.includes('cedefi') || c.includes('card')) return 'cex';
  if (c.includes('curator') || c.includes('allocator') || c.includes('index') || c.includes('liquidity manager') || c.includes('collateral management')) return 'vault';
  if (c.includes('insurance')) return 'insurance';
  return 'generic';
}

/** The category's core action, worded for the TVL tier and gas tier. */
function coreAction(pb: Playbook, name: string, chain: string, capital: string, gas: GasTier, big: boolean): string {
  const cheap = gas.tier === 'l2' || gas.tier === 'solana' || gas.tier === 'low';
  const framing = gas.tier === 'expensive'
    ? 'Keep it to few, larger transactions so the gas is covered by the allocation size'
    : cheap
      ? 'Gas is under $0.50 a transaction, so split the work into small weekly actions'
      : 'Keep transactions to a few per week and batch them where the app allows';
  const singleSided = big && gas.tier === 'expensive' ? ' Use a single-sided deposit where the app offers one, to avoid a second swap.' : '';
  switch (pb) {
    case 'lending':
      return `Supply ${capital} of USDC to ${name} on ${chain} and borrow a small amount against it, then repay half the borrow so the position shows both sides.${singleSided} ${framing}.`;
    case 'dex':
      return big
        ? `Provide ${capital} of liquidity to ${name}'s deepest pool on ${chain} in one deposit, then route a swap through the same pool each week.${singleSided} ${framing}.`
        : `Provide ${capital} of liquidity to ${name}'s main pool on ${chain} and route a swap through a different pair each week to spread volume across the pairs.${singleSided} ${framing}.`;
    case 'staking':
      return `Stake ${capital} of the chain's staking asset through ${name} on ${chain} and hold the receipt token in the same wallet.${singleSided} ${framing}.`;
    case 'bridge':
      return `Bridge ${capital} of USDC through ${name} onto ${chain}, then use the bridged funds inside an app on that chain instead of bridging straight back.${singleSided} ${framing}.`;
    case 'yield':
      return `Deposit ${capital} into ${name}'s highest-TVL vault on ${chain} and leave the shares untouched while the vault compounds.${singleSided} ${framing}.`;
    case 'derivatives':
      return `Deposit ${capital} of USDC as margin on ${name} on ${chain}, open one small hedged position, and close it before the funding window resets.${singleSided} ${framing}.`;
    case 'cdp':
      return `Lock ${capital} of collateral in ${name} on ${chain}, mint the stable asset against it, and keep the collateral ratio above the app's safe line.${singleSided} ${framing}.`;
    case 'rwa':
      return `Mint ${capital} of ${name}'s yield asset on ${chain} and hold it in the farming wallet for the full 12 weeks.${singleSided} ${framing}.`;
    case 'cex':
      return `Deposit ${capital} to ${name}, place a spot trade on ${chain} and one limit order, and keep a small balance on the venue between trades.${singleSided} ${framing}.`;
    case 'vault':
      return `Deposit ${capital} into a ${name} vault on ${chain} and keep the shares for the full 12 weeks so the position reads as one long allocation.${singleSided} ${framing}.`;
    case 'insurance':
      return `Buy ${capital} of cover from ${name} on ${chain} and keep the policy active for the full 12 weeks.${singleSided} ${framing}.`;
    default:
      return `Deposit ${capital} of USDC into ${name} on ${chain} and use the app's main feature once a week.${singleSided} ${framing}.`;
  }
}

/** The weekly cadence step, worded for the gas tier. */
function cadenceStep(pb: Playbook, name: string, chain: string, gas: GasTier): string {
  const n = gas.actions_per_week;
  const cost = (gas.cost_per_tx_usd * n * 4.3).toFixed(2);
  if (gas.tier === 'expensive') {
    return `Do one qualifying action every two weeks on ${name} (${chain}) — a top-up, a borrow-and-repay, or a vote — and skip the in-between weeks: at ${gas.cost_label} a transaction, weekly churn costs more than it adds. Cost: about $${(gas.cost_per_tx_usd * 2.15).toFixed(0)} a month in gas. Time: 15 minutes every two weeks, ${CONFIG.farm_weeks} weeks.`;
  }
  if (gas.tier === 'solana') {
    return `Interact with ${name} on ${chain} about ${n} times a week — small swaps, deposits and votes — since each transaction costs ${gas.cost_label}. Cost: about $${cost} of gas over 30 days. Time: 10 minutes a week, ${CONFIG.farm_weeks} weeks.`;
  }
  const extra = pb === 'dex' ? ' Route the volume across different pairs each week.' : pb === 'yield' ? ' Move a slice between vaults once a month if a new points epoch opens.' : '';
  return `Do about ${n} qualifying actions a week on ${name} (${chain}) — deposits, swaps, votes or claims — gas is ${gas.cost_label} a transaction.${extra} Cost: about $${cost} of gas over 30 days. Time: 15 minutes a week, ${CONFIG.farm_weeks} weeks.`;
}

/** Hold length from the protocol's age: younger protocols get a longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 90;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 45;
}

/** Whole dollars with thousands separators: $1,234,567. */
function fmtWhole(n: number): string {
  return `$${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** Compact dollars: $4.03B, $27.7M, $850K, $123. */
function fmtCompact(n: number): string {
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

/** The EV-to-gas rating word for a multiple. */
export function evRating(multiple: number | null): string {
  if (multiple === null || !Number.isFinite(multiple)) return 'n/a';
  if (multiple >= 20) return 'excellent';
  if (multiple >= 8) return 'strong';
  if (multiple >= 3) return 'fair';
  if (multiple >= 1) return 'thin';
  return 'negative';
}

export interface AirdropEv {
  pool_usd: number;
  share_pct: number;
  per_wallet_usd: number;
  wallets_assumed: number;
}

export interface FarmPlan {
  steps: string[];
  gas: GasTier & { gas_30d_usd: number; ev_gas_multiple: number | null; total_plan_gas_usd: number };
  capital_range: string;
  /** Total hands-on time across the whole plan, in minutes. */
  total_minutes: number;
}

/** A protocol's farm plan: 6 steps, each an action with a cost and a time,
 *  built from its own category, chains, TVL tier and airdrop arithmetic. */
export function farmPlan(p: SnapshotProtocol, age: number | null, ev: AirdropEv, impliedUsd: number): FarmPlan {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const gas = gasTierFor(chain);
  const capital = capitalRangeFor(p.tvl_usd);
  const big = p.tvl_usd >= 100_000_000;
  const pb = playbookFor(p.category);
  const hold = holdDaysFor(age);
  const gas30 = Math.round(gas.cost_per_tx_usd * gas.actions_per_week * 4.3 * 100) / 100;
  const totalGas = Math.round(gas30 * (CONFIG.farm_weeks / 4.3) * 100) / 100;
  const evGas = totalGas > 0 ? Math.round((ev.per_wallet_usd / totalGas) * 10) / 10 : null;
  const totalMinutes = 10 + 15 + gas.minutes_per_week * CONFIG.farm_weeks + 30;
  const secondChain = p.chains.length >= 2
    ? ` In week 2, repeat a smaller deposit on ${p.chains[1]} so the wallet shows real activity on both networks ${p.name} runs on.`
    : '';
  const steps = [
    `Open a fresh wallet that holds only the funds you plan to farm on ${p.name}, and keep its seed phrase offline. Fund it with ${capital} plus gas for the first transaction on ${chain}. Cost: one transaction at ${gas.cost_label}. Time: 10 minutes to set up.`,
    coreAction(pb, p.name, chain, capital, gas, big) + secondChain,
    cadenceStep(pb, p.name, chain, gas),
    `Run the value check before adding funds: the board prices ${p.name} at ${fmtCompact(impliedUsd)}, and a ${Math.round(ev.share_pct * 100)}% airdrop pool is ${fmtCompact(ev.pool_usd)} — across roughly ${ev.wallets_assumed.toLocaleString('en-US')} active wallets that is about ${fmtWhole(ev.per_wallet_usd)} per wallet, against ${fmtWhole(totalGas)} of gas over ${CONFIG.farm_weeks} weeks, an EV-to-gas multiple of ${evGas === null ? 'n/a' : `${evGas}x`} (${evRating(evGas)}). The pool share is the board's stated assumption, not a promise. Cost: none. Time: 5 minutes.`,
    `Hold the position for at least ${hold} days and open ${p.name}'s own points or rewards page once a month to check the activity is counted. Cost: no fee to check. Time: 10 minutes a month for ${CONFIG.farm_weeks} weeks.`,
    `When the ${CONFIG.farm_weeks} weeks end, claim only from the link ${p.name} itself publishes, never pay to claim, and write the wallet, dates and every transaction in a farm log before you unwind. Cost: one exit transaction at ${gas.cost_label}. Time: 15 minutes.`,
  ];
  return {
    steps: steps.map((s) => {
      if (s.length > 600) return `${s.slice(0, 596)}...`;
      return s;
    }),
    gas: { ...gas, gas_30d_usd: gas30, ev_gas_multiple: evGas, total_plan_gas_usd: totalGas },
    capital_range: capital,
    total_minutes: totalMinutes,
  };
}

// ---------------------------------------------------------------------------
// Board build
// ---------------------------------------------------------------------------

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  model: {
    fitted_multiple: number;
    fit_source: 'category' | 'global';
    fit_weight: number;
    comp_count: number;
    peers: PeerComp[];
    base_usd: number;
    factors: FactorContribution[];
    calibration_factor: number;
    category_factor: number;
    floor_estimate: boolean;
  };
  airdrop: AirdropEv & { ev_rating: string };
  gas: FarmPlan['gas'];
  capital_range: string;
  total_minutes: number;
  farm_steps: string[];
}

export interface RadarRow extends BoardRow {}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  ratio: number;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  config: typeof CONFIG;
  total_protocols: number;
  pre_token_size: number;
  watchlist_size: number;
  board_size: number;
  live_size: number;
  comps: CompStats;
  fit: {
    chosen_id: string;
    chosen_label: string;
    features: FeatureName[];
    cat_k: number;
    trim: boolean;
    trimmed_count: number;
    calibration_factor: number;
    coefficients: { intercept_at_pool_mean: number; log_tvl: number; age: number | null };
    candidates: { id: string; label: string; cv_mdape_pct: number; chosen: boolean }[];
  };
  universe: {
    excluded_categories: readonly string[];
    min_category_comps: number;
    min_tvl_usd: number;
  };
  backtest: { tested: number; mdape_pct: number; median_signed_pct: number; previous_mdape_pct: number; first_mdape_pct: number };
  rows: RadarRow[];
  live: LiveRow[];
}

/** Airdrop-pool share of implied value by category: 15% for Dexs/Lending/Yield, 5% for CEX/Bridge, 10% otherwise. */
function airdropSharePct(category: string | null): number {
  const c = category ?? '';
  if (CONFIG.airdrop_high_cats.includes(c as never)) return CONFIG.airdrop_high_pct;
  if (CONFIG.airdrop_low_cats.includes(c as never) || c.includes('Bridge')) return CONFIG.airdrop_low_pct;
  return CONFIG.airdrop_default_pct;
}

/** Whether a pre-token protocol belongs to the launch-candidate universe the board ranks. */
export function inUniverse(p: SnapshotProtocol, comps: CompStats, watch: Set<string>): boolean {
  const key = p.category ?? 'Other';
  if ((CONFIG.universe_excluded_categories as readonly string[]).includes(key)) return false;
  if (watch.has(p.slug)) return true;
  if ((comps.by_category[key]?.count ?? 0) >= CONFIG.universe_min_category_comps) return true;
  return p.tvl_usd >= CONFIG.universe_min_tvl_usd;
}

/**
 * The protocols the board ranks, strongest first, with ranks 1..n: the
 * launch-candidate universe (see inUniverse), priced off the selected fit.
 */
export function buildBoard(snapshot: Snapshot, comps: CompStats, model: FittedModel, pool: SnapshotProtocol[]): BoardRow[] {
  const watch = new Set(snapshot.watchlist);
  const missingWatch = snapshot.watchlist.filter((s) => !snapshot.protocols.some((p) => p.slug === s));
  if (missingWatch.length > 0) throw new Error(`token radar: watchlist slugs missing from the snapshot: ${missingWatch.join(', ')}`);
  const preTokenList = snapshot.protocols
    .filter(isPreToken)
    .filter((p) => inUniverse(p, comps, watch))
    .map((p) => {
      const age = ageDays(snapshot.as_of, p.listed_at);
      const fv = fittedValue(p, model, snapshot.as_of);
      const estFdv = Math.max(1, Math.round(fv.base_usd));
      return { p, age, fv, estFdv, peers: peerCompsFor(p, pool) };
    });

  // Automated verification, in the model's own terms: every watchlist
  // slug on the board, every implied value finite and positive, and the
  // board in rank order once sorted.
  const boardSlugs = new Set(preTokenList.map((s) => s.p.slug));
  const offBoard = snapshot.watchlist.filter((s) => !boardSlugs.has(s));
  console.assert(offBoard.length === 0, 'Watchlist ada yang tertinggal dari board!');
  console.assert(preTokenList.every((p) => Number.isFinite(p.estFdv) && p.estFdv > 0), 'Ada valuasi invalid!');
  if (offBoard.length > 0) throw new Error(`token radar: watchlist slugs left off the board: ${offBoard.join(', ')}`);
  if (!preTokenList.every((s) => Number.isFinite(s.estFdv) && s.estFdv > 0)) throw new Error('token radar: a row has an invalid implied value');

  preTokenList.sort((a, b) => b.estFdv - a.estFdv || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  for (let i = 1; i < preTokenList.length; i++) {
    if (preTokenList[i]!.estFdv > preTokenList[i - 1]!.estFdv) throw new Error('token radar: board rows are not in rank order');
  }
  return preTokenList.map((s, i) => {
    const sharePct = airdropSharePct(s.p.category);
    const poolUsd = Math.round(s.estFdv * sharePct);
    const wallets = CONFIG.wallets_by_tvl_tier[tvlTier(s.p.tvl_usd)];
    const perWallet = Math.round((poolUsd / wallets) * 100) / 100;
    const ev: AirdropEv = { pool_usd: poolUsd, share_pct: sharePct, per_wallet_usd: perWallet, wallets_assumed: wallets };
    const plan = farmPlan(s.p, s.age, ev, s.estFdv);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_days: s.age,
      watchlist: watch.has(s.p.slug),
      implied_value_usd: s.estFdv,
      model: {
        fitted_multiple: s.fv.fitted_multiple,
        fit_source: s.fv.fit_source,
        fit_weight: s.fv.fit_weight,
        comp_count: s.fv.comp_count,
        peers: s.peers,
        base_usd: Math.round(s.fv.base_usd),
        factors: s.fv.factors,
        calibration_factor: s.fv.calibration_factor,
        category_factor: s.fv.category_factor,
        floor_estimate: s.fv.floor_estimate,
      },
      airdrop: { ...ev, ev_rating: evRating(plan.gas.ev_gas_multiple) },
      gas: plan.gas,
      capital_range: plan.capital_range,
      total_minutes: plan.total_minutes,
      farm_steps: plan.steps,
    };
  });
}

/** The live-token protocols, by market cap, as the comps evidence. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter(isLiveComp)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      ratio: round4(p.mcap_usd! / p.tvl_usd),
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const comps = buildComps(snapshot);
  const pool = snapshot.protocols.filter(isLiveComp);
  const selection = selectCandidate(pool, snapshot.as_of);
  const model = fitCalibrated(pool, snapshot.as_of, selection.chosen);
  const board = buildBoard(snapshot, comps, model, pool);
  const live = liveRows(snapshot);
  const bt = backtest(snapshot);
  const coef = (col: number): number | null => {
    const at = model.active.indexOf(col);
    return at >= 0 ? round4(model.beta[at + 1]!) : null;
  };
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    config: CONFIG,
    total_protocols: snapshot.protocols.length,
    pre_token_size: snapshot.protocols.filter(isPreToken).length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    comps,
    fit: {
      chosen_id: selection.chosen.id,
      chosen_label: selection.chosen.label,
      features: selection.chosen.features,
      cat_k: selection.chosen.cat_k,
      trim: selection.chosen.trim,
      trimmed_count: model.trimmed_count,
      calibration_factor: round4(Math.exp(model.shift)),
      coefficients: {
        intercept_at_pool_mean: round4(model.beta[0]!),
        log_tvl: round4(coef(0) ?? 0),
        age: selection.chosen.features.length > 0 ? coef(1) : null,
      },
      candidates: selection.scores.map((s) => ({ id: s.id, label: s.label, cv_mdape_pct: s.cv_mdape_pct, chosen: s.id === selection.chosen.id })),
    },
    universe: {
      excluded_categories: CONFIG.universe_excluded_categories,
      min_category_comps: CONFIG.universe_min_category_comps,
      min_tvl_usd: CONFIG.universe_min_tvl_usd,
    },
    backtest: { tested: bt.tested, mdape_pct: bt.mdape_pct, median_signed_pct: bt.median_signed_pct, previous_mdape_pct: CONFIG.previous_mdape_pct, first_mdape_pct: CONFIG.first_mdape_pct },
    rows: board,
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
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
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
    };
  });
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
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (!Number.isFinite(r.implied_value_usd)) return `${r.slug} has a non-finite implied value`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
