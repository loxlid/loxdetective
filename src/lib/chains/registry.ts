import type { ChainFamily, ChainId, ChainInfo } from '../types';

const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';

function explorer(name: string, url: string): ChainInfo['explorer'] {
  const base = url.replace(/\/$/, '');
  return {
    name,
    url: base,
    tx: (h) => `${base}/tx/${h}`,
    address: (a) => `${base}/address/${a}`,
  };
}

function evm(
  id: ChainId,
  name: string,
  shortName: string,
  evmChainId: number,
  symbol: string,
  priceKey: string,
  rpcUrls: string[],
  opts: {
    blockscoutUrl?: string;
    explorerName?: string;
    explorerUrl?: string;
    routescan?: boolean;
    color?: string;
    testnet?: boolean;
    blockTimeSec?: number;
    nativeName?: string;
  } = {},
): ChainInfo {
  const explorerUrl = opts.explorerUrl ?? opts.blockscoutUrl ?? `https://etherscan.io`;
  return {
    id,
    family: 'evm',
    name,
    shortName,
    evmChainId,
    native: { name: opts.nativeName ?? symbol, symbol, decimals: 18, priceKey },
    rpcUrls,
    blockscoutUrl: opts.blockscoutUrl,
    etherscanApi: opts.routescan
      ? { url: `https://api.routescan.io/v2/network/mainnet/evm/${evmChainId}/etherscan/api`, requiresKey: false }
      : { url: ETHERSCAN_V2, requiresKey: true, v2ChainId: evmChainId },
    explorer: explorer(opts.explorerName ?? 'Explorer', explorerUrl),
    color: opts.color ?? '#8b9cff',
    testnet: opts.testnet,
    blockTimeSec: opts.blockTimeSec ?? 12,
  };
}

/**
 * The chain registry. Order matters: it is the order chains are scanned and
 * displayed. Public RPC URLs are all CORS-enabled at the time of writing; the
 * user can prepend their own in Settings.
 */
export const CHAINS: ChainInfo[] = [
  evm('ethereum', 'Ethereum', 'ETH', 1, 'ETH', 'coingecko:ethereum', [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.llamarpc.com',
    'https://cloudflare-eth.com',
    'https://rpc.ankr.com/eth',
    'https://1rpc.io/eth',
  ], { blockscoutUrl: 'https://eth.blockscout.com', explorerName: 'Etherscan', explorerUrl: 'https://etherscan.io', color: '#627eea', blockTimeSec: 12, nativeName: 'Ether' }),

  evm('base', 'Base', 'BASE', 8453, 'ETH', 'coingecko:ethereum', [
    'https://mainnet.base.org',
    'https://base-rpc.publicnode.com',
    'https://base.llamarpc.com',
    'https://1rpc.io/base',
  ], { blockscoutUrl: 'https://base.blockscout.com', explorerName: 'Basescan', explorerUrl: 'https://basescan.org', color: '#0052ff', blockTimeSec: 2 }),

  evm('arbitrum', 'Arbitrum One', 'ARB', 42161, 'ETH', 'coingecko:ethereum', [
    'https://arb1.arbitrum.io/rpc',
    'https://arbitrum-one-rpc.publicnode.com',
    'https://arbitrum.llamarpc.com',
    'https://1rpc.io/arb',
  ], { blockscoutUrl: 'https://arbitrum.blockscout.com', explorerName: 'Arbiscan', explorerUrl: 'https://arbiscan.io', color: '#28a0f0', blockTimeSec: 0.25 }),

  evm('optimism', 'OP Mainnet', 'OP', 10, 'ETH', 'coingecko:ethereum', [
    'https://mainnet.optimism.io',
    'https://optimism-rpc.publicnode.com',
    'https://optimism.llamarpc.com',
    'https://1rpc.io/op',
  ], { blockscoutUrl: 'https://optimism.blockscout.com', explorerName: 'OP Etherscan', explorerUrl: 'https://optimistic.etherscan.io', color: '#ff0420', blockTimeSec: 2 }),

  evm('polygon', 'Polygon PoS', 'POL', 137, 'POL', 'coingecko:matic-network', [
    'https://polygon-bor-rpc.publicnode.com',
    'https://polygon-rpc.com',
    'https://polygon.llamarpc.com',
    'https://1rpc.io/matic',
  ], { blockscoutUrl: 'https://polygon.blockscout.com', explorerName: 'Polygonscan', explorerUrl: 'https://polygonscan.com', color: '#8247e5', blockTimeSec: 2 }),

  evm('bsc', 'BNB Smart Chain', 'BNB', 56, 'BNB', 'coingecko:binancecoin', [
    'https://bsc-rpc.publicnode.com',
    'https://bsc-dataseed.binance.org',
    'https://bsc-dataseed1.defibit.io',
    'https://1rpc.io/bnb',
  ], { explorerName: 'BscScan', explorerUrl: 'https://bscscan.com', color: '#f0b90b', blockTimeSec: 3 }),

  evm('avalanche', 'Avalanche C-Chain', 'AVAX', 43114, 'AVAX', 'coingecko:avalanche-2', [
    'https://api.avax.network/ext/bc/C/rpc',
    'https://avalanche-c-chain-rpc.publicnode.com',
    'https://1rpc.io/avax/c',
  ], { routescan: true, explorerName: 'Snowtrace', explorerUrl: 'https://snowtrace.io', color: '#e84142', blockTimeSec: 2 }),

  evm('gnosis', 'Gnosis Chain', 'GNO', 100, 'xDAI', 'coingecko:xdai', [
    'https://rpc.gnosischain.com',
    'https://gnosis-rpc.publicnode.com',
    'https://1rpc.io/gnosis',
  ], { blockscoutUrl: 'https://gnosis.blockscout.com', explorerName: 'Gnosisscan', explorerUrl: 'https://gnosisscan.io', color: '#04795b', blockTimeSec: 5 }),

  evm('zksync', 'zkSync Era', 'ZKSYNC', 324, 'ETH', 'coingecko:ethereum', [
    'https://mainnet.era.zksync.io',
    'https://zksync-era.blockpi.network/v1/rpc/public',
  ], { blockscoutUrl: 'https://zksync.blockscout.com', explorerName: 'zkSync Explorer', explorerUrl: 'https://explorer.zksync.io', color: '#8c8dfc', blockTimeSec: 1 }),

  evm('linea', 'Linea', 'LINEA', 59144, 'ETH', 'coingecko:ethereum', [
    'https://rpc.linea.build',
    'https://linea-rpc.publicnode.com',
    'https://1rpc.io/linea',
  ], { blockscoutUrl: 'https://explorer.linea.build', explorerName: 'Lineascan', explorerUrl: 'https://lineascan.build', color: '#61dfff', blockTimeSec: 2 }),

  evm('scroll', 'Scroll', 'SCROLL', 534352, 'ETH', 'coingecko:ethereum', [
    'https://rpc.scroll.io',
    'https://scroll-rpc.publicnode.com',
    'https://1rpc.io/scroll',
  ], { blockscoutUrl: 'https://scroll.blockscout.com', explorerName: 'Scrollscan', explorerUrl: 'https://scrollscan.com', color: '#ffeeda', blockTimeSec: 3 }),

  evm('polygon-zkevm', 'Polygon zkEVM', 'ZKEVM', 1101, 'ETH', 'coingecko:ethereum', [
    'https://zkevm-rpc.com',
    'https://polygon-zkevm.drpc.org',
  ], { blockscoutUrl: 'https://zkevm.blockscout.com', explorerName: 'zkEVM Polygonscan', explorerUrl: 'https://zkevm.polygonscan.com', color: '#7b3fe4', blockTimeSec: 2 }),

  evm('blast', 'Blast', 'BLAST', 81457, 'ETH', 'coingecko:ethereum', [
    'https://rpc.blast.io',
    'https://blast-rpc.publicnode.com',
  ], { blockscoutUrl: 'https://blast.blockscout.com', explorerName: 'Blastscan', explorerUrl: 'https://blastscan.io', color: '#fcfc03', blockTimeSec: 2 }),

  evm('mantle', 'Mantle', 'MNT', 5000, 'MNT', 'coingecko:mantle', [
    'https://rpc.mantle.xyz',
    'https://mantle-rpc.publicnode.com',
  ], { blockscoutUrl: 'https://explorer.mantle.xyz', explorerName: 'Mantle Explorer', explorerUrl: 'https://explorer.mantle.xyz', color: '#65b3ae', blockTimeSec: 2 }),

  evm('celo', 'Celo', 'CELO', 42220, 'CELO', 'coingecko:celo', [
    'https://forno.celo.org',
    'https://celo-rpc.publicnode.com',
  ], { blockscoutUrl: 'https://celo.blockscout.com', explorerName: 'Celoscan', explorerUrl: 'https://celoscan.io', color: '#fcff52', blockTimeSec: 5 }),

  evm('fantom', 'Fantom Opera (legacy)', 'FTM', 250, 'FTM', 'coingecko:fantom', [
    'https://rpc.ftm.tools',
    'https://fantom-rpc.publicnode.com',
    'https://1rpc.io/ftm',
  ], { routescan: true, explorerName: 'FTMScan', explorerUrl: 'https://ftmscan.com', color: '#1969ff', blockTimeSec: 1 }),

  evm('cronos', 'Cronos', 'CRO', 25, 'CRO', 'coingecko:crypto-com-chain', [
    'https://evm.cronos.org',
    'https://cronos-evm-rpc.publicnode.com',
  ], { explorerName: 'Cronoscan', explorerUrl: 'https://cronoscan.com', color: '#002d74', blockTimeSec: 6 }),

  evm('moonbeam', 'Moonbeam', 'GLMR', 1284, 'GLMR', 'coingecko:moonbeam', [
    'https://rpc.api.moonbeam.network',
    'https://moonbeam-rpc.publicnode.com',
  ], { explorerName: 'Moonscan', explorerUrl: 'https://moonscan.io', color: '#53cbc8', blockTimeSec: 6 }),

  evm('sepolia', 'Sepolia (testnet)', 'SEP', 11155111, 'ETH', 'coingecko:ethereum', [
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://rpc.sepolia.org',
    'https://1rpc.io/sepolia',
  ], { blockscoutUrl: 'https://eth-sepolia.blockscout.com', explorerName: 'Sepolia Etherscan', explorerUrl: 'https://sepolia.etherscan.io', color: '#9aa4b2', testnet: true }),

  {
    id: 'bitcoin',
    family: 'bitcoin',
    name: 'Bitcoin',
    shortName: 'BTC',
    native: { name: 'Bitcoin', symbol: 'BTC', decimals: 8, priceKey: 'coingecko:bitcoin' },
    // Esplora-compatible REST APIs (mempool.space + Blockstream).
    rpcUrls: ['https://mempool.space/api', 'https://blockstream.info/api'],
    explorer: {
      name: 'mempool.space',
      url: 'https://mempool.space',
      tx: (h) => `https://mempool.space/tx/${h}`,
      address: (a) => `https://mempool.space/address/${a}`,
    },
    color: '#f7931a',
    blockTimeSec: 600,
  },

  {
    id: 'solana',
    family: 'solana',
    name: 'Solana',
    shortName: 'SOL',
    native: { name: 'Solana', symbol: 'SOL', decimals: 9, priceKey: 'coingecko:solana' },
    rpcUrls: [
      'https://api.mainnet-beta.solana.com',
      'https://solana-rpc.publicnode.com',
      'https://solana.drpc.org',
    ],
    explorer: {
      name: 'Solscan',
      url: 'https://solscan.io',
      tx: (h) => `https://solscan.io/tx/${h}`,
      address: (a) => `https://solscan.io/account/${a}`,
    },
    color: '#9945ff',
    blockTimeSec: 0.4,
  },
];

const BY_ID = new Map(CHAINS.map((c) => [c.id, c]));
const BY_EVM_ID = new Map(CHAINS.filter((c) => c.evmChainId !== undefined).map((c) => [c.evmChainId as number, c]));

export function getChain(id: ChainId): ChainInfo {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`Unknown chain: ${id}`);
  return c;
}

export function findChain(id: string | undefined | null): ChainInfo | undefined {
  if (!id) return undefined;
  return BY_ID.get(id) ?? (/^\d+$/.test(id) ? BY_EVM_ID.get(Number(id)) : undefined);
}

export function getChainByEvmId(evmChainId: number): ChainInfo | undefined {
  return BY_EVM_ID.get(evmChainId);
}

export function chainsByFamily(family: ChainFamily, includeTestnets = false): ChainInfo[] {
  return CHAINS.filter((c) => c.family === family && (includeTestnets || !c.testnet));
}

export function evmChains(includeTestnets = false): ChainInfo[] {
  return chainsByFamily('evm', includeTestnets);
}

export function allChains(includeTestnets = false): ChainInfo[] {
  return CHAINS.filter((c) => includeTestnets || !c.testnet);
}

export const DEFAULT_EVM_CHAIN: ChainId = 'ethereum';

/** Where address history comes from for a chain, in the order the EVM façade prefers them. */
export type HistorySource = 'blockscout' | 'etherscan-key' | 'routescan' | 'esplora' | 'solana-rpc';

/**
 * Which backend serves address history: Blockscout when an instance exists,
 * otherwise the Etherscan-compatible API (keyless Routescan or key-gated
 * Etherscan V2); Bitcoin uses Esplora and Solana its own RPC.
 */
export function historySource(chain: ChainInfo): HistorySource {
  if (chain.family === 'bitcoin') return 'esplora';
  if (chain.family === 'solana') return 'solana-rpc';
  if (chain.blockscoutUrl) return 'blockscout';
  if (chain.etherscanApi && !chain.etherscanApi.requiresKey) return 'routescan';
  return 'etherscan-key';
}

/** True when history is only available through a key-gated Etherscan API (no Blockscout instance). */
export function historyNeedsKey(chain: ChainInfo): boolean {
  return !chain.blockscoutUrl && chain.etherscanApi?.requiresKey === true;
}
