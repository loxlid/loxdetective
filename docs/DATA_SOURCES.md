# Data sources

Every request LoxDetective makes goes **directly from the browser** to one of the
public APIs below. There is no proxy and no backend. All calls run through
`fetchJson` / `jsonRpc` / `withFallback` in [`src/lib/http.ts`](../src/lib/http.ts)
with a per-attempt timeout, so a slow or dead endpoint falls through to the next
one in the list.

**Endpoint cooldown.** `withFallback` remembers endpoints that failed in a way
that suggests the endpoint, not the request, is at fault — a timeout, a network
error, an HTTP 5xx or 429 — and puts them on a cooldown of `COOLDOWN_MS`
(60 s). A cooling endpoint is not dropped: `orderByCooldown` moves it to the
back of the queue, so healthy endpoints are tried first and a request can still
succeed when every endpoint is cooling. A successful answer clears the mark.
Deterministic errors (JSON-RPC errors such as reverts or invalid params, HTTP
4xx other than 429, aborts) never mark an endpoint. The multi-chain probes
(activity strip, transaction lookup) use a shorter `PROBE_TIMEOUT_MS` (6 s)
than ordinary requests (12–15 s).

Rate limits are those published or observed at the time of writing (October 2026);
public providers change them without notice. "CORS" means the endpoint sends
`Access-Control-Allow-Origin` headers that let a browser on `loxlid.github.io`
(or `localhost`) call it. Anything marked *fair use* has no published number.

User-supplied endpoints and keys are configured in **Settings** and stored in
`localStorage` under `loxdetective.settings.v1`.

## 1. EVM JSON-RPC

Used by [`src/lib/providers/evm/rpc.ts`](../src/lib/providers/evm/rpc.ts).
Endpoints are tried in order — custom RPCs from Settings, then Alchemy when a
key is set (section 1a), then the registry defaults below, reordered so that
endpoints on cooldown come last; a request that fails on one endpoint is
retried on the next. Deterministic errors (reverts, invalid params) are not
retried.

Methods: `eth_blockNumber`, `eth_getBalance`, `eth_getCode`,
`eth_getTransactionCount`, `eth_getTransactionByHash`,
`eth_getTransactionReceipt`, `eth_getBlockByNumber`, `eth_getStorageAt`,
`eth_call` (ERC-20 metadata, `balanceOf`, ENS registry/resolver, proxy probes)
and `eth_getLogs` (approval scan over a bounded range, at most 2 endpoints).
The multi-chain activity strip sends one JSON-RPC **batch**
(`eth_getBalance` + `eth_getTransactionCount`) per chain, six chains at a time.

| Chain | Endpoints (in order) | Key | CORS | Rate limit |
| --- | --- | --- | --- | --- |
| Ethereum (1) | `https://ethereum-rpc.publicnode.com`, `https://eth.llamarpc.com`, `https://cloudflare-eth.com`, `https://rpc.ankr.com/eth`, `https://1rpc.io/eth` | No | Yes | PublicNode / LlamaRPC / Cloudflare: fair use. Ankr public: ~30 req/s per IP. 1RPC: free daily quota per IP. |
| Base (8453) | `https://mainnet.base.org`, `https://base-rpc.publicnode.com`, `https://base.llamarpc.com`, `https://1rpc.io/base` | No | Yes | mainnet.base.org is rate-limited for heavy use (Coinbase recommends a provider for production). |
| Arbitrum One (42161) | `https://arb1.arbitrum.io/rpc`, `https://arbitrum-one-rpc.publicnode.com`, `https://arbitrum.llamarpc.com`, `https://1rpc.io/arb` | No | Yes | Offchain Labs public RPC: fair use, `eth_getLogs` range capped. |
| OP Mainnet (10) | `https://mainnet.optimism.io`, `https://optimism-rpc.publicnode.com`, `https://optimism.llamarpc.com`, `https://1rpc.io/op` | No | Yes | Fair use. |
| Polygon PoS (137) | `https://polygon-bor-rpc.publicnode.com`, `https://polygon-rpc.com`, `https://polygon.llamarpc.com`, `https://1rpc.io/matic` | No | Yes | Fair use. |
| BNB Smart Chain (56) | `https://bsc-rpc.publicnode.com`, `https://bsc-dataseed.binance.org`, `https://bsc-dataseed1.defibit.io`, `https://1rpc.io/bnb` | No | Yes | Binance dataseeds: fair use, `eth_getLogs` limited to 5,000 blocks. |
| Avalanche C-Chain (43114) | `https://api.avax.network/ext/bc/C/rpc`, `https://avalanche-c-chain-rpc.publicnode.com`, `https://1rpc.io/avax/c` | No | Yes | Ava Labs public API: fair use, `eth_getLogs` limited to 2,048 blocks. |
| Gnosis Chain (100) | `https://rpc.gnosischain.com`, `https://gnosis-rpc.publicnode.com`, `https://1rpc.io/gnosis` | No | Yes | Fair use. |
| zkSync Era (324) | `https://mainnet.era.zksync.io`, `https://zksync-era.blockpi.network/v1/rpc/public` | No | Yes | Fair use; BlockPI public endpoints have a per-IP throttle. |
| Linea (59144) | `https://rpc.linea.build`, `https://linea-rpc.publicnode.com`, `https://1rpc.io/linea` | No | Yes | Fair use. |
| Scroll (534352) | `https://rpc.scroll.io`, `https://scroll-rpc.publicnode.com`, `https://1rpc.io/scroll` | No | Yes | Fair use. |
| Polygon zkEVM (1101) | `https://zkevm-rpc.com`, `https://polygon-zkevm.drpc.org` | No | Yes | Fair use; dRPC public: per-IP throttle. |
| Blast (81457) | `https://rpc.blast.io`, `https://blast-rpc.publicnode.com` | No | Yes | Fair use. |
| Mantle (5000) | `https://rpc.mantle.xyz`, `https://mantle-rpc.publicnode.com` | No | Yes | Fair use. |
| Celo (42220) | `https://forno.celo.org`, `https://celo-rpc.publicnode.com` | No | Yes | Forno: fair use. |
| Fantom Opera (legacy) (250) | `https://rpc.ftm.tools`, `https://fantom-rpc.publicnode.com`, `https://1rpc.io/ftm` | No | Yes | Fair use. The network is being superseded by Sonic; public endpoints may thin out. |
| Cronos (25) | `https://evm.cronos.org`, `https://cronos-evm-rpc.publicnode.com` | No | Yes | Fair use. |
| Moonbeam (1284) | `https://rpc.api.moonbeam.network`, `https://moonbeam-rpc.publicnode.com` | No | Yes | Moonbeam public RPC: 1,000 req/s burst per IP, `eth_getLogs` range capped. |
| Sepolia (11155111, testnet) | `https://ethereum-sepolia-rpc.publicnode.com`, `https://rpc.sepolia.org`, `https://1rpc.io/sepolia` | No | Yes | Fair use. |

Public RPCs regularly reject large `eth_getLogs` ranges; the approvals scanner
(`scanApprovals`) splits the range into chunks and stops at the first refusal,
keeping the approvals found in the chunks that succeeded. The result carries
`scanIncomplete`, the scanned `fromBlock` / `toBlock` and a human-readable
`reason` (for example "The Base RPC refused the approval log query (query
exceeds max block range); blocks 1,000,000–3,000,000 were not scanned"), which
the Approvals tab shows as the scan status.

### 1a. Alchemy (optional, EVM JSON-RPC)

Configured in **Settings → Alchemy API key**
([`src/lib/settings/store.ts`](../src/lib/settings/store.ts), `alchemyUrlFor`).
When a key is present, `rpcUrlsFor(chain)` inserts
`https://<slug>.g.alchemy.com/v2/<key>` after the custom RPCs and before the
public defaults for the chains Alchemy serves. The key is URL-encoded and only
ever sent to `*.g.alchemy.com`.

| Chain | Alchemy network slug |
| --- | --- |
| Ethereum | `eth-mainnet` |
| Base | `base-mainnet` |
| Arbitrum One | `arb-mainnet` |
| OP Mainnet | `opt-mainnet` |
| Polygon PoS | `polygon-mainnet` |
| zkSync Era | `zksync-mainnet` |
| Linea | `linea-mainnet` |
| Scroll | `scroll-mainnet` |
| Blast | `blast-mainnet` |
| BNB Smart Chain | `bnb-mainnet` |
| Avalanche C-Chain | `avax-mainnet` |
| Gnosis Chain | `gnosis-mainnet` |
| Polygon zkEVM | `polygonzkevm-mainnet` |
| Celo | `celo-mainnet` |
| Sepolia | `eth-sepolia` |

Mantle, Fantom, Cronos and Moonbeam are not served and keep the public
endpoints. Key: **yes** (free tier available). CORS: yes. Rate limit: per plan
(compute units per second); a 429 puts the endpoint on cooldown like any other.
Only standard JSON-RPC methods are used today; Alchemy's enhanced APIs are not.

## 2. Blockscout API v2

Used by [`src/lib/providers/evm/blockscout.ts`](../src/lib/providers/evm/blockscout.ts)
for history, token balances, internal calls, transaction summaries and verified
contract metadata. Preferred over Etherscan wherever an instance exists.

Paths (relative to `<instance>/api/v2`):

| Path | Purpose |
| --- | --- |
| `GET /addresses/{address}` | Contract/EOA flag, name, ENS, verification, creator, implementation, token info |
| `GET /addresses/{address}/counters` | Transaction and token-transfer counts, gas used |
| `GET /addresses/{address}/transactions` | Transaction list (cursor = `next_page_params`) |
| `GET /addresses/{address}/token-transfers` | Token transfer list |
| `GET /addresses/{address}/internal-transactions` | Internal call list |
| `GET /addresses/{address}/tokens?type=ERC-20,ERC-721,ERC-1155` | Token balances (up to 5 pages) |
| `GET /transactions/{hash}` | Method name, fee, status, timestamp |
| `GET /transactions/{hash}/token-transfers` | Decoded token transfers with metadata |
| `GET /transactions/{hash}/internal-transactions` | Internal calls |
| `GET /smart-contracts/{address}` | Verification, compiler, proxy/implementation, source link |

| Chain | Instance | Key | CORS | Rate limit |
| --- | --- | --- | --- | --- |
| Ethereum | `https://eth.blockscout.com` | No | Yes | Per-IP throttling (HTTP 429), roughly 10 req/s |
| Base | `https://base.blockscout.com` | No | Yes | same |
| Arbitrum One | `https://arbitrum.blockscout.com` | No | Yes | same |
| OP Mainnet | `https://optimism.blockscout.com` | No | Yes | same |
| Polygon PoS | `https://polygon.blockscout.com` | No | Yes | same |
| Gnosis Chain | `https://gnosis.blockscout.com` | No | Yes | same |
| zkSync Era | `https://zksync.blockscout.com` | No | Yes | same |
| Linea | `https://explorer.linea.build` | No | Yes | same |
| Scroll | `https://scroll.blockscout.com` | No | Yes | same |
| Polygon zkEVM | `https://zkevm.blockscout.com` | No | Yes | same |
| Blast | `https://blast.blockscout.com` | No | Yes | same |
| Mantle | `https://explorer.mantle.xyz` | No | Yes | same |
| Celo | `https://celo.blockscout.com` | No | Yes | same |
| Sepolia | `https://eth-sepolia.blockscout.com` | No | Yes | same |

BNB Smart Chain, Avalanche, Fantom, Cronos and Moonbeam have no Blockscout
instance in the registry and fall back to section 3.

## 3. Etherscan-compatible APIs

Used by [`src/lib/providers/evm/etherscan.ts`](../src/lib/providers/evm/etherscan.ts)
when Blockscout is unavailable or fails. Actions: `module=account` with
`action=txlist`, `tokentx`, `txlistinternal`, `balance`, paged with
`page`/`offset`, sorted descending. Which backend serves a chain's history is
answered by `historySource(chain)` in the registry (`blockscout`,
`etherscan-key`, `routescan`, `esplora`, `solana-rpc`); `historyNeedsKey(chain)`
is true only for chains that have neither Blockscout nor Routescan.

| Provider | Endpoint | Chains | Key | CORS | Rate limit |
| --- | --- | --- | --- | --- | --- |
| Etherscan V2 (multi-chain) | `https://api.etherscan.io/v2/api?chainid=<id>&…&apikey=<key>` | Every EVM chain except Avalanche and Fantom | **Yes** — free key from etherscan.io, entered in Settings | Yes | Free tier: 5 calls/s, 100,000 calls/day |
| Routescan | `https://api.routescan.io/v2/network/mainnet/evm/<id>/etherscan/api` | Avalanche (43114), Fantom (250) | No | Yes | Modest per-IP throttle (HTTP 429 when exceeded, which puts the endpoint on cooldown). Etherscan-compatible responses, so the same parser is used; `source` is reported as `routescan` |

Without a key, history on chains that have neither Blockscout nor Routescan
(BNB Smart Chain, Cronos, Moonbeam) raises
`Etherscan API key required (Settings)` and the UI shows a hint to add one.

## 4. Bitcoin (Esplora REST)

Used by [`src/lib/providers/btc/esplora.ts`](../src/lib/providers/btc/esplora.ts).
mempool.space and Blockstream expose the same Esplora API and are tried in order.

| Path | Purpose |
| --- | --- |
| `GET /address/{address}` | `chain_stats` + `mempool_stats` (funded/spent sums, tx counts) |
| `GET /address/{address}/txs` | Newest transactions (mempool + 25 confirmed); the tracer walks up to 2 pages (`btcHistoryDetailed`) and emits one row per counterparty (`btcTxToListItems`) |
| `GET /address/{address}/txs/chain/{lastSeenTxid}` | Next page of confirmed transactions |
| `GET /address/{address}/utxo` | Unspent outputs |
| `GET /tx/{txid}` | Transaction with inputs/outputs/status |
| `GET /tx/{txid}/status` | Confirmation status (fallback when `status` is absent) |
| `GET /blocks/tip/height` | Tip height for confirmation counts |

| Provider | Base URL | Key | CORS | Rate limit |
| --- | --- | --- | --- | --- |
| mempool.space | `https://mempool.space/api` | No | Yes | Fair use; heavy users are asked to self-host |
| Blockstream | `https://blockstream.info/api` | No | Yes | Fair use |

## 5. Solana JSON-RPC

Used by [`src/lib/providers/sol/rpc.ts`](../src/lib/providers/sol/rpc.ts).
Methods: `getAccountInfo` (jsonParsed), `getBalance`,
`getTokenAccountsByOwner` (Token and Token-2022 programs, jsonParsed),
`getSignaturesForAddress`, `getTransaction` (jsonParsed,
`maxSupportedTransactionVersion: 0`). History enrichment
(`solEnrichHistory`) fetches `getTransaction` for up to 25 of the newest
successful signatures per page (15 in the tracer), three at a time, through an
in-memory per-signature cache of 500 entries, and replaces each signature row
by one row per SOL / SPL transfer touching the address.

| Provider | Endpoint | Key | CORS | Rate limit |
| --- | --- | --- | --- | --- |
| Solana Foundation | `https://api.mainnet-beta.solana.com` | No | Yes | 100 req / 10 s per IP, 40 req / 10 s per method, 40 concurrent connections |
| PublicNode | `https://solana-rpc.publicnode.com` | No | Yes | Fair use |
| dRPC | `https://solana.drpc.org` | No | Yes | Per-IP throttle |
| Helius (optional) | `https://mainnet.helius-rpc.com/?api-key=<key>` | Yes (Settings → Helius API key) — becomes the first endpoint when set | Yes | Per plan |

## 6. Prices — DefiLlama

Used by [`src/lib/providers/prices.ts`](../src/lib/providers/prices.ts).

| Endpoint | Key | CORS | Rate limit |
| --- | --- | --- | --- |
| `GET https://coins.llama.fi/prices/current/<key>,<key>,…` | No | Yes | Generous public limit; the app batches ≤100 keys per request and caches results for 5 minutes in memory |

Keys look like `coingecko:ethereum` (native coins) or `<llama-chain-slug>:<token address>`
(`ethereum:0xa0b8…`, `bsc:0x…`, `solana:<mint>`). Prices with confidence
below 0.5 are ignored.

## 7. Function signature databases

Used by [`src/lib/providers/evm/decode.ts`](../src/lib/providers/evm/decode.ts)
only when a selector is not in the built-in table of common functions.
Results are memoised for the session.

| Provider | Endpoint | Key | CORS | Rate limit |
| --- | --- | --- | --- | --- |
| openchain.xyz | `GET https://api.openchain.xyz/signature-database/v1/lookup?function=<selector>&filter=true` | No | Yes | Fair use |
| 4byte.directory (fallback) | `GET https://www.4byte.directory/api/v1/signatures/?hex_signature=<selector>` | No | Yes | Fair use |

## 8. ENS

Resolved on-chain on Ethereum mainnet through `eth_call` (section 1), using the
registry `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e` → `resolver(bytes32)` →
`addr(bytes32)` / `name(bytes32)`. Reverse names are verified with a forward
lookup. Off-chain (CCIP-read) names are not supported.

## 9. Sanctions feed

Used by [`src/lib/intel/sanctions.ts`](../src/lib/intel/sanctions.ts) when
*OFAC sanctions feed* is enabled in Settings (default: on). The app also ships a
built-in snapshot of well-documented SDN entries that is always active.

| Endpoint | Key | CORS | Rate limit |
| --- | --- | --- | --- |
| `GET https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.json` | No | Yes | GitHub raw content: fair use (the app fetches at most once per 24 h) |
| `GET https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_XBT.json` | No | Yes | same |

The result is cached in `localStorage` under `loxdetective.sanctions.v1` for
24 hours. Any failure degrades to the cached or built-in data; it never blocks
the UI. The authoritative list is published by [OFAC](https://ofac.treasury.gov/).

## 10. Built-in, no network

- **Address labels** — `src/lib/intel/labels.ts`, curated list shipped with the app.
- **Risk heuristics** — `src/lib/intel/risk.ts`, pure functions over data already fetched.
- **Known selectors / Solana programs / SPL mints** — small tables in the providers.
- **Cases and notes** — `localStorage` under `loxdetective.cases.v1`.
- **Recent searches** — `localStorage` under `loxdetective.recent.v1` (at most 10 entries; cleared via Settings → clear caches).

## 11. Outbound links only (no API calls)

Explorer links open in a new tab: Etherscan, Basescan, Arbiscan, OP Etherscan,
Polygonscan, BscScan, Snowtrace, Gnosisscan, zkSync Explorer, Lineascan,
Scrollscan, zkEVM Polygonscan, Blastscan, Mantle Explorer, Celoscan, FTMScan,
Cronoscan, Moonscan, Sepolia Etherscan, mempool.space and Solscan.

## Changing or adding a source

- RPC / explorer endpoints per chain: edit `CHAINS` in
  [`src/lib/chains/registry.ts`](../src/lib/chains/registry.ts).
- Users can prepend their own RPCs per chain in Settings without touching code.
- New providers must go through `src/lib/http.ts`, accept an `AbortSignal` and
  either return complete data or throw — see [`CONTRIBUTING.md`](../CONTRIBUTING.md).
