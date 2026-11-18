// Token Radar's model: one sealed snapshot in, one ranked board out.
//
// The board ranks protocols that record no token yet. Every watchlist slug is on it (the floor,
// never the ceiling), plus the strongest further candidates the same screen finds anywhere in the
// snapshot. Protocols whose token already trades are never ranked: they are carried separately,
// at the market's own values, for the dashboard's "already trading" view.
//
// THE VALUE MODEL (peer-anchored, snapshot-only)
// ----------------------------------------------
// A token that does not exist has no price, so the model borrows one from the protocols whose
// tokens do trade, inside the same snapshot:
//
//   implied = TVL x peerMultiple(category) x momentum x maturity x breadth
//
// - peerMultiple(category): for every tokenised protocol in the snapshot, the ratio
//   mcap_usd / tvl_usd is what the market actually pays per dollar of TVL. The category's
//   multiple is the median of its peers' ratios, shrunk toward the global median with weight
//   PEER_SHRINK (a category with one loud peer mostly inherits the market-wide figure), then
//   clamped to [MULTIPLE_MIN, MULTIPLE_MAX] so no thin category prices a protocol at an absurd
//   figure. Exchange (CEX) records are left out of the peer set: an exchange token is not priced
//   on protocol TVL. A category with no tokenised peer uses the global median.
// - momentum: the 7-day TVL change, clamped to [-40, +60] percent, moves the value by
//   MOMENTUM_WEIGHT of itself: a protocol adding TVL fast is worth more than its static TVL
//   says, and one bleeding TVL less. Unreported change is neutral.
// - maturity: days since DefiLlama first tracked the protocol (listed_at to the snapshot's
//   as_of). A launch priced after years of tokenless operation rests on a longer record than
//   one priced after a month, so the factor rises smoothly from MATURITY_FLOOR to
//   MATURITY_FLOOR + MATURITY_SPAN over MATURITY_DAYS days. An unknown listing day is scored
//   at UNKNOWN_AGE_DAYS, below the middle, never at the top.
// - breadth: each extra chain is distribution a launch can reach, worth a mild
//   BREADTH_WEIGHT x ln(1 + chains), capped so a chain count alone cannot carry a row.
//
// The formula is smooth and, inside a category, monotone in TVL: two protocols of one category
// with the same growth, age and chains rank exactly as their TVLs do. No protocol's name is
// special-cased anywhere: one function scores every row, and the dashboard shows each row's
// own arithmetic.

/** One protocol record: exactly the ten fields the sealed snapshot carries. */
export interface SnapProtocol {
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

/** The snapshot document as the model reads it. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapProtocol[];
  watchlist: string[];
}

/** The model's constants, printed on the dashboard so a reader can re-derive any row. */
export const MODEL = {
  version: 'peer-anchor-1',
  shrink_weight: 8, // pseudo-count of global-median peers blended into every category median
  multiple_min: 0.03,
  multiple_max: 1.6,
  ratio_min: 0.005, // single-peer ratios are clamped to this band before any median is taken
  ratio_max: 10,
  momentum_weight: 0.6,
  momentum_floor_pct: -40,
  momentum_cap_pct: 60,
  maturity_floor: 0.8,
  maturity_span: 0.35,
  maturity_days: 1460,
  unknown_age_days: 270,
  breadth_weight: 0.05,
  breadth_chain_cap: 24,
};

/** How many early (non-watchlist) candidates the board carries at most. */
export const EARLY_CAP = 150;

/** How many already-trading protocols the dashboard's live view carries. */
export const LIVE_CAP = 28;

/** The value model's full arithmetic for one protocol, kept on the row for the detail view. */
export interface Breakdown {
  peer_multiple: number;
  peer_count: number;
  category_median: number | null;
  momentum_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  age_days: number | null;
}

/** One row of board.json. Extra keys beyond the gate's five are the dashboard's to use. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  model: Breakdown;
  farm_steps: string[];
}

/** A protocol whose token already trades: shown at the market's value, never ranked. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

/** A category's peer evidence, for the dashboard's model panel. */
export interface CategoryStat {
  category: string;
  peers: number;
  median: number | null;
  multiple: number;
}

/** Everything data.js hands the dashboard. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: typeof MODEL;
  global_median: number;
  peer_protocols: number;
  categories: CategoryStat[];
  scanned: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: (BoardRow & { farm_steps: string[] })[];
  live: LiveRow[];
}

/** Why a snapshot cannot be scored. */
export class SnapshotError extends Error {}

const DAY_MS = 86_400_000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** Whole days from listed_at to as_of; null when the listing day is absent or unparseable. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A token is recorded when any of the three token fields is present. */
export function recordsToken(p: SnapProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null || p.mcap_usd !== null;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

/** The peer evidence: per-category mcap/TVL medians from the snapshot's tokenised protocols. */
export function peerStats(snapshot: Snapshot): { globalMedian: number; peerCount: number; byCategory: Map<string, { peers: number; median: number | null; multiple: number }> } {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (!recordsToken(p) || p.mcap_usd === null || p.tvl_usd <= 0) continue;
    if (p.category === 'CEX') continue; // an exchange token is not priced on protocol TVL
    const ratio = clamp(p.mcap_usd / p.tvl_usd, MODEL.ratio_min, MODEL.ratio_max);
    all.push(ratio);
    const key = p.category ?? '(uncategorised)';
    const list = ratiosByCategory.get(key) ?? [];
    list.push(ratio);
    ratiosByCategory.set(key, list);
  }
  const globalMedian = all.length > 0 ? median(all) : 0.2;
  const byCategory = new Map<string, { peers: number; median: number | null; multiple: number }>();
  for (const [category, ratios] of ratiosByCategory) {
    const med = median(ratios);
    const shrunk = (ratios.length * med + MODEL.shrink_weight * globalMedian) / (ratios.length + MODEL.shrink_weight);
    byCategory.set(category, { peers: ratios.length, median: med, multiple: clamp(shrunk, MODEL.multiple_min, MODEL.multiple_max) });
  }
  return { globalMedian, peerCount: all.length, byCategory };
}

/** Score one pre-token protocol: the implied value and every factor that produced it. */
export function score(p: SnapshotProtocol, asOf: string, peers: ReturnType<typeof peerStats>): { implied: number; model: Breakdown } {
  const stat = peers.byCategory.get(p.category ?? '(uncategorised)');
  const multiple = stat?.multiple ?? clamp(peers.globalMedian, MODEL.multiple_min, MODEL.multiple_max);
  const growthPct = p.change_7d === null ? 0 : clamp(p.change_7d, MODEL.momentum_floor_pct, MODEL.momentum_cap_pct);
  const momentum = 1 + (growthPct / 100) * MODEL.momentum_weight;
  const age = ageInDays(asOf, p.listed_at);
  const ageForModel = age ?? MODEL.unknown_age_days;
  const maturity = MODEL.maturity_floor + (clamp(ageForModel, 0, MODEL.maturity_days) / MODEL.maturity_days) * MODEL.maturity_span;
  const breadth = 1 + MODEL.breadth_weight * Math.log(1 + Math.min(p.chains.length, MODEL.breadth_chain_cap));
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * momentum * maturity * breadth));
  return {
    implied,
    model: {
      peer_multiple: round4(multiple),
      peer_count: stat?.peers ?? 0,
      category_median: stat?.median === null || stat?.median === undefined ? null : round4(stat.median),
      momentum_multiplier: round4(momentum),
      maturity_multiplier: round4(maturity),
      breadth_multiplier: round4(breadth),
      age_days: age,
    },
  };
}

// ------------------------------------------------------------------ the screen

/** Categories that are a product of another protocol or an exchange, not a launch of their own. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** A name ending in a release marker is one version of another protocol. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Whole words that mark a wrapped or staked product of a token that already trades. */
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;
/** Names that open with an exchange's name are that exchange's product. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/**
 * Whether a protocol the watchlist does not name is still a launch candidate: it records no
 * token, and it is not a wrapped, staked, bridged or exchange product of one that trades. This
 * is the watchlist's own screen, applied past the floor: the radar's job is finding the early
 * ones, not re-ranking the market's plumbing.
 */
export function isCandidate(p: SnapProtocol): boolean {
  if (recordsToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name) || PRODUCT_WORD.test(p.name) || EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

// ------------------------------------------------------------------ the board

/** Build the ranked board and everything the dashboard renders. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const peers = peerStats(snapshot);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watch = new Set(snapshot.watchlist);

  const chosen = new Map<string, SnapProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isCandidate(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, EARLY_CAP);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, ...score(p, snapshot.as_of, peers) }));
  scored.sort((a, b) => b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    on_watchlist: watch.has(s.p.slug),
    implied_value_usd: s.implied,
    model: s.model,
    farm_steps: farmPlan(s.p, s.model.age_days),
  }));

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => recordsToken(p) && p.mcap_usd !== null && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_CAP)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd!, change_7d: p.change_7d }));

  const categories: CategoryStat[] = [...peers.byCategory.entries()]
    .map(([category, s]) => ({ category, peers: s.peers, median: s.median === null ? null : round4(s.median), multiple: round4(s.multiple) }))
    .sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1));

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: MODEL,
    global_median: round4(peers.globalMedian),
    peer_protocols: peers.peerCount,
    categories,
    scanned: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.on_watchlist).length,
    live_size: live.length,
    rows: board,
    live,
  };
  return { board, radar };
}

// ------------------------------------------------------------------ farm plans

/** A tiny deterministic hash of a slug, so wording varies by protocol but never between runs. */
function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pick = <T,>(slug: string, salt: number, options: readonly T[]): T => options[hashOf(`${slug}:${salt}`) % options.length]!;

/** Chains where a qualifying action costs real money in gas, and chains where it barely does. */
const COSTLY_CHAINS = new Set(['Ethereum', 'Bitcoin', 'Arbitrum', 'Optimism']);

/** The gas budget line for working on a chain, in dollars a farmer should expect to spend. */
function gasLine(chain: string): string {
  if (chain === 'Ethereum') return 'about $10-18 in mainnet gas across the setup transactions';
  if (chain === 'Bitcoin') return 'about $2-4 in network fees across the setup transactions';
  if (COSTLY_CHAINS.has(chain)) return 'about $2-5 in gas across the setup transactions';
  if (chain === 'Solana') return 'under $0.25 in fees across the setup transactions';
  return 'about $0.50-2 in gas across the setup transactions';
}

/** The position size the plan works with, scaled to the protocol's own TVL tier. */
function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 1000;
  if (tvl >= 250_000_000) return 500;
  if (tvl >= 50_000_000) return 250;
  return 100;
}

/** How long a position must season before it reads as a real user's, from the protocol's age. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 540) return 45;
  return 30;
}

type Family = 'dex' | 'lending' | 'derivatives' | 'restaking' | 'staking' | 'vault' | 'rwa' | 'payments' | 'insurance' | 'chain' | 'stable' | 'generic';

/** The working family a category belongs to; the plan's verbs follow it. */
function familyOf(category: string | null): Family {
  const c = (category ?? '').toLowerCase();
  if (c.includes('dex')) return 'dex';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) return 'derivatives';
  if (c.includes('restak') || c.includes('collateral market')) return 'restaking';
  if (c.includes('staking pool') || c === 'staking') return 'staking';
  if (c.includes('lend') || c.includes('cdp')) return 'lending';
  if (c.includes('rwa')) return 'rwa';
  if (c.includes('payment')) return 'payments';
  if (c.includes('insurance')) return 'insurance';
  if (c.includes('stable') || c.includes('cdp')) return 'stable';
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('basis')) return 'vault';
  if (c === 'chain') return 'chain';
  return 'generic';
}

/** The two core on-protocol actions of a plan, in the family's own verbs. */
function coreActions(family: Family, name: string, chain: string, capital: number, slug: string): [string, string] {
  switch (family) {
    case 'dex':
      return [
        `Add $${capital} of paired liquidity (for example $${Math.round(capital / 2)} of ETH against $${Math.round(capital / 2)} of USDC) to ${name}'s deepest pool on ${chain}, and leave the LP position untouched.`,
        pick(slug, 2, [
          `Route at least $300 of swaps a week through ${name} on ${chain}, split across three or more days, so the wallet reads as a trader and not a one-off.`,
          `Make two swaps a week on ${name} totalling $250 or more, varying the pairs, and claim any fee or points credit the interface shows.`,
        ]),
      ];
    case 'lending':
      return [
        `Supply $${capital} of USDC to ${name} on ${chain} as lending collateral and keep the supply in place; do not withdraw inside the first month.`,
        `Borrow about $${Math.round(capital * 0.4)} of a second stablecoin against the supply, redeposit it once, and hold the loop at under 45% loan-to-value so a bad week cannot liquidate it.`,
      ];
    case 'derivatives':
      return [
        `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position (long spot elsewhere, short here) so the account carries open interest without directional risk.`,
        `Trade at least $1,000 of notional a week on ${name} in two or more sessions, and keep the margin account funded above $${Math.round(capital * 0.6)} at all times.`,
      ];
    case 'restaking':
      return [
        `Deposit $${capital} of ETH or a liquid staking token into ${name} on ${chain} and keep the restaked position and its receipt token in the wallet.`,
        pick(slug, 2, [
          `Opt the position into one of ${name}'s operator sets or vaults when the app offers it, and leave the delegation unchanged for the full holding period.`,
          `Add a second smaller deposit of $${Math.round(capital * 0.25)} after two weeks, so the wallet shows recurring use rather than a single airdrop-sized entry.`,
        ]),
      ];
    case 'staking':
      return [
        `Stake $${capital} of the chain's native asset through ${name} and keep the staking receipt in the wallet for the whole period.`,
        `Claim and re-stake the rewards once a month, and vote or delegate with the position if ${name} offers governance from the staking page.`,
      ];
    case 'vault':
      return [
        `Deposit $${capital} of USDC into ${name}'s flagship vault on ${chain} and keep the vault shares; curator and allocator vaults score the wallets that stay, not the ones that rotate.`,
        pick(slug, 2, [
          `Split a second $${Math.round(capital * 0.5)} across one more of ${name}'s vaults on a different chain it serves, so the wallet appears in more than one of its markets.`,
          `Top the position up by $${Math.round(capital * 0.25)} after the first month rather than entering once, and never let the share balance sit at zero between deposits.`,
        ]),
      ];
    case 'rwa':
      return [
        `Subscribe $${capital} into ${name}'s yield product on ${chain}, complete any eligibility check the app requires, and hold the issued asset.`,
        `Keep the position to its first full distribution or interest period, and reinvest the payout once so the wallet shows a second on-protocol transaction.`,
      ];
    case 'payments':
      return [
        `Fund the wallet with $${capital} and route two real payments or transfers a week through ${name}, keeping each one small and ordinary.`,
        `Hold a working balance of about $${Math.round(capital * 0.5)} in ${name} between payments instead of sweeping it out after each use.`,
      ];
    case 'insurance':
      return [
        `Buy $${capital} of cover on a position you actually hold through ${name}, and keep the policy to its full term.`,
        `Underwrite a small $${Math.round(capital * 0.5)} share of one of ${name}'s cover pools if the app offers it, and leave it through one full epoch.`,
      ];
    case 'chain':
      return [
        `Bridge $${capital} of working funds onto ${name}'s chain and keep them there; a chain's own launch maths rewards wallets that stay native.`,
        `Make at least three transactions a week on the chain across two or more of its apps (a swap, a lend and a transfer), so the wallet reads as a resident, not a visitor.`,
      ];
    case 'stable':
      return [
        `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}, against collateral the app accepts, and hold the stablecoin in the wallet.`,
        `Use the stablecoin once a week inside ${name}'s own ecosystem (a payment, a pool deposit or a transfer) rather than only holding it idle.`,
      ];
    default:
      return [
        `Deposit $${capital} of USDC into ${name} on ${chain} through its main app and keep the position open.`,
        `Repeat one qualifying action a week inside ${name} (a deposit, a swap, a claim or a vote), always from the same wallet.`,
      ];
  }
}

/**
 * One protocol's farm plan: six steps, each naming the protocol, its chain, real amounts, a
 * dollar cost and a time. The plan is generated from the protocol's category, chains, TVL tier
 * and age; two protocols of one family differ in wording, amounts and cadence, never in honesty:
 * every step is an action a farmer can actually take this week.
 */
export function farmPlan(p: SnapProtocol, age: number | null): string[] {
  const family = familyOf(p.category);
  const chain = p.chains[0] ?? 'its home chain';
  const others = p.chains.slice(1, 4);
  const chainList = others.length > 0 ? `; ${p.name} also runs on ${others.join(', ')}${p.chains.length > 4 ? ` and ${p.chains.length - 4} further chains` : ''}` : '';
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const weeks = Math.max(4, Math.round(hold / 7));
  const [core1, core2] = coreActions(family, p.name, chain, capital, p.slug);
  const gas = gasLine(chain);
  const steps = [
    `Set up one fresh wallet for ${p.name} alone and fund it on ${chain} with the $${capital} working position plus gas money${chainList}. Keep the seed phrase offline. Cost: ${gas}. Time: about 20 minutes, once.`,
    `${core1} Cost: the $${capital} position plus gas. Time: about 15 minutes to place.`,
    `${core2} Cost: included in the position above, plus about $${family === 'derivatives' || family === 'dex' ? 6 : 3} a week in fees and gas. Time: 10 minutes a week.`,
    pick(p.slug, 4, [
      `Keep the weekly rhythm for ${weeks} weeks: one qualifying action on ${p.name} every week, on varying days, and log each transaction hash in a simple farm diary. Cost: about $2 a week in gas. Time: 10 minutes a week.`,
      `Stay active on ${p.name} for ${weeks} straight weeks, repeating the core action weekly and never letting a calendar month pass with no transaction. Cost: about $2 a week in gas. Time: 10 minutes a week.`,
    ]),
    pick(p.slug, 5, [
      `Check ${p.name}'s own points, rewards or quests page every Sunday and finish any listed task the wallet qualifies for, including Galxe or Zealy quests only when the protocol's own page links them. Cost: nothing to check; never pay a third party to "unlock" a claim. Time: 15 minutes a week.`,
      `Open ${p.name}'s rewards or points page weekly; if it runs quests on Galxe, Zealy or Layer3, do the ones your existing position already satisfies before adding any new spend. Cost: nothing beyond gas already budgeted. Time: 15 minutes a week.`,
    ]),
    `Hold the position for at least ${hold} days so it spans several of the snapshots protocols use to weigh wallets, then unwind in two steps a week apart rather than in one exit. Risk note: this is unaudited-launch farming — keep the position money you can afford to lose to a contract bug, and re-check ${p.name}'s own page before any claim. Cost: exit gas only. Time: ${hold} days in total.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

// ------------------------------------------------------------------ input and the gate's shape

/** Parse and validate the snapshot's text; throws SnapshotError with the reason. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json carries no as_of date');
  if (typeof o.source !== 'string' || o.source.length === 0) throw new SnapshotError('snapshot.json carries no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json carries no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json carries no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json carries no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
    return {
      slug: p.slug,
      name: p.name,
      category: str(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: num(p.change_7d),
      mcap_usd: num(p.mcap_usd),
      listed_at: str(p.listed_at),
      gecko_id: str(p.gecko_id),
      symbol: str(p.symbol),
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board fails the gate's shape, or null: coverage, ranks, ordering, value spread, steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `${r.slug} appears twice`;
    seen.add(r.slug);
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return `rank ${i + 1} is held by ${byRank[i]!.slug} with rank ${byRank[i]!.rank}`;
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `${byRank[i]!.slug} outranks ${byRank[i - 1]!.slug} on implied value`;
  }
  if (board.length >= 2 && board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) return 'every row carries the same implied value';
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** The dashboard's data as one script: window.RADAR, no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
