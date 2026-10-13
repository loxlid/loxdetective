# LoxDetective — Implementation Spec

LoxDetective is a **client-only** (no backend) multi-chain on-chain investigation
toolkit deployed to GitHub Pages. Everything runs in the browser against public
RPCs / explorer APIs; users may add their own RPCs and API keys in Settings.

All UI copy, comments and docs are **English**.

## 0. Hard rules for every implementer

- Stack is fixed: Vite 5 + React 18 + TypeScript (strict) + viem + @tanstack/react-query +
  zustand + react-router-dom v6 (HashRouter) + d3 v7. Tests: vitest (node env, mock
  `globalThis.fetch`). **Do not add npm dependencies.** If something is truly needed,
  say so in your final report instead.
- Shared contracts live in `src/lib/types.ts`, `src/lib/chains/registry.ts`,
  `src/lib/http.ts`, `src/lib/detect.ts`, `src/lib/format.ts`. Use them; do not
  redefine their types. You may **add** fields/types to `types.ts` only if backwards
  compatible (optional fields) and you mention it in your report.
- Only write the files you own (listed per module below). Never touch other
  modules' files; if you need something from another module that does not exist
  yet, code against the signatures in this spec.
- Imports use the `@/` alias (`@/lib/types`) or relative paths.
- Every network call goes through `fetchJson` / `jsonRpc` / `withFallback` from
  `src/lib/http.ts` so timeouts, fallbacks and AbortSignals work uniformly.
  Accept an optional `signal?: AbortSignal` on every async provider function.
- Amounts are `bigint` base units; never parse to float except for USD display.
- EVM addresses: compare lower-cased; display checksummed (`getAddress` from viem).
- Errors: throw `Error` with a human-readable message. Providers must never
  return partially wrong data silently — either return data or throw.
- Keep bundle size sane: import from `viem` by named imports only.
- `npm run typecheck` and `npm test` must pass for your files before you finish.
  Run only your own test files while others work: `npx vitest run tests/<yourfile>`.
  Do NOT run `npm install`.

## 1. Settings & chain endpoints (owner: stores module)

`src/lib/settings/store.ts` — zustand store persisted to `localStorage` key
`loxdetective.settings.v1`:

```ts
export const useSettings: UseBoundStore<StoreApi<AppSettings & { set(p: Partial<AppSettings>): void; reset(): void }>>
export function getSettings(): AppSettings            // non-hook read for providers
export function rpcUrlsFor(chain: ChainInfo): string[] // custom (from settings) first, then chain.rpcUrls
export const DEFAULT_SETTINGS: AppSettings
```

Providers call `rpcUrlsFor(chain)` to get the ordered endpoint list.

## 2. EVM providers (owner: evm module)

### `src/lib/providers/evm/rpc.ts`
Thin JSON-RPC layer over `jsonRpc`/`withFallback` (do not use viem transports;
viem is used for utilities: `getAddress`, `formatUnits`, `decodeEventLog`,
`parseAbi`, `hexToBigInt`, `namehash`, etc.).

```ts
export async function getBlockNumber(chain: ChainInfo, signal?): Promise<number>
export async function getNativeBalance(chain: ChainInfo, address: string, signal?): Promise<NativeBalance>  // never throws: sets .error
export async function getCode(chain: ChainInfo, address: string, signal?): Promise<string>                 // '0x' when EOA
export async function getTransactionCount(chain: ChainInfo, address: string, signal?): Promise<number>
export async function getTransaction(chain: ChainInfo, hash: string, signal?): Promise<RawEvmTx | null>     // eth_getTransactionByHash
export async function getTransactionReceipt(chain: ChainInfo, hash: string, signal?): Promise<RawEvmReceipt | null>
export async function getBlock(chain: ChainInfo, numberOrTag: number | 'latest', signal?): Promise<RawEvmBlock | null>
export async function getStorageAt(chain: ChainInfo, address: string, slot: string, signal?): Promise<string>
export async function ethCall(chain: ChainInfo, to: string, data: string, signal?): Promise<string>
export async function resolveEns(name: string, signal?): Promise<string | null>   // mainnet only, via eth_call to ENS registry/resolver
export async function lookupEnsName(address: string, signal?): Promise<string | null> // reverse lookup, mainnet
export async function multiChainBalances(chains: ChainInfo[], address: string, signal?): Promise<NativeBalance[]> // parallel (mapLimit 6)
export async function findTxChain(chains: ChainInfo[], hash: string, signal?): Promise<ChainInfo | null>       // probes all chains in parallel, first hit wins
export async function erc20Meta(chain: ChainInfo, token: string, signal?): Promise<TokenInfo>                   // name/symbol/decimals via eth_call, tolerant to bytes32 names
export async function erc20Balance(chain: ChainInfo, token: string, owner: string, signal?): Promise<bigint>
```
Define and export `RawEvmTx`, `RawEvmReceipt`, `RawEvmBlock` types (hex-string shaped
as returned by the node). ENS resolution: registry `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e`,
`resolver(bytes32)` then `addr(bytes32)`; reverse: `<addr>.addr.reverse` → `name(bytes32)`.

### `src/lib/providers/evm/decode.ts`
Pure functions (no network, except `lookupSelector`).
```ts
export function decodeTransfersFromLogs(chain: ChainId, logs: RawLog[], tokenMeta: (addr: string) => TokenInfo | undefined): Transfer[]
   // ERC-20 Transfer(address,address,uint256) topic 0xddf252ad…; ERC-721 same topic with 4 topics (tokenId indexed);
   // ERC-1155 TransferSingle 0xc3d58168… and TransferBatch 0x4a39dc06…; WETH Deposit/Withdrawal optional.
export function decodeKnownEvents(logs: RawLog[]): EvmLog[]   // Transfer, Approval, ApprovalForAll, Swap (UniV2/V3), Deposit, Withdrawal, OwnershipTransferred, Upgraded
export function selectorOf(input: string): string | undefined  // first 4 bytes
export async function lookupSelector(selector: string, signal?): Promise<string | undefined>
   // openchain.xyz  https://api.openchain.xyz/signature-database/v1/lookup?function=<sel>&filter=true
   // fallback 4byte.directory https://www.4byte.directory/api/v1/signatures/?hex_signature=<sel>
   // memoize in-module; include a small built-in table of ~40 common selectors (transfer, approve, swapExactTokensForTokens, execute, multicall, …) so no network is needed for them.
export const WELL_KNOWN_SELECTORS: Record<string, string>
export function detectProxy(getStorage: (slot: string) => Promise<string>, code: string): Promise<{ implementation?: string; proxyType?: ContractInfo['proxyType'] }>
   // EIP-1967 impl slot 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc,
   // EIP-1967 beacon slot 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50, EIP-1822 (UUPS) slot keccak("PROXIABLE"),
   // EIP-1167 minimal proxy by bytecode pattern 363d3d373d3d3d363d73<impl>5af43d82803e903d91602b57fd5bf3
```
`RawLog` = `{ address: string; topics: string[]; data: string; logIndex: string | number }`.

### `src/lib/providers/evm/blockscout.ts`
Blockscout API v2 (`${chain.blockscoutUrl}/api/v2/...`). All functions throw
`new Error('Blockscout not available for <chain>')` if `chain.blockscoutUrl` is missing.
```ts
export function hasBlockscout(chain: ChainInfo): boolean
export async function addressInfo(chain, address, signal?): Promise<{ isContract: boolean; name?: string; isVerified?: boolean; ensName?: string; creatorAddress?: string; creationTx?: string; implementation?: string; token?: TokenInfo; txCount?: number }>
export async function addressTransactions(chain, address, cursor?: string, signal?): Promise<PagedResult<TxListItem>>     // /addresses/{a}/transactions ; cursor = JSON of next_page_params
export async function addressTokenTransfers(chain, address, cursor?: string, signal?): Promise<PagedResult<TxListItem>>   // /addresses/{a}/token-transfers
export async function addressTokenBalances(chain, address, signal?): Promise<TokenBalance[]>                               // /addresses/{a}/tokens?type=ERC-20%2CERC-721%2CERC-1155
export async function addressInternalTxs(chain, address, cursor?: string, signal?): Promise<PagedResult<TxListItem>>
export async function txInternal(chain, hash, signal?): Promise<InternalCall[]>                                          // /transactions/{h}/internal-transactions
export async function txTokenTransfers(chain, hash, signal?): Promise<Transfer[]>                                        // /transactions/{h}/token-transfers
export async function txSummary(chain, hash, signal?): Promise<Partial<Transaction>>                                     // /transactions/{h} (method, fee, status, timestamp)
export async function contractInfo(chain, address, signal?): Promise<ContractInfo>                                       // /smart-contracts/{a}
export async function addressCounters(chain, address, signal?): Promise<{ txCount: number; tokenTransfers: number; gasUsed?: bigint }>
```
Map Blockscout `items[]` to `TxListItem` with `direction` computed vs the queried
address. `source` = `'blockscout'`.

### `src/lib/providers/evm/etherscan.ts`
Etherscan-compatible (`module=account&action=txlist|tokentx|txlistinternal|balance`).
Uses `chain.etherscanApi`; `v2ChainId` appended as `chainid`; `apikey` from
`getSettings().etherscanApiKey` when `requiresKey`. Throws a clear error
`'Etherscan API key required (Settings)'` when a key is required and missing.
Same return shapes as blockscout (`PagedResult<TxListItem>` with page-number cursor,
`source` = `'etherscan'` or `'routescan'`).

### `src/lib/providers/evm/index.ts` — the façade the UI uses
```ts
export async function getAddressSummary(chain, address, signal?): Promise<AddressSummary>
   // rpc balance + code + nonce; ENS reverse on ethereum; blockscout addressInfo when available (tolerant: failures degrade, never throw unless RPC itself fails)
export async function getAddressHistory(chain, address, opts: { cursor?: string; kind: 'tx' | 'token' | 'internal' }, signal?): Promise<PagedResult<TxListItem>>
   // prefer blockscout → etherscan(if configured or keyless routescan) → throw Error('No history provider for <chain>; add an Etherscan API key in Settings')
export async function getTokenBalances(chain, address, signal?): Promise<TokenBalance[]>
export async function getTransactionFull(chain, hash, signal?): Promise<Transaction>
   // rpc tx + receipt + block(timestamp); decode logs→transfers & events (decode.ts); methodName via WELL_KNOWN_SELECTORS then blockscout txSummary then lookupSelector; internal via blockscout when available; token meta via blockscout token-transfers if available else erc20Meta via RPC (cache per chain+address)
export async function getContractInfo(chain, address, signal?): Promise<ContractInfo>  // blockscout + proxy detection via storage slots
export async function getApprovals(chain, address, signal?): Promise<ApprovalInfo[]>   // from blockscout logs?topic0=Approval filter if available, else from history token transfers heuristics; define ApprovalInfo {token: TokenInfo; spender: string; amount: bigint; unlimited: boolean; txHash: string; timestamp?: number; spenderLabel?: string}
export { findTxChain, multiChainBalances, resolveEns, lookupEnsName } from './rpc'
```
Add `ApprovalInfo` to `types.ts` (optional fields only in existing types).

## 3. Bitcoin, Solana, prices, signatures (owner: nonevm module)

### `src/lib/providers/btc/esplora.ts` (mempool.space & blockstream share the Esplora API)
```ts
export async function btcAddressSummary(address, signal?): Promise<AddressSummary & { utxoCount: number; received: bigint; sent: bigint }>  // /address/{a}: chain_stats + mempool_stats
export async function btcAddressTxs(address, lastSeenTxid?: string, signal?): Promise<PagedResult<TxListItem>>  // /address/{a}/txs[/chain/{lastSeenTxid}] ; direction computed from vin/vout membership; value = net change for the address
export async function btcTransaction(txid, signal?): Promise<Transaction & { inputs: BtcIo[]; outputs: BtcIo[] }>  // /tx/{txid} + /tx/{txid}/status ; transfers = each output as native Transfer with from = inputs joined (or 'coinbase'); fee from /tx; extra: size, weight, vsize, confirmations (needs /blocks/tip/height)
export async function btcUtxos(address, signal?): Promise<{ txid: string; vout: number; value: bigint; confirmed: boolean }[]>
export interface BtcIo { address?: string; value: bigint; scriptType?: string; txid?: string; vout?: number }
```
Bitcoin `chain` = `'bitcoin'`, `value.decimals = 8`, `symbol 'BTC'`.

### `src/lib/providers/sol/rpc.ts`
```ts
export async function solAddressSummary(address, signal?): Promise<AddressSummary & { executable: boolean; owner?: string; lamports: bigint }>  // getAccountInfo (jsonParsed) + getBalance
export async function solTokenBalances(address, signal?): Promise<TokenBalance[]>  // getTokenAccountsByOwner (programId TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA and Token-2022 TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb) jsonParsed; symbol/name unknown → use mint short; map well-known mints (USDC EPjFWdd5…, USDT Es9vMFrz…, wSOL So111…, JUP, BONK, mSOL, jitoSOL) to names in a small table
export async function solSignatures(address, before?: string, limit = 25, signal?): Promise<PagedResult<TxListItem>>  // getSignaturesForAddress; TxListItem.value = 0 unless enriched; status from err; nextCursor = last signature
export async function solTransaction(signature, signal?): Promise<Transaction>  // getTransaction {encoding:'jsonParsed', maxSupportedTransactionVersion:0}; derive native transfers from pre/postBalances diffs per account; SPL transfers from pre/postTokenBalances diffs; fee from meta.fee; methodName = first program id name (System, Token, Jupiter v6 JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4, Raydium 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8, Orca whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc, etc. small table); logs → extra.logMessages (first 20)
export const KNOWN_SOL_PROGRAMS: Record<string, string>
export const KNOWN_SOL_MINTS: Record<string, { symbol: string; name: string; decimals: number }>
```

### `src/lib/providers/prices.ts`
DefiLlama coins API: `GET https://coins.llama.fi/prices/current/<comma keys>` → `{coins:{key:{price,symbol,decimals,timestamp,confidence}}}`.
```ts
export type PriceKey = string // 'coingecko:ethereum' | 'ethereum:0xA0b8…' | 'solana:<mint>' | 'bsc:0x…'
export function priceKeyForToken(chain: ChainInfo, tokenAddress: string): PriceKey  // llama chain slug map: ethereum→ethereum, bsc→bsc, polygon→polygon, arbitrum→arbitrum, optimism→optimism, base→base, avalanche→avax, gnosis→xdai, fantom→fantom, zksync→era, linea→linea, scroll→scroll, polygon-zkevm→polygon_zkevm, blast→blast, mantle→mantle, celo→celo, cronos→cronos, moonbeam→moonbeam, solana→solana
export async function getPrices(keys: PriceKey[], signal?): Promise<Record<PriceKey, number>>   // batches of ≤100 keys, 5-minute in-memory cache, tolerant (missing keys omitted)
export async function nativePrice(chain: ChainInfo, signal?): Promise<number | undefined>
export function usdValue(raw: bigint, decimals: number, price: number | undefined): number | undefined
```

### Tests (owner: nonevm module): `tests/esplora.test.ts`, `tests/sol.test.ts`, `tests/prices.test.ts` with mocked `fetch` fixtures.

## 4. Intelligence: labels, sanctions, risk (owner: intel module)

### `src/lib/intel/labels.ts`
```ts
export const BUILTIN_LABELS: AddressLabel[]   // ≥ 80 high-confidence entries: major CEX hot wallets (Binance, Coinbase, Kraken, OKX, Bybit, KuCoin, Bitfinex, Gate, HTX, Crypto.com), bridges (Arbitrum, Optimism, Base, Polygon, zkSync, Linea, Scroll, Across, Stargate, Wormhole, LayerZero), DEX routers (Uniswap V2/V3/Universal, 1inch, 0x, SushiSwap, Curve, Balancer vault, PancakeSwap on bsc), lending (Aave v3 pool, Compound), mixers (Tornado Cash routers + pools, Railgun), stablecoins/tokens (USDT, USDC, DAI, WETH, WBTC, stETH), burn (0x0, 0xdead), infrastructure (Multicall3 0xcA11bde05977b3631167028862bE2a173976CA11, ENS registry, Permit2 0x000000000022D473030F116dDEE9F6B43aC78BA3, Seaport, Blur, Gnosis Safe factory), Bitcoin (a few: Binance cold 34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo, Bitfinex cold bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97, Mt.Gox 1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF), Solana (Binance 5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9, Coinbase H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS, Raydium/Jupiter programs). Only include addresses you are highly confident about; set `source: 'builtin'`.
export function lookupLabel(address: string, chain?: ChainId): AddressLabel | undefined  // case-insensitive for EVM; respects chain scoping ('evm'/'any'/specific)
export function labelMap(): Map<string, AddressLabel>
export function registerLabels(labels: AddressLabel[]): void  // used by sanctions feed + user tags
```

### `src/lib/intel/sanctions.ts`
```ts
export const BUILTIN_SANCTIONED: AddressLabel[]  // Tornado Cash contract set + a few well-documented OFAC entries (e.g. Lazarus/Ronin 0x098B716B8Aaf21512996dC57EB0615e2383E2f96) — category 'sanctioned', source 'OFAC SDN (builtin snapshot)'
export const SANCTIONS_FEED_URL = 'https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.json'  // JSON array of addresses; also _BTC.json, _XBT? use ETH + BTC lists
export async function loadSanctionsFeed(signal?): Promise<{ eth: string[]; btc: string[]; fetchedAt: number }>  // cached in localStorage 'loxdetective.sanctions.v1' for 24h; registers labels; tolerant to failure (returns builtin only)
export function isSanctioned(address: string): AddressLabel | undefined
```

### `src/lib/intel/risk.ts` — pure heuristics
```ts
export interface RiskInput {
  chain: ChainId; address: string; summary?: AddressSummary;
  history?: TxListItem[]; tokenTransfers?: TxListItem[];
  counterpartyLabels?: Map<string, AddressLabel>; // lower-cased address → label
  approvals?: ApprovalInfo[]; now?: number;
}
export function assessAddress(input: RiskInput): RiskReport
```
Flags (each with stable `id`, level, title, detail, evidence):
`sanctioned` (critical), `mixer-direct` (high: sent to / received from mixer), `mixer-1hop` (medium when a counterparty is labelled mixer via counterpartyLabels of counterparties — only if data provided), `fresh-wallet` (low: first seen < 7d), `high-velocity` (medium: > 50 txs in 24h), `dust-pattern` (low: many tiny incoming native transfers from distinct senders), `pass-through` (medium: ≥90% of received value forwarded within 1h), `unlimited-approvals` (medium: ≥1 unlimited approval to unlabelled spender; high if ≥5), `contract-unverified` (low), `scam-label` (critical), `exchange-deposit` (info/none: looks like a CEX deposit address), `large-value` (info). Score = weighted sum clipped to 100; level thresholds 0 none, 1-24 low, 25-49 medium, 50-74 high, 75+ critical. Deterministic and fully unit-tested (`tests/risk.test.ts`, `tests/labels.test.ts`).

## 5. Fund-flow tracer (owner: trace module)

### `src/lib/trace/flow.ts`
```ts
export interface FlowProvider {
  history(chain: ChainId, address: string, kind: 'tx' | 'token', signal?: AbortSignal): Promise<TxListItem[]>  // first page(s); adapter over evm/index getAddressHistory, btcAddressTxs, solSignatures+solTransaction (keep simple for BTC/SOL)
  label(address: string, chain: ChainId): AddressLabel | undefined
  isContract?(chain: ChainId, address: string, signal?: AbortSignal): Promise<boolean>
  price?(chain: ChainId, tokenAddress?: string): number | undefined
}
export async function traceFunds(chain: ChainId, root: string, opts: TraceOptions, provider: FlowProvider): Promise<FlowGraph>
   // BFS by hop; per node fetch tx + token history; build edges keyed `${from}->${to}:${chain}`; aggregate transfers; respect maxFanOut (expand the top-N counterparties by USD/value), stopAtLabelled, minUsd, direction; call onProgress after each node; honour signal; record truncated nodes; never expand burn/zero addresses or labelled 'token'/'dex'/'bridge' contracts when stopAtLabelled.
export function graphToCsv(g: FlowGraph): string
export function graphToJson(g: FlowGraph): string
export function summarizeGraph(g: FlowGraph): { topSinks: FlowNode[]; topSources: FlowNode[]; labelledEndpoints: FlowNode[]; totalNodes: number; totalEdges: number }
export function createDefaultFlowProvider(): FlowProvider  // wires evm/index, btc, sol, labels, prices (lazy)
```
Unit tests with an in-memory fake provider (`tests/flow.test.ts`): hop limits,
fan-out, stopAtLabelled, direction, aggregation, cycle safety.

### `src/components/FlowGraph.tsx`
D3 force-directed SVG graph (`d3-force`, `d3-zoom`, `d3-drag` via `import * as d3 from 'd3'`).
Props: `{ graph: FlowGraph; onSelect?(nodeId: string): void; selected?: string; height?: number }`.
Node colour by `risk`/label category (sanctioned red, mixer orange, exchange blue, root accent),
edge width by `totalUsd` (log scale), arrow markers, hover tooltip (label/address/USD),
click → onSelect, zoom/pan, "fit" button, legend. Must be SSR-safe (no window access at import) and clean up on unmount.

## 6. UI (owner: ui module) — layout, components, pages, hooks

Routes (HashRouter):
- `/` Home: hero + universal `SearchBar` + feature tiles + recent searches (localStorage) + supported chain strip.
- `/search/:query` resolve page: uses `detectInput`; for `evm-address` → redirect `/address/ethereum/:addr`; `ens-name` → resolve then redirect; `evm-tx` → `findTxChain` then redirect `/tx/:chain/:hash`; `btc-*` / `sol-*` → redirect to the family's chain; ambiguous → probe both and show choices.
- `/address/:chain/:address` AddressPage with tabs: Overview (summary cards, native balance, multi-chain balance strip for EVM with per-chain links, labels, risk badge + flags), Transactions (paged table), Token Transfers, Tokens (balances with USD), Internal, Approvals (EVM), Contract (if contract: verified, proxy/impl, creator, source link). Buttons: "Trace funds", "Add to case", "Open in <explorer>", copy.
- `/tx/:chain/:hash` TxPage: status, block, time, from/to with labels, value, fee, gas, method, decoded transfers table (with USD), internal calls, decoded events, raw logs toggle, raw input; "Add to case".
- `/trace/:chain/:address` TracePage: options form (hops 1-4, fan-out, direction, stop at labelled, min USD, include tokens), run/cancel, progress line, `FlowGraph`, side panel for selected node (label, risk, totals, "open address"), summary (top sinks/sources, labelled endpoints), export CSV/JSON.
- `/cases` CasesPage: list/create/rename/delete cases, entities with tags & colours, notes (markdown-ish plain text), export case JSON, import JSON.
- `/settings` SettingsPage: custom RPC per chain (textarea, one per line), Etherscan API key, Alchemy/Helius keys (stored only), testnets toggle, sanctions feed toggle, theme (system/dark/light → sets `data-theme` on `<html>`), "Reset".
- `/about` AboutPage: what it is, data sources & their limits, privacy (all client-side; keys stay in localStorage), disclaimer.

Layout: top nav (logo, compact SearchBar on non-home pages, links Cases/Settings/About, theme toggle), footer with GitHub link `https://github.com/loxlid/loxdetective`.

Shared components (`src/components/`): `SearchBar`, `ChainBadge`, `AddressDisplay` (checksum, label chip, copy, link to AddressPage), `HashDisplay`, `CopyButton`, `Card`, `StatGrid`, `DataTable` (generic, with empty/loading states), `Tabs`, `RiskBadge`, `LabelChip`, `Spinner`, `ErrorBox` (shows message + retry), `Pagination` (cursor based "Load more"), `AmountCell`, `Timestamp`, `EmptyState`, `Toast` (simple), `ThemeToggle`.

Hooks (`src/hooks/`): `useAddressSummary(chain, address)`, `useAddressHistory(chain, address, kind)` (infinite query), `useTokenBalances`, `useTransaction`, `useMultiChainBalances(address)`, `useRisk(...)`, `useLabel(address, chain)`, `useRecentSearches()`, `useTheme()`.

Styling: plain CSS in `src/styles/components.css` (imported from `App.tsx`) using the tokens in
`global.css`. Responsive down to 360px. No inline style objects except dynamic values.

`src/App.tsx`: the real layout + routes (replace placeholder). Wrap pages in an
`ErrorBoundary` component.

Family dispatch in hooks/pages: `getChain(chain).family` → call evm façade / btc esplora / sol rpc.
Every page must render something sensible when a provider throws (ErrorBox with the message and the "add API key" hint for history).

## 7. Cases & settings stores (owner: stores module)

`src/lib/cases/store.ts` — zustand, persisted to `localStorage` `loxdetective.cases.v1`:
```ts
useCases: { cases: InvestigationCase[]; activeCaseId?: string;
  createCase(title): InvestigationCase; renameCase(id, title); deleteCase(id); setActive(id?);
  addEntity(caseId, e: Omit<CaseEntity,'id'|'addedAt'>): void; removeEntity(caseId, entityId); tagEntity(caseId, entityId, tag?, color?);
  addNote(caseId, text); deleteNote(caseId, noteId);
  exportCase(id): string; importCase(json: string): InvestigationCase; }
export function entityId(chain, kind, value): string
```
Entity tags also register as labels (`registerLabels`) with `source: 'case'` and category `'wallet'` so they show up across the UI.

Tests: `tests/stores.test.ts` (use an in-memory localStorage shim).

## 8. Repo infra (owner: infra module)

- `.github/workflows/deploy.yml`: on push to the repository's default branch (any name; see §9) and `workflow_dispatch`: checkout, setup-node 22 with npm cache, `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, upload `dist` with `actions/upload-pages-artifact@v3`, deploy with `actions/deploy-pages@v4` (permissions `pages: write`, `id-token: write`; `concurrency: pages`).
- `.github/workflows/ci.yml`: on pull_request + push to non-default branches: typecheck, test, build, Playwright e2e (uses bundled Chromium path if present else `npx playwright install --with-deps chromium`).
- `public/404.html`: HashRouter needs none, but add a tiny redirect page to `/loxdetective/#/` for deep-link safety.
- `README.md` (English): badges, what/why, feature list, screenshots placeholder, live link `https://loxlid.github.io/loxdetective/`, local dev, deployment (Settings → Pages → Source: GitHub Actions), data sources table, settings/API keys, privacy & disclaimer, roadmap, license (MIT). `LICENSE` MIT (c) 2026 loxlid.
- `e2e/smoke.spec.ts`: Playwright test with `page.route` mocks for RPC/Blockscout/esplora/llama endpoints: (1) Home renders & search bar works, (2) searching a 0x address lands on AddressPage with mocked balance shown, (3) tx page renders mocked tx with decoded ERC-20 transfer, (4) settings persists a custom RPC, (5) cases: add entity & note. Any console error fails the test. Round 2 added: (6) the EVM Overview shows the multi-chain activity strip from the mocked batch (`eth_getTransactionCount` → `0x5`), (7) the Approvals tab shows the scan banner when `eth_getLogs` answers a JSON-RPC error (per-test `overrideRpc` / `rpcErrorFor` helpers in `e2e/mocks.ts`), (8) a trace is saved to a case and reopened from the Cases page. The additive test ids are listed in `docs/UI_TESTIDS.md`.
- `docs/DATA_SOURCES.md`: list of every endpoint used, CORS status, rate limits, key requirements.

## 9. Round 2 additions

Added after the first implementation round. Existing signatures above are
unchanged; everything here is additive.

### `src/lib/http.ts` — endpoint cooldown
```ts
export const COOLDOWN_MS = 60_000
export function markEndpointFailed(url: string, now = Date.now()): void
export function isEndpointCooling(url: string, now = Date.now()): boolean
export function clearEndpointCooldowns(): void                       // tests / settings changes
export function isEndpointFailure(err: unknown, signal?: AbortSignal): boolean
   // true for timeout / network error / HTTP 5xx / 429; false for RpcError, HTTP 4xx (except 429), AbortError or an aborted signal
export function orderByCooldown(urls: readonly string[], now = Date.now()): string[]
   // healthy first (original order), then cooling ones (original order) — cooling endpoints are tried last, never dropped
```
`withFallback(urls, fn, opts)` keeps its signature; it iterates `orderByCooldown(urls)`, marks a URL on `isEndpointFailure` and clears the mark on success.

### `src/lib/providers/evm/rpc.ts` / `index.ts`
```ts
export const PROBE_TIMEOUT_MS = 6_000   // multiChainBalances, multiChainActivity, findTxChain
export async function multiChainActivity(chains: ChainInfo[], address: string, signal?): Promise<ChainActivity[]>
   // one jsonRpcBatch [eth_getBalance, eth_getTransactionCount] per chain via withFallback(rpcUrlsFor(chain)), mapLimit 6, never rejects
export async function scanApprovals(chain: ChainInfo, address: string, signal?): Promise<ApprovalScan>
   // chunked eth_getLogs; keeps approvals from successful chunks, stops at the first refusal, reports reason + scanned range
// getApprovals(chain, address, signal?) stays a thin wrapper returning scan.approvals
// index.ts re-exports: multiChainActivity, PROBE_TIMEOUT_MS (alongside findTxChain, multiChainBalances, resolveEns, lookupEnsName)
// rpcCall applies orderByCooldown before slicing maxUrls
```

### `src/lib/settings/store.ts` — Alchemy
```ts
export const ALCHEMY_SLUGS: Readonly<Record<string, string>>   // ethereum → eth-mainnet, base → base-mainnet, … sepolia → eth-sepolia (15 chains)
export function alchemyUrlFor(chain: ChainInfo, apiKey = getSettings().alchemyApiKey): string | undefined
   // https://<slug>.g.alchemy.com/v2/<encodeURIComponent(key)>
// rpcUrlsFor(chain) order: custom RPCs, Alchemy (key set and chain served), registry defaults; deduplicated
```

### `src/lib/chains/registry.ts`
```ts
export type HistorySource = 'blockscout' | 'etherscan-key' | 'routescan' | 'esplora' | 'solana-rpc'
export function historySource(chain: ChainInfo): HistorySource
export function historyNeedsKey(chain: ChainInfo): boolean   // !blockscoutUrl && etherscanApi?.requiresKey === true
// Fantom display name: 'Fantom Opera (legacy)' (id / evmChainId / shortName unchanged)
```

### `src/lib/providers/sol/rpc.ts` — history enrichment
```ts
export function solTransfersToRows(address: string, tx: Transaction): TxListItem[]
   // one row per native / SPL transfer touching `address` (direction, counterparty, amount, token, status, timestamp, slot, enriched: true)
export async function solEnrichHistory(address: string, items: TxListItem[], opts?: { limit?: number; concurrency?: number; signal?: AbortSignal }): Promise<TxListItem[]>
   // resolves up to opts.limit (25) successful signature rows via getTransaction, mapLimit(concurrency 3), per-signature cache (500, in-flight dedupe); unchanged rows are returned as the same object; order preserved; rethrows only on abort
export const SOL_ENRICH_DEFAULT_LIMIT = 25
export const SOL_ENRICH_DEFAULT_CONCURRENCY = 3
export const SOL_TX_CACHE_MAX = 500
export function clearSolTxCache(): void
export function solTxCacheSize(): number
```

### `src/lib/providers/btc/esplora.ts` — per-counterparty rows
```ts
export function btcTxToListItems(address: string, tx: EsploraTx): TxListItem[]
   // spend: one 'out' row per output not paid back to an input address (change heuristic), value pro rata to the address's share of input value;
   // receive: one 'in' row per distinct input address, received amount split by input value (integer, remainder to the largest input);
   // coinbase → single row from 'coinbase'; consolidations → the singular 'self' row; unrelated tx → []; all rows enriched: true
export async function btcHistoryDetailed(address: string, opts?: { pages?: number; signal?: AbortSignal }): Promise<TxListItem[]>
   // up to opts.pages (2) pages of /address/{a}/txs (+ /txs/chain/{lastTxid}), flattened through btcTxToListItems; first page errors throw, later pages end the walk with a console.warn
export const BTC_DETAILED_DEFAULT_PAGES = 2
```

### `src/lib/trace/flow.ts`
No new exports. `createDefaultFlowProvider` uses `btcHistoryDetailed(address, { pages: 2 })` for Bitcoin and `solSignatures` + `solEnrichHistory` (limit 15, concurrency 3, per-address promise cache shared by the `tx` / `token` kinds, enriched rows only) for Solana. `traceFunds` sets `graph.stats.enrichedTxs` (distinct hashes among rows with `enriched === true`; 0 when none).

### `src/lib/intel/labels.ts`
`BUILTIN_LABELS` gained Bitcoin entries (Binance / HTX cold wallets, Silk Road and Bitfinex-hack seizure addresses, Satoshi block-9 coinbase, Hal Finney, burn addresses) and Solana entries (Stake / Vote / BPF Loader / Address Lookup Table programs, incinerator, Jupiter v4 + DCA, Orca v2, Meteora DLMM, OpenBook v3, Marinade, Wormhole Core, Metaplex Bubblegum, Magic Eden v2, Tensor, JUP / BONK / mSOL / jitoSOL / PYUSD mints).

### `src/lib/types.ts` (append-only)
```ts
export interface ChainActivity { chain: ChainId; balance?: NativeBalance; txCount?: number; error?: string }
export interface ApprovalScan { approvals: ApprovalInfo[]; scanIncomplete: boolean; fromBlock?: number; toBlock?: number; reason?: string }
TxListItem.enriched?: boolean
FlowGraph.stats.enrichedTxs?: number
export interface CaseAttachment { id: string; kind: 'trace'; title: string; createdAt: number; chain: ChainId; root: string; options: Omit<TraceOptions, 'signal' | 'onProgress'>; data: string /* graphToJson */ }
InvestigationCase.attachments?: CaseAttachment[]   // absent when empty
```

### `src/lib/cases/store.ts` — attachments
```ts
export const CASE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024
export type NewCaseAttachment = Omit<CaseAttachment, 'id' | 'createdAt'>
useCases.addAttachment(caseId, a: NewCaseAttachment): CaseAttachment | undefined
   // undefined for an unknown case; throws Error('Invalid attachment') on a bad shape, Error('Attachment too large …') above the cap,
   // and Error('Could not save the attachment: …') when localStorage refuses the write (state is rolled back)
useCases.removeAttachment(caseId, attachmentId): void             // the key disappears when the last attachment goes
export function parseAttachment(raw: unknown, now = Date.now()): CaseAttachment | undefined   // shape + size validation (used by import and rehydration)
export function attachmentBytes(data: string): number                                        // UTF-8 size
// exportCase / importCase carry attachments; import rejects a case file with a malformed or oversized attachment ('Invalid case file');
// storage rehydration drops broken attachments but keeps the case.
```

### Pages
```ts
// src/pages/TracePage.tsx
export type SavedTraceOptions = CaseAttachment['options']
export function traceQueryFor(o: SavedTraceOptions): string                 // 'hops=&fanout=&direction=&stop=&minUsd=&tokens='
export function formFromSearch(search: string | URLSearchParams, base = DEFAULT_TRACE_FORM): TraceForm   // prefill from the query string; invalid values fall back, numbers clamp
export function traceTitle(chainName: string, address: string, o: SavedTraceOptions): string
// "Save trace to case" button (data-testid trace-save-case): active case / inline picker / creates "New case"; CSV + JSON export via src/lib/export
// src/pages/CasesPage.tsx
export function attachmentStats(data: string): { nodes: number; edges: number; hops?: number; error?: string }   // lazy JSON.parse, never throws
export function attachmentTraceLink(a: Pick<CaseAttachment, 'chain' | 'root' | 'options'>): string             // /trace/:chain/:root?<traceQueryFor>
// "Saved traces" card per case: title, chain, root, node / edge counts, options, Open trace, Download JSON (downloadJson), Remove
```

### Workflows
- `deploy.yml`: triggered by a push to any branch plus `workflow_dispatch`; the build and deploy jobs run only when `github.ref == format('refs/heads/{0}', github.event.repository.default_branch)` (or on manual dispatch); `actions/configure-pages@v5` (Pages must be enabled once by hand under Settings → Pages → Source: GitHub Actions; the default `GITHUB_TOKEN` cannot enable it); permissions `contents: read`, `pages: write`, `id-token: write`; concurrency group `pages` without cancel-in-progress; environment `github-pages` with the `page_url` output.
- `ci.yml`: `pull_request` plus pushes to any branch, guarded by the inverted condition so the default branch is not checked twice.
