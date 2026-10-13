/**
 * Pure EVM decoding helpers: token transfers and well-known events from raw
 * logs, 4-byte selectors and proxy detection. No network access except
 * `lookupSelector`.
 */
import { decodeAbiParameters, decodeEventLog, getAddress, hexToBigInt, parseAbi, toEventSelector, type AbiEvent, type Hex } from 'viem';
import type { ChainId, ContractInfo, EvmLog, TokenInfo, Transfer } from '@/lib/types';
import { fetchJson } from '@/lib/http';
import { shorten } from '@/lib/format';

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: string | number;
}

// ---------------------------------------------------------------------------
// Event topics
// ---------------------------------------------------------------------------

export const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const TOPIC_APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
export const TOPIC_APPROVAL_FOR_ALL = '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31';
export const TOPIC_TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
export const TOPIC_TRANSFER_BATCH = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';
export const TOPIC_DEPOSIT = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
export const TOPIC_WITHDRAWAL = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';

/** Topics that may carry a token movement; used by the façade to pre-fetch token metadata. */
export const TRANSFER_TOPICS: ReadonlySet<string> = new Set([
  TOPIC_TRANSFER,
  TOPIC_TRANSFER_SINGLE,
  TOPIC_TRANSFER_BATCH,
  TOPIC_DEPOSIT,
  TOPIC_WITHDRAWAL,
]);

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Human-readable ABI of the events we decode. Overloads with the same topic0
 * (ERC-20 vs ERC-721 Transfer/Approval, Uniswap V2 vs V3 Swap) are tried in
 * order; the first one whose indexed/data layout matches wins.
 */
export const KNOWN_EVENTS_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)',
  'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'event Deposit(address indexed dst, uint256 wad)',
  'event Withdrawal(address indexed src, uint256 wad)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
  'event Upgraded(address indexed implementation)',
  'event BeaconUpgraded(address indexed beacon)',
  'event AdminChanged(address previousAdmin, address newAdmin)',
  'event Sync(uint112 reserve0, uint112 reserve1)',
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)',
  'event Paused(address account)',
  'event Unpaused(address account)',
]);

const EVENTS_BY_TOPIC: Map<string, AbiEvent[]> = (() => {
  const m = new Map<string, AbiEvent[]>();
  for (const item of KNOWN_EVENTS_ABI) {
    if (item.type !== 'event') continue;
    const topic = toEventSelector(item).toLowerCase();
    const list = m.get(topic) ?? [];
    list.push(item);
    m.set(topic, list);
  }
  return m;
})();

/** Wrapped-native tokens whose Deposit/Withdrawal events are mint/burn-like transfers. */
const WRAPPED_NATIVE: Record<string, string> = {
  ethereum: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  base: '0x4200000000000000000000000000000000000006',
  optimism: '0x4200000000000000000000000000000000000006',
  blast: '0x4300000000000000000000000000000000000004',
  arbitrum: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
  polygon: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
  bsc: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  avalanche: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
  gnosis: '0xe91d153e0b41518a2ce8dd3d7944fa863463a97d',
  fantom: '0x21be370d5312f44cb42ce377bc9b8a0cef1a4c83',
  linea: '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f',
  scroll: '0x5300000000000000000000000000000000000004',
  zksync: '0x5aea5775959fbc2557cc8789bc1bf90a239d9a91',
};

export function isWrappedNative(chain: ChainId, address: string): boolean {
  return WRAPPED_NATIVE[chain] === address.toLowerCase();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function asHex(s: string): Hex {
  return (s.startsWith('0x') ? s : `0x${s}`) as Hex;
}

/** Last 20 bytes of a 32-byte topic, checksummed. */
export function topicToAddress(topic: string): string {
  const hex = topic.replace(/^0x/, '').padStart(64, '0').slice(-40);
  try {
    return getAddress(`0x${hex}`);
  } catch {
    return `0x${hex}`;
  }
}

function toIndex(v: string | number | undefined): number {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  return /^0x/i.test(v) ? Number.parseInt(v, 16) : Number.parseInt(v, 10);
}

/** Number of 32-byte words in a data field. */
function dataWords(data: string | undefined): number {
  if (!data || data === '0x') return 0;
  return Math.floor((data.length - 2) / 64);
}

function checksum(a: string): string {
  try {
    return getAddress(a);
  } catch {
    return a;
  }
}

function fallbackToken(chain: ChainId, address: string, type: TokenInfo['type']): TokenInfo {
  return { chain, address: checksum(address), name: 'Unknown token', symbol: shorten(address), decimals: 0, type };
}

/** Make a token's declared type/decimals agree with the log shape we observed. */
function reconcileToken(meta: TokenInfo | undefined, chain: ChainId, address: string, kind: 'ERC-20' | 'ERC-721' | 'ERC-1155'): TokenInfo {
  const base = meta ?? fallbackToken(chain, address, kind);
  if (kind === 'ERC-20') return base.type === 'ERC-20' ? base : { ...base, type: 'ERC-20' };
  return { ...base, type: kind, decimals: 0 };
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

/**
 * Extract token transfers from raw receipt logs.
 *
 * - `Transfer` with 3 topics + 32-byte data → ERC-20
 * - `Transfer` with 4 topics (tokenId indexed) → ERC-721
 * - `Transfer` with 1 topic + 96-byte data → legacy token with non-indexed args
 * - `TransferSingle` / `TransferBatch` → ERC-1155
 * - `Deposit` / `Withdrawal` on the chain's wrapped-native token → mint/burn style ERC-20 moves
 *
 * `tokenMeta` supplies name/symbol/decimals; unknown tokens get a shortened
 * address as symbol and decimals 0 so the raw amount is still visible.
 */
export function decodeTransfersFromLogs(chain: ChainId, logs: RawLog[], tokenMeta: (addr: string) => TokenInfo | undefined): Transfer[] {
  const out: Transfer[] = [];
  for (const log of logs) {
    const topic0 = log.topics?.[0]?.toLowerCase();
    if (!topic0) continue;
    const index = toIndex(log.logIndex);
    const data = log.data ?? '0x';
    const topics = log.topics;
    try {
      if (topic0 === TOPIC_TRANSFER) {
        if (topics.length === 4) {
          const token = reconcileToken(tokenMeta(log.address), chain, log.address, 'ERC-721');
          out.push({
            kind: 'ERC-721',
            from: topicToAddress(topics[1]),
            to: topicToAddress(topics[2]),
            tokenId: hexToBigInt(asHex(topics[3])).toString(),
            amount: { raw: 1n, decimals: 0, symbol: token.symbol },
            token,
            index,
          });
        } else if (topics.length === 3 && dataWords(data) === 1) {
          const token = reconcileToken(tokenMeta(log.address), chain, log.address, 'ERC-20');
          out.push({
            kind: 'ERC-20',
            from: topicToAddress(topics[1]),
            to: topicToAddress(topics[2]),
            amount: { raw: hexToBigInt(asHex(data)), decimals: token.decimals, symbol: token.symbol },
            token,
            index,
          });
        } else if (topics.length === 1 && dataWords(data) === 3) {
          const [from, to, value] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], asHex(data));
          const token = reconcileToken(tokenMeta(log.address), chain, log.address, 'ERC-20');
          out.push({ kind: 'ERC-20', from, to, amount: { raw: value, decimals: token.decimals, symbol: token.symbol }, token, index });
        }
      } else if (topic0 === TOPIC_TRANSFER_SINGLE && topics.length === 4 && dataWords(data) === 2) {
        const [id, value] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], asHex(data));
        const token = reconcileToken(tokenMeta(log.address), chain, log.address, 'ERC-1155');
        out.push({
          kind: 'ERC-1155',
          from: topicToAddress(topics[2]),
          to: topicToAddress(topics[3]),
          tokenId: id.toString(),
          amount: { raw: value, decimals: 0, symbol: token.symbol },
          token,
          index,
        });
      } else if (topic0 === TOPIC_TRANSFER_BATCH && topics.length === 4) {
        const [ids, values] = decodeAbiParameters([{ type: 'uint256[]' }, { type: 'uint256[]' }], asHex(data));
        const token = reconcileToken(tokenMeta(log.address), chain, log.address, 'ERC-1155');
        const from = topicToAddress(topics[2]);
        const to = topicToAddress(topics[3]);
        ids.forEach((id, i) => {
          out.push({
            kind: 'ERC-1155',
            from,
            to,
            tokenId: id.toString(),
            amount: { raw: values[i] ?? 0n, decimals: 0, symbol: token.symbol },
            token,
            index,
          });
        });
      } else if ((topic0 === TOPIC_DEPOSIT || topic0 === TOPIC_WITHDRAWAL) && topics.length === 2 && dataWords(data) === 1 && isWrappedNative(chain, log.address)) {
        const token = reconcileToken(tokenMeta(log.address), chain, log.address, 'ERC-20');
        const who = topicToAddress(topics[1]);
        out.push({
          kind: 'ERC-20',
          from: topic0 === TOPIC_DEPOSIT ? ZERO_ADDRESS : who,
          to: topic0 === TOPIC_DEPOSIT ? who : ZERO_ADDRESS,
          amount: { raw: hexToBigInt(asHex(data)), decimals: token.decimals, symbol: token.symbol },
          token,
          index,
        });
      }
    } catch {
      /* malformed log: skip rather than guess */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Known events
// ---------------------------------------------------------------------------

function stringifyArg(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return JSON.stringify(v.map((x) => (typeof x === 'bigint' ? x.toString() : x)));
  if (v && typeof v === 'object') return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  return String(v);
}

function stringifyArgs(args: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(args)) {
    args.forEach((v, i) => (out[`arg${i}`] = stringifyArg(v)));
  } else if (args && typeof args === 'object') {
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) out[k] = stringifyArg(v);
  }
  return out;
}

/**
 * Annotate logs with event names + decoded args for the events in
 * `KNOWN_EVENTS_ABI`. Unknown logs are passed through untouched.
 */
export function decodeKnownEvents(logs: RawLog[]): EvmLog[] {
  return logs.map((log) => {
    const base: EvmLog = { address: log.address, topics: log.topics ?? [], data: log.data ?? '0x', logIndex: toIndex(log.logIndex) };
    const candidates = EVENTS_BY_TOPIC.get(base.topics[0]?.toLowerCase() ?? '');
    if (!candidates) return base;
    for (const ev of candidates) {
      try {
        const { eventName, args } = decodeEventLog({
          abi: [ev],
          data: asHex(base.data),
          topics: base.topics.map(asHex) as [Hex, ...Hex[]],
        });
        return { ...base, eventName, decoded: stringifyArgs(args) };
      } catch {
        /* layout mismatch: try the next overload */
      }
    }
    return base;
  });
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** First 4 bytes of calldata as `0x12345678`, or undefined for empty/short input. */
export function selectorOf(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  const s = input.toLowerCase();
  if (!/^0x[0-9a-f]{8}/.test(s)) return undefined;
  return s.slice(0, 10);
}

/**
 * Built-in selector table (verified against `toFunctionSelector` in tests) so
 * the most common calls never need a network lookup.
 */
export const WELL_KNOWN_SELECTORS: Record<string, string> = {
  // ERC-20
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x095ea7b3': 'approve(address,uint256)',
  '0x70a08231': 'balanceOf(address)',
  '0xdd62ed3e': 'allowance(address,address)',
  '0x18160ddd': 'totalSupply()',
  '0x06fdde03': 'name()',
  '0x95d89b41': 'symbol()',
  '0x313ce567': 'decimals()',
  '0x40c10f19': 'mint(address,uint256)',
  '0xa0712d68': 'mint(uint256)',
  '0x42966c68': 'burn(uint256)',
  '0x9dc29fac': 'burn(address,uint256)',
  '0x39509351': 'increaseAllowance(address,uint256)',
  '0xa457c2d7': 'decreaseAllowance(address,uint256)',
  '0xd505accf': 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  // Wrapped native / vaults
  '0xd0e30db0': 'deposit()',
  '0xb6b55f25': 'deposit(uint256)',
  '0x2e1a7d4d': 'withdraw(uint256)',
  '0x3ccfd60b': 'withdraw()',
  // ERC-721 / ERC-1155
  '0x42842e0e': 'safeTransferFrom(address,address,uint256)',
  '0xb88d4fde': 'safeTransferFrom(address,address,uint256,bytes)',
  '0xa22cb465': 'setApprovalForAll(address,bool)',
  '0x6352211e': 'ownerOf(uint256)',
  '0xc87b56dd': 'tokenURI(uint256)',
  '0xf242432a': 'safeTransferFrom(address,address,uint256,uint256,bytes)',
  '0x2eb2c2d6': 'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)',
  // Uniswap V2-style routers
  '0x38ed1739': 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  '0x8803dbee': 'swapTokensForExactTokens(uint256,uint256,address[],address,uint256)',
  '0x7ff36ab5': 'swapExactETHForTokens(uint256,address[],address,uint256)',
  '0x18cbafe5': 'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
  '0xfb3bdb41': 'swapETHForExactTokens(uint256,address[],address,uint256)',
  '0x4a25d94a': 'swapTokensForExactETH(uint256,uint256,address[],address,uint256)',
  '0x5c11d795': 'swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
  '0xb6f9de95': 'swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)',
  '0x791ac947': 'swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)',
  '0xe8e33700': 'addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)',
  '0xf305d719': 'addLiquidityETH(address,uint256,uint256,uint256,address,uint256)',
  '0xbaa2abde': 'removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)',
  '0x02751cec': 'removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)',
  // Uniswap V3 SwapRouter / SwapRouter02
  '0x414bf389': 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
  '0xc04b8d59': 'exactInput((bytes,address,uint256,uint256,uint256))',
  '0xdb3e2198': 'exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
  '0xf28c0498': 'exactOutput((bytes,address,uint256,uint256,uint256))',
  '0x04e45aaf': 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
  '0xb858183f': 'exactInput((bytes,address,uint256,uint256))',
  '0xac9650d8': 'multicall(bytes[])',
  '0x5ae401dc': 'multicall(uint256,bytes[])',
  '0x1f0464d1': 'multicall(bytes32,bytes[])',
  // Uniswap Universal Router
  '0x3593564c': 'execute(bytes,bytes[],uint256)',
  '0x24856bc3': 'execute(bytes,bytes[])',
  // 1inch / 0x / Curve aggregators
  '0x12aa3caf': 'swap(address,(address,address,address,address,uint256,uint256,uint256),bytes,bytes)',
  '0x07ed2379': 'swap(address,(address,address,address,address,uint256,uint256,uint256),bytes)',
  '0x0502b1c5': 'unoswap(address,uint256,uint256,uint256[])',
  '0xe449022e': 'uniswapV3Swap(uint256,uint256,uint256[])',
  '0x415565b0': 'transformERC20(address,address,uint256,uint256,(uint32,bytes)[])',
  '0xd9627aa4': 'sellToUniswap(address[],uint256,uint256,bool)',
  '0x3df02124': 'exchange(int128,int128,uint256,uint256)',
  '0xa6417ed6': 'exchange_underlying(int128,int128,uint256,uint256)',
  // NFT marketplaces
  '0xfb0f3ee1':
    'fulfillBasicOrder((address,uint256,uint256,address,address,address,uint256,uint256,uint8,uint256,uint256,bytes32,uint256,bytes32,bytes32,uint256,(uint256,address)[],bytes))',
  '0xab834bab': 'atomicMatch_(address[14],uint256[18],uint8[8],bytes,bytes,bytes,bytes,bytes,bytes,uint8[2],bytes32[5])',
  // Safe / account abstraction / multicall
  '0x6a761202': 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)',
  '0x1fad948c': 'handleOps((address,uint256,bytes,bytes,uint256,uint256,uint256,uint256,uint256,bytes,bytes)[],address)',
  '0x252dba42': 'aggregate((address,bytes)[])',
  '0x82ad56cb': 'aggregate3((address,bool,bytes)[])',
  '0xbce38bd7': 'tryAggregate(bool,(address,bytes)[])',
  '0x87517c45': 'approve(address,address,uint160,uint48)',
  // Lending (Aave v3)
  '0x617ba037': 'supply(address,uint256,address,uint16)',
  '0xa415bcad': 'borrow(address,uint256,uint256,uint16,address)',
  '0x573ade81': 'repay(address,uint256,uint256,address)',
  '0x69328dec': 'withdraw(address,uint256,address)',
  '0x42b0b77c': 'flashLoanSimple(address,address,uint256,bytes,uint16)',
  '0x58c22be7': 'depositETH(address,uint16)',
  // Staking / rewards
  '0x4e71d92d': 'claim()',
  '0xa694fc3a': 'stake(uint256)',
  '0x2e17de78': 'unstake(uint256)',
  '0x3d18b912': 'getReward()',
  '0x3111e7b3': 'claimRewards(address[],uint256,address)',
  // Ownership / upgrades
  '0x3659cfe6': 'upgradeTo(address)',
  '0x4f1ef286': 'upgradeToAndCall(address,bytes)',
  '0xf2fde38b': 'transferOwnership(address)',
  '0x715018a6': 'renounceOwnership()',
  // Bridges / ENS
  '0xe9e05c42': 'depositTransaction(address,uint256,uint64,bool,bytes)',
  '0x01e4f53a': 'relayTokens(address,uint256)',
  '0xf14fcbc8': 'commit(bytes32)',
};

interface OpenchainResponse {
  ok?: boolean;
  result?: { function?: Record<string, { name?: string; filtered?: boolean }[] | null> };
}

interface FourByteResponse {
  results?: { id?: number; text_signature?: string }[];
}

const selectorCache = new Map<string, Promise<string | undefined>>();

async function fetchSelector(sel: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const r = await fetchJson<OpenchainResponse>(`https://api.openchain.xyz/signature-database/v1/lookup?function=${sel}&filter=true`, {
      signal,
      timeoutMs: 8_000,
    });
    const list = r?.result?.function?.[sel] ?? [];
    const hit = list.find((x) => x && typeof x.name === 'string' && !x.filtered) ?? list.find((x) => x && typeof x.name === 'string');
    if (hit?.name) return hit.name;
  } catch {
    /* fall through to 4byte */
  }
  if (signal?.aborted) return undefined;
  try {
    const r = await fetchJson<FourByteResponse>(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${sel}`, { signal, timeoutMs: 8_000 });
    const rows = (r?.results ?? []).filter((x) => typeof x?.text_signature === 'string');
    // The lowest id is the earliest submission and almost always the canonical signature.
    rows.sort((a, b) => (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER));
    return rows[0]?.text_signature;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a 4-byte selector to a signature: built-in table → openchain.xyz →
 * 4byte.directory. Memoised per selector; never throws.
 */
export async function lookupSelector(selector: string, signal?: AbortSignal): Promise<string | undefined> {
  const sel = selector.toLowerCase();
  if (!/^0x[0-9a-f]{8}$/.test(sel)) return undefined;
  const builtin = WELL_KNOWN_SELECTORS[sel];
  if (builtin) return builtin;
  const cached = selectorCache.get(sel);
  if (cached) return cached;
  const p = fetchSelector(sel, signal).then(
    (v) => {
      if (v === undefined) selectorCache.delete(sel);
      return v;
    },
    () => {
      selectorCache.delete(sel);
      return undefined;
    },
  );
  selectorCache.set(sel, p);
  return p;
}

// ---------------------------------------------------------------------------
// Proxy detection
// ---------------------------------------------------------------------------

export const SLOT_EIP1967_IMPLEMENTATION = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const SLOT_EIP1967_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
/** keccak256("PROXIABLE") — EIP-1822 (UUPS). */
export const SLOT_EIP1822_PROXIABLE = '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7';
/** keccak256("org.zeppelinos.proxy.implementation") — legacy OpenZeppelin unstructured storage. */
export const SLOT_OZ_LEGACY_IMPLEMENTATION = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';

const EIP1167_RE = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/;
/** 0age's shorter minimal-proxy variant. */
const EIP1167_SHORT_RE = /^0x3d3d3d3d363d3d37363d73([0-9a-f]{40})5af43d3d93803e602a57fd5bf3$/;
/** `implementation()` selector, for beacons. */
const BEACON_IMPLEMENTATION_CALLDATA = '0x5c60da1b';

export interface ProxyDetection {
  implementation?: string;
  proxyType?: ContractInfo['proxyType'];
  /** Beacon contract for beacon proxies (implementation resolved through it when `call` is given). */
  beacon?: string;
}

/** Interpret a storage word / call result as an address; undefined when zero or malformed. */
export function storageToAddress(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const hex = value.replace(/^0x/, '').padStart(64, '0').slice(-40);
  if (!/^[0-9a-fA-F]{40}$/.test(hex) || /^0+$/.test(hex)) return undefined;
  return getAddress(`0x${hex}`);
}

/**
 * Detect proxy patterns from bytecode + storage: EIP-1167 minimal proxies by
 * bytecode, then EIP-1967 implementation / beacon slots, EIP-1822 (UUPS) and
 * the legacy OpenZeppelin slot. `call` (optional) lets beacon proxies resolve
 * their implementation via `implementation()`.
 */
export async function detectProxy(
  getStorage: (slot: string) => Promise<string>,
  code: string,
  call?: (to: string, data: string) => Promise<string>,
): Promise<ProxyDetection> {
  const bytecode = (code ?? '0x').toLowerCase();
  if (bytecode === '0x' || bytecode === '') return {};

  const m = EIP1167_RE.exec(bytecode) ?? EIP1167_SHORT_RE.exec(bytecode);
  if (m) return { implementation: getAddress(`0x${m[1]}`), proxyType: 'EIP-1167' };

  const read = async (slot: string): Promise<string | undefined> => {
    try {
      return storageToAddress(await getStorage(slot));
    } catch {
      return undefined;
    }
  };

  const impl = await read(SLOT_EIP1967_IMPLEMENTATION);
  if (impl) return { implementation: impl, proxyType: 'EIP-1967' };

  const beacon = await read(SLOT_EIP1967_BEACON);
  if (beacon) {
    let implementation: string | undefined;
    if (call) {
      try {
        implementation = storageToAddress(await call(beacon, BEACON_IMPLEMENTATION_CALLDATA));
      } catch {
        implementation = undefined;
      }
    }
    return { implementation, beacon, proxyType: 'EIP-1967' };
  }

  const uups = await read(SLOT_EIP1822_PROXIABLE);
  if (uups) return { implementation: uups, proxyType: 'EIP-1822' };

  const legacy = await read(SLOT_OZ_LEGACY_IMPLEMENTATION);
  if (legacy) return { implementation: legacy, proxyType: 'unknown' };

  return {};
}
