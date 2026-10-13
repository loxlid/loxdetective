/**
 * Shared domain types for LoxDetective.
 *
 * Everything in the app is keyed by a `ChainId` (string slug, e.g. "ethereum",
 * "base", "bitcoin", "solana"). EVM chains additionally carry a numeric
 * `evmChainId`. All amounts are carried as `bigint` in base units plus the
 * token/native `decimals` needed to render them; never as floating point.
 */

export type ChainFamily = 'evm' | 'bitcoin' | 'solana';

export type ChainId = string;

export interface NativeCurrency {
  name: string;
  symbol: string;
  decimals: number;
  /** DefiLlama coins key, e.g. "coingecko:ethereum". */
  priceKey?: string;
}

export interface ChainInfo {
  id: ChainId;
  family: ChainFamily;
  name: string;
  shortName: string;
  /** Numeric chain id for EVM chains (undefined for bitcoin/solana). */
  evmChainId?: number;
  native: NativeCurrency;
  /** Ordered list of public JSON-RPC (EVM / Solana) or REST (Bitcoin Esplora) base URLs. First is preferred. */
  rpcUrls: string[];
  /** Blockscout instance base URL (no trailing slash), if one exists for this chain. */
  blockscoutUrl?: string;
  /**
   * Etherscan-compatible API base. Etherscan V2 (`https://api.etherscan.io/v2/api`) is
   * shared across chains and needs an API key; Routescan exposes keyless
   * per-chain endpoints for some networks.
   */
  etherscanApi?: { url: string; requiresKey: boolean; v2ChainId?: number };
  /** Human explorer base, used for outbound links. */
  explorer: { name: string; url: string; tx: (hash: string) => string; address: (addr: string) => string };
  /** Brand colour for badges. */
  color: string;
  /** true for testnets (hidden unless enabled in settings). */
  testnet?: boolean;
  /** Rough block time in seconds, for UI hints. */
  blockTimeSec?: number;
}

/** Result of classifying free-form search input. */
export type InputKind =
  | 'evm-address'
  | 'evm-tx'
  | 'ens-name'
  | 'btc-address'
  | 'btc-tx'
  | 'sol-address'
  | 'sol-tx'
  | 'block-number'
  | 'unknown';

export interface DetectedInput {
  kind: InputKind;
  /** Normalised value (checksummed EVM address, lower-cased hash, trimmed name). */
  value: string;
  /** Chain families that can plausibly own this input. */
  families: ChainFamily[];
  /** Human hint for the UI. */
  hint: string;
}

/** A generic monetary amount in base units. */
export interface Amount {
  raw: bigint;
  decimals: number;
  symbol: string;
}

export interface TokenInfo {
  chain: ChainId;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  type: 'ERC-20' | 'ERC-721' | 'ERC-1155' | 'SPL' | 'native' | 'unknown';
  logoUrl?: string;
}

export interface TokenBalance {
  token: TokenInfo;
  balance: bigint;
  /** USD value if a price was found. */
  usd?: number;
}

export interface NativeBalance {
  chain: ChainId;
  balance: bigint;
  decimals: number;
  symbol: string;
  usd?: number;
  /** Set when the RPC call failed; the balance is then meaningless. */
  error?: string;
}

export interface AddressSummary {
  chain: ChainId;
  address: string;
  isContract: boolean;
  /** EVM nonce / outgoing tx count where available. */
  txCount?: number;
  nativeBalance?: NativeBalance;
  firstSeen?: number; // unix seconds
  lastSeen?: number;
  ensName?: string;
  contract?: ContractInfo;
}

export interface ContractInfo {
  verified: boolean;
  name?: string;
  compiler?: string;
  creator?: string;
  creationTx?: string;
  /** EIP-1967 / EIP-1167 implementation if detected. */
  implementation?: string;
  proxyType?: 'EIP-1967' | 'EIP-1167' | 'EIP-1822' | 'unknown';
  isToken?: boolean;
  token?: TokenInfo;
  sourceUrl?: string;
}

export type TxStatus = 'success' | 'failed' | 'pending';

/** A normalised transaction, independent of chain family. */
export interface Transaction {
  chain: ChainId;
  hash: string;
  status: TxStatus;
  blockNumber?: number;
  timestamp?: number; // unix seconds
  from: string;
  to?: string;
  /** Native value moved by the top-level call. */
  value: Amount;
  fee?: Amount;
  gasUsed?: bigint;
  gasLimit?: bigint;
  gasPrice?: bigint;
  nonce?: number;
  /** Raw calldata (EVM). */
  input?: string;
  /** 4-byte selector (EVM) or program id (Solana). */
  methodId?: string;
  /** Human method signature, e.g. "transfer(address,uint256)". */
  methodName?: string;
  contractCreated?: string;
  /** Token transfers decoded from logs / inner instructions / outputs. */
  transfers: Transfer[];
  /** Internal (trace) calls where the provider exposes them. */
  internal?: InternalCall[];
  /** Raw logs for EVM. */
  logs?: EvmLog[];
  /** Chain-family specific extras, rendered as key/value. */
  extra?: Record<string, string | number | boolean | null>;
}

export interface Transfer {
  /** 'native' for ETH/BTC/SOL, otherwise token standard. */
  kind: 'native' | 'ERC-20' | 'ERC-721' | 'ERC-1155' | 'SPL' | 'internal';
  from: string;
  to: string;
  amount: Amount;
  token?: TokenInfo;
  tokenId?: string;
  /** Log index / instruction index for ordering. */
  index?: number;
  usd?: number;
}

export interface InternalCall {
  from: string;
  to: string;
  value: Amount;
  type: string; // call / delegatecall / create / suicide
  error?: string;
  depth?: number;
}

export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
  /** Decoded event name if recognised. */
  eventName?: string;
  decoded?: Record<string, string>;
}

/** Lightweight tx row for history lists. */
export interface TxListItem {
  chain: ChainId;
  hash: string;
  timestamp?: number;
  blockNumber?: number;
  from: string;
  to?: string;
  value: Amount;
  status: TxStatus;
  methodName?: string;
  /** Direction relative to the queried address. */
  direction: 'in' | 'out' | 'self' | 'unknown';
  /** Token transfer summary when the row is a token movement. */
  token?: { symbol: string; amount: Amount; tokenAddress?: string; kind: Transfer['kind'] };
}

export interface PagedResult<T> {
  items: T[];
  /** Opaque cursor for the next page, if any. */
  nextCursor?: string;
  /** Which backend served the result, for provenance in the UI. */
  source: string;
}

/** A known-address label. */
export type LabelCategory =
  | 'exchange'
  | 'bridge'
  | 'dex'
  | 'lending'
  | 'mixer'
  | 'sanctioned'
  | 'scam'
  | 'token'
  | 'burn'
  | 'infrastructure'
  | 'nft'
  | 'wallet'
  | 'other';

export interface AddressLabel {
  address: string;
  chain?: ChainId | 'evm' | 'any';
  name: string;
  category: LabelCategory;
  /** Where this label comes from (built-in list, OFAC feed, user tag). */
  source: string;
  url?: string;
}

export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

export interface RiskFlag {
  id: string;
  level: RiskLevel;
  title: string;
  detail: string;
  /** Evidence rows, e.g. tx hashes or counterparties. */
  evidence?: string[];
}

export interface RiskReport {
  score: number; // 0-100
  level: RiskLevel;
  flags: RiskFlag[];
}

/** Fund-flow graph used by the tracer and the D3 renderer. */
export interface FlowNode {
  id: string; // address (lower-case for EVM)
  chain: ChainId;
  label?: AddressLabel;
  isContract?: boolean;
  /** Hop distance from the root address. */
  depth: number;
  totalInUsd?: number;
  totalOutUsd?: number;
  risk?: RiskLevel;
}

export interface FlowEdge {
  id: string;
  source: string; // node id
  target: string; // node id
  chain: ChainId;
  /** Aggregated transfers along this edge. */
  transfers: Transfer[];
  txHashes: string[];
  totalUsd?: number;
  firstTs?: number;
  lastTs?: number;
}

export interface FlowGraph {
  root: string;
  chain: ChainId;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Addresses that were not expanded (depth / fan-out limits). */
  truncated: string[];
  stats: { hops: number; txsScanned: number; durationMs: number };
}

export interface TraceOptions {
  maxHops: number; // 1-4
  maxFanOut: number; // max counterparties expanded per node
  direction: 'out' | 'in' | 'both';
  /** Ignore transfers below this USD value when prices are known. */
  minUsd?: number;
  /** Skip expanding labelled entities (exchanges etc.). */
  stopAtLabelled: boolean;
  includeTokens: boolean;
  signal?: AbortSignal;
  onProgress?: (msg: string, graph: FlowGraph) => void;
}

/** Persisted investigation case. */
export interface CaseNote {
  id: string;
  createdAt: number;
  text: string;
}

export interface CaseEntity {
  id: string; // `${chain}:${address|hash}`
  chain: ChainId;
  kind: 'address' | 'tx';
  value: string;
  tag?: string;
  color?: string;
  addedAt: number;
}

export interface InvestigationCase {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  entities: CaseEntity[];
  notes: CaseNote[];
}

export interface AppSettings {
  /** User-supplied RPC overrides keyed by ChainId (prepended to defaults). */
  customRpc: Record<ChainId, string[]>;
  etherscanApiKey?: string;
  /** Optional premium providers; when set they are preferred for history. */
  alchemyApiKey?: string;
  heliusApiKey?: string;
  showTestnets: boolean;
  /** Fetch the community OFAC mirror at runtime. */
  enableSanctionsFeed: boolean;
  currency: 'usd';
}
