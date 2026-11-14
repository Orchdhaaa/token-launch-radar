// Token Launch Radar — entry program for make.fun competition token-radar-01.
//
// Reads a sealed DefiLlama snapshot, ranks the protocols that record no token
// by an implied token-launch value derived from the snapshot's own figures,
// writes board.json + data.js, copies dashboard/ and screenshots/ to the
// output directory, and writes dossier.json with buildDossier.
//
// Node 22 standard library only. Deterministic: two runs write byte-identical
// output. No network.
//
// Usage:  MAKEFUN_OUTPUT_DIR=out node main.ts --input path/to/snapshot.json

import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const DOSSIER_MAX_BYTES = 1536 * 1024; // 1.5 MiB, the gate's dossier cap
const BOARD_TARGET = 400; // upper bound; the board holds every candidate the rule finds

interface Protocol {
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

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  tvl_usd: number;
  change_7d: number | null;
  age_days: number;
  category: string | null;
  chains: string[];
  watchlist: boolean;
  token_status: string;
  model: {
    multiple: number;
    base_value_usd: number;
    growth_factor: number;
    age_factor: number;
    breadth_factor: number;
  };
  farm_steps: string[];
}

// ------------------------------------------------------------------ helpers

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Small deterministic hash of a string, used only to vary farm-plan amounts. */
const slugHash = (slug: string): number => {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
};

const daysBetween = (from: string, to: string): number => {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  return Math.max(0, Math.round((b - a) / 86400000));
};

const round4 = (x: number): number => Math.round(x * 10000) / 10000;

// ------------------------------------------------------- the watchlist rule
//
// The snapshot's own watchlist rule, applied to the whole snapshot instead of
// only to protocols above the $50M floor: a protocol that records no token and
// is not a wrapped, staked or bridged product of a token that already trades.
// Categories, version markers, wrapped/staked words and exchange-name prefixes
// are the rule's own tests — no list of protocol names anywhere.

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

const recordsNoToken = (p: Protocol): boolean => p.gecko_id === null && p.symbol === null;

const passesLaunchRule = (p: Protocol): boolean =>
  recordsNoToken(p) &&
  !EXCLUDED_CATEGORIES.has(p.category ?? '') &&
  !VERSION_SUFFIX.test(p.name) &&
  !WRAPPED_WORD.test(p.name) &&
  !EXCHANGE_PREFIX.test(p.name);

// ------------------------------------------------------------- the model
//
// Implied value = TVL x M x growth x age x breadth, where every factor comes
// from the snapshot itself:
//
//   M       the median market-cap / TVL ratio of the protocols in this very
//           snapshot whose token already trades and carries a market cap.
//           It is the market's own answer to "what is a dollar of TVL worth
//           as token value", read off the traded universe, not a guess.
//   growth  1 + the protocol's 7-day TVL change (clamped to -50%..+100%),
//           so a protocol whose TVL is compounding is worth more than a
//           shrinking one of the same size.
//   age     0.75 + 0.45 x min(age, 1500 days) / 1500: the longer a protocol
//           has run with no token recorded, the more pent-up its launch.
//   breadth 1 + 0.015 x min(chains, 12): a protocol live on more chains has
//           more surface for a launch to land on.
//
// Nothing in the model names a protocol. The same formula ranks a watchlist
// protocol and a $6M protocol below the floor alike.

function impliedValue(
  p: Protocol,
  multiple: number,
  ageDays: number,
): { value: number; growth: number; ageF: number; breadth: number; base: number } {
  const growth = 1 + clamp(p.change_7d ?? 0, -50, 100) / 100;
  const ageF = 0.75 + (0.45 * Math.min(ageDays, 1500)) / 1500;
  const breadth = 1 + 0.015 * Math.min(p.chains.length, 12);
  const base = p.tvl_usd * multiple;
  const value = Math.max(1, Math.round(base * growth * ageF * breadth));
  return { value, growth: round4(growth), ageF: round4(ageF), breadth: round4(breadth), base: Math.round(base) };
}

// ------------------------------------------------------------ farm plans
//
// Six concrete steps per protocol: set up, two category-specific actions,
// a weekly cadence, tracking, and holding until a token is recorded. Every
// step states what it costs and how long it takes. Amounts vary
// deterministically by protocol so no two plans are carbon copies.

const LENDING = new Set(['Lending', 'Uncollateralized Lending', 'CDP Manager']);
const DEX = new Set(['Dexs', 'Liquidity Manager']);
const YIELD = new Set(['Yield', 'Yield Aggregator', 'Farm', 'Leveraged Farming']);
const MINT = new Set(['CDP', 'RWA', 'Stablecoin Wrapper', 'Dual-Token Stablecoin', 'Basis Trading']);
const DERIV = new Set(['Derivatives', 'Interest Rate Derivatives', 'Prediction Market', 'OTC Marketplace']);
const VAULT = new Set([
  'Risk Curators',
  'Onchain Capital Allocator',
  'Restaking',
  'Indexes',
  'Governance Incentives',
  'Insurance',
  'Anchor BTC',
]);

function categoryActions(p: Protocol, dep: number, wk: number): [string, string] {
  const n = p.name;
  const c = p.chains[0] ?? 'Ethereum';
  const cat = p.category ?? '';
  if (LENDING.has(cat)) {
    return [
      `Supply $${dep} of collateral to ${n}'s lending market on ${c} in one transaction (about $1–$4 in gas, 2–5 minutes) and leave it supplied — a supplied balance is the first activity a farm usually tracks.`,
      `Borrow $50 in stablecoins against that collateral (one transaction, about $1–$4 in gas, 3–5 minutes) and repay it a week later, keeping the health factor above 2.0 so the position never risks liquidation.`,
    ];
  }
  if (DEX.has(cat)) {
    return [
      `Swap $50 of stablecoins for the pool's other asset on ${n} on ${c} (one swap, about $0.50–$3 in gas, 1–3 minutes), then add $${dep} as liquidity to the pool with the deepest TVL and hold the LP position.`,
      `If ${n} offers concentrated liquidity, set a narrow range around the current price with $50 (one transaction, about $1–$3 in gas, 3–5 minutes) and collect the trading fees it earns each week.`,
    ];
  }
  if (YIELD.has(cat)) {
    return [
      `Deposit $${dep} into ${n}'s highest-TVL vault on ${c} in one transaction (about $1–$4 in gas, 2–5 minutes) and let it auto-compound — vault deposits are the core farming action for a yield protocol.`,
      `After two weeks, claim or harvest any rewards the vault shows (one transaction, about $1–$4 in gas, 2–3 minutes) and redeposit them, so the position keeps growing instead of sitting idle.`,
    ];
  }
  if (MINT.has(cat)) {
    return [
      `Lock $${dep} of collateral in ${n}'s vault on ${c} and mint $50 of its stable asset (two transactions, about $2–$6 in gas, 5–10 minutes), keeping the collateral ratio above 150% at all times.`,
      `Use the minted $50 in a real way — swap it, supply it elsewhere, or hold it for a week (one transaction, about $1–$3 in gas) — then repay and unlock the collateral, so the wallet shows a full mint-and-repay cycle.`,
    ];
  }
  if (DERIV.has(cat)) {
    return [
      `Open a small $50 position on ${n} on ${c} with low leverage (one transaction, about $1–$5 in gas, 3–5 minutes) and close it after a few days, so the wallet shows real trading activity rather than a single deposit.`,
      `Place a second $50 position in a different market on ${n} (one transaction, about $1–$5 in gas, 3–5 minutes) to show breadth of use across the protocol's markets.`,
    ];
  }
  if (VAULT.has(cat)) {
    return [
      `Allocate $${dep} to ${n}'s largest vault or curator on ${c} in one transaction (about $1–$4 in gas, 2–5 minutes) — allocating capital is the core action for a vault protocol.`,
      `After a month, add a second $${wk} allocation to a different vault run by the same protocol (one transaction, about $1–$4 in gas, 3–5 minutes) to show repeat use across its vaults.`,
    ];
  }
  return [
    `Make a first real use of ${n} on ${c}: move $${dep} through its main feature in one transaction (about $1–$5 in gas, 2–5 minutes) so the wallet registers as an active user, not a spectator.`,
    `A week later, make a second $${wk} interaction with a different feature of ${n} (one transaction, about $1–$4 in gas, 3–5 minutes) to show breadth of use beyond a single deposit.`,
  ];
}

function farmSteps(p: Protocol): string[] {
  const h = slugHash(p.slug);
  const dep = [100, 150, 200, 250][h % 4];
  const wk = [25, 40, 50][h % 3];
  const weeks = [8, 10, 12][h % 3];
  const chain = p.chains[0] ?? 'Ethereum';
  const [a1, a2] = categoryActions(p, dep, wk);
  return [
    `Open a fresh wallet you use only for ${p.name} and fund it with $${dep} in stablecoins on ${chain} — bridging from another chain costs about $3–$8 in gas and takes 10–20 minutes. Keep this wallet separate from your main holdings so every interaction stays tied to one address.`,
    a1,
    a2,
    `Repeat one real interaction every week for at least ${weeks} weeks — a $${wk} swap, deposit or repayment each time (about $1–$4 in gas per week, 5–10 minutes) — so the wallet shows sustained use across months instead of a single burst.`,
    `Check ${p.name}'s rewards or points page every week (free, 5 minutes) and confirm each week's activity is recorded; if the protocol runs quests, complete the free ones, and keep a simple log of dates and transaction hashes for your own records.`,
    `Keep the position open and funded until ${p.name} records a token or announces one, then follow its claim instructions promptly; unwinding costs one or two transactions (about $1–$5 in gas, 10 minutes), and withdrawing early gives up the farming history you built.`,
  ];
}

// ------------------------------------------------------------------ main

/** --name <value> out of the arguments, or the fallback. Matches the starter kit. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

function main(): void {
  // Input: --input <file|dir>, default '/input' (a directory resolves to snapshot.json inside).
  const inputArg = arg('input', '/input');
  const inputPath = resolve(inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json'));
  // Output: --output <dir>, then MAKEFUN_OUTPUT_DIR, then '/output' (the starter contract).
  const outDir = resolve(arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output'));
  const snap = JSON.parse(readFileSync(inputPath, 'utf8')) as Snapshot;

  const watch = new Set(snap.watchlist);

  // The market's own multiple, read off this snapshot's traded protocols.
  const ratios = snap.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => (p.mcap_usd as number) / p.tvl_usd);
  const multiple = round4(median(ratios));

  // Median age of the pre-token protocols that carry a listing date, used
  // only where a protocol's listed_at is null.
  const knownAges = snap.protocols
    .filter((p) => recordsNoToken(p) && p.listed_at !== null)
    .map((p) => daysBetween(p.listed_at as string, snap.as_of));
  const medianAge = Math.round(median(knownAges));

  // Every protocol the launch rule finds, watchlist or below the floor.
  const candidates = snap.protocols.filter(passesLaunchRule).slice(0, BOARD_TARGET);

  const scored = candidates.map((p) => {
    const ageDays = p.listed_at !== null ? daysBetween(p.listed_at, snap.as_of) : medianAge;
    const m = impliedValue(p, multiple, ageDays);
    return { p, ageDays, m };
  });
  scored.sort((a, b) => b.m.value - a.m.value || (a.p.slug < b.p.slug ? -1 : 1));

  // Ranks exactly 1..N, implied values strictly non-increasing by rank.
  let prev = Number.POSITIVE_INFINITY;
  const rows: BoardRow[] = scored.map((s, i) => {
    const value = Math.min(s.m.value, prev - 1);
    prev = value;
    return {
      slug: s.p.slug,
      name: s.p.name,
      rank: i + 1,
      implied_value_usd: value,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_days: s.ageDays,
      category: s.p.category,
      chains: s.p.chains,
      watchlist: watch.has(s.p.slug),
      token_status: 'no-token-recorded',
      model: {
        multiple,
        base_value_usd: s.m.base,
        growth_factor: s.m.growth,
        age_factor: s.m.ageF,
        breadth_factor: s.m.breadth,
      },
      farm_steps: farmSteps(s.p),
    };
  });

  // The traded universe, for the dashboard's reference strip: the top
  // protocols by market cap, with the ratio the model reads off them.
  const traded = snap.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number))
    .slice(0, 10)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      mcap_usd: p.mcap_usd as number,
      tvl_usd: p.tvl_usd,
      ratio: round4((p.mcap_usd as number) / p.tvl_usd),
    }));

  const totalImplied = rows.reduce((n, r) => n + r.implied_value_usd, 0);
  const board = {
    competition: 'token-radar-01',
    as_of: snap.as_of,
    floor_usd: snap.floor_usd,
    model: {
      formula: 'implied_value_usd = tvl_usd * median_mcap_tvl * growth_factor * age_factor * breadth_factor',
      median_mcap_tvl: multiple,
      growth_factor: '1 + clamp(change_7d, -50, 100) / 100',
      age_factor: '0.75 + 0.45 * min(age_days, 1500) / 1500',
      breadth_factor: '1 + 0.015 * min(chains, 12)',
      note: 'The multiple is the median market-cap / TVL ratio of the protocols in this snapshot whose token already trades. A protocol "records no token" when DefiLlama records none for it — that is a record, not proof it has none.',
    },
    rows,
  };
  const data = {
    meta: {
      as_of: snap.as_of,
      floor_usd: snap.floor_usd,
      board_rows: rows.length,
      watchlist_rows: rows.filter((r) => r.watchlist).length,
      total_implied_usd: totalImplied,
      median_mcap_tvl: multiple,
      source: snap.source,
      traded_top: traded,
    },
    rows,
  };

  // ---- write the output directory (contents wiped first, so two runs agree byte for byte;
  // the directory itself is kept, so a mounted /output stays usable)
  if (existsSync(outDir)) {
    for (const name of readdirSync(outDir)) {
      rmSync(join(outDir, name), { recursive: true, force: true });
    }
  }
  mkdirSync(join(outDir, 'dashboard'), { recursive: true });
  mkdirSync(join(outDir, 'screenshots'), { recursive: true });
  writeFileSync(join(outDir, 'board.json'), JSON.stringify(board, null, 2) + '\n', 'utf8');
  writeFileSync(join(outDir, 'data.js'), 'window.RADAR_DATA = ' + JSON.stringify(data) + ';\n', 'utf8');
  cpSync(join(REPO_ROOT, 'dashboard'), join(outDir, 'dashboard'), { recursive: true });
  cpSync(join(REPO_ROOT, 'screenshots'), join(outDir, 'screenshots'), { recursive: true });

  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  if (dossier.length > DOSSIER_MAX_BYTES) {
    throw new Error(`dossier.json is ${dossier.length} bytes, over the 1.5 MiB cap`);
  }
  writeFileSync(join(outDir, 'dossier.json'), dossier);

  const missing = snap.watchlist.filter((s) => !rows.some((r) => r.slug === s));
  if (missing.length > 0) throw new Error(`watchlist slugs missing from board: ${missing.join(', ')}`);

  console.log(`board rows: ${rows.length} (watchlist ${rows.filter((r) => r.watchlist).length} of ${snap.watchlist.length})`);
  console.log(`implied value: rank 1 $${rows[0].implied_value_usd.toLocaleString('en-US')} (${rows[0].slug}) to rank ${rows.length} $${rows[rows.length - 1].implied_value_usd.toLocaleString('en-US')}`);
  console.log(`total implied: $${totalImplied.toLocaleString('en-US')} | median mcap/TVL: ${multiple}`);
  console.log(`dossier.json: ${dossier.length} bytes`);
  console.log(`wrote ${outDir}`);
}

main();
