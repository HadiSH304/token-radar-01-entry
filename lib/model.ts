// Token Radar v1 model: category comps valuation.
//
// Every pre-token protocol is priced off the live market, not off a fixed
// constant: its implied value is TVL times the median FDV/TVL multiple of
// the live-token protocols in its own category, adjusted for 7-day TVL
// growth and for how long it has run with no token on record. Categories
// with too few live peers fall back to the global median multiple, so no
// row is ever priced from a single peer. All weights and multipliers live
// in CONFIG below, in one block, so a later dev-heat read can retune them
// in one place.
//
//   base       = tvl_usd x category_multiple
//   growth     = 1 + clamp(change_7d, -50, 100) / 100 x GROWTH_WEIGHT
//   maturity   = 0.70 + 0.50 x min(age_days, 1460) / 1460   (age unknown: 0.95)
//   implied    = max(1, round(base x growth x maturity))
//
// The model also backtests itself on the snapshot's listed protocols: for
// each live protocol whose category holds at least 3 other comps, it
// predicts the market cap from TVL and the peer median excluding itself,
// and reports the median absolute percentage error (MdAPE). Farm plans are
// built per row from category playbook x TVL tier x primary-chain gas tier,
// so two rows never share the same plan text with names swapped.

/** Every scoring weight and multiplier, in one block. Retune here only. */
export const CONFIG = {
  growth_weight: 0.35,
  growth_clamp_min: -50,
  growth_clamp_max: 100,
  maturity_floor: 0.7,
  maturity_range: 0.5,
  maturity_days: 1460,
  unknown_age_mult: 0.95,
  min_comps: 3,
  trim_threshold: 8,
  trim_pct: 0.1,
  airdrop_default_pct: 0.1,
  airdrop_high_pct: 0.15,
  airdrop_low_pct: 0.05,
  airdrop_high_cats: ['Dexs', 'Lending', 'Yield', 'Yield Aggregator'],
  airdrop_low_cats: ['CEX'],
  // Rough active-wallet counts by TVL tier, used only for the indicative
  // per-wallet figure in the detail view. Stated in the dashboard as the
  // entry's own assumption, never a promise.
  wallets_by_tvl_tier: [250_000, 100_000, 40_000, 15_000],
  farm_horizon_weeks: 12,
} as const;

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-comps-v1';

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

/**
 * Category median multiple. With >= 8 comps the median is trimmed: the top
 * and bottom 10% of ratios are dropped first, so one outsized listing
 * cannot drag the sector's multiple.
 */
function categoryMultiple(ratios: number[]): number {
  if (ratios.length >= CONFIG.trim_threshold) {
    const drop = Math.floor(ratios.length * CONFIG.trim_pct);
    const s = [...ratios].sort((a, b) => a - b);
    return medianOf(s.slice(drop, s.length - drop));
  }
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

/** A category's multiple: its own trimmed median when it holds >= 3 comps, else the global median. */
export function multipleFor(category: string | null, comps: CompStats): { multiple: number; comp_count: number; fallback: boolean; peers: PeerComp[] } {
  const key = category ?? 'Other';
  const entry = comps.by_category[key];
  if (entry !== undefined && entry.count >= CONFIG.min_comps) {
    return { multiple: entry.multiple, comp_count: entry.count, fallback: false, peers: entry.peers };
  }
  // Fallback pool: the whole live market's top-3 by market cap, as the audit trail.
  const allPeers = Object.values(comps.by_category)
    .flatMap((e) => e.peers)
    .sort((a, b) => b.mcap_usd - a.mcap_usd)
    .slice(0, 3)
    .map((p) => ({ name: p.name, ratio: p.ratio, mcap_usd: p.mcap_usd }));
  return { multiple: comps.global_median, comp_count: entry?.count ?? 0, fallback: true, peers: allPeers };
}

/** The self-backtest: predict each listed protocol's market cap from its TVL and its peers, excluding itself. */
export function backtest(snapshot: Snapshot, comps: CompStats): { tested: number; mdape_pct: number } {
  const live = snapshot.protocols.filter(isLiveComp);
  const byCat = new Map<string, SnapshotProtocol[]>();
  for (const p of live) {
    const key = p.category ?? 'Other';
    const list = byCat.get(key) ?? [];
    list.push(p);
    byCat.set(key, list);
  }
  const errors: number[] = [];
  for (const p of live) {
    const others = (byCat.get(p.category ?? 'Other') ?? []).filter((q) => q.slug !== p.slug);
    if (others.length < CONFIG.min_comps) continue;
    const ratios = others.map((q) => q.mcap_usd! / q.tvl_usd);
    const predicted = p.tvl_usd * categoryMultiple(ratios);
    errors.push(Math.abs(predicted - p.mcap_usd!) / p.mcap_usd!);
  }
  if (errors.length === 0) return { tested: 0, mdape_pct: 0 };
  return { tested: errors.length, mdape_pct: round4(medianOf(errors) * 100) };
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
      return `Mint ${capital} of ${name}'s yield asset on ${chain} and hold it in the farming wallet for the full horizon.${singleSided} ${framing}.`;
    case 'cex':
      return `Deposit ${capital} to ${name}, place a spot trade on ${chain} and one limit order, and keep a small balance on the venue between trades.${singleSided} ${framing}.`;
    case 'vault':
      return `Deposit ${capital} into a ${name} vault on ${chain} and keep the shares for the full horizon so the position reads as one long allocation.${singleSided} ${framing}.`;
    case 'insurance':
      return `Buy ${capital} of cover from ${name} on ${chain} and keep the policy active for the full horizon.${singleSided} ${framing}.`;
    default:
      return `Deposit ${capital} of USDC into ${name} on ${chain} and use the app's main feature once a week.${singleSided} ${framing}.`;
  }
}

/** The weekly cadence step, worded for the gas tier. */
function cadenceStep(pb: Playbook, name: string, chain: string, gas: GasTier, capital: string): string {
  const n = gas.actions_per_week;
  const cost = (gas.cost_per_tx_usd * n * 4.3).toFixed(2);
  if (gas.tier === 'expensive') {
    return `Do one qualifying action every two weeks on ${name} (${chain}) — a top-up, a borrow-and-repay, or a vote — and skip the in-between weeks: at ${gas.cost_label} a transaction, weekly churn costs more than it adds. Cost: about $${(gas.cost_per_tx_usd * 2.15).toFixed(0)} a month in gas. Time: 15 minutes every two weeks, ${CONFIG.farm_horizon_weeks} weeks.`;
  }
  if (gas.tier === 'solana') {
    return `Interact with ${name} on ${chain} about ${n} times a week — small swaps, deposits and votes — since each transaction costs ${gas.cost_label}. Cost: about $${cost} of gas over 30 days. Time: 10 minutes a week, ${CONFIG.farm_horizon_weeks} weeks.`;
  }
  const extra = pb === 'dex' ? ' Route the volume across different pairs each week.' : pb === 'yield' ? ' Move a slice between vaults once a month if a new points epoch opens.' : '';
  return `Do about ${n} qualifying actions a week on ${name} (${chain}) — deposits, swaps, votes or claims — gas is ${gas.cost_label} a transaction.${extra} Cost: about $${cost} of gas over 30 days. Time: 15 minutes a week, ${CONFIG.farm_horizon_weeks} weeks.`;
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
    `Hold the position for at least ${hold} days and open ${p.name}'s own points or rewards page once a month to check the activity is counted. Cost: no fee to check. Time: 10 minutes a month for ${CONFIG.farm_horizon_weeks} weeks.`,
    `When the horizon ends, claim only from the link ${p.name} itself publishes, never pay to claim, and write the wallet, dates and every transaction in a farm log before you unwind. Cost: one exit transaction at ${gas.cost_label}. Time: 15 minutes.`,
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
    category_multiple: number;
    comp_count: number;
    comps_fallback: boolean;
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
  watchlist_size: number;
  board_size: number;
  live_size: number;
  comps: CompStats;
  backtest: { tested: number; mdape_pct: number };
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

/**
 * The protocols the board ranks, strongest first, with ranks 1..n.
 * Every pre-token protocol in the snapshot is ranked: the watchlist is the
 * floor, and the board covers all 342 pre-token protocols.
 */
export function buildBoard(snapshot: Snapshot, comps: CompStats): BoardRow[] {
  const preTokenProtocols = snapshot.protocols.filter(isPreToken);
  const watch = new Set(snapshot.watchlist);
  const preTokenList = preTokenProtocols.map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const { multiple, comp_count, fallback, peers } = multipleFor(p.category, comps);
    const growthPct = p.change_7d === null ? 0 : Math.min(CONFIG.growth_clamp_max, Math.max(CONFIG.growth_clamp_min, p.change_7d));
    const growthMult = p.change_7d === null ? 1 : 1 + (growthPct / 100) * CONFIG.growth_weight;
    const maturityMult = age === null ? CONFIG.unknown_age_mult : CONFIG.maturity_floor + (Math.min(Math.max(age, 0), CONFIG.maturity_days) / CONFIG.maturity_days) * CONFIG.maturity_range;
    const base = p.tvl_usd * multiple;
    const estFdv = Math.max(1, Math.round(base * growthMult * maturityMult));
    return { p, age, multiple, comp_count, fallback, peers, growthMult, maturityMult, base, estFdv };
  });

  // Automated verification, in the model's own terms.
  console.assert(preTokenList.length === 342, "Harus tepat 342 protokol!");
  console.assert(preTokenList.every(p => Number.isFinite(p.estFdv) && p.estFdv > 0), "Ada valuasi invalid!");
  if (preTokenList.length !== 342) throw new Error(`token radar: expected 342 pre-token protocols, found ${preTokenList.length}`);
  if (!preTokenList.every((s) => Number.isFinite(s.estFdv) && s.estFdv > 0)) throw new Error('token radar: a row has an invalid implied value');
  const missingWatch = snapshot.watchlist.filter((s) => !bySlug(snapshot.protocols).has(s));
  if (missingWatch.length > 0) throw new Error(`token radar: watchlist slugs missing from the snapshot: ${missingWatch.join(', ')}`);

  // Floor estimate for a row with no positive TVL (the snapshot floors at
  // $5M, so this should not occur): the category's median implied value.
  const byCatImplied = new Map<string, number[]>();
  for (const s of preTokenList) {
    if (s.p.tvl_usd <= 0) continue;
    const key = s.p.category ?? 'Other';
    const list = byCatImplied.get(key) ?? [];
    list.push(s.estFdv);
    byCatImplied.set(key, list);
  }
  const allImplied = preTokenList.filter((s) => s.p.tvl_usd > 0).map((s) => s.estFdv);
  for (const s of preTokenList) {
    if (s.p.tvl_usd > 0) continue;
    const catVals = byCatImplied.get(s.p.category ?? 'Other');
    s.estFdv = catVals !== undefined && catVals.length > 0 ? Math.round(medianOf(catVals)) : Math.round(medianOf(allImplied));
  }

  preTokenList.sort((a, b) => b.estFdv - a.estFdv || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return preTokenList.map((s, i) => {
    const sharePct = airdropSharePct(s.p.category);
    const pool = Math.round(s.estFdv * sharePct);
    const wallets = CONFIG.wallets_by_tvl_tier[tvlTier(s.p.tvl_usd)];
    const perWallet = Math.round((pool / wallets) * 100) / 100;
    const plan = farmPlan(s.p, s.age, perWallet);
    const floorEstimate = s.p.tvl_usd <= 0;
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
        category_multiple: s.multiple,
        comp_count: s.comp_count,
        comps_fallback: s.fallback,
        peers: s.peers,
        base_usd: Math.round(s.base),
        growth_multiplier: round4(s.growthMult),
        maturity_multiplier: round4(s.maturityMult),
        floor_estimate: floorEstimate,
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
  const board = buildBoard(snapshot, comps);
  const live = liveRows(snapshot);
  const bt = backtest(snapshot, comps);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    config: CONFIG,
    total_protocols: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    comps,
    backtest: bt,
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
