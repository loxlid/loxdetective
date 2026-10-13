# Contributing to LoxDetective

Thanks for considering a contribution. Bug reports, label corrections, new
chains, new heuristics, docs and tests are all welcome. This document explains
how the project is organised and what a good pull request looks like.

## Ground rules

- Be respectful and constructive in issues and reviews.
- Never add an address label or a sanctions entry you cannot back with a public
  source (an explorer tag, an official announcement, an OFAC notice). Include
  the source URL in the entry.
- Keep the app **client-only**: no servers, no telemetry, no third-party
  scripts. Every network request must go to a public, CORS-enabled API and be
  documented in [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md).
- Do not add npm dependencies without discussing it in an issue first; bundle
  size matters for a static site.

## Development setup

Requirements: Node.js 22, npm.

```bash
git clone https://github.com/loxlid/loxdetective.git
cd loxdetective
npm ci
npm run dev            # http://localhost:5173/loxdetective/
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | TypeScript in strict mode (`noUnusedLocals`, `noUnusedParameters`) |
| `npm test` | Vitest unit tests (`tests/**/*.test.{ts,tsx}`) |
| `npx vitest run tests/<file>.test.ts(x)` | One test file |
| `npm run build` | Typecheck + production build |
| `npm run e2e` | Playwright smoke tests against the build (`npm run build` first; Chromium via `npx playwright install chromium`) |
| `SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts` | Regenerate `docs/screenshots/*.png` from the mocked build (skipped without the env var) |
| `npm run check` | typecheck + tests + build, what CI runs before e2e |

## Project layout

```
src/
  lib/
    types.ts            shared domain types (ChainInfo, Transaction, FlowGraph, …)
    chains/registry.ts  the chain registry (RPCs, explorers, Blockscout/Etherscan)
    http.ts             fetchJson / jsonRpc / withFallback / mapLimit
    detect.ts           classify free-form search input
    format.ts           amount / date / hash formatting
    settings/store.ts   persisted settings (zustand)
    cases/store.ts      persisted investigation cases (zustand)
    providers/
      evm/              rpc.ts, decode.ts, blockscout.ts, etherscan.ts, index.ts (façade)
      btc/esplora.ts    Bitcoin via Esplora
      sol/rpc.ts        Solana JSON-RPC
      prices.ts         DefiLlama prices
    intel/              labels.ts, sanctions.ts, risk.ts
    trace/flow.ts       fund-flow tracer (BFS) + exports
  components/           shared UI (SearchBar, DataTable, FlowGraph, …)
  hooks/                react-query hooks per data type
  pages/                one component per route
  styles/               global.css tokens + components.css
tests/                  vitest unit tests (mocked fetch)
e2e/                    Playwright smoke tests (mocked network via page.route)
docs/                   SPEC.md, DATA_SOURCES.md, UI_TESTIDS.md, screenshots/
```

The authoritative description of module boundaries and exported signatures is
[`docs/SPEC.md`](docs/SPEC.md). Read it before changing a provider or a store.

## Code conventions

- **TypeScript strict**, named imports only (`import { getAddress } from 'viem'`).
- **Amounts are `bigint` base units** plus `decimals`; convert to floating point
  only for USD display.
- **EVM addresses**: compare lower-cased, display checksummed.
- **Every network call** goes through `src/lib/http.ts` and accepts an optional
  `signal?: AbortSignal`. Providers either return complete data or throw an
  `Error` with a human-readable message — never partial data silently.
- **Pure functions first.** Decoders, heuristics and formatters must be
  side-effect free so they can be unit-tested without a network.
- Prefer small, focused modules; keep comments concise and in English.
- UI copy is English. Plain CSS with the tokens in `src/styles/global.css`; no
  inline style objects except for dynamic values.

## Tests

- Unit tests live in `tests/` and run under Vitest in a Node environment.
  Mock the network with `vi.stubGlobal('fetch', …)` and realistic fixtures
  (see the existing provider tests). Tests must never hit a real API.
- Smoke tests live in `e2e/` and intercept all external traffic with
  `page.route`. They rely on the `data-testid` contract in
  [`docs/UI_TESTIDS.md`](docs/UI_TESTIDS.md) — keep it in sync when you change
  the UI, and keep every test free of console errors.
- A change to a provider, decoder or heuristic should come with a test.

## Adding an EVM chain

1. Add an `evm(...)` entry to `CHAINS` in `src/lib/chains/registry.ts` with at
   least two CORS-enabled public RPCs, the explorer, and a `blockscoutUrl`
   if one exists (or `routescan: true` for keyless Routescan support).
2. Add the DefiLlama slug to `LLAMA_CHAIN_SLUGS` in `src/lib/providers/prices.ts`
   if token prices should resolve on that chain.
3. Document the endpoints in `docs/DATA_SOURCES.md` and add the chain to the
   README table.
4. Run `npm run check`.

## Adding or fixing labels

- Built-in labels: `BUILTIN_LABELS` in `src/lib/intel/labels.ts`. Use the
  helper, set the right `category`, scope the `chain` (`'evm'`, `'any'` or a
  specific id) and add a `url` pointing to the evidence.
- Sanctions: `BUILTIN_SANCTIONED` in `src/lib/intel/sanctions.ts`, with the
  OFAC notice as `url`.
- Add a case to `tests/labels.test.ts` when behaviour changes.

## Pull requests

1. Fork and create a branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep PRs focused; one logical change per PR.
3. Make sure `npm run check` passes locally. CI runs typecheck, unit tests,
   build and the Playwright smoke suite on every PR.
4. Describe *what* and *why* in the PR body; link the issue if there is one.
   Screenshots are appreciated for UI changes.
5. Commit messages: imperative mood, short subject line
   (`Add Blast to the chain registry`).

## Reporting security issues

If you find a vulnerability that could leak user data (keys, cases) or execute
untrusted content, please do not open a public issue. Contact the maintainer
through the e-mail on the GitHub profile of `loxlid` instead.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
