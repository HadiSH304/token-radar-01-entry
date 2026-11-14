// Token Radar v2 model: size-fitted valuation over a launch-candidate
// universe.
//
// The board ranks launch candidates only, not every pre-token protocol:
// CEX, Bridge and Canonical Bridge rows are excluded (venues and asset
// movers whose tokens already exist, or claims on existing assets), and of
// the rest a protocol makes the board when its category holds at least 3
// live comps, when it sits on the snapshot watchlist, or when its TVL is
// at least $20M. Every watchlist slug still lands on the board.
//
// Prices come from a line fitted to protocol size on the live comps pool:
//
//   log(mcap)  = a + b x log(TVL)          (robust least squares)
//   base       = exp(fitted log mcap), the category fit blended in where
//                the category holds at least 8 comps (weight n/(n+6) on
//                the category line); below that the global line plus the
//                category's median residual, shrunk by the same weight
//   growth     = 1 + clamp(change_7d, -50, 100) / 100 x GROWTH_WEIGHT
//   maturity   = 0.70 + 0.50 x min(age_days, 1460) / 1460   (age unknown: 0.95)
//   implied    = max(1, round(base x growth x maturity))
//
// All weights and multipliers live in CONFIG below, in one block, so a
// later dev-heat read can retune them in one place.
//
// The model also backtests itself, leave-one-out, on the snapshot's
// listed protocols: each live protocol's market cap is predicted from a
// fit that excludes it, and the board reports the median absolute
// percentage error (MdAPE) and the median signed percentage error next to
// the previous model's 91.81% MdAPE. Farm plans are built per row from
// category playbook x TVL tier x primary-chain gas tier, so two rows
// never share the same plan text with names swapped.

/** Every scoring weight and multiplier, in one block. Retune here only. */
export const CONFIG = {
  growth_weight: 0.35,
  growth_clamp_min: -50,
  growth_clamp_max: 100,
  maturity_floor: 0.7,
  maturity_range: 0.5,
  maturity_days: 1460,
  unknown_age_mult: 0.95,
  universe_excluded_categories: ['CEX', 'Bridge', 'Canonical Bridge'],
  universe_min_category_comps: 3,
  universe_min_tvl_usd: 20_000_000,
  category_line_min_comps: 8,
  blend_shrink_k: 6,
  huber_k: 1.345,
  huber_iterations: 4,
  previous_mdape_pct: 91.81,
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
export const MODEL_VERSION = 'radar-fit-v2';

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

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Median of a sorted-ascending copy. Assumes at least one value. */
function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Category median multiple, kept as a descriptive statistic for the comps record; pricing no longer uses it. */
function categoryMultiple(ratios: number[]): number {
  return medianOf(ratios);
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

/** Build the comp pool from the snapshot's live-token protocols. */
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
    by_category[cat] = { count: list.length, multiple: round4(categoryMultiple(ratios)), peers };
  }
  return { pool_size: live.length, global_median: round4(globalMedian), categories_with_comps: byCat.size, by_category };
}

// ---------------------------------------------------------------------------
// Size fit: log(mcap) = a + b x log(TVL), robust least squares
// ---------------------------------------------------------------------------

export interface LineFit {
  a: number;
  b: number;
}

/** Weighted least squares of log mcap on log TVL. Assumes at least two points with spread. */
function olsFit(points: { x: number; y: number }[], weights: number[] | null): LineFit {
  const n = points.length;
  let sw = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    const w = weights === null ? 1 : weights[i]!;
    sw += w;
    mx += w * points[i]!.x;
    my += w * points[i]!.y;
  }
  mx /= sw;
  my /= sw;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const w = weights === null ? 1 : weights[i]!;
    sxy += w * (points[i]!.x - mx) * (points[i]!.y - my);
    sxx += w * (points[i]!.x - mx) ** 2;
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/**
 * Least squares with Huber weights, iterated: residuals are scaled by
 * their own median absolute deviation, and any point past huber_k scaled
 * deviations counts for less. One outsized listing cannot bend the line
 * the way it bends a plain fit.
 */
function robustFit(points: { x: number; y: number }[]): LineFit {
  let line = olsFit(points, null);
  for (let iter = 0; iter < CONFIG.huber_iterations; iter++) {
    const residuals = points.map((pt) => pt.y - (line.a + line.b * pt.x));
    const centre = medianOf(residuals);
    const sigma = 1.4826 * medianOf(residuals.map((r) => Math.abs(r - centre)));
    if (!Number.isFinite(sigma) || sigma <= 0) break;
    const cap = CONFIG.huber_k * sigma;
    const weights = residuals.map((r) => {
      const d = Math.abs(r);
      return d <= cap ? 1 : cap / d;
    });
    line = olsFit(points, weights);
  }
  return line;
}

type CategoryFit =
  | { kind: 'line'; line: LineFit; count: number }
  | { kind: 'offset'; resid: number; count: number };

export interface SizeFit {
  global: LineFit;
  by_category: Map<string, CategoryFit>;
  /** Median TVL of the live comps, the pricing point for a row with no positive TVL. */
  global_median_tvl: number;
  /** Per-category median TVL of the live comps. */
  category_median_tvl: Map<string, number>;
  line_categories: number;
  offset_categories: number;
}

/** Fit the size lines on a pool of live comps: one global line, one line or shrunk offset per category. */
export function buildFit(pool: SnapshotProtocol[]): SizeFit {
  const points = pool.map((p) => ({ x: Math.log(p.tvl_usd), y: Math.log(p.mcap_usd!) }));
  const global = robustFit(points);
  const byCat = new Map<string, SnapshotProtocol[]>();
  for (const p of pool) {
    const key = p.category ?? 'Other';
    const list = byCat.get(key) ?? [];
    list.push(p);
    byCat.set(key, list);
  }
  const by_category = new Map<string, CategoryFit>();
  const category_median_tvl = new Map<string, number>();
  let lineCats = 0;
  let offsetCats = 0;
  for (const [cat, list] of byCat) {
    category_median_tvl.set(cat, medianOf(list.map((p) => p.tvl_usd)));
    if (list.length >= CONFIG.category_line_min_comps) {
      by_category.set(cat, { kind: 'line', line: robustFit(list.map((p) => ({ x: Math.log(p.tvl_usd), y: Math.log(p.mcap_usd!) }))), count: list.length });
      lineCats++;
    } else {
      const resid = medianOf(list.map((p) => Math.log(p.mcap_usd!) - (global.a + global.b * Math.log(p.tvl_usd))));
      by_category.set(cat, { kind: 'offset', resid, count: list.length });
      offsetCats++;
    }
  }
  return {
    global,
    by_category,
    global_median_tvl: pool.length > 0 ? medianOf(pool.map((p) => p.tvl_usd)) : 0,
    category_median_tvl,
    line_categories: lineCats,
    offset_categories: offsetCats,
  };
}

export interface FittedValue {
  /** exp(fitted log mcap) at the protocol's TVL, before growth and maturity. */
  base_usd: number;
  /** base_usd over TVL (over the category median TVL for a floor row). */
  fitted_multiple: number;
  /** 'category' when the category fit carries at least half the weight, else 'global'. */
  fit_source: 'category' | 'global';
  /** The category weight n/(n+6); 0 when the category holds no comps. */
  fit_weight: number;
  comp_count: number;
  floor_estimate: boolean;
}

/** Price one protocol off the fitted lines. Never returns NaN, Infinity or a non-positive value. */
export function fittedValue(p: SnapshotProtocol, fit: SizeFit): FittedValue {
  const key = p.category ?? 'Other';
  const cat = fit.by_category.get(key);
  const count = cat?.count ?? 0;
  const weight = count / (count + CONFIG.blend_shrink_k);
  const floor = !(p.tvl_usd > 0);
  const tvlPoint = floor ? (fit.category_median_tvl.get(key) ?? fit.global_median_tvl) : p.tvl_usd;
  const logTvl = Math.log(Math.max(tvlPoint, 1));
  const globalLog = fit.global.a + fit.global.b * logTvl;
  let fittedLog = globalLog;
  if (cat !== undefined) {
    if (cat.kind === 'line') {
      const catLog = cat.line.a + cat.line.b * logTvl;
      fittedLog = (1 - weight) * globalLog + weight * catLog;
    } else {
      fittedLog = globalLog + weight * cat.resid;
    }
  }
  let base = Math.exp(fittedLog);
  if (!Number.isFinite(base) || base <= 0) base = 1;
  return {
    base_usd: base,
    fitted_multiple: round4(base / Math.max(tvlPoint, 1)),
    fit_source: cat !== undefined && cat.kind === 'line' && weight >= 0.5 ? 'category' : 'global',
    fit_weight: round4(weight),
    comp_count: count,
    floor_estimate: floor,
  };
}

/**
 * The leave-one-out self-backtest: each live protocol's market cap is
 * predicted from a fit on the rest of the pool, growth and maturity left
 * out, so the figure grades the fit itself.
 */
export function backtest(snapshot: Snapshot): { tested: number; mdape_pct: number; median_signed_pct: number } {
  const live = snapshot.protocols.filter(isLiveComp);
  const absolute: number[] = [];
  const signed: number[] = [];
  for (const p of live) {
    const pool = live.filter((q) => q.slug !== p.slug);
    if (pool.length < 2) continue;
    const fit = buildFit(pool);
    const predicted = fittedValue(p, fit).base_usd;
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
}

/** Primary-chain gas tier: chains[0] decides, per-chain TVL is not in the snapshot. */
export function gasTierFor(chain: string): GasTier {
  if (chain === 'Ethereum') return { tier: 'expensive', cost_label: '$6–$20', cost_per_tx_usd: 13, actions_per_week: 1 };
  if (chain === 'Solana') return { tier: 'solana', cost_label: 'about $0.05', cost_per_tx_usd: 0.05, actions_per_week: 4 };
  if (['Arbitrum', 'Base', 'Optimism', 'Scroll', 'Linea'].includes(chain)) {
    return { tier: 'l2', cost_label: 'under $0.50', cost_per_tx_usd: 0.1, actions_per_week: 4 };
  }
  if (['Binance', 'Polygon', 'Avalanche'].includes(chain)) {
    return { tier: 'low', cost_label: '$0.10–$1', cost_per_tx_usd: 0.5, actions_per_week: 3 };
  }
  return { tier: 'other', cost_label: '$0.10–$2', cost_per_tx_usd: 1, actions_per_week: 2 };
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
function cadenceStep(pb: Playbook, name: string, chain: string, gas: GasTier, capital: string): string {
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

export interface FarmPlan {
  steps: string[];
  gas: GasTier & { gas_30d_usd: number; ev_gas_multiple: number | null };
  capital_range: string;
}

/** A protocol's farm plan: 5 steps, each an action with a cost and a time. */
export function farmPlan(p: SnapshotProtocol, age: number | null, perWalletUsd: number): FarmPlan {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const gas = gasTierFor(chain);
  const capital = capitalRangeFor(p.tvl_usd);
  const big = p.tvl_usd >= 100_000_000;
  const pb = playbookFor(p.category);
  const hold = holdDaysFor(age);
  const gas30 = Math.round(gas.cost_per_tx_usd * gas.actions_per_week * 4.3 * 100) / 100;
  const evGas = gas30 > 0 ? Math.round((perWalletUsd / gas30) * 10) / 10 : null;
  const steps = [
    `Open a fresh wallet that holds only the funds you plan to farm on ${p.name}, and keep its seed phrase offline. Fund it with ${capital} plus gas for the first transaction on ${chain}. Cost: one transaction at ${gas.cost_label}. Time: 10 minutes to set up.`,
    coreAction(pb, p.name, chain, capital, gas, big),
    cadenceStep(pb, p.name, chain, gas, capital),
    `Hold the position for at least ${hold} days and open ${p.name}'s own points or rewards page once a month to check the activity is counted. Cost: no fee to check. Time: 10 minutes a month for ${CONFIG.farm_weeks} weeks.`,
    `When the 12 weeks end, claim only from the link ${p.name} itself publishes, never pay to claim, and write the wallet, dates and every transaction in a farm log before you unwind. Cost: one exit transaction at ${gas.cost_label}. Time: 15 minutes.`,
  ];
  return {
    steps: steps.map((s) => {
      if (s.length > 600) return `${s.slice(0, 596)}...`;
      return s;
    }),
    gas: { ...gas, gas_30d_usd: gas30, ev_gas_multiple: evGas },
    capital_range: capital,
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
    growth_multiplier: number;
    maturity_multiplier: number;
    floor_estimate: boolean;
  };
  airdrop: {
    pool_usd: number;
    share_pct: number;
    per_wallet_usd: number;
    wallets_assumed: number;
  };
  gas: FarmPlan['gas'];
  capital_range: string;
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
    global_intercept: number;
    global_slope: number;
    line_categories: number;
    offset_categories: number;
  };
  universe: {
    excluded_categories: readonly string[];
    min_category_comps: number;
    min_tvl_usd: number;
  };
  backtest: { tested: number; mdape_pct: number; median_signed_pct: number; previous_mdape_pct: number };
  rows: RadarRow[];
  live: LiveRow[];
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
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
 * launch-candidate universe (see inUniverse), priced off the size fit.
 */
export function buildBoard(snapshot: Snapshot, comps: CompStats, fit: SizeFit): BoardRow[] {
  const watch = new Set(snapshot.watchlist);
  const missingWatch = snapshot.watchlist.filter((s) => !bySlug(snapshot.protocols).has(s));
  if (missingWatch.length > 0) throw new Error(`token radar: watchlist slugs missing from the snapshot: ${missingWatch.join(', ')}`);
  const globalPeers = Object.values(comps.by_category)
    .flatMap((e) => e.peers)
    .sort((a, b) => b.mcap_usd - a.mcap_usd)
    .slice(0, 3);
  const preTokenList = snapshot.protocols
    .filter(isPreToken)
    .filter((p) => inUniverse(p, comps, watch))
    .map((p) => {
      const age = ageDays(snapshot.as_of, p.listed_at);
      const fv = fittedValue(p, fit);
      const growthPct = p.change_7d === null ? 0 : Math.min(CONFIG.growth_clamp_max, Math.max(CONFIG.growth_clamp_min, p.change_7d));
      const growthMult = p.change_7d === null ? 1 : 1 + (growthPct / 100) * CONFIG.growth_weight;
      const maturityMult = age === null ? CONFIG.unknown_age_mult : CONFIG.maturity_floor + (Math.min(Math.max(age, 0), CONFIG.maturity_days) / CONFIG.maturity_days) * CONFIG.maturity_range;
      const estFdv = Math.max(1, Math.round(fv.base_usd * growthMult * maturityMult));
      const catPeers = comps.by_category[p.category ?? 'Other']?.peers;
      return { p, age, fv, growthMult, maturityMult, estFdv, peers: catPeers !== undefined && catPeers.length > 0 ? catPeers : globalPeers };
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
    const pool = Math.round(s.estFdv * sharePct);
    const wallets = CONFIG.wallets_by_tvl_tier[tvlTier(s.p.tvl_usd)];
    const perWallet = Math.round((pool / wallets) * 100) / 100;
    const plan = farmPlan(s.p, s.age, perWallet);
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
        growth_multiplier: round4(s.growthMult),
        maturity_multiplier: round4(s.maturityMult),
        floor_estimate: s.fv.floor_estimate,
      },
      airdrop: { pool_usd: pool, share_pct: sharePct, per_wallet_usd: perWallet, wallets_assumed: wallets },
      gas: plan.gas,
      capital_range: plan.capital_range,
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
  const fit = buildFit(snapshot.protocols.filter(isLiveComp));
  const board = buildBoard(snapshot, comps, fit);
  const live = liveRows(snapshot);
  const bt = backtest(snapshot);
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
      global_intercept: round4(fit.global.a),
      global_slope: round4(fit.global.b),
      line_categories: fit.line_categories,
      offset_categories: fit.offset_categories,
    },
    universe: {
      excluded_categories: CONFIG.universe_excluded_categories,
      min_category_comps: CONFIG.universe_min_category_comps,
      min_tvl_usd: CONFIG.universe_min_tvl_usd,
    },
    backtest: { tested: bt.tested, mdape_pct: bt.mdape_pct, median_signed_pct: bt.median_signed_pct, previous_mdape_pct: CONFIG.previous_mdape_pct },
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
