# UI test-id contract

The Playwright smoke suite in [`e2e/smoke.spec.ts`](../e2e/smoke.spec.ts) drives
the real UI through `data-testid` attributes. The UI **must** expose every id
below with the described semantics. Ids are stable API: changing one breaks CI.

Rules:

- Each id is rendered on **at most one element at a time** (Playwright runs in
  strict mode; two matches fail the test). On the Home page only the hero
  search bar carries `search-input` / `search-submit`; the compact nav search
  bar is shown on non-home pages only.
- Put the id on the element the test interacts with (the `<input>`, the
  `<button>`, the page's root container), not on a wrapper.
- Text assertions are substring / case-insensitive matches on `textContent`.

## Routes (HashRouter)

| Route | Page |
| --- | --- |
| `/#/` | Home |
| `/#/search/:query` | Resolve page (redirects) |
| `/#/address/:chain/:address` — e.g. `/#/address/ethereum/0x742d35Cc6634C0532925a3b844Bc454e4438f44e` | Address profile |
| `/#/tx/:chain/:hash` — e.g. `/#/tx/ethereum/0xaaaa…(64 hex)` | Transaction |
| `/#/trace/:chain/:address` | Fund-flow tracer |
| `/#/cases` | Cases |
| `/#/settings` | Settings |
| `/#/about` | About |

## The ids

Exact list (28): `search-input`, `search-submit`, `nav-home`, `nav-cases`,
`nav-settings`, `nav-about`, `address-page`, `address-native-balance`,
`address-tab-transactions`, `address-tab-tokens`, `address-tab-approvals`,
`address-tab-contract`, `tx-page`, `tx-status`, `tx-transfers`, `trace-page`,
`trace-run`, `cases-page`, `case-create`, `case-title-input`, `case-add-note`,
`case-note-input`, `settings-page`, `settings-rpc-ethereum`,
`settings-etherscan-key`, `settings-save`, `risk-badge`, `flow-graph`.

### Global layout

| testid | Element | Contract |
| --- | --- | --- |
| `search-input` | `<input type="text">` of the universal `SearchBar` | Free-form input (address / hash / ENS / block). Controlled; `fill()` must update it. |
| `search-submit` | `<button type="submit">` of the same `SearchBar` | Submits the search: navigates to `/#/search/<query>` (or directly to the resolved page). Pressing Enter in the input must do the same. |
| `nav-home` | `<a>` in the top nav (the logo / brand link is fine) | Links to `/#/`. |
| `nav-cases` | `<a>` in the top nav | Links to `/#/cases`. |
| `nav-settings` | `<a>` in the top nav | Links to `/#/settings`. |
| `nav-about` | `<a>` in the top nav | Links to `/#/about`. |

The four nav links must be visible at the default 1280×720 viewport (not
collapsed into a hidden menu).

### Home (`/#/`)

- Renders exactly one `<h1>` (the hero heading) and the hero `SearchBar`.
- `document.title` contains `LoxDetective` (the default from `index.html` is fine).

### Address page (`/#/address/:chain/:address`)

| testid | Element | Contract |
| --- | --- | --- |
| `address-page` | Root container of the page | Rendered as soon as the route mounts (before data arrives is fine). |
| `address-native-balance` | Element showing the native balance on the Overview tab | Text contains the formatted amount **and** the symbol, e.g. `1 ETH` (`formatAmount` + `chain.native.symbol`). Must reflect the RPC `eth_getBalance` result for the page's chain. May additionally show USD. |
| `address-tab-transactions` | Tab button | Activates the Transactions tab. |
| `address-tab-tokens` | Tab button | Activates the Tokens (balances) tab. |
| `address-tab-approvals` | Tab button | Activates the Approvals tab (EVM). |
| `address-tab-contract` | Tab button | Activates the Contract tab (render it even for EOAs, it may be disabled or show "not a contract"). |
| `risk-badge` | The `RiskBadge` component on the Overview tab | Text contains the risk level (`none` / `low` / `medium` / `high` / `critical`, any casing). |

The search flow used by the tests: Home → type
`0x742d35Cc6634C0532925a3b844Bc454e4438f44e` into `search-input` → click
`search-submit` → URL ends with `#/address/ethereum/0x742d35Cc…` (case of the
address may differ) and `address-page` is visible.

### Transaction page (`/#/tx/:chain/:hash`)

| testid | Element | Contract |
| --- | --- | --- |
| `tx-page` | Root container of the page | Rendered as soon as the route mounts. |
| `tx-status` | Element showing the status | Text contains `Success`, `Failed` or `Pending` (case-insensitive) from `Transaction.status`. |
| `tx-transfers` | Container of the decoded transfers table | Text contains each transfer's token symbol (e.g. `USDC`) and amount. For a tx with no transfers render the container with an empty state. |

### Trace page (`/#/trace/:chain/:address`)

| testid | Element | Contract |
| --- | --- | --- |
| `trace-page` | Root container | Rendered on mount. |
| `trace-run` | `<button>` | Starts the trace with the current options. |
| `flow-graph` | Root `<svg>` (or its wrapper) of the `FlowGraph` component | Present once a graph has been produced. |

### Cases page (`/#/cases`)

| testid | Element | Contract |
| --- | --- | --- |
| `cases-page` | Root container | Rendered on mount. Its text includes the titles of all cases and the notes of the selected case. |
| `case-title-input` | `<input type="text">` for a new case title | Always visible on the page. |
| `case-create` | `<button>` | Creates a case from `case-title-input`'s value (falls back to a default title when empty), clears the input, and **selects the new case** so its detail panel is visible. |
| `case-note-input` | `<textarea>` or `<input>` for a new note on the selected case | Visible whenever a case is selected. |
| `case-add-note` | `<button>` | Appends the note to the selected case and clears the input. The note text must then be visible inside `cases-page`. |

Persistence: cases and notes are stored by `useCases` under
`localStorage['loxdetective.cases.v1']`; after `page.reload()` the case title
and note must be visible again without any interaction (the previously selected
case stays selected, or the first case is selected by default).

Test flow: fill `case-title-input` with `Test case` → click `case-create` →
fill `case-note-input` with `hello` → click `case-add-note` → reload → both
`Test case` and `hello` are visible inside `cases-page`.

### Settings page (`/#/settings`)

| testid | Element | Contract |
| --- | --- | --- |
| `settings-page` | Root container | Rendered on mount. |
| `settings-rpc-ethereum` | `<textarea>` for custom Ethereum RPC URLs, one per line | Reflects `settings.customRpc.ethereum` joined by `\n`. The other chains use `settings-rpc-<chainId>` by the same convention. |
| `settings-etherscan-key` | `<input>` for the Etherscan API key | Reflects `settings.etherscanApiKey`. |
| `settings-save` | `<button>` | Persists all edited fields through `useSettings.set(...)` (persisted under `localStorage['loxdetective.settings.v1']`). Saving on every keystroke is also acceptable as long as clicking the button is harmless. |

Test flow: fill `settings-rpc-ethereum` with `https://example-rpc.test` → click
`settings-save` → `localStorage['loxdetective.settings.v1']` contains that URL →
reload → the textarea's value still contains the URL.

## Console hygiene

Every smoke test fails on any `console.error` or uncaught exception, except
messages mentioning `favicon`, `net::ERR` or `404` (mocked endpoints answer
404 for unknown resources). Use `console.warn` for degraded-but-expected
situations (provider fallbacks, missing API key) and make sure React does not
log key / hydration / act warnings in the production build.

## Network expectations in the tests

The suite mocks every external request (see the header of `e2e/smoke.spec.ts`):
JSON-RPC methods return fixed values (`eth_getBalance` = 1 ETH, `eth_getCode` =
`0x`, a single mocked transaction on Ethereum mainnet with one USDC `Transfer`
log, `eth_call` answering USDC metadata), Blockscout returns empty collections,
DefiLlama returns `ETH = 2500 USD`, the sanctions mirror returns `[]`, and
everything else answers `404 {}`. Pages must render with such minimal data and
must not hang or throw when a provider returns an error or an empty result.
