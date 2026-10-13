/**
 * Known-address labels: a curated built-in list plus a small in-memory
 * registry that other modules (sanctions feed, case tags) extend at runtime.
 *
 * Lookup semantics
 * - EVM addresses and bech32 Bitcoin addresses are compared case-insensitively;
 *   base58 (legacy BTC, Solana) addresses are case-sensitive.
 * - A label is scoped by `chain`: a specific chain id, `'evm'` (every EVM
 *   chain) or `'any'` / undefined. `lookupLabel(addr, chain)` only returns
 *   labels whose scope covers `chain`; with no chain every scope matches.
 * - When several labels match, the winner is chosen by: non-builtin source
 *   first (so case tags and the OFAC feed override the built-in list), then
 *   the most specific scope, then the most recent registration.
 */
import type { AddressLabel, ChainId, LabelCategory } from '../types';
import { findChain } from '../chains/registry';

type Scope = ChainId | 'evm' | 'any';

interface Entry {
  label: AddressLabel;
  scope: Scope;
  seq: number;
  builtin: boolean;
}

const EVM_ADDR_RE = /^0x[0-9a-f]{40}$/i;
const BECH32_RE = /^(bc1|tb1)[0-9a-z]{6,90}$/i;

/** Canonical map key for an address: lower-case for EVM / bech32, verbatim otherwise. */
export function normalizeAddress(address: string): string {
  const a = (address ?? '').trim();
  return EVM_ADDR_RE.test(a) || BECH32_RE.test(a) ? a.toLowerCase() : a;
}

function isEvmChain(chain: ChainId): boolean {
  if (chain === 'evm') return true;
  const info = findChain(chain);
  return info ? info.family === 'evm' : false;
}

function scopeMatches(scope: Scope, chain: ChainId | undefined): boolean {
  if (chain === undefined || scope === 'any') return true;
  if (scope === 'evm') return isEvmChain(chain);
  return scope === chain;
}

function specificity(scope: Scope): number {
  return scope === 'any' ? 0 : scope === 'evm' ? 1 : 2;
}

/** Higher rank wins: user/feed labels beat builtin, then specific scope, then recency. */
function rank(e: Entry): [number, number, number] {
  return [e.builtin ? 0 : 1, specificity(e.scope), e.seq];
}

function better(a: Entry, b: Entry): boolean {
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return ra[i] > rb[i];
  }
  return false;
}

function L(
  address: string,
  name: string,
  category: LabelCategory,
  chain: AddressLabel['chain'] = 'ethereum',
  url?: string,
): AddressLabel {
  return url ? { address, chain, name, category, source: 'builtin', url } : { address, chain, name, category, source: 'builtin' };
}

/**
 * High-confidence, long-lived, widely documented addresses. Mainnet-only
 * contracts use `chain: 'ethereum'`; contracts deployed at the same address on
 * many EVM chains use `chain: 'evm'`.
 */
export const BUILTIN_LABELS: AddressLabel[] = [
  // --- Burn / null (every EVM chain) -------------------------------------
  L('0x0000000000000000000000000000000000000000', 'Null address (0x0)', 'burn', 'evm'),
  L('0x000000000000000000000000000000000000dEaD', 'Burn address (0xdead)', 'burn', 'evm'),

  // --- Infrastructure deployed at the same address on many chains --------
  L('0xcA11bde05977b3631167028862bE2a173976CA11', 'Multicall3', 'infrastructure', 'evm'),
  L('0x000000000022D473030F116dDEE9F6B43aC78BA3', 'Permit2 (Uniswap)', 'infrastructure', 'evm'),
  L('0x4e59b44847b379578588920cA78FbF26c0B4956C', 'Deterministic deployment proxy (CREATE2 factory)', 'infrastructure', 'evm'),
  L('0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2', 'Safe: Proxy Factory 1.3.0', 'infrastructure', 'evm'),
  L('0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67', 'Safe: Proxy Factory 1.4.1', 'infrastructure', 'evm'),
  L('0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552', 'Safe: Singleton 1.3.0', 'infrastructure', 'evm'),
  L('0x3E5c63644E683549055b9Be8653de26E0B4CD36E', 'Safe: Singleton L2 1.3.0', 'infrastructure', 'evm'),
  L('0x1a44076050125825900e736c501f859c50fE728c', 'LayerZero: Endpoint V2', 'bridge', 'evm'),

  // --- DEX routers / AMMs -------------------------------------------------
  L('0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', 'Uniswap V2: Router 2', 'dex'),
  L('0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f', 'Uniswap V2: Factory', 'dex'),
  L('0xE592427A0AeCe92De3Edee1F8F0fBd7cc5f1B6E6', 'Uniswap V3: SwapRouter', 'dex'),
  L('0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', 'Uniswap V3: SwapRouter02', 'dex'),
  L('0x1F98431c8aD98523631AE4a59f267346ea31F984', 'Uniswap V3: Factory', 'dex', 'evm'),
  L('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', 'Uniswap V3: Positions NFT', 'dex', 'evm'),
  L('0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', 'Uniswap: Universal Router', 'dex', 'evm'),
  L('0x1111111254EEB25477B68fb85Ed929f73A960582', '1inch: Aggregation Router V5', 'dex', 'evm'),
  L('0x1111111254fb6c44bAC0beD2854e76F90643097d', '1inch: Aggregation Router V4', 'dex', 'evm'),
  L('0x111111125421cA6dc452d289314280a0f8842A65', '1inch: Aggregation Router V6', 'dex', 'evm'),
  L('0xDef1C0ded9bec7F1a1670819833240f027b25EfF', '0x: Exchange Proxy', 'dex', 'evm'),
  L('0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F', 'SushiSwap: Router', 'dex'),
  L('0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7', 'Curve: 3pool (DAI/USDC/USDT)', 'dex'),
  L('0xBA12222222228d8Ba445958a75a0704d566BF2C8', 'Balancer: Vault', 'dex', 'evm'),
  L('0x10ED43C718714eb63d5aA57B78B54704E256024E', 'PancakeSwap V2: Router', 'dex', 'bsc'),
  L('0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', 'PancakeSwap V3: SwapRouter', 'dex', 'bsc'),
  L('0x60aE616a2155Ee3d9A68541Ba4544862310933d4', 'Trader Joe: Router', 'dex', 'avalanche'),

  // --- Lending ----------------------------------------------------------
  L('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', 'Aave V3: Pool', 'lending'),
  L('0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9', 'Aave V2: LendingPool', 'lending'),
  L('0x39AA39c021dfbaE8faC545936693aC917d5E7563', 'Compound V2: cUSDC', 'lending'),
  L('0x4Ddc2D193948926D02f9B1fE9e1daa0718270ED5', 'Compound V2: cETH', 'lending'),
  L('0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643', 'Compound V2: cDAI', 'lending'),
  L('0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B', 'Compound V2: Comptroller', 'lending'),
  L('0xc3d688B66703497DAA19211EEdff47f25384cdc3', 'Compound V3: cUSDCv3 (Comet)', 'lending'),
  L('0x5ef30b9986345249bc32d8928B7ee64DE9435E39', 'MakerDAO: CDP Manager', 'lending'),
  L('0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B', 'MakerDAO: Vat', 'lending'),

  // --- Tokens (Ethereum mainnet) ---------------------------------------
  L('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'WETH (Wrapped Ether)', 'token'),
  L('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC (Circle)', 'token'),
  L('0xdAC17F958D2ee523a2206206994597C13D831ec7', 'USDT (Tether)', 'token'),
  L('0x6B175474E89094C44Da98b954EedeAC495271d0F', 'DAI (MakerDAO)', 'token'),
  L('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 'WBTC (Wrapped Bitcoin)', 'token'),
  L('0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', 'Lido: stETH', 'token'),
  L('0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', 'Lido: wstETH', 'token'),
  L('0xae78736Cd615f374D3085123A210448E74Fc6393', 'Rocket Pool: rETH', 'token'),
  L('0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', 'UNI (Uniswap)', 'token'),
  L('0x514910771AF9Ca656af840dff83E8264EcF986CA', 'LINK (Chainlink)', 'token'),
  L('0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0', 'MATIC (Polygon, legacy ERC-20)', 'token'),
  L('0x4Fabb145d64652a948d72533023f6E7A623C7C53', 'BUSD (Binance USD)', 'token'),
  L('0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', 'AAVE', 'token'),
  L('0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', 'MKR (Maker)', 'token'),
  L('0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', 'LDO (Lido DAO)', 'token'),
  L('0xD533a949740bb3306d119CC777fa900bA034cd52', 'CRV (Curve DAO)', 'token'),
  L('0x6982508145454Ce325dDbE47a25d4ec3d2311933', 'PEPE', 'token'),
  L('0x95aD61b0a150d79219dCCF0a5B2e3d1F0a7DBfC0', 'SHIB (Shiba Inu)', 'token'),
  L('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 'cbBTC (Coinbase Wrapped BTC)', 'token', 'evm'),

  // --- Tokens on other EVM chains ---------------------------------------
  L('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 'WBNB (Wrapped BNB)', 'token', 'bsc'),
  L('0x55d398326f99059fF775485246999027B3197955', 'USDT (Binance-Peg)', 'token', 'bsc'),
  L('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 'USDC (Binance-Peg)', 'token', 'bsc'),
  L('0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', 'BUSD (Binance-Peg)', 'token', 'bsc'),
  L('0x2170Ed0880ac9A755fd29B2688956BD959F933F8', 'ETH (Binance-Peg)', 'token', 'bsc'),
  L('0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', 'BTCB (Binance-Peg BTC)', 'token', 'bsc'),
  L('0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', 'CAKE (PancakeSwap)', 'token', 'bsc'),
  L('0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', 'WPOL / WMATIC (Wrapped POL)', 'token', 'polygon'),
  L('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 'USDC.e (bridged)', 'token', 'polygon'),
  L('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 'USDC (native)', 'token', 'polygon'),
  L('0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 'USDT (PoS)', 'token', 'polygon'),
  L('0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 'WETH (PoS)', 'token', 'polygon'),
  L('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 'WETH', 'token', 'arbitrum'),
  L('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'USDC (native)', 'token', 'arbitrum'),
  L('0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', 'USDC.e (bridged)', 'token', 'arbitrum'),
  L('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 'USDT', 'token', 'arbitrum'),
  L('0x912CE59144191C1204E64559FE8253a0e49E6548', 'ARB (Arbitrum)', 'token', 'arbitrum'),
  L('0x4200000000000000000000000000000000000006', 'WETH (OP Stack predeploy)', 'token', 'optimism'),
  L('0x4200000000000000000000000000000000000042', 'OP (Optimism)', 'token', 'optimism'),
  L('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 'USDC (native)', 'token', 'optimism'),
  L('0x7F5c764cBc14f9669B88837ca1490cCa17c31607', 'USDC.e (bridged)', 'token', 'optimism'),
  L('0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 'USDT', 'token', 'optimism'),
  L('0x4200000000000000000000000000000000000006', 'WETH (OP Stack predeploy)', 'token', 'base'),
  L('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC (native)', 'token', 'base'),
  L('0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', 'USDbC (bridged USDC)', 'token', 'base'),
  L('0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', 'cbETH (Coinbase Wrapped Staked ETH)', 'token', 'base'),
  L('0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', 'DAI', 'token', 'base'),
  L('0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', 'WAVAX (Wrapped AVAX)', 'token', 'avalanche'),
  L('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 'USDC (native)', 'token', 'avalanche'),
  L('0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 'USDT (native)', 'token', 'avalanche'),
  L('0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', 'WXDAI (Wrapped xDAI)', 'token', 'gnosis'),

  // --- NFT marketplaces / ENS / misc infrastructure (mainnet) ---------
  L('0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC', 'OpenSea: Seaport 1.5', 'nft', 'evm'),
  L('0x0000000000000068F116a894984e2DB1123eB395', 'OpenSea: Seaport 1.6', 'nft', 'evm'),
  L('0x00000000006c3852cbEf3e08E8dF289169EdE581', 'OpenSea: Seaport 1.1', 'nft', 'evm'),
  L('0x7Be8076f4EA4A4AD08075C2508e481d6C946D12b', 'OpenSea: Wyvern Exchange v1 (legacy)', 'nft'),
  L('0x7f268357A8c2552623316e2562D90e642bB538E5', 'OpenSea: Wyvern Exchange v2 (legacy)', 'nft'),
  L('0x000000000000Ad05Ccc4F10045630fb830B95127', 'Blur: Marketplace', 'nft'),
  L('0x0000000000A39bb272e79075ade125fd351887Ac', 'Blur: Pool (Blend)', 'nft'),
  L('0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e', 'ENS: Registry', 'infrastructure'),
  L('0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63', 'ENS: Public Resolver', 'infrastructure'),
  L('0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85', 'ENS: Base Registrar (.eth NFT)', 'infrastructure'),
  L('0x283Af0B28c62C092C9727F1Ee09c02CA627EB7F5', 'ENS: ETH Registrar Controller (legacy)', 'infrastructure'),

  // --- Centralised exchanges (Ethereum) --------------------------------
  L('0x5754284f345afc66a98fbB0a0Afe71e0F007B949', 'Tether: Treasury', 'exchange'),
  L('0x28C6c06298d514Db089934071355E5743bf21d60', 'Binance 14 (hot wallet)', 'exchange'),
  L('0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549', 'Binance 15 (hot wallet)', 'exchange'),
  L('0xDFd5293D8e347dFe59E90eFd55b2956a1343963d', 'Binance 16 (hot wallet)', 'exchange'),
  L('0x56Eddb7aa87536c09CCc2793473599fD21A8b17F', 'Binance 17 (hot wallet)', 'exchange'),
  L('0x9696f59E4d72E237BE84fFD425DCaD154Bf96976', 'Binance 18 (hot wallet)', 'exchange'),
  L('0x4976A4A02f38326660D17bf34b431dC6e2eb2327', 'Binance 20 (hot wallet)', 'exchange'),
  L('0x5a52E96BAcdaBb82fd05763E25335261B270Efcb', 'Binance 28 (hot wallet)', 'exchange'),
  L('0xF977814e90dA44bFA03b6295A0616a897441aceC', 'Binance 8 (cold wallet)', 'exchange'),
  L('0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8', 'Binance 7 (cold wallet)', 'exchange'),
  L('0x71660c4005BA85c37ccec55d0C4493E66Fe775d3', 'Coinbase 1 (hot wallet)', 'exchange'),
  L('0x503828976D22510aad0201ac7EC88293211D23Da', 'Coinbase 2 (hot wallet)', 'exchange'),
  L('0xddfAbCdc4D8FfC6d5beaf154f18B778f892A0740', 'Coinbase 3 (hot wallet)', 'exchange'),
  L('0x3cD751E6b0078Be393132286c442345e5DC49699', 'Coinbase 4 (hot wallet)', 'exchange'),
  L('0xb5d85CBf7cB3EE0D56b3bB207D5Fc4B82f43F511', 'Coinbase 5 (hot wallet)', 'exchange'),
  L('0xeB2629a2734e272Bcc07BDA959863f316F4bD4Cf', 'Coinbase 6 (hot wallet)', 'exchange'),
  L('0xA9D1e08C7793af67e9d92fe308d5697FB81d3E43', 'Coinbase 10 (hot wallet)', 'exchange'),
  L('0x2910543Af39abA0Cd09dBb2D50200b3E800A63D2', 'Kraken 4 (hot wallet)', 'exchange'),
  L('0x53d284357ec70cE289D6D64134DfAc8E511c8a3D', 'Kraken 2 (hot wallet)', 'exchange'),
  L('0xe9f7eCAe3A53D2A67105292894676b00d1FbE3ac', 'Kraken 13 (hot wallet)', 'exchange'),
  L('0x6cC5F688a315f3dC28A7781717a9A798a59fDA7b', 'OKX (hot wallet)', 'exchange'),
  L('0x876EabF441B2EE5B5b0554Fd502a8E0600950cFa', 'Bitfinex (hot wallet)', 'exchange'),
  L('0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'Bitfinex 2 (cold wallet)', 'exchange'),
  L('0x0D0707963952f2fBA59dD06f2b425ace40b492Fe', 'Gate.io (hot wallet)', 'exchange'),
  L('0xf89d7b9c864f589bbF53a82105107622B35EaA40', 'Bybit (hot wallet)', 'exchange'),
  L('0x2B5634C42055806a59e9107ED44D43c426E58258', 'KuCoin (hot wallet)', 'exchange'),
  L('0xAb5C66752a9e8167967685F1450532fB96d5d24f', 'HTX / Huobi (hot wallet)', 'exchange'),
  L('0x6262998Ced04146fA42253a5C0AF90CA02dfd2A3', 'Crypto.com (hot wallet)', 'exchange'),
  L('0xD24400ae8BfEBb18cA49Be86258a3C749cf46853', 'Gemini (hot wallet)', 'exchange'),
  L('0xFBb1b73C4f0BDa4f67dcA266ce6Ef42f520fBB98', 'Bittrex (hot wallet)', 'exchange'),
  L('0x8894E0a0c962CB723c1976a4421c95949bE2D4E3', 'Binance (hot wallet)', 'exchange', 'bsc'),

  // --- Bridges (L1 side on Ethereum unless noted) ----------------------
  L('0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a', 'Arbitrum One: Bridge', 'bridge'),
  L('0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f', 'Arbitrum One: Delayed Inbox', 'bridge'),
  L('0xa3A7B6F88361F48403514059F1F16C8E78d60EeC', 'Arbitrum One: L1 ERC20 Gateway', 'bridge'),
  L('0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef', 'Arbitrum One: L1 Gateway Router', 'bridge'),
  L('0x5288c571Fd7aD117beA99bF60FE0846C4E84F933', 'Arbitrum One: L2 Gateway Router', 'bridge', 'arbitrum'),
  L('0x0000000000000000000000000000000000000064', 'Arbitrum: ArbSys precompile', 'infrastructure', 'arbitrum'),
  L('0xbEb5Fc579115071764c7423A4f12eDde41f106Ed', 'Optimism: Portal', 'bridge'),
  L('0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1', 'Optimism: L1 Standard Bridge', 'bridge'),
  L('0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1', 'Optimism: L1 Cross Domain Messenger', 'bridge'),
  L('0x49048044D57e1C92A77f79988d21Fa8fAF74E97e', 'Base: Portal', 'bridge'),
  L('0x3154Cf16ccdb4C6d922629664174b904d80F2C35', 'Base: L1 Standard Bridge', 'bridge'),
  L('0x866E82a600A1414e583f7F13623F1aC5d58b0Afa', 'Base: L1 Cross Domain Messenger', 'bridge'),
  L('0x4200000000000000000000000000000000000010', 'OP Stack: L2 Standard Bridge', 'bridge', 'optimism'),
  L('0x4200000000000000000000000000000000000007', 'OP Stack: L2 Cross Domain Messenger', 'bridge', 'optimism'),
  L('0x4200000000000000000000000000000000000010', 'OP Stack: L2 Standard Bridge', 'bridge', 'base'),
  L('0x4200000000000000000000000000000000000007', 'OP Stack: L2 Cross Domain Messenger', 'bridge', 'base'),
  L('0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf', 'Polygon PoS: ERC20 Bridge (predicate)', 'bridge'),
  L('0x8484Ef722627bf18ca5Ae6BcF031c23E6e922B30', 'Polygon PoS: Ether Bridge (predicate)', 'bridge'),
  L('0x401F6c983eA34274ec46f84D70b31C151321188b', 'Polygon PoS: Plasma Bridge', 'bridge'),
  L('0xA0c68C638235ee32657e8f720a23ceC1bFc77C77', 'Polygon PoS: Root Chain Manager', 'bridge'),
  L('0xA6FA4fB5f76172d178d61B04b0ecd319C5d1C0aa', 'Polygon PoS: Child Chain Manager', 'bridge', 'polygon'),
  L('0x32400084C286CF3E17e7B677ea9583e60a000324', 'zkSync Era: Diamond Proxy (bridge)', 'bridge'),
  L('0xd19d4B5d358258f05D7B411E21A1460D11B0876F', 'Linea: L1 Message Service', 'bridge'),
  L('0x6774Bcbd5ceCeF1336b5300fb5186a12DDD8b367', 'Scroll: L1 Messenger', 'bridge'),
  L('0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe', 'Polygon zkEVM: Bridge', 'bridge', 'evm'),
  L('0x8731d54E9D02c286767d56ac03e8037C07e01e98', 'Stargate: Router', 'bridge'),
  L('0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5', 'Across: Ethereum SpokePool', 'bridge'),
  L('0x3ee18B2214AFF97000D974cf647E7C347E8fa585', 'Wormhole: Token Bridge', 'bridge'),
  L('0x66A71Dcef29A0fFBDBE3c6a460a3B5BC225Cd675', 'LayerZero: Endpoint V1', 'bridge'),
  L('0x6b7a87899490EcE95443e979cA9485CBE7E71522', 'Multichain (Anyswap): Router V4 (defunct)', 'bridge'),
  L('0x8EB8a3b98659Cce290402893d0123abb75E3ab28', 'Avalanche Bridge', 'bridge'),
  L('0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820', 'Celer: cBridge', 'bridge', 'evm'),
  L('0xb8901acB165ed027E32754E0FFe830802919727f', 'Hop Protocol: ETH Bridge', 'bridge'),
  L('0x2796317b0fF8538F253012862c06787Adfb8cEb6', 'Synapse: Bridge', 'bridge'),

  // --- Mixers / privacy pools (Ethereum) -------------------------------
  L('0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b', 'Tornado Cash: Router', 'mixer'),
  L('0x722122dF12D4e14e13Ac3b6895a86e84145b6967', 'Tornado Cash: Proxy (legacy)', 'mixer'),
  L('0x12D66f87A04A9E220743712cE6d9bB1B5616B8Fc', 'Tornado Cash: 0.1 ETH pool', 'mixer'),
  L('0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936', 'Tornado Cash: 1 ETH pool', 'mixer'),
  L('0x910Cbd523D972eb0a6f4cAe4618aD62622b39DbF', 'Tornado Cash: 10 ETH pool', 'mixer'),
  L('0xA160cdAB225685dA1d56aa342Ad8841c3b53f291', 'Tornado Cash: 100 ETH pool', 'mixer'),
  L('0xD4B88Df4D29F5CedD6857912842cff3b20C8Cfa3', 'Tornado Cash: 100 DAI pool', 'mixer'),
  L('0xFD8610d20aA15b7B2E3Be39B396a1bC3516c7144', 'Tornado Cash: 1,000 DAI pool', 'mixer'),
  L('0x07687e702b410Fa43f4cB4Af7FA097918ffD2730', 'Tornado Cash: 10,000 DAI pool', 'mixer'),
  L('0x23773E65ed146A459791799d01336DB287f25334', 'Tornado Cash: 100,000 DAI pool', 'mixer'),
  L('0x22aaA7720ddd5388A3c0A3333430953C68f1849b', 'Tornado Cash: 5,000 cDAI pool', 'mixer'),
  L('0x03893a7c7463AE47D46bc7f091665f1893656003', 'Tornado Cash: 50,000 cDAI pool', 'mixer'),
  L('0x2717c5e28cf931547B621a5dddb772Ab6A35B701', 'Tornado Cash: 500,000 cDAI pool', 'mixer'),
  L('0xD21be7248e0197Ee08E0c20D4a96DEBdaC3D20Af', 'Tornado Cash: 5,000,000 cDAI pool', 'mixer'),
  L('0xd96f2B1c14Db8458374d9Aca76E26c3D18364307', 'Tornado Cash: 1,000 USDC pool', 'mixer'),
  L('0x4736dCf1b7A3d580672CcE6E7c65cd5cc9cFBa19', 'Tornado Cash: 10,000 USDC pool', 'mixer'),
  L('0x169AD27A470D064DEDE56a2D3ff727986b15D52B', 'Tornado Cash: 1,000 USDT pool', 'mixer'),
  L('0x178169B423a011fff22B9e3F3abeA13414dDD0F1', 'Tornado Cash: 0.1 WBTC pool', 'mixer'),
  L('0x610B717796ad172B316836AC95a2ffad065CeaB4', 'Tornado Cash: 1 WBTC pool', 'mixer'),
  L('0xbB93e510BbCD0B7beb5A853875f9eC60275CF498', 'Tornado Cash: 10 WBTC pool', 'mixer'),
  L('0x77777FeDdddFfC19Ff86DB637967013e6C6A116C', 'Tornado Cash: TORN token', 'mixer'),
  L('0x5efda50f22d34F262c29268506C5Fa42cB56A1Ce', 'Tornado Cash: Governance', 'mixer'),
  L('0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9', 'Railgun: Smart Wallet (privacy pool)', 'mixer'),

  // --- Sanctioned (well-documented OFAC entries; see sanctions.ts) -----
  L('0x098B716B8Aaf21512996dC57EB0615e2383E2f96', 'Lazarus Group: Ronin Bridge exploiter (OFAC SDN)', 'sanctioned', 'evm', 'https://ofac.treasury.gov/recent-actions/20220414'),

  // --- Bitcoin ----------------------------------------------------------
  L('34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo', 'Binance (cold wallet)', 'exchange', 'bitcoin'),
  L('bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97', 'Bitfinex (cold wallet)', 'exchange', 'bitcoin'),
  L('1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF', 'Mt. Gox (hacked exchange, 2011 theft wallet)', 'exchange', 'bitcoin'),
  L('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'Genesis block coinbase (Satoshi)', 'other', 'bitcoin'),
  L('1HQ3Go3ggs8pFnXuHVHRytPCq5fGG8Hbhx', 'Silk Road funds (seized by US DOJ, 2020)', 'other', 'bitcoin'),

  // --- Solana -----------------------------------------------------------
  L('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', 'Binance (hot wallet)', 'exchange', 'solana'),
  L('H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', 'Coinbase (hot wallet)', 'exchange', 'solana'),
  L('11111111111111111111111111111111', 'System Program', 'infrastructure', 'solana'),
  L('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'SPL Token Program', 'infrastructure', 'solana'),
  L('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'SPL Token-2022 Program', 'infrastructure', 'solana'),
  L('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'Associated Token Account Program', 'infrastructure', 'solana'),
  L('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo Program', 'infrastructure', 'solana'),
  L('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', 'Metaplex: Token Metadata Program', 'nft', 'solana'),
  L('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'Jupiter: Aggregator v6', 'dex', 'solana'),
  L('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'Raydium: AMM v4 (Liquidity Pool)', 'dex', 'solana'),
  L('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', 'Orca: Whirlpool', 'dex', 'solana'),
  L('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'Pump.fun: Bonding curve program', 'dex', 'solana'),
  L('wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb', 'Wormhole: Token Bridge', 'bridge', 'solana'),
  L('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC (Circle) mint', 'token', 'solana'),
  L('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT (Tether) mint', 'token', 'solana'),
  L('So11111111111111111111111111111111111111112', 'Wrapped SOL mint', 'token', 'solana'),
];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const store = new Map<string, Entry[]>();
let seq = 0;

/**
 * Add or replace labels. A label replaces any earlier label with the same
 * address and scope; different scopes coexist and are resolved at lookup.
 * Invalid entries (missing address or name) are ignored.
 */
export function registerLabels(labels: AddressLabel[]): void {
  for (const label of labels ?? []) {
    if (!label || typeof label.address !== 'string' || !label.address.trim() || typeof label.name !== 'string') continue;
    const key = normalizeAddress(label.address);
    const scope: Scope = label.chain ?? 'any';
    const entry: Entry = { label, scope, seq: ++seq, builtin: label.source === 'builtin' };
    const list = store.get(key);
    if (!list) {
      store.set(key, [entry]);
      continue;
    }
    const idx = list.findIndex((e) => e.scope === scope);
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
  }
}

/** Best label for an address, optionally restricted to labels whose scope covers `chain`. */
export function lookupLabel(address: string, chain?: ChainId): AddressLabel | undefined {
  if (!address) return undefined;
  const list = store.get(normalizeAddress(address));
  if (!list) return undefined;
  let best: Entry | undefined;
  for (const e of list) {
    if (!scopeMatches(e.scope, chain)) continue;
    if (!best || better(e, best)) best = e;
  }
  return best?.label;
}

/** Snapshot of every known address (normalised key) → its best unscoped label. */
export function labelMap(): Map<string, AddressLabel> {
  const out = new Map<string, AddressLabel>();
  for (const [key, list] of store) {
    let best: Entry | undefined;
    for (const e of list) if (!best || better(e, best)) best = e;
    if (best) out.set(key, best.label);
  }
  return out;
}

/** All labels registered for an address (every scope), most relevant first. */
export function labelsFor(address: string): AddressLabel[] {
  const list = store.get(normalizeAddress(address)) ?? [];
  return [...list].sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0)).map((e) => e.label);
}

/** Remove every registered label matching `predicate`; returns the number removed. */
export function unregisterLabels(predicate: (label: AddressLabel) => boolean): number {
  let removed = 0;
  for (const [key, list] of store) {
    const kept = list.filter((e) => !predicate(e.label));
    removed += list.length - kept.length;
    if (kept.length) store.set(key, kept);
    else store.delete(key);
  }
  return removed;
}

/** Drop every runtime registration and restore the built-in list (tests / settings reset). */
export function resetLabels(): void {
  store.clear();
  seq = 0;
  registerLabels(BUILTIN_LABELS);
}

registerLabels(BUILTIN_LABELS);
