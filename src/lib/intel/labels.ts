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
import { CHAINS, findChain } from '../chains/registry';

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

/** One label per chain, for a contract deployed at the same address on an explicit set of chains. */
function LM(address: string, name: string, category: LabelCategory, chains: readonly ChainId[], url?: string): AddressLabel[] {
  return chains.map((chain) => L(address, name, category, chain, url));
}

/**
 * zkSync Era uses different bytecode and CREATE2 semantics, so the canonical
 * "same address everywhere" infrastructure contracts live at other addresses
 * there. Every other EVM chain in the registry.
 */
const EVM_EXCEPT_ZKSYNC: readonly ChainId[] = CHAINS.filter((c) => c.family === 'evm' && c.id !== 'zksync').map((c) => c.id);

/** Chains where the Uniswap V3 core contracts share the mainnet addresses. */
const UNISWAP_V3_CANONICAL: readonly ChainId[] = ['ethereum', 'arbitrum', 'optimism', 'polygon'];

/**
 * High-confidence, long-lived, widely documented addresses. Mainnet-only
 * contracts use `chain: 'ethereum'`; contracts deployed at the same address on
 * every EVM chain use `chain: 'evm'`; contracts that share an address on only
 * some chains get one entry per chain (`LM`).
 */
export const BUILTIN_LABELS: AddressLabel[] = [
  // --- Burn / null (every EVM chain) -------------------------------------
  L('0x0000000000000000000000000000000000000000', 'Null address (0x0)', 'burn', 'evm'),
  L('0x000000000000000000000000000000000000dEaD', 'Burn address (0xdead)', 'burn', 'evm'),

  // --- Infrastructure deployed at the same address on many chains --------
  ...LM('0xcA11bde05977b3631167028862bE2a173976CA11', 'Multicall3', 'infrastructure', EVM_EXCEPT_ZKSYNC),
  ...LM('0x000000000022D473030F116dDEE9F6B43aC78BA3', 'Permit2 (Uniswap)', 'infrastructure', EVM_EXCEPT_ZKSYNC),
  ...LM('0x4e59b44847b379578588920cA78FbF26c0B4956C', 'Deterministic deployment proxy (CREATE2 factory)', 'infrastructure', EVM_EXCEPT_ZKSYNC),
  ...LM('0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2', 'Safe: Proxy Factory 1.3.0', 'infrastructure', EVM_EXCEPT_ZKSYNC),
  L('0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67', 'Safe: Proxy Factory 1.4.1', 'infrastructure', 'evm'),
  ...LM('0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552', 'Safe: Singleton 1.3.0', 'infrastructure', EVM_EXCEPT_ZKSYNC),
  ...LM('0x3E5c63644E683549055b9Be8653de26E0B4CD36E', 'Safe: Singleton L2 1.3.0', 'infrastructure', EVM_EXCEPT_ZKSYNC),
  L('0x1a44076050125825900e736c501f859c50fE728c', 'LayerZero: Endpoint V2', 'bridge', 'evm'),
  L('0x00000000219ab540356cBB839Cbe05303d7705Fa', 'Ethereum: Beacon Chain Deposit Contract', 'infrastructure'),

  // --- DEX routers / AMMs -------------------------------------------------
  L('0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', 'Uniswap V2: Router 2', 'dex'),
  L('0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f', 'Uniswap V2: Factory', 'dex'),
  L('0xE592427A0AeCe92De3Edee1F8F0fBd7cc5f1B6E6', 'Uniswap V3: SwapRouter', 'dex'),
  L('0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', 'Uniswap V3: SwapRouter02', 'dex'),
  ...LM('0x1F98431c8aD98523631AE4a59f267346ea31F984', 'Uniswap V3: Factory', 'dex', UNISWAP_V3_CANONICAL),
  ...LM('0xC36442b4a4522E871399CD717aBDD847Ab11FE88', 'Uniswap V3: Positions NFT', 'dex', UNISWAP_V3_CANONICAL),
  L('0x33128a8fC17869897dcE68Ed026d694621f6FDfD', 'Uniswap V3: Factory', 'dex', 'base'),
  L('0x2626664c2603336E57B271c5C0b26F421741e481', 'Uniswap V3: SwapRouter02', 'dex', 'base'),
  ...LM('0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', 'Uniswap: Universal Router', 'dex', [...UNISWAP_V3_CANONICAL, 'base']),
  ...LM('0x000000000004444c5dc75cB358380D2e3dE08A90', 'Uniswap V4: PoolManager', 'dex', ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc', 'avalanche', 'blast']),
  L('0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43', 'Aerodrome: Router', 'dex', 'base'),
  L('0x1111111254EEB25477B68fb85Ed929f73A960582', '1inch: Aggregation Router V5', 'dex', 'evm'),
  L('0x1111111254fb6c44bAC0beD2854e76F90643097d', '1inch: Aggregation Router V4', 'dex', 'evm'),
  L('0x111111125421cA6dc452d289314280a0f8842A65', '1inch: Aggregation Router V6', 'dex', 'evm'),
  L('0xDef1C0ded9bec7F1a1670819833240f027b25EfF', '0x: Exchange Proxy', 'dex', 'evm'),
  L('0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F', 'SushiSwap: Router', 'dex'),
  L('0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', 'SushiSwap: Router', 'dex', 'polygon'),
  L('0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7', 'Curve: 3pool (DAI/USDC/USDT)', 'dex'),
  L('0xBA12222222228d8Ba445958a75a0704d566BF2C8', 'Balancer: Vault', 'dex', 'evm'),
  L('0x10ED43C718714eb63d5aA57B78B54704E256024E', 'PancakeSwap V2: Router', 'dex', 'bsc'),
  L('0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', 'PancakeSwap V3: SwapRouter', 'dex', 'bsc'),
  L('0x60aE616a2155Ee3d9A68541Ba4544862310933d4', 'Trader Joe: Router', 'dex', 'avalanche'),

  // --- Lending ----------------------------------------------------------
  L('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', 'Aave V3: Pool', 'lending'),
  L('0x794a61358D6845594F94dc1DB02A252b5b4814aD', 'Aave V3: Pool', 'lending', 'polygon'),
  L('0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9', 'Aave V2: LendingPool', 'lending'),
  L('0x39AA39c021dfbaE8faC545936693aC917d5E7563', 'Compound V2: cUSDC', 'lending'),
  L('0xf650C3d88D12dB855b8bf7D11Be6C55A4e07dCC9', 'Compound V2: cUSDT', 'lending'),
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
  L('0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1', 'Lido: Withdrawal Queue (unstETH)', 'infrastructure'),
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
  ...LM('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 'cbBTC (Coinbase Wrapped BTC)', 'token', ['ethereum', 'base']),

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
  L('0x0000000000A39bb272e79075ade125fd351887Ac', 'Blur: Pool', 'nft'),
  L('0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e', 'ENS: Registry', 'infrastructure'),
  L('0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63', 'ENS: Public Resolver', 'infrastructure'),
  L('0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85', 'ENS: Base Registrar (.eth NFT)', 'infrastructure'),
  L('0x283Af0B28c62C092C9727F1Ee09c02CA627EB7F5', 'ENS: ETH Registrar Controller (legacy)', 'infrastructure'),

  // --- Issuers (Ethereum) ----------------------------------------------
  L('0x5754284f345afc66a98fbB0a0Afe71e0F007B949', 'Tether: Treasury', 'other'),

  // --- Centralised exchanges (Ethereum) --------------------------------
  L('0x3f5CE5FBFe3E9af3971dD833D26bA9b5C936f0bE', 'Binance 1 (hot wallet)', 'exchange'),
  L('0xD551234Ae421e3BCBA99A0Da6d736074f22192FF', 'Binance 2 (hot wallet)', 'exchange'),
  L('0x564286362092D8e7936f0549571a803B203aAceD', 'Binance 3 (hot wallet)', 'exchange'),
  L('0x0681d8Db095565FE8A346fA0277bFfdE9C0eDBBF', 'Binance 4 (hot wallet)', 'exchange'),
  L('0xfE9e8709d3215310075d67E3ed32A380CCf451C8', 'Binance 5 (hot wallet)', 'exchange'),
  L('0x4E9ce36E442e55EcD9025B9a6E0D88485d628A67', 'Binance 6 (hot wallet)', 'exchange'),
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
  L('0x53d284357ec70cE289D6D64134DfAc8E511c8a3D', 'Kraken (hot wallet)', 'exchange'),
  L('0xe9f7eCAe3A53D2A67105292894676b00d1FbE3ac', 'Kraken (hot wallet)', 'exchange'),
  L('0x6cC5F688a315f3dC28A7781717a9A798a59fDA7b', 'OKX (hot wallet)', 'exchange'),
  L('0x876EabF441B2EE5B5b0554Fd502a8E0600950cFa', 'Bitfinex', 'exchange'),
  L('0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'Bitfinex', 'exchange'),
  L('0x75e89d5979E4f6Fba9F97c104c2F0AFB3F1dcB88', 'MEXC (hot wallet)', 'exchange'),
  L('0xC098B2a3Aa256D2140208C3de6543aAEf5cd3A94', 'FTX Exchange (defunct, hot wallet)', 'exchange'),
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
  L('0x4200000000000000000000000000000000000016', 'OP Stack: L2ToL1MessagePasser', 'bridge', 'optimism'),
  L('0x4200000000000000000000000000000000000010', 'OP Stack: L2 Standard Bridge', 'bridge', 'base'),
  L('0x4200000000000000000000000000000000000007', 'OP Stack: L2 Cross Domain Messenger', 'bridge', 'base'),
  L('0x4200000000000000000000000000000000000016', 'OP Stack: L2ToL1MessagePasser', 'bridge', 'base'),
  L('0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf', 'Polygon PoS: ERC20 Bridge (predicate)', 'bridge'),
  L('0x8484Ef722627bf18ca5Ae6BcF031c23E6e922B30', 'Polygon PoS: Ether Bridge (predicate)', 'bridge'),
  L('0x401F6c983eA34274ec46f84D70b31C151321188b', 'Polygon PoS: Plasma Bridge', 'bridge'),
  L('0xA0c68C638235ee32657e8f720a23ceC1bFc77C77', 'Polygon PoS: Root Chain Manager', 'bridge'),
  L('0xA6FA4fB5f76172d178d61B04b0ecd319C5d1C0aa', 'Polygon PoS: Child Chain Manager', 'bridge', 'polygon'),
  L('0x32400084C286CF3E17e7B677ea9583e60a000324', 'zkSync Era: Diamond Proxy (bridge)', 'bridge'),
  L('0xd19d4B5d358258f05D7B411E21A1460D11B0876F', 'Linea: L1 Message Service', 'bridge'),
  L('0x6774Bcbd5ceCeF1336b5300fb5186a12DDD8b367', 'Scroll: L1 Messenger', 'bridge'),
  ...LM('0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe', 'Polygon zkEVM: Bridge', 'bridge', ['ethereum', 'polygon-zkevm']),
  L('0x8731d54E9D02c286767d56ac03e8037C07e01e98', 'Stargate: Router', 'bridge'),
  L('0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5', 'Across: Ethereum SpokePool', 'bridge'),
  L('0x3ee18B2214AFF97000D974cf647E7C347E8fa585', 'Wormhole: Token Bridge', 'bridge'),
  L('0x66A71Dcef29A0fFBDBE3c6a460a3B5BC225Cd675', 'LayerZero: Endpoint V1', 'bridge'),
  L('0x6b7a87899490EcE95443e979cA9485CBE7E71522', 'Multichain (Anyswap): Router V4 (defunct)', 'bridge'),
  L('0x8EB8a3b98659Cce290402893d0123abb75E3ab28', 'Avalanche Bridge', 'bridge'),
  L('0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820', 'Celer: cBridge', 'bridge'),
  L('0xb8901acB165ed027E32754E0FFe830802919727f', 'Hop Protocol: ETH Bridge', 'bridge'),
  L('0x2796317b0fF8538F253012862c06787Adfb8cEb6', 'Synapse: Bridge', 'bridge'),
  L('0x1A2a1c938CE3eC39b6D47113c7955bAa9DD454F2', 'Ronin Bridge v1 (exploited March 2022)', 'bridge'),

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
  L('0xd96f2B1c14Db8458374d9Aca76E26c3D18364307', 'Tornado Cash: 100 USDC pool', 'mixer'),
  L('0x4736dCf1b7A3d580672CcE6E7c65cd5cc9cFBa19', 'Tornado Cash: 1,000 USDC pool', 'mixer'),
  L('0x169AD27A470D064DEDE56a2D3ff727986b15D52B', 'Tornado Cash: 100 USDT pool', 'mixer'),
  L('0x0836222F2B2B24A3F36f98668Ed8F0B38D1a872f', 'Tornado Cash: 1,000 USDT pool', 'mixer'),
  L('0x178169B423a011fff22B9e3F3abeA13414dDD0F1', 'Tornado Cash: 0.1 WBTC pool', 'mixer'),
  L('0x610B717796ad172B316836AC95a2ffad065CeaB4', 'Tornado Cash: 1 WBTC pool', 'mixer'),
  L('0xbB93e510BbCD0B7beb5A853875f9eC60275CF498', 'Tornado Cash: 10 WBTC pool', 'mixer'),
  // The TORN token and governance contracts are not mixing pools (the OFAC history
  // lives in sanctions.ts), so a wallet that merely holds TORN is not a mixer user.
  L('0x77777FeDdddFfC19Ff86DB637967013e6C6A116C', 'Tornado Cash: TORN token', 'token'),
  L('0x5efda50f22d34F262c29268506C5Fa42cB56A1Ce', 'Tornado Cash: Governance', 'infrastructure'),
  L('0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9', 'Railgun: Smart Wallet (privacy pool)', 'mixer'),

  // --- Sanctioned (well-documented OFAC entries; see sanctions.ts) -----
  L('0x098B716B8Aaf21512996dC57EB0615e2383E2f96', 'Lazarus Group: Ronin Bridge exploiter (OFAC SDN)', 'sanctioned', 'evm', 'https://ofac.treasury.gov/recent-actions/20220414'),

  // --- Exploiters / scams ------------------------------------------------
  L('0x47666Fab8bd0Ac7003bce3f5C3585383F09486E2', 'Bybit exploiter (Lazarus / TraderTraitor, 2025-02-21)', 'scam'),

  // --- Bitcoin ----------------------------------------------------------
  L('34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo', 'Binance (cold wallet)', 'exchange', 'bitcoin'),
  L('bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97', 'Bitfinex (cold wallet)', 'exchange', 'bitcoin'),
  // Controlled by the 2011 thief, not by the exchange, hence not 'exchange'.
  L('1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF', 'Mt. Gox 2011 theft wallet (79,956 BTC stolen from the exchange)', 'other', 'bitcoin'),
  L('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'Genesis block coinbase (Satoshi)', 'other', 'bitcoin'),
  L('1HQ3Go3ggs8pFnXuHVHRytPCq5fGG8Hbhx', 'Silk Road funds (seized by US DOJ, 2020)', 'other', 'bitcoin'),
  L('1FfmbHfnpaZjKFvyi1okTjJJusN455paPH', 'Silk Road: DPR wallet seized by the FBI (2013)', 'other', 'bitcoin'),
  // 2016 Bitfinex hack proceeds, seized by the US DOJ in February 2022 (Lichtenstein / Morgan).
  L('bc1qazcm763858nkj2dj986etajv6wquslv8uxwczt', 'Bitfinex 2016 hack funds (seized by US DOJ, 2022)', 'other', 'bitcoin'),
  L('bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h', 'Binance (cold wallet)', 'exchange', 'bitcoin'),
  L('3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6', 'Binance (cold wallet)', 'exchange', 'bitcoin'),
  L('1LQoWist8KkaUXSPKZHNvEyfrEkPHzSsCd', 'HTX / Huobi (cold wallet)', 'exchange', 'bitcoin'),
  // Block 9 coinbase: the source of the first ever bitcoin transaction (to Hal Finney, Jan 2009).
  L('12cbQLTFMXRnSzktFkuoG3eHoMeFtpTu3S', 'Satoshi Nakamoto (block 9 coinbase, first tx sender)', 'other', 'bitcoin'),
  L('1Q2TWHE3GMdB6BZKafqwxXtWAWgFt5Jvm3', 'Hal Finney (first bitcoin transaction recipient)', 'other', 'bitcoin'),
  L('1BitcoinEaterAddressDontSendf59kuE', 'Bitcoin Eater (provably unspendable burn address)', 'burn', 'bitcoin'),
  L('1CounterpartyXXXXXXXXXXXXXXXUWLpVr', 'Counterparty proof-of-burn address', 'burn', 'bitcoin'),

  // --- Solana -----------------------------------------------------------
  L('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', 'Binance (hot wallet)', 'exchange', 'solana'),
  L('11111111111111111111111111111111', 'System Program', 'infrastructure', 'solana'),
  L('ComputeBudget111111111111111111111111111111', 'Compute Budget Program', 'infrastructure', 'solana'),
  L('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'SPL Token Program', 'infrastructure', 'solana'),
  L('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'SPL Token-2022 Program', 'infrastructure', 'solana'),
  L('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'Associated Token Account Program', 'infrastructure', 'solana'),
  L('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo Program', 'infrastructure', 'solana'),
  L('Stake11111111111111111111111111111111111111', 'Stake Program', 'infrastructure', 'solana'),
  L('Vote111111111111111111111111111111111111111', 'Vote Program', 'infrastructure', 'solana'),
  L('BPFLoaderUpgradeab1e11111111111111111111111', 'BPF Upgradeable Loader', 'infrastructure', 'solana'),
  L('AddressLookupTab1e1111111111111111111111111', 'Address Lookup Table Program', 'infrastructure', 'solana'),
  L('1nc1nerator11111111111111111111111111111111', 'Incinerator (burn address)', 'burn', 'solana'),
  L('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', 'Metaplex: Token Metadata Program', 'nft', 'solana'),
  L('BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY', 'Metaplex: Bubblegum (compressed NFTs)', 'nft', 'solana'),
  L('M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K', 'Magic Eden: Marketplace v2', 'nft', 'solana'),
  L('TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN', 'Tensor: Swap', 'nft', 'solana'),
  L('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'Jupiter: Aggregator v6', 'dex', 'solana'),
  L('JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', 'Jupiter: Aggregator v4', 'dex', 'solana'),
  L('DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M', 'Jupiter: DCA', 'dex', 'solana'),
  L('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'Raydium: AMM v4 (Liquidity Pool)', 'dex', 'solana'),
  L('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', 'Raydium: CLMM', 'dex', 'solana'),
  L('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', 'Raydium: CPMM', 'dex', 'solana'),
  L('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', 'Orca: Whirlpool', 'dex', 'solana'),
  L('9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', 'Orca: Token Swap v2', 'dex', 'solana'),
  L('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 'Meteora: DLMM', 'dex', 'solana'),
  L('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX', 'OpenBook (Serum v3): DEX', 'dex', 'solana'),
  L('MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD', 'Marinade Finance: Liquid staking', 'other', 'solana'),
  L('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'Pump.fun: Bonding curve program', 'dex', 'solana'),
  L('wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb', 'Wormhole: Token Bridge', 'bridge', 'solana'),
  L('worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth', 'Wormhole: Core Bridge', 'bridge', 'solana'),
  L('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC (Circle) mint', 'token', 'solana'),
  L('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT (Tether) mint', 'token', 'solana'),
  L('So11111111111111111111111111111111111111112', 'Wrapped SOL mint', 'token', 'solana'),
  L('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 'JUP (Jupiter) mint', 'token', 'solana'),
  L('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'BONK mint', 'token', 'solana'),
  L('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', 'mSOL (Marinade staked SOL) mint', 'token', 'solana'),
  L('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', 'jitoSOL (Jito staked SOL) mint', 'token', 'solana'),
  L('2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', 'PYUSD (PayPal USD) mint', 'token', 'solana'),

  // =====================================================================
  // Extended set (exchanges on BTC/SOL/EVM, L2 canonical contracts, DEX /
  // lending / token coverage per chain, Solana programs). Same confidence
  // bar as above: long-lived, widely documented addresses only.
  // =====================================================================

  // --- Centralised exchanges (EOAs: the same key controls the address on every EVM chain) ---
  L('0x40B38765696e3d5d8d9d834D8AaD4bB6e418E489', 'Robinhood (cold wallet)', 'exchange', 'evm'),
  L('0x85b931A32a0725Be14285B66f1a22178c672d69B', 'Binance 10 (hot wallet)', 'exchange', 'evm'),
  L('0x708396f17127c42383E3b9014072679b2F60B82f', 'Binance 11 (hot wallet)', 'exchange', 'evm'),
  L('0xE0F0CfDe7Ee664943906f17F7f14342E76A5CeC7', 'Binance 12 (hot wallet)', 'exchange', 'evm'),
  L('0xe2fc31F816A9b94326492132018C3aEcC4a93aE1', 'Binance (hot wallet)', 'exchange', 'evm'),
  L('0x77696bb39917C91A0c3908D577d5e322095425cA', 'Coinbase 11 (hot wallet)', 'exchange', 'evm'),
  L('0xA090e606E30bD747d4E6245a1517EbE430F0057e', 'Coinbase (hot wallet)', 'exchange', 'evm'),
  L('0x267be1C1D684F78cb4F6a176C4911b741E4Ffdc0', 'Kraken (hot wallet)', 'exchange', 'evm'),
  L('0x0A869d79a7052C7f1b55a8EbAbbEa3420F0D1E13', 'Kraken (hot wallet)', 'exchange', 'evm'),
  L('0xFa52274DD61E1643d2205169732f29114BC240b3', 'Kraken 6 (hot wallet)', 'exchange', 'evm'),
  L('0x5041ed759Dd4aFc3a72b8192C143F72f4724081A', 'OKX (hot wallet)', 'exchange', 'evm'),
  L('0x2c8FBB630289363Ac80705A1a61273f76fD5a161', 'OKX (hot wallet)', 'exchange', 'evm'),
  L('0x98EC059Dc3aDFBdd63429454aEB0c990FBA4A128', 'OKX (hot wallet)', 'exchange', 'evm'),
  L('0x1Db92e2EeBC8E0c075a02BeA49a2935BcD2dFCF4', 'Bybit: Cold Wallet (Safe, drained 2025-02-21)', 'exchange'),
  L('0xee5B5B923fFcE93A870B3104b7CA09c3db80047A', 'Bybit (hot wallet)', 'exchange', 'evm'),
  L('0x77134cbC06cB00b66F4c7e623D5fdBF6777635EC', 'Bitfinex 5 (exchange wallet)', 'exchange', 'evm'),
  L('0x1151314c646Ce4E0eFD76d1aF4760aE66a9Fe30F', 'Bitfinex 4 (exchange wallet)', 'exchange', 'evm'),
  L('0x5f65f7b609678448494De4C87521CdF6cEf1e932', 'Gemini 4 (hot wallet)', 'exchange', 'evm'),
  L('0x6748F50f686bfbcA6Fe8ad62b22228b87F31ff2b', 'HTX / Huobi 2 (hot wallet)', 'exchange', 'evm'),
  L('0xeEe28d484628d41A82d01e21d12E2E78D69920da', 'HTX / Huobi 4 (hot wallet)', 'exchange', 'evm'),
  L('0x689C56AEf474Df92D44A1B70850f808488F9769C', 'KuCoin 2 (hot wallet)', 'exchange', 'evm'),
  L('0x1C4b70a3968436B9A0a9cf5205c787eb81Bb558c', 'Gate.io 3 (hot wallet)', 'exchange', 'evm'),
  L('0x46340b20830761efd32832A74d7169B29FEB9758', 'Crypto.com 2 (hot wallet)', 'exchange', 'evm'),
  L('0x72A53cDBBcc1b9efa39c834A540550e23463AAcB', 'Crypto.com 3 (hot wallet)', 'exchange', 'evm'),
  L('0x0639556F03714A74a5fEEaF5736a4A64fF70D206', 'Bitget (hot wallet)', 'exchange', 'evm'),
  L('0x5bdf85216ec1e38D6458C870992A69e38e03F7Ef', 'Bitget (hot wallet)', 'exchange', 'evm'),
  L('0x0211f3ceDbEf3143223D3ACF0e589747933e8527', 'MEXC 2 (hot wallet)', 'exchange', 'evm'),
  L('0x9642b23Ed1E01Df1092B92641051881a322F5D4E', 'MEXC 3 (hot wallet)', 'exchange', 'evm'),
  L('0x390dE26d772D2e2005C6d1d24afC902bae37a4bB', 'Upbit (hot wallet)', 'exchange', 'evm'),
  L('0x91Dca37856240E5e1906222ec79278b16420Dc92', 'Indodax 1 (hot wallet)', 'exchange', 'evm'),
  L('0x32Be343B94f860124dC4fEe278FDCBD38C102D88', 'Poloniex 1 (hot wallet, legacy)', 'exchange', 'evm'),
  L('0xb794F5eA0ba39494cE839613fffBA74279579268', 'Poloniex 4 (cold wallet)', 'exchange', 'evm'),
  L('0x00BDb5699745f5b860228c8f939ABF1b9Ae374eD', 'Bitstamp 1 (hot wallet)', 'exchange', 'evm'),
  L('0x1522900B6daFac587d499a862861C0869Be6E428', 'Bitstamp 2 (hot wallet)', 'exchange', 'evm'),
  L('0xE94b04a0FeD112f3664e45adb2B8915693dD5FF3', 'Bittrex 2 (hot wallet)', 'exchange', 'evm'),
  L('0x2FAF487A4414Fe77e2327F0bf4AE2a264a776AD2', 'FTX Exchange (defunct, hot wallet)', 'exchange', 'evm'),
  L('0x73AF3bcf944a6559933396c1577B257e2054D935', 'Robinhood 2 (cold wallet)', 'exchange', 'evm'),
  L('0x6b76F8B1e9E59913BfE758821887311bA1805cAB', 'Coinbase (hot wallet)', 'exchange', 'evm'),
  L('0xE853c56864A2ebe4576a807D26Fdc4A0adA51919', 'Kraken (hot wallet)', 'exchange', 'evm'),
  L('0x89e51fA8CA5D66cd220bAed62ED01e8951aa7c40', 'Kraken 8 (hot wallet)', 'exchange', 'evm'),
  L('0xDA9dfA130Df4dE4673b89022EE50ff26f6EA73Cf', 'Kraken 13 (hot wallet)', 'exchange', 'evm'),
  L('0x236F9F97e0E62388479bf9E5BA4889e46B0273C3', 'OKX (hot wallet, ex-OKEx)', 'exchange', 'evm'),
  L('0x4fdd5Eb2FB260149A3903859043e962Ab89D8ED4', 'Bitfinex 3 (exchange wallet)', 'exchange', 'evm'),
  L('0x6Fc82a5fe25A5cDb58bc74600A40A69C065263f8', 'Gemini 2 (hot wallet)', 'exchange', 'evm'),
  L('0x61EDCDf5bb737ADffE5043706e7C5bb1f1a56eEA', 'Gemini 3 (hot wallet)', 'exchange', 'evm'),
  L('0xfdb16996831753d5331fF813c29a93c76834A0AD', 'HTX / Huobi 3 (hot wallet)', 'exchange', 'evm'),
  L('0x5C985E89DDe482eFE97ea9f1950aD149Eb73829B', 'HTX / Huobi 5 (hot wallet)', 'exchange', 'evm'),
  L('0xDc76CD25977E0a5Ae17155770273aD58648900D3', 'HTX / Huobi 6 (hot wallet)', 'exchange', 'evm'),
  L('0xadB2B42F6bD96F5c65920b9ac88619DcE4166f94', 'HTX / Huobi 7 (hot wallet)', 'exchange', 'evm'),
  L('0xa8660c8ffD6D578F657B72c0c811284aef0B735e', 'HTX / Huobi 8 (hot wallet)', 'exchange', 'evm'),
  L('0x1062a747393198f70F71ec65A582423Dba7E5Ab3', 'HTX / Huobi 9 (hot wallet)', 'exchange', 'evm'),
  L('0xE93381fB4c4F14bDa253907b18faD305D799241a', 'HTX / Huobi 10 (hot wallet)', 'exchange', 'evm'),
  L('0xFA4B5Be3f2f84f56703C42eB22142744E95a2c58', 'HTX / Huobi 11 (hot wallet)', 'exchange', 'evm'),
  L('0x46705dfff24256421A05D056c29E81Bdc09723B8', 'HTX / Huobi 12 (hot wallet)', 'exchange', 'evm'),
  L('0xa1D8d972560C2f8144AF871Db508F0B0B10a3fBf', 'KuCoin 3 (hot wallet)', 'exchange', 'evm'),
  L('0x4ad64983349C49dEfE8d7A4686202d24b25D0CE8', 'KuCoin 4 (hot wallet)', 'exchange', 'evm'),
  L('0x1692E170361cEFD1eb7240ec13D048Fd9aF6d667', 'KuCoin 5 (hot wallet)', 'exchange', 'evm'),
  L('0xD6216fC19DB775Df9774a6E33526131dA7D19a2c', 'KuCoin 6 (hot wallet)', 'exchange', 'evm'),
  L('0xe59Cd29be3BE4461d79C0881D238Cbe87D64595A', 'KuCoin 7 (hot wallet)', 'exchange', 'evm'),
  L('0x7793cD85c11a924478d358D49b05b37E91B5810F', 'Gate.io 2 (hot wallet)', 'exchange', 'evm'),
  L('0xD793281182A0e3E023116004778F45c29fc14F19', 'Gate.io 4 (hot wallet)', 'exchange', 'evm'),
  L('0x66f820a414680B5bcda5eECA5dea238543F42054', 'Bittrex 3 (hot wallet)', 'exchange', 'evm'),

  // --- Market makers, issuers, treasuries, notable wallets, prediction markets ---
  L('0xf584F8728B874a6a5c7A8d4d387C9aae9172D621', 'Jump Trading (market maker)', 'other', 'evm'),
  L('0x0000006daea1723962647b7e189d311d757Fb793', 'Wintermute (market maker)', 'other', 'evm'),
  L('0x55FE002aefF02F77364de339a1292923A15844B8', 'Circle (USDC issuer hot wallet)', 'other', 'evm'),
  L('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'vitalik.eth', 'wallet', 'evm'),
  L('0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', 'Polymarket: CTF Exchange', 'other', 'polygon'),
  L('0xC5d563A36AE78145C45a50134d48A1215220f80a', 'Polymarket: Neg Risk CTF Exchange', 'other', 'polygon'),
  L('0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c', 'Lido DAO: Agent (Treasury)', 'other'),
  L('0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe', 'Ethereum Foundation: Treasury', 'other'),

  // --- Sanctioned (OFAC SDN; mirrored in sanctions.ts) -------------------------
  L('0xa0e1c89Ef1a489c9C7dE96311eD5Ce5D32c20E4B', 'Lazarus Group: Ronin Bridge exploiter 2 (OFAC SDN)', 'sanctioned', 'evm', 'https://ofac.treasury.gov/recent-actions/20220422'),
  L('0x3Cffd56B47B7b41c56258D9C7731ABaDc360E073', 'Lazarus Group: Ronin Bridge exploiter 3 (OFAC SDN)', 'sanctioned', 'evm', 'https://ofac.treasury.gov/recent-actions/20220422'),
  L('0x53b6936513e738f44FB50d2b9476730C0Ab3Bfc1', 'Lazarus Group: Ronin Bridge exploiter 4 (OFAC SDN)', 'sanctioned', 'evm', 'https://ofac.treasury.gov/recent-actions/20220422'),

  // --- Exploiters / scams ------------------------------------------------------
  L('0x59ABf3837Fa962d6853b4Cc0a19513AA031fd32b', 'FTX Accounts Drainer (Nov 2022 exploiter)', 'scam', 'evm'),

  // --- Safe / account abstraction infrastructure -------------------------------
  L('0x41675C099F32341bf84BFc5382aF534df5C7461a', 'Safe: Singleton 1.4.1', 'infrastructure', 'evm'),
  L('0x29fcB43b46531BcA003ddC8FCB67FFE91900C762', 'Safe: Singleton L2 1.4.1', 'infrastructure', 'evm'),
  ...LM('0x40A2aCCbd92BCA938b02010E17A5b8929b49130D', 'Safe: MultiSendCallOnly 1.3.0', 'infrastructure', EVM_EXCEPT_ZKSYNC),
  ...LM('0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761', 'Safe: MultiSend 1.3.0', 'infrastructure', EVM_EXCEPT_ZKSYNC),
  ...LM('0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4', 'Safe: CompatibilityFallbackHandler 1.3.0', 'infrastructure', EVM_EXCEPT_ZKSYNC),
  L('0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a', 'Coinbase Smart Wallet: Factory', 'infrastructure', 'evm'),
  L('0x34CfAC646f301356fAa8B21e94227e3583Fe3F5F', 'Safe: Singleton 1.1.1 (legacy)', 'infrastructure'),
  L('0x76E2cFc1F5Fa8F6a5b3fC4c8F4788F0116861F9B', 'Safe: Proxy Factory 1.1.1 (legacy)', 'infrastructure'),
  ...LM('0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789', 'ERC-4337: EntryPoint v0.6', 'infrastructure', EVM_EXCEPT_ZKSYNC),
  ...LM('0x0000000071727De22E5E9d8BAf0edAc6f37da032', 'ERC-4337: EntryPoint v0.7', 'infrastructure', EVM_EXCEPT_ZKSYNC),

  // --- Staking, restaking and oracle infrastructure (Ethereum) -----------------
  L('0x858646372CC42E1A627fcE94aa7A7033e7CF075A', 'EigenLayer: StrategyManager', 'infrastructure'),
  L('0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A', 'EigenLayer: DelegationManager', 'infrastructure'),
  L('0x91E677b07F7AF907ec9a428aafA9fc14a0d3A338', 'EigenLayer: EigenPodManager', 'infrastructure'),
  L('0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46', 'Rocket Pool: RocketStorage', 'infrastructure'),
  L('0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908', 'Polygon PoS: StakeManager', 'infrastructure'),
  L('0x55032650b14df07b85bF18A3a3eC8E0Af2e028d5', 'Lido: Node Operators Registry', 'infrastructure'),
  L('0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', 'Chainlink: ETH/USD Price Feed', 'infrastructure'),

  // --- L2 system contracts and precompiles -------------------------------------
  L('0x000000000000000000000000000000000000800A', 'zkSync Era: L2 ETH token (system contract)', 'infrastructure', 'zksync'),
  L('0x000000000000000000000000000000000000006E', 'Arbitrum: ArbRetryableTx precompile', 'infrastructure', 'arbitrum'),
  L('0x000000000000000000000000000000000000006C', 'Arbitrum: ArbGasInfo precompile', 'infrastructure', 'arbitrum'),
  L('0x00000000000000000000000000000000000000C8', 'Arbitrum: NodeInterface (virtual)', 'infrastructure', 'arbitrum'),

  // --- DEX: Ethereum -----------------------------------------------------------
  L('0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af', 'Uniswap: Universal Router V2', 'dex'),
  ...LM('0x1b81D678ffb9C0263b24A97847620C99d213eB14', 'PancakeSwap V3: SwapRouter', 'dex', ['ethereum', 'bsc', 'base', 'arbitrum']),
  L('0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac', 'SushiSwap: Factory', 'dex'),
  L('0xDC24316b9AE028F1497c275EB9192a3Ea0f67022', 'Curve: stETH/ETH pool', 'dex'),
  L('0xD51a44d3FaE010294C616388b506AcdA1bfAAE46', 'Curve: tricrypto2 (USDT/WBTC/WETH)', 'dex'),
  L('0xEf1c6E67703c7BD7107eed8303Fbe6EC2554BF6B', 'Uniswap: Universal Router (legacy v1)', 'dex'),
  L('0xDcEF968d416a41Cdac0ED8702fAC8128A64241A2', 'Curve: FRAX/USDC (fraxbp)', 'dex'),

  // --- DEX: Base ---------------------------------------------------------------
  L('0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', 'Uniswap V2: Factory (Base)', 'dex', 'base'),
  L('0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', 'Uniswap V2: Router (Base)', 'dex', 'base'),
  L('0x420DD381b31aEf6683db6B902084cB0FFECe40Da', 'Aerodrome: PoolFactory', 'dex', 'base'),
  L('0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A', 'Aerodrome: CL Factory (Slipstream)', 'dex', 'base'),

  // --- DEX: Optimism -----------------------------------------------------------
  L('0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858', 'Velodrome V2: Router', 'dex', 'optimism'),
  L('0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a', 'Velodrome V2: PoolFactory', 'dex', 'optimism'),

  // --- DEX: Arbitrum -----------------------------------------------------------
  L('0xc873fEcbd354f5A56E00E710B90EF4201db2448d', 'Camelot: Router (V2)', 'dex', 'arbitrum'),
  L('0xaBBc5F99639c9B6bCb58544ddf04EFA6802F4064', 'GMX V1: Router', 'dex', 'arbitrum'),
  L('0x489ee077994B6658eAfA855C308275EAd8097C4A', 'GMX V1: Vault', 'dex', 'arbitrum'),
  ...LM('0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', 'SushiSwap: Router', 'dex', ['arbitrum', 'avalanche', 'bsc', 'fantom', 'gnosis']),
  L('0x7f90122BF0700F9E7e1F688fe926940E8839F353', 'Curve: 2pool (USDC/USDT)', 'dex', 'arbitrum'),

  // --- DEX: Polygon ------------------------------------------------------------
  L('0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff', 'QuickSwap: Router', 'dex', 'polygon'),
  L('0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32', 'QuickSwap: Factory', 'dex', 'polygon'),
  L('0xf5b509bB0909a69B1c207E495f687a596C168E12', 'QuickSwap v3: SwapRouter (Algebra)', 'dex', 'polygon'),
  L('0x445FE580eF8d70FF569aB36e80c647af338db351', 'Curve: Aave 3pool (am3CRV)', 'dex', 'polygon'),

  // --- DEX: Avalanche ----------------------------------------------------------
  L('0xb4315e873dBcf96Ffd0acd8EA43f689D8c20fB30', 'Trader Joe: LB Router V2.1', 'dex', 'avalanche'),
  L('0xE54Ca86531e17Ef3616d22Ca28b0D458b6C89106', 'Pangolin: Router', 'dex', 'avalanche'),

  // --- DEX: BNB Chain ----------------------------------------------------------
  L('0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73', 'PancakeSwap V2: Factory', 'dex', 'bsc'),
  ...LM('0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', 'PancakeSwap V3: Factory', 'dex', ['bsc', 'ethereum', 'base', 'arbitrum']),
  L('0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8', 'Biswap: Router', 'dex', 'bsc'),
  L('0xa5f8C5Dbd5F286960b9d90548680aE5ebFf07652', 'PancakeSwap: MasterChef v2', 'dex', 'bsc'),

  // --- DEX: every EVM chain ----------------------------------------------------
  L('0xbA1333333333a1BA1108E8412f11850A5C319bA9', 'Balancer V3: Vault', 'dex', 'evm'),
  L('0x9008D19f58AAbD9eD0D60971565AA8510560ab41', 'CoW Protocol: GPv2 Settlement', 'dex', 'evm'),
  L('0xC92E8bdf79f0507f65a392b0ab4667716BFE0110', 'CoW Protocol: GPv2 Vault Relayer', 'dex', 'evm'),

  // --- DEX: Cronos -------------------------------------------------------------
  L('0x145863Eb42Cf62847A6Ca784e6416C1682b1b2Ae', 'VVS Finance: Router', 'dex', 'cronos'),

  // --- DEX: zkSync Era ---------------------------------------------------------
  L('0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295', 'SyncSwap: Router', 'dex', 'zksync'),

  // --- DEX: Fantom -------------------------------------------------------------
  L('0xF491e7B69E4244ad4002BC14e878a34207E38c29', 'SpookySwap: Router', 'dex', 'fantom'),

  // --- DEX: Moonbeam -----------------------------------------------------------
  L('0x70085a09D30D6f8C4ecF6eE10120d1847383BB57', 'StellaSwap: Router', 'dex', 'moonbeam'),

  // --- Lending (by chain) ------------------------------------------------------
  ...LM('0x794a61358D6845594F94dc1DB02A252b5b4814aD', 'Aave V3: Pool', 'lending', ['arbitrum', 'optimism', 'avalanche', 'fantom']),
  L('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', 'Aave V3: Pool (Base)', 'lending', 'base'),
  L('0x6807dc923806fE8Fd134338EABCA509979a7e0cB', 'Aave V3: Pool (BNB Chain)', 'lending', 'bsc'),
  L('0xb50201558B00496A145fE76f7424749556E326D8', 'Aave V3: Pool (Gnosis)', 'lending', 'gnosis'),
  L('0x8dFf5E27EA6b7AC08EbFdf9eB090F32ee9a30fcf', 'Aave V2: LendingPool (Polygon)', 'lending', 'polygon'),
  L('0xA17581A9E3356d9A858b789D68B4d866e593aE94', 'Compound V3: cWETHv3 (Comet)', 'lending'),
  L('0xb125E6687d4313864e53df431d5425969c15Eb2F', 'Compound V3: cUSDCv3 (Comet, Base)', 'lending', 'base'),
  ...LM('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', 'Morpho Blue', 'lending', ['ethereum', 'base']),
  L('0xC13e21B648A5Ee794902342038FF3aDAB66BE987', 'SparkLend: Pool', 'lending'),
  L('0xfD36E2c2a6789Db23113685031d7F16329158384', 'Venus: Comptroller (Unitroller)', 'lending', 'bsc'),
  L('0xA07c5b74C9B40447a954e1466938b865b6BBea36', 'Venus: vBNB', 'lending', 'bsc'),
  L('0x11fCfe756c05AD438e312a7fd934381537D3cFfe', 'Aave V3: Pool', 'lending', 'scroll'),
  L('0x78e30497a3c7527d953c6B1E3541b021A98Ac43c', 'Aave V3: Pool', 'lending', 'zksync'),
  L('0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac', 'Aave V3: Pool', 'lending', 'linea'),
  L('0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840', 'Compound V3: cUSDTv3 (Comet)', 'lending'),
  L('0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf', 'Compound V3: cUSDbCv3 (Comet)', 'lending', 'base'),
  L('0x46e6b214b524310239732D51387075E0e70970bf', 'Compound V3: cWETHv3 (Comet)', 'lending', 'base'),
  L('0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA', 'Compound V3: cUSDC.ev3 (Comet)', 'lending', 'arbitrum'),
  L('0xF25212E676D1F7F89Cd72fFEe66158f541246445', 'Compound V3: cUSDCv3 (Comet)', 'lending', 'polygon'),
  L('0x2e44e174f7D53F0212823acC11C01A11d58c5bCB', 'Compound V3: cUSDCv3 (Comet)', 'lending', 'optimism'),

  // --- Tokens: Base ------------------------------------------------------------
  L('0x940181a94A35A4569E4529A3CDfB74e38FD98631', 'AERO (Aerodrome)', 'token', 'base'),
  L('0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 'USDT', 'token', 'base'),
  L('0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', 'DEGEN', 'token', 'base'),
  L('0x532f27101965dd16442E59d40670FaF5eBB142E4', 'BRETT', 'token', 'base'),
  L('0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', 'VIRTUAL (Virtuals Protocol)', 'token', 'base'),
  L('0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', 'EURC', 'token', 'base'),
  L('0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', 'wstETH', 'token', 'base'),

  // --- Tokens: Optimism --------------------------------------------------------
  L('0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db', 'VELO (Velodrome V2)', 'token', 'optimism'),
  L('0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4', 'SNX', 'token', 'optimism'),
  L('0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb', 'wstETH', 'token', 'optimism'),

  // --- Tokens: Arbitrum --------------------------------------------------------
  L('0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', 'GMX token', 'token', 'arbitrum'),
  L('0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8', 'PENDLE', 'token', 'arbitrum'),
  ...LM('0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 'DAI', 'token', ['arbitrum', 'optimism']),
  L('0x539bdE0d7Dbd336b79148AA742883198BBF60342', 'MAGIC (Treasure)', 'token', 'arbitrum'),
  L('0x5979D7b546E38E414F7E9822514be443A4800529', 'wstETH', 'token', 'arbitrum'),
  L('0x3d9907F9a368ad0a51Be60f7Da3b97cf940982D8', 'GRAIL token', 'token', 'arbitrum'),
  L('0x4277f8F2c384827B5273592FF7CeBd9f2C1ac258', 'GLP token', 'token', 'arbitrum'),

  // --- Tokens: Avalanche -------------------------------------------------------
  L('0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd', 'JOE (Trader Joe)', 'token', 'avalanche'),
  L('0x152b9d0FdC40C096757F570A51E494bd4b943E50', 'BTC.b (Avalanche Bridge BTC)', 'token', 'avalanche'),
  L('0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', 'WETH.e', 'token', 'avalanche'),
  L('0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664', 'USDC.e (bridged)', 'token', 'avalanche'),
  L('0xc7198437980c041c805A1EDcbA50c1Ce5db95118', 'USDT.e (bridged)', 'token', 'avalanche'),
  L('0xd586E7F844cEa2F87f50152665BCbc2C279D8d70', 'DAI.e (bridged)', 'token', 'avalanche'),
  L('0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE', 'sAVAX (Benqi Liquid Staked AVAX)', 'token', 'avalanche'),

  // --- Tokens: Ethereum --------------------------------------------------------
  L('0x6B3595068778DD592e39A122f4f5a5cF09C90fE2', 'SUSHI token', 'token'),
  L('0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E', 'crvUSD (Curve stablecoin)', 'token'),
  L('0xba100000625a3754423978a60c9317c58a424e3D', 'BAL (Balancer)', 'token'),
  L('0xec53bF9167f50cDEB3Ae105f56099aaaB9061F83', 'EIGEN token', 'token'),
  L('0x83F20F44975D03b1b09e64809B757c47f942BEeA', 'sDAI (Savings DAI)', 'token'),
  L('0xdC035D45d973E3EC169d2276DDab16f1e407384F', 'USDS (Sky)', 'token'),
  L('0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', 'USDe (Ethena)', 'token'),
  L('0x9D39A5DE30e57443BfF2A8307A4256c8797A3497', 'sUSDe (Ethena staked USDe)', 'token'),
  L('0x57e114B691Db790C35207b2e685D4A43181e6061', 'ENA (Ethena)', 'token'),
  L('0x853d955aCEf822Db058eb8505911ED77F175b99e', 'FRAX', 'token'),
  L('0x5E8422345238F34275888049021821E8E08CAa1f', 'frxETH', 'token'),
  L('0xac3E018457B222d93114458476f3E3416Abbe38F', 'sfrxETH', 'token'),
  L('0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', 'cbETH (Coinbase Wrapped Staked ETH)', 'token'),
  L('0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3', 'ONDO', 'token'),
  L('0x808507121B80c02388fAd14726482e061B8da827', 'PENDLE', 'token'),
  L('0x3c3a81e81dc49A522A592e7622A7E711c06bf354', 'MNT (Mantle)', 'token'),
  L('0x7712c34205737192402172409a8F7ccef8aA2AEc', 'BUIDL (BlackRock USD Institutional Digital Liquidity Fund)', 'token'),
  L('0x056Fd409E1d7A124BD7017459dFEa2F387b6d5Cd', 'GUSD (Gemini Dollar)', 'token'),
  L('0xA0b73E1Ff0B80914AB6fe0444E65848C4C34450b', 'CRO (Cronos / Crypto.com Coin)', 'token'),
  L('0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa', 'mETH (Mantle Staked Ether)', 'token'),
  L('0x6810e776880C02933D47DB1b9fc05908e5386b96', 'GNO', 'token'),
  L('0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6', 'POL (Polygon Ecosystem Token)', 'token'),
  L('0xc00e94Cb662C3520282E6f5717214004A7f26888', 'COMP token', 'token'),
  L('0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD', 'sUSDS (Savings USDS)', 'token'),
  L('0x56072C95FAA701256059aa122697B133aDEd9279', 'SKY token', 'token'),
  L('0xD33526068D116cE69F19A9ee46F0bd304F21A51f', 'RPL token', 'token'),
  L('0xDEf1CA1fb7FBcDC777520aa7f396b4E015F497aB', 'COW token', 'token'),
  ...LM('0xAf5191B0De278C7286d6C7CC6ab6BB8A73bA2Cd6', 'STG token', 'token', ['ethereum', 'bsc', 'polygon', 'avalanche', 'arbitrum', 'optimism', 'fantom']),
  L('0x0000000000085d4780B73119b644AE5ecd22b376', 'TUSD', 'token'),
  L('0x8E870D67F660D95d5be530380D0eC0bd388289E1', 'USDP (Pax Dollar)', 'token'),
  L('0x6c3ea9036406852006290770BEdFcAbA0e23A0e8', 'PYUSD (PayPal USD)', 'token'),
  L('0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', 'FDUSD', 'token'),
  L('0xbf5495Efe5DB9ce00f80364C8B423567e58d2110', 'ezETH', 'token'),
  L('0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee', 'weETH', 'token'),
  L('0x35fA164735182de50811E8e2E824cFb9B6118ac2', 'eETH', 'token'),
  L('0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7', 'rsETH', 'token'),
  L('0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1', 'ARB (Arbitrum)', 'token'),
  L('0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72', 'ENS token', 'token'),
  L('0x4d224452801ACEd8B2F0aebE155379bb5D594381', 'APE token', 'token'),
  L('0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F', 'SNX (Synthetix) proxy', 'token'),
  L('0xc944E90C64B2c07662A292be6244BDf05Cda44a7', 'GRT token', 'token'),
  L('0x111111111117dC0aa78b770fA6A738034120C302', '1INCH token', 'token'),
  L('0x3845badAde8e6dFF049820680d1F14bD3903a5d0', 'SAND token', 'token'),
  L('0x0F5D2fB29fb7d3CFeE444a200298f468908cC942', 'MANA token', 'token'),
  L('0xBB0E17EF65F82Ab018d8EDd776e8DD940327B28b', 'AXS token', 'token'),
  L('0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24', 'RNDR token (legacy)', 'token'),
  L('0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85', 'FET token', 'token'),
  L('0x4da27a545c0c5B758a6BA100e3a049001de870f5', 'stkAAVE (Staked Aave)', 'token'),
  L('0x163f8C2467924be0ae7B5347228CABF260318753', 'WLD token', 'token'),

  // --- Tokens: Polygon ---------------------------------------------------------
  L('0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', 'DAI (PoS)', 'token', 'polygon'),
  L('0xD6DF932A45C0f255f85145f286eA0b292B21C90B', 'AAVE (PoS)', 'token', 'polygon'),
  L('0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', 'LINK (PoS)', 'token', 'polygon'),
  L('0x0000000000000000000000000000000000001010', 'Polygon: MATIC/POL native token (MRC20 predeploy)', 'token', 'polygon'),
  L('0x03b54A6e9a984069379fae1a4fC4dBAE93B3bCCD', 'wstETH', 'token', 'polygon'),
  L('0xB5C064F955D8e7F38fE0460C556a72987494eE17', 'QUICK (new) token', 'token', 'polygon'),

  // --- Tokens: BNB Chain -------------------------------------------------------
  L('0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE', 'XRP (Binance-Peg)', 'token', 'bsc'),
  L('0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47', 'ADA (Binance-Peg)', 'token', 'bsc'),
  L('0xbA2aE424d960c26247Dd6c32edC70B295c744C43', 'DOGE (Binance-Peg)', 'token', 'bsc'),
  L('0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402', 'DOT (Binance-Peg)', 'token', 'bsc'),
  L('0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63', 'XVS token', 'token', 'bsc'),
  L('0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', 'DAI (Binance-Peg)', 'token', 'bsc'),

  // --- Tokens: Gnosis ----------------------------------------------------------
  L('0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb', 'GNO', 'token', 'gnosis'),
  L('0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83', 'USDC (bridged)', 'token', 'gnosis'),
  L('0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1', 'WETH (bridged)', 'token', 'gnosis'),
  L('0x4ECaBa5870353805a9F068101A40E0f32ed605C6', 'USDT (bridged)', 'token', 'gnosis'),
  L('0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0', 'USDC.e (Circle bridged standard)', 'token', 'gnosis'),
  L('0xaf204776c7245bF4147c2612BF6e5972Ee483701', 'sDAI (Savings xDAI)', 'token', 'gnosis'),

  // --- Tokens: zkSync Era ------------------------------------------------------
  L('0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4', 'USDC.e (bridged)', 'token', 'zksync'),
  L('0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', 'WETH', 'token', 'zksync'),
  L('0x493257fD37EDB34451f62EDf8D2a0C418852bA4C', 'USDT (bridged)', 'token', 'zksync'),
  L('0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E', 'ZK (zkSync)', 'token', 'zksync'),
  L('0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4', 'USDC (native)', 'token', 'zksync'),

  // --- Tokens: Linea -----------------------------------------------------------
  L('0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', 'WETH', 'token', 'linea'),
  L('0x176211869cA2b568f2A7D4EE941E073a821EE1ff', 'USDC.e (bridged)', 'token', 'linea'),
  L('0xA219439258ca9da29E9Cc4cE5596924745e12B93', 'USDT (bridged)', 'token', 'linea'),

  // --- Tokens: Scroll ----------------------------------------------------------
  L('0x5300000000000000000000000000000000000004', 'WETH', 'token', 'scroll'),
  L('0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4', 'USDC (bridged)', 'token', 'scroll'),
  L('0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df', 'USDT (bridged)', 'token', 'scroll'),
  L('0xd29687c813D741E2F938F4aC377128810E217b1b', 'SCR (Scroll)', 'token', 'scroll'),

  // --- Tokens: Polygon zkEVM ---------------------------------------------------
  L('0x4F9A0e7FD2Bf6067db6994CF12E4495Df938E6e9', 'WETH', 'token', 'polygon-zkevm'),
  L('0xA8CE8aee21bC2A48a5EF670afCc9274C7bbbC035', 'USDC.e (bridged)', 'token', 'polygon-zkevm'),
  L('0x1E4a5963aBFD975d8c9021ce480b42188849D41d', 'USDT (bridged)', 'token', 'polygon-zkevm'),

  // --- Tokens: Blast -----------------------------------------------------------
  L('0x4300000000000000000000000000000000000004', 'WETH (Blast rebasing)', 'token', 'blast'),
  L('0x4300000000000000000000000000000000000003', 'USDB (Blast USD)', 'token', 'blast'),
  L('0xb1a5700fA2358173Fe465e6eA4Ff52E36e88E2ad', 'BLAST token', 'token', 'blast'),

  // --- Tokens: Mantle ----------------------------------------------------------
  L('0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8', 'WMNT (Wrapped Mantle)', 'token', 'mantle'),
  L('0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE', 'USDT (bridged)', 'token', 'mantle'),
  L('0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9', 'USDC (bridged)', 'token', 'mantle'),
  L('0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111', 'WETH (bridged)', 'token', 'mantle'),
  L('0xcDA86A272531e8640cD7F1a92c01839911B90bb0', 'mETH (Mantle Staked Ether)', 'token', 'mantle'),

  // --- Tokens: Celo ------------------------------------------------------------
  L('0x765DE816845861e75A25fCA122bb6898B8B1282a', 'cUSD (Celo Dollar)', 'token', 'celo'),
  L('0x471EcE3750Da237f93B8E339c536989b8978a438', 'CELO (native ERC-20)', 'token', 'celo'),
  L('0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73', 'cEUR (Celo Euro)', 'token', 'celo'),
  L('0xcebA9300f2b948710d2653dD7B07f33A8B32118C', 'USDC (native)', 'token', 'celo'),
  L('0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', 'USDT (native)', 'token', 'celo'),

  // --- Tokens: Fantom ----------------------------------------------------------
  L('0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83', 'WFTM (Wrapped Fantom)', 'token', 'fantom'),
  L('0x04068DA6C83AFCFA0e13ba15A6696662335D5B75', 'USDC (bridged)', 'token', 'fantom'),

  // --- Tokens: Cronos ----------------------------------------------------------
  L('0x5C7F8A570d578ED84E63fdFA7b1eE72dEae1AE23', 'WCRO (Wrapped CRO)', 'token', 'cronos'),
  L('0xc21223249CA28397B4B6541dfFaEcC539BfF0c59', 'USDC (bridged)', 'token', 'cronos'),
  L('0x66e428c3f67a68878562e79A0234c1F83c208770', 'USDT (bridged)', 'token', 'cronos'),

  // --- Tokens: Moonbeam --------------------------------------------------------
  L('0xAcc15dC74880C9944775448304B263D191c6077F', 'WGLMR (Wrapped GLMR)', 'token', 'moonbeam'),
  L('0x931715FEE2d06333043d11F658C8CE934aC61D0c', 'USDC (Wormhole)', 'token', 'moonbeam'),

  // --- Canonical rollup / sidechain bridges ------------------------------------
  L('0x88ad09518695c6c3712AC10a214bE5109a655671', 'Gnosis OmniBridge (Ethereum side)', 'bridge'),
  L('0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016', 'Gnosis xDai Bridge (Ethereum side)', 'bridge'),
  L('0xf6A78083ca3e2a662D6dd1703c939c8aCE2e268d', 'Gnosis OmniBridge (Gnosis side)', 'bridge', 'gnosis'),
  L('0x57891966931Eb4Bb6FB81430E6cE0A03AAbDe063', 'zkSync Era: L1 ERC20 Bridge', 'bridge'),
  L('0xD7f9f54194C633F36CCD5F3da84ad4a1c38cB2cB', 'zkSync: L1 Shared Bridge', 'bridge'),
  L('0x051F1D88f0aF5763fB888eC4378b4D8B29ea3319', 'Linea: L1 Token Bridge', 'bridge'),
  L('0xF8B1378579659D8F7EE5f3C929c2f3E332E41Fd6', 'Scroll: L1 Gateway Router', 'bridge'),
  L('0x95fC37A27a2f68e3A647CDc081F0A89bb47c3012', 'Mantle: L1 Standard Bridge', 'bridge'),
  L('0x09e9222E96E7B4AE2a407B98d48e330053351EEe', 'Arbitrum One: L2 ERC20 Gateway', 'bridge', 'arbitrum'),
  L('0xd92023E9d9911199a6711321D1277285e6d4e2db', 'Arbitrum One: L1 WETH Gateway', 'bridge'),
  L('0xcEe284F754E854890e311e3280b767F80797180d', 'Arbitrum One: L1 Custom Gateway', 'bridge'),
  L('0x6c411aD3E74De3E7Bd422b94A27770f5B86C623B', 'Arbitrum One: L2 WETH Gateway', 'bridge', 'arbitrum'),
  L('0x096760F208390250649E3e8763348E783AEF5562', 'Arbitrum One: L2 Custom Gateway', 'bridge', 'arbitrum'),
  L('0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840', 'Arbitrum One: Outbox', 'bridge'),
  L('0x11f943b2c77b743AB90f4A0Ae7d5A4e7FCA3E102', 'zkSync Era: L2 ERC20 Bridge', 'bridge', 'zksync'),
  L('0x508Ca82Df566dCD1B0DE8296e70a96332cD644ec', 'Linea: L2 Message Service', 'bridge', 'linea'),
  L('0x353012dc4a9A6cF55c941bADC267f82004A8ceB9', 'Linea: L2 Token Bridge', 'bridge', 'linea'),
  L('0xa13BAF47339d63B743e7Da8741db5456DAc1E556', 'Scroll: ScrollChain (rollup)', 'bridge'),
  L('0x781e90f1c8Fc4611c9b7497C3B47F99Ef6969CbC', 'Scroll: L2 Messenger', 'bridge', 'scroll'),
  L('0x4C0926FF5252A435FD19e10ED15e5a249Ba19d79', 'Scroll: L2 Gateway Router', 'bridge', 'scroll'),
  L('0xc54cb22944F2bE476E02dECfCD7e3E7d3e15A8Fb', 'Mantle: L1 Portal', 'bridge'),
  L('0x697402166Fbf2F22E970df8a6486Ef171dbfc524', 'Blast: L1 Bridge', 'bridge'),

  // --- Third-party bridges and messaging ---------------------------------------
  L('0x53Bf833A5d6c4ddA888F69c22C88C9f356a41614', 'Stargate: Router', 'bridge', 'arbitrum'),
  L('0xB0D502E938ed5f4df2E681fE6E419ff29631d62b', 'Stargate: Router', 'bridge', 'optimism'),
  ...LM('0x45A01E4e04F14f7A4a6702c74187c5F6222033cd', 'Stargate: Router', 'bridge', ['polygon', 'avalanche']),
  L('0x4a364f8c717cAAD9A442737Eb7b8A55cc6cf18D8', 'Stargate: Router', 'bridge', 'bsc'),
  L('0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A', 'Across: Arbitrum SpokePool', 'bridge', 'arbitrum'),
  L('0x6f26Bf09B1C792e3228e5467807a900A503c0281', 'Across: Optimism SpokePool', 'bridge', 'optimism'),
  L('0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64', 'Across: Base SpokePool', 'bridge', 'base'),
  L('0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096', 'Across: Polygon SpokePool', 'bridge', 'polygon'),
  L('0xc186fA914353c44b2E33eBE05f21846F1048bEda', 'Across: HubPool', 'bridge'),
  L('0x6F4e8eBa4D337f874Ab57478AcC2Cb5BACdc19c9', 'Synapse: Bridge', 'bridge', 'arbitrum'),
  L('0xd123f70AE324d34A9E76b67a27bf77593bA8749f', 'Synapse: Bridge', 'bridge', 'bsc'),
  L('0x8F5BBB2BB8c2Ee94639E55d5F41de9b4839C1280', 'Synapse: Bridge', 'bridge', 'polygon'),
  L('0x3666f603Cc164936C1b87e207F36BEBa4AC5f18a', 'Hop Protocol: USDC Bridge', 'bridge'),
  L('0x3E4a3a4796d16c0Cd582C382691998f7c06420B6', 'Hop Protocol: USDT Bridge', 'bridge'),
  L('0x3d4Cc8A61c7528Fd86C55cfe061a78dCBA48EDd1', 'Hop Protocol: DAI Bridge', 'bridge'),
  L('0x1619DE6B6B20eD217a58d00f37B9d47C7663feca', 'Celer: cBridge', 'bridge', 'arbitrum'),
  L('0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B', 'Wormhole: Core Bridge', 'bridge'),
  L('0xB6F6D86a8f9879A9c87f643768d9efc38c1Da6E7', 'Wormhole: Token Bridge', 'bridge', 'bsc'),
  L('0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE', 'Wormhole: Token Bridge', 'bridge', 'polygon'),
  L('0x0e082F06FF657D94310cB8cE8B0D9a04541d8052', 'Wormhole: Token Bridge', 'bridge', 'avalanche'),
  L('0x0b2402144Bb366A632D14B83F244D2e0e21bD39c', 'Wormhole: Token Bridge', 'bridge', 'arbitrum'),
  L('0x1D68124e65faFC907325e3EDbF8c4d84499DAa8b', 'Wormhole: Token Bridge', 'bridge', 'optimism'),
  L('0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627', 'Wormhole: Token Bridge', 'bridge', 'base'),
  ...LM('0x3c2269811836af69497E5F486A85D7316753cf62', 'LayerZero: Endpoint V1', 'bridge', ['arbitrum', 'optimism', 'polygon', 'avalanche', 'bsc', 'fantom']),
  L('0xeF4fB24aD0916217251F553c0596F8Edc630EB66', 'deBridge: DLN Source', 'bridge', 'evm'),
  L('0xE7351Fd770A37282b91D153Ee690B63579D6dd7f', 'deBridge: DLN Destination', 'bridge', 'evm'),
  L('0x80C67432656d59144cEFf962E8fAF8926599bCF8', 'Orbiter Finance: Maker', 'bridge', 'evm'),
  L('0x45f1A95A4D3f3836523F5c83673c797f4d4d263B', 'Stargate: Router', 'bridge', 'base'),
  L('0xE0B015E54d54fc84a6cB9B666099c46adE9335FF', 'Across: zkSync SpokePool', 'bridge', 'zksync'),
  L('0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75', 'Across: Linea SpokePool', 'bridge', 'linea'),
  L('0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96', 'Across: Scroll SpokePool', 'bridge', 'scroll'),
  L('0xC05e61d0E7a63D27546389B7aD62FdFf5A91aACE', 'Synapse: Bridge', 'bridge', 'avalanche'),
  L('0xAf41a65F786339e7911F4acDAD6BD49426F2Dc6b', 'Synapse: Bridge', 'bridge', 'optimism'),
  L('0x88DCDC47D2f83a99CF0000FDF667A468bB958a78', 'Celer: cBridge', 'bridge', 'polygon'),
  ...LM('0xb6319cC6c8c27A8F5dAF0dD3DF91EA35C4720dd7', 'LayerZero: Endpoint V1', 'bridge', ['base', 'linea', 'scroll', 'mantle', 'polygon-zkevm']),
  L('0xE4eDb277e41dc89aB076a1F049f4a3EfA700bCE8', 'Orbiter Finance: Maker 2', 'bridge', 'evm'),
  L('0x88A69B4E698A4B090DF6CF5Bd7B2D47325Ad30A3', 'Nomad: ERC20 Bridge (exploited Aug 2022)', 'bridge'),

  // --- Mixers: Tornado Cash multichain pools (same addresses on each chain, native-coin denominations) ---
  L('0x84443CFd09A48AF6eF360C6976C5392aC5023a1F', 'Tornado Cash: 0.1 BNB pool', 'mixer', 'bsc'),
  ...LM('0x84443CFd09A48AF6eF360C6976C5392aC5023a1F', 'Tornado Cash: 0.1 ETH pool', 'mixer', ['arbitrum', 'optimism']),
  L('0xd47438C816c9E7f2E2888E060936a499Af9582b3', 'Tornado Cash: 1 BNB pool', 'mixer', 'bsc'),
  ...LM('0xd47438C816c9E7f2E2888E060936a499Af9582b3', 'Tornado Cash: 1 ETH pool', 'mixer', ['arbitrum', 'optimism']),
  L('0x330bdFADE01eE9bF63C209Ee33102DD334618e0a', 'Tornado Cash: 10 BNB pool', 'mixer', 'bsc'),
  ...LM('0x330bdFADE01eE9bF63C209Ee33102DD334618e0a', 'Tornado Cash: 10 ETH pool', 'mixer', ['arbitrum', 'optimism']),
  L('0x1E34A77868E19A6647b1f2F47B51ed72dEDE95DD', 'Tornado Cash: 100 BNB pool', 'mixer', 'bsc'),
  ...LM('0x1E34A77868E19A6647b1f2F47B51ed72dEDE95DD', 'Tornado Cash: 100 ETH pool', 'mixer', ['arbitrum', 'optimism']),

  // --- Bitcoin -----------------------------------------------------------------
  L('bc1ql49ydapnjafl5t2cp9zqpjwe6pdgmxy98859v2', 'Robinhood (cold wallet)', 'exchange', 'bitcoin'),
  L('3LYJfcfHPXYJreMsASk2jkn69LWEYKzexb', 'Binance (cold wallet)', 'exchange', 'bitcoin'),
  L('1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s', 'Binance (hot wallet)', 'exchange', 'bitcoin'),
  L('3D2oetdNuZUqQHPJmcMDDHYoqkyNVsFk9r', 'Bitfinex (cold wallet, legacy)', 'exchange', 'bitcoin'),
  L('3BMEXqGpG4FxBA1KWhRFufXfSTRgzfDBhJ', 'BitMEX (cold wallet)', 'exchange', 'bitcoin'),
  L('12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX', 'Block 1 coinbase (Satoshi)', 'other', 'bitcoin'),
  L('bc1qa5wkgaew2dkv56kfvj49j0av5nml45x9ek9hz6', 'US Government: seized Silk Road funds (DOJ)', 'other', 'bitcoin'),

  // --- Solana: exchange --------------------------------------------------------
  L('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'Binance (hot wallet)', 'exchange', 'solana'),
  L('2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S', 'Binance (hot wallet)', 'exchange', 'solana'),
  L('H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', 'Coinbase 2 (hot wallet)', 'exchange', 'solana'),
  L('GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', 'Coinbase (hot wallet)', 'exchange', 'solana'),
  L('FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5', 'Kraken (hot wallet)', 'exchange', 'solana'),
  L('AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2', 'Bybit (hot wallet)', 'exchange', 'solana'),
  L('BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6', 'KuCoin (hot wallet)', 'exchange', 'solana'),
  L('u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w', 'Gate.io (hot wallet)', 'exchange', 'solana'),
  L('AobVSwdW9BbpMdJvTqeCN4hPAmh4rHm7vwLnQ5ATSyrS', 'Crypto.com (hot wallet)', 'exchange', 'solana'),

  // --- Solana: dex -------------------------------------------------------------
  L('PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu', 'Jupiter: Perpetuals', 'dex', 'solana'),
  L('j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X', 'Jupiter: Limit Order v2', 'dex', 'solana'),
  L('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', 'Raydium: LaunchLab (Launchpad)', 'dex', 'solana'),
  L('5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h', 'Raydium: Stable AMM', 'dex', 'solana'),
  L('PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY', 'Phoenix: DEX', 'dex', 'solana'),
  L('opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb', 'OpenBook v2: DEX', 'dex', 'solana'),
  L('Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', 'Meteora: Dynamic AMM (Pools)', 'dex', 'solana'),
  L('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', 'Meteora: Dynamic Bonding Curve', 'dex', 'solana'),
  L('2wT8Yq49kHgDzXuPxZSaeLaH1qbmGXtEyPy64bL7aD3c', 'Lifinity: AMM v2', 'dex', 'solana'),
  L('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'Pump.fun: PumpSwap AMM', 'dex', 'solana'),
  L('4MangoMjqJ2firMokCjjGgoK8d4MXcrgL7XJaL3w6fVg', 'Mango Markets v4', 'dex', 'solana'),
  L('DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1', 'Orca: Token Swap v1', 'dex', 'solana'),

  // --- Solana: infrastructure --------------------------------------------------
  L('T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt', 'Jito: Tip Payment Program', 'infrastructure', 'solana'),
  L('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'Jito: Tip Account 1', 'infrastructure', 'solana'),
  L('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy', 'SPL Stake Pool Program', 'infrastructure', 'solana'),
  L('FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH', 'Pyth: Oracle Program', 'infrastructure', 'solana'),
  L('SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu', 'Squads: Multisig v3', 'infrastructure', 'solana'),
  L('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf', 'Squads: Multisig v4', 'infrastructure', 'solana'),
  L('namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX', 'Solana Name Service (.sol)', 'infrastructure', 'solana'),

  // --- Solana: other -----------------------------------------------------------
  L('Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb', 'Jito: Stake Pool (jitoSOL)', 'other', 'solana'),

  // --- Solana: token -----------------------------------------------------------
  L('jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', 'JTO (Jito) mint', 'token', 'solana'),
  L('HZ1JovNiVvGrGNiiYvEozEVjZ58xaU3RKwX8eACQBCt3', 'PYTH mint', 'token', 'solana'),
  L('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'WIF (dogwifhat) mint', 'token', 'solana'),
  L('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', 'RAY (Raydium) mint', 'token', 'solana'),
  L('orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', 'ORCA mint', 'token', 'solana'),
  L('bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', 'bSOL (BlazeStake staked SOL) mint', 'token', 'solana'),
  L('6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', 'TRUMP mint', 'token', 'solana'),
  L('7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', 'POPCAT mint', 'token', 'solana'),
  L('rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', 'RENDER mint', 'token', 'solana'),
  L('hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux', 'HNT mint', 'token', 'solana'),
  L('85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', 'W (Wormhole) mint', 'token', 'solana'),
  L('cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', 'cbBTC (Coinbase Wrapped BTC) mint', 'token', 'solana'),
  L('HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr', 'EURC (Circle) mint', 'token', 'solana'),
  L('MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey', 'MNDE (Marinade) mint', 'token', 'solana'),
  L('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', 'WETH (Wormhole) mint', 'token', 'solana'),
  L('2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv', 'PENGU mint', 'token', 'solana'),

  // --- Solana: nft -------------------------------------------------------------
  L('TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp', 'Tensor: cNFT Marketplace', 'nft', 'solana'),
  L('CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR', 'Metaplex: Candy Machine v3', 'nft', 'solana'),
  L('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', 'Metaplex: Core', 'nft', 'solana'),
  L('hausS13jsjafwWwGqZTUQRmWyvyxn9EQpqMwV1PBBmk', 'Metaplex: Auction House', 'nft', 'solana'),
  L('Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g', 'Metaplex: Candy Guard', 'nft', 'solana'),

  // --- Solana: lending ---------------------------------------------------------
  L('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', 'Kamino: Lending (KLend)', 'lending', 'solana'),
  L('So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo', 'Solend (Save)', 'lending', 'solana'),

  // --- Solana: bridge ----------------------------------------------------------
  L('WnFt12ZrnzZrFZkt2xsNsaNWoQribnuQ5B5FrDbwDhD', 'Wormhole: NFT Bridge', 'bridge', 'solana'),
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
