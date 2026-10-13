/**
 * Solana provider over plain JSON-RPC (`jsonRpc` + `withFallback`). Endpoints
 * come from `rpcUrlsFor(getChain('solana'))`; a Helius key from Settings, when
 * present, is prepended as the preferred endpoint.
 *
 * Transfers are *derived* from balance diffs rather than instruction decoding,
 * which keeps this module dependency-free and version-agnostic (legacy and v0
 * transactions alike). See `deriveNativeTransfers` / `deriveSplTransfers` for
 * the approximation used.
 */
import { getChain } from '@/lib/chains/registry';
import { shorten } from '@/lib/format';
import { jsonRpc, RpcError, withFallback } from '@/lib/http';
import { getSettings, rpcUrlsFor } from '@/lib/settings/store';
import type { AddressSummary, Amount, PagedResult, TokenBalance, TokenInfo, Transaction, Transfer, TxListItem } from '@/lib/types';

const CHAIN_ID = 'solana';
const SOURCE = 'solana-rpc';
const SOL_DECIMALS = 9;
const SOL_SYMBOL = 'SOL';
const COMMITMENT = 'confirmed';

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const MAX_LOG_LINES = 20;

/** Program id → display name. Used for `methodName` and the `programs` extra. */
export const KNOWN_SOL_PROGRAMS: Record<string, string> = {
  [SYSTEM_PROGRAM_ID]: 'System Program',
  [TOKEN_PROGRAM_ID]: 'Token Program',
  [TOKEN_2022_PROGRAM_ID]: 'Token-2022 Program',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token Account Program',
  [COMPUTE_BUDGET_PROGRAM_ID]: 'Compute Budget Program',
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: 'Memo Program',
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: 'Memo Program v1',
  Stake11111111111111111111111111111111111111: 'Stake Program',
  Vote111111111111111111111111111111111111111: 'Vote Program',
  BPFLoaderUpgradeab1e11111111111111111111111: 'BPF Upgradeable Loader',
  AddressLookupTab1e1111111111111111111111111: 'Address Lookup Table Program',
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: 'Metaplex Token Metadata',
  BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY: 'Metaplex Bubblegum (cNFT)',
  SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy: 'SPL Stake Pool',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter Aggregator v6',
  JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB: 'Jupiter Aggregator v4',
  DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M: 'Jupiter DCA',
  jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu: 'Jupiter Limit Order v2',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium Liquidity Pool V4',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium CPMM',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca Whirlpools',
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP': 'Orca Token Swap v2',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: 'Meteora Pools',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump.fun',
  PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: 'Phoenix DEX',
  srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX: 'OpenBook DEX v1',
  opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb: 'OpenBook DEX v2',
  MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD: 'Marinade Finance',
  MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA: 'Marginfi v2',
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD: 'Kamino Lend',
  So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo: 'Solend',
  TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN: 'Tensor Swap',
  M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K: 'Magic Eden v2',
  worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth: 'Wormhole Core Bridge',
  wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb: 'Wormhole Token Bridge',
  SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu: 'Squads Multisig v3',
};

/** Mint → metadata for well-known tokens (symbol/name are not on-chain for SPL). */
export const KNOWN_SOL_MINTS: Record<string, { symbol: string; name: string; decimals: number }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', name: 'Tether USD', decimals: 6 },
  So11111111111111111111111111111111111111112: { symbol: 'wSOL', name: 'Wrapped SOL', decimals: 9 },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: 'JUP', name: 'Jupiter', decimals: 6 },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: 'BONK', name: 'Bonk', decimals: 5 },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: 'mSOL', name: 'Marinade staked SOL', decimals: 9 },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { symbol: 'jitoSOL', name: 'Jito Staked SOL', decimals: 9 },
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: { symbol: 'bSOL', name: 'BlazeStake Staked SOL', decimals: 9 },
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': { symbol: 'RAY', name: 'Raydium', decimals: 6 },
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: { symbol: 'PYTH', name: 'Pyth Network', decimals: 6 },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { symbol: 'WIF', name: 'dogwifhat', decimals: 6 },
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: { symbol: 'JTO', name: 'Jito', decimals: 9 },
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: { symbol: 'ORCA', name: 'Orca', decimals: 6 },
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': { symbol: 'PYUSD', name: 'PayPal USD', decimals: 6 },
  '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ': { symbol: 'W', name: 'Wormhole', decimals: 6 },
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: { symbol: 'RENDER', name: 'Render', decimals: 8 },
  hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux: { symbol: 'HNT', name: 'Helium', decimals: 8 },
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': { symbol: 'WETH', name: 'Ether (Wormhole)', decimals: 8 },
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': { symbol: 'WBTC', name: 'Wrapped BTC (Wormhole)', decimals: 8 },
};

/* ---------- Raw RPC shapes (subset; defensive) ---------- */

interface SolAccountInfo {
  lamports?: number;
  owner?: string;
  executable?: boolean;
  rentEpoch?: number;
  space?: number;
  data?: { program?: string; parsed?: { type?: string; info?: Record<string, unknown> }; space?: number } | string[] | string;
}

interface SolTokenAmount {
  amount?: string;
  decimals?: number;
  uiAmountString?: string;
}

interface SolTokenAccount {
  pubkey?: string;
  account?: { data?: { parsed?: { info?: { mint?: string; owner?: string; tokenAmount?: SolTokenAmount } } } };
}

interface SolSignatureInfo {
  signature: string;
  slot?: number;
  err?: unknown;
  blockTime?: number | null;
  memo?: string | null;
}

interface SolTokenBalance {
  accountIndex: number;
  mint?: string;
  owner?: string;
  programId?: string;
  uiTokenAmount?: SolTokenAmount;
}

interface SolInstruction {
  programId?: string;
  program?: string;
  parsed?: { type?: string; info?: Record<string, unknown> } | string;
  accounts?: string[];
  data?: string;
}

interface SolRawTransaction {
  slot?: number;
  blockTime?: number | null;
  version?: 'legacy' | number;
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: SolTokenBalance[];
    postTokenBalances?: SolTokenBalance[];
    logMessages?: string[] | null;
    computeUnitsConsumed?: number;
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
  } | null;
  transaction?: {
    message?: {
      accountKeys?: ({ pubkey?: string; signer?: boolean; writable?: boolean; source?: string } | string)[];
      instructions?: SolInstruction[];
      recentBlockhash?: string;
    };
    signatures?: string[];
  };
}

/* ---------- Small pure helpers ---------- */

function toBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}

function sol(raw: bigint): Amount {
  return { raw, decimals: SOL_DECIMALS, symbol: SOL_SYMBOL };
}

function assertSolAddress(address: string): string {
  const a = address.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) throw new Error(`Invalid Solana address: ${a || '(empty)'}`);
  return a;
}

/** TokenInfo for a mint: well-known table, else a shortened mint as symbol. */
export function solTokenInfo(mint: string, decimals?: number): TokenInfo {
  const known = KNOWN_SOL_MINTS[mint];
  return {
    chain: CHAIN_ID,
    address: mint,
    name: known?.name ?? `SPL token ${shorten(mint, 4, 4)}`,
    symbol: known?.symbol ?? shorten(mint, 4, 4),
    decimals: decimals ?? known?.decimals ?? 0,
    type: 'SPL',
  };
}

function programName(programId: string | undefined, rawProgram?: string): string | undefined {
  if (!programId) return rawProgram;
  return KNOWN_SOL_PROGRAMS[programId] ?? rawProgram ?? shorten(programId, 4, 4);
}

interface Flow {
  from: string;
  to: string;
  amount: bigint;
}

/**
 * Greedy flow matching: walk decreasers and increasers in order, moving the
 * smaller of the two remaining amounts each step. Unmatched remainders (mint,
 * burn, lamports collected as rent) are dropped. Exported for tests.
 */
export function matchFlows(
  decreases: readonly { account: string; amount: bigint }[],
  increases: readonly { account: string; amount: bigint }[],
): Flow[] {
  const src = decreases.filter((d) => d.amount > 0n).map((d) => ({ ...d }));
  const dst = increases.filter((d) => d.amount > 0n).map((d) => ({ ...d }));
  const out: Flow[] = [];
  let i = 0;
  let j = 0;
  while (i < src.length && j < dst.length) {
    const amount = src[i].amount < dst[j].amount ? src[i].amount : dst[j].amount;
    out.push({ from: src[i].account, to: dst[j].account, amount });
    src[i].amount -= amount;
    dst[j].amount -= amount;
    if (src[i].amount === 0n) i++;
    if (dst[j].amount === 0n) j++;
  }
  return out;
}

/**
 * Native SOL transfers from pre/post lamport balances.
 *
 * Approximation: the fee payer (index 0) is credited back its fee, then every
 * account whose balance went down is paired with accounts whose balance went
 * up, in account order. Because the fee payer sits first, the common case
 * "payer funds N recipients" yields payer→recipient transfers; when the payer
 * did not lose lamports (e.g. a program vault paying out) the other decreasing
 * accounts are paired with the increasing ones in order instead.
 */
export function deriveNativeTransfers(
  accountKeys: readonly string[],
  preBalances: readonly number[],
  postBalances: readonly number[],
  fee: bigint,
): Transfer[] {
  const decreases: { account: string; amount: bigint }[] = [];
  const increases: { account: string; amount: bigint }[] = [];
  const n = Math.min(accountKeys.length, preBalances.length, postBalances.length);
  for (let i = 0; i < n; i++) {
    let delta = toBig(postBalances[i]) - toBig(preBalances[i]);
    if (i === 0) delta += fee;
    if (delta < 0n) decreases.push({ account: accountKeys[i], amount: -delta });
    else if (delta > 0n) increases.push({ account: accountKeys[i], amount: delta });
  }
  return matchFlows(decreases, increases).map((f, index) => ({
    kind: 'native',
    from: f.from,
    to: f.to,
    amount: sol(f.amount),
    index,
  }));
}

/**
 * SPL transfers from pre/post token balances: diff per (owner, mint) using the
 * raw `uiTokenAmount.amount`, then pair decreasers with increasers of the same
 * mint. Token accounts created or closed inside the tx simply have a 0 side.
 */
export function deriveSplTransfers(
  accountKeys: readonly string[],
  preTokenBalances: readonly SolTokenBalance[],
  postTokenBalances: readonly SolTokenBalance[],
  startIndex = 0,
): Transfer[] {
  interface Entry { owner: string; mint: string; decimals: number; pre: bigint; post: bigint }
  const entries = new Map<string, Entry>();
  const ownerOf = (tb: SolTokenBalance) => tb.owner ?? accountKeys[tb.accountIndex] ?? `account#${tb.accountIndex}`;
  const upsert = (tb: SolTokenBalance, side: 'pre' | 'post') => {
    if (!tb.mint) return;
    const owner = ownerOf(tb);
    const key = `${owner}|${tb.mint}`;
    const e = entries.get(key) ?? { owner, mint: tb.mint, decimals: tb.uiTokenAmount?.decimals ?? 0, pre: 0n, post: 0n };
    e[side] += toBig(tb.uiTokenAmount?.amount);
    if (tb.uiTokenAmount?.decimals !== undefined) e.decimals = tb.uiTokenAmount.decimals;
    entries.set(key, e);
  };
  preTokenBalances.forEach((tb) => upsert(tb, 'pre'));
  postTokenBalances.forEach((tb) => upsert(tb, 'post'));

  const byMint = new Map<string, { decimals: number; dec: { account: string; amount: bigint }[]; inc: { account: string; amount: bigint }[] }>();
  for (const e of entries.values()) {
    const delta = e.post - e.pre;
    if (delta === 0n) continue;
    const g = byMint.get(e.mint) ?? { decimals: e.decimals, dec: [], inc: [] };
    if (delta < 0n) g.dec.push({ account: e.owner, amount: -delta });
    else g.inc.push({ account: e.owner, amount: delta });
    byMint.set(e.mint, g);
  }

  const out: Transfer[] = [];
  for (const [mint, g] of byMint) {
    const token = solTokenInfo(mint, g.decimals);
    for (const f of matchFlows(g.dec, g.inc)) {
      out.push({
        kind: 'SPL',
        from: f.from,
        to: f.to,
        amount: { raw: f.amount, decimals: token.decimals, symbol: token.symbol },
        token,
        index: startIndex + out.length,
      });
    }
  }
  return out;
}

/* ---------- Transport ---------- */

function solEndpoints(): string[] {
  const urls = rpcUrlsFor(getChain(CHAIN_ID));
  const helius = getSettings().heliusApiKey?.trim();
  return helius ? [`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(helius)}`, ...urls] : urls;
}

async function solRpc<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  try {
    return await withFallback(solEndpoints(), (url) => jsonRpc<T>(url, method, params, { signal }), { signal });
  } catch (err) {
    if (err instanceof RpcError) throw new Error(`Solana RPC ${method} failed: ${err.message}`);
    throw err;
  }
}

/* ---------- Public API ---------- */

/** `getAccountInfo` (jsonParsed) + `getBalance`. A non-existent account yields a zero balance. */
export async function solAddressSummary(
  address: string,
  signal?: AbortSignal,
): Promise<AddressSummary & { executable: boolean; owner?: string; lamports: bigint; accountType?: string }> {
  const addr = assertSolAddress(address);
  const [info, balance] = await Promise.all([
    solRpc<{ value?: SolAccountInfo | null } | null>('getAccountInfo', [addr, { encoding: 'jsonParsed', commitment: COMMITMENT }], signal),
    solRpc<{ value?: number } | null>('getBalance', [addr, { commitment: COMMITMENT }], signal),
  ]);
  const acct = info?.value ?? null;
  const lamports = toBig(balance?.value ?? acct?.lamports ?? 0);
  const executable = acct?.executable === true;
  const parsedType = acct && typeof acct.data === 'object' && !Array.isArray(acct.data) ? acct.data.parsed?.type : undefined;

  return {
    chain: CHAIN_ID,
    address: addr,
    isContract: executable,
    nativeBalance: { chain: CHAIN_ID, balance: lamports, decimals: SOL_DECIMALS, symbol: SOL_SYMBOL },
    executable,
    owner: acct?.owner,
    lamports,
    accountType: executable ? 'program' : parsedType,
  };
}

/**
 * `getTokenAccountsByOwner` for both the Token and Token-2022 programs,
 * aggregated per mint; zero balances are dropped.
 */
export async function solTokenBalances(address: string, signal?: AbortSignal): Promise<TokenBalance[]> {
  const addr = assertSolAddress(address);
  const results = await Promise.all(
    [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
      solRpc<{ value?: SolTokenAccount[] } | null>(
        'getTokenAccountsByOwner',
        [addr, { programId }, { encoding: 'jsonParsed', commitment: COMMITMENT }],
        signal,
      ),
    ),
  );

  const byMint = new Map<string, { balance: bigint; decimals: number }>();
  for (const res of results) {
    for (const acc of res?.value ?? []) {
      const info = acc.account?.data?.parsed?.info;
      const mint = info?.mint;
      if (!mint) continue;
      const amount = toBig(info?.tokenAmount?.amount);
      const prev = byMint.get(mint);
      byMint.set(mint, {
        balance: (prev?.balance ?? 0n) + amount,
        decimals: info?.tokenAmount?.decimals ?? prev?.decimals ?? KNOWN_SOL_MINTS[mint]?.decimals ?? 0,
      });
    }
  }

  const balances: TokenBalance[] = [];
  for (const [mint, { balance, decimals }] of byMint) {
    if (balance <= 0n) continue;
    balances.push({ token: solTokenInfo(mint, decimals), balance });
  }
  // Well-known tokens first, then by human-readable amount.
  const ui = (b: TokenBalance) => Number(b.balance) / 10 ** b.token.decimals;
  return balances.sort((a, b) => {
    const ka = KNOWN_SOL_MINTS[a.token.address] ? 0 : 1;
    const kb = KNOWN_SOL_MINTS[b.token.address] ? 0 : 1;
    return ka - kb || ui(b) - ui(a);
  });
}

/**
 * `getSignaturesForAddress`. Rows carry no value until enriched with
 * `solTransaction`; `nextCursor` is the last signature of a full page.
 */
export async function solSignatures(
  address: string,
  before?: string,
  limit = 25,
  signal?: AbortSignal,
): Promise<PagedResult<TxListItem>> {
  const addr = assertSolAddress(address);
  const lim = Math.min(1000, Math.max(1, Math.floor(limit)));
  const sigs = await solRpc<SolSignatureInfo[] | null>(
    'getSignaturesForAddress',
    [addr, { limit: lim, before: before || undefined, commitment: COMMITMENT }],
    signal,
  );
  const list = Array.isArray(sigs) ? sigs : [];
  const items: TxListItem[] = list
    .filter((s) => typeof s.signature === 'string')
    .map((s) => ({
      chain: CHAIN_ID,
      hash: s.signature,
      timestamp: typeof s.blockTime === 'number' ? s.blockTime : undefined,
      blockNumber: s.slot,
      from: addr,
      value: sol(0n),
      status: s.err ? 'failed' : 'success',
      methodName: s.memo ? `memo: ${s.memo}` : undefined,
      direction: 'unknown',
    }));
  const nextCursor = list.length >= lim ? list[list.length - 1]?.signature : undefined;
  return { items, nextCursor, source: SOURCE };
}

/** `getTransaction` (jsonParsed, v0-capable) normalised to `Transaction`. */
export async function solTransaction(signature: string, signal?: AbortSignal): Promise<Transaction> {
  const sig = signature.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) throw new Error(`Invalid Solana transaction signature: ${sig || '(empty)'}`);
  const tx = await solRpc<SolRawTransaction | null>(
    'getTransaction',
    [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: COMMITMENT }],
    signal,
  );
  if (!tx) throw new Error(`Solana transaction not found: ${shorten(sig, 8, 8)}`);

  const meta = tx.meta ?? {};
  const message = tx.transaction?.message ?? {};
  const keys: string[] = (message.accountKeys ?? [])
    .map((k) => (typeof k === 'string' ? k : k.pubkey))
    .filter((k): k is string => typeof k === 'string');
  // v0 transactions: addresses from lookup tables are appended (writable, then readonly)
  // unless the jsonParsed encoding already merged them into accountKeys.
  const pre = meta.preBalances ?? [];
  const post = meta.postBalances ?? [];
  if (keys.length < pre.length) keys.push(...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? []));

  const fee = toBig(meta.fee);
  const feePayer = keys[0] ?? 'unknown';
  const native = deriveNativeTransfers(keys, pre, post, fee);
  const spl = deriveSplTransfers(keys, meta.preTokenBalances ?? [], meta.postTokenBalances ?? [], native.length);
  const transfers = [...native, ...spl];

  // Main instruction: first one that is not a compute-budget hint.
  const instructions = message.instructions ?? [];
  const main = instructions.find((ix) => ix.programId !== COMPUTE_BUDGET_PROGRAM_ID) ?? instructions[0];
  const mainProgram = main?.programId;
  const mainName = programName(mainProgram, main?.program);
  const mainType = main && typeof main.parsed === 'object' && main.parsed ? main.parsed.type : undefined;
  const methodName = mainName ? (mainType ? `${mainName}: ${mainType}` : mainName) : undefined;
  const programs = Array.from(new Set(instructions.map((ix) => ix.programId).filter((p): p is string => !!p)))
    .map((p) => programName(p) ?? p)
    .join(', ');

  const sentByPayer = native.filter((t) => t.from === feePayer).reduce((acc, t) => acc + t.amount.raw, 0n);
  const logs = (meta.logMessages ?? []).slice(0, MAX_LOG_LINES);
  const failed = meta.err !== undefined && meta.err !== null;

  return {
    chain: CHAIN_ID,
    hash: tx.transaction?.signatures?.[0] ?? sig,
    status: failed ? 'failed' : 'success',
    blockNumber: tx.slot,
    timestamp: typeof tx.blockTime === 'number' ? tx.blockTime : undefined,
    from: feePayer,
    to: mainProgram,
    value: sol(sentByPayer),
    fee: sol(fee),
    gasUsed: meta.computeUnitsConsumed !== undefined ? toBig(meta.computeUnitsConsumed) : undefined,
    methodId: mainProgram,
    methodName,
    transfers,
    extra: {
      slot: tx.slot ?? null,
      version: tx.version === undefined ? 'legacy' : String(tx.version),
      recentBlockhash: message.recentBlockhash ?? null,
      computeUnitsConsumed: meta.computeUnitsConsumed ?? null,
      instructionCount: instructions.length,
      accountCount: keys.length,
      programs: programs || null,
      error: failed ? JSON.stringify(meta.err) : null,
      logMessages: logs.join('\n'),
      logTruncated: (meta.logMessages?.length ?? 0) > MAX_LOG_LINES,
    },
  };
}
