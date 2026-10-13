import { getAddress, isAddress } from 'viem';
import type { DetectedInput } from './types';

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;
const ENS = /^(?=.{3,255}$)([a-z0-9-]+\.)+(eth|xyz|luxe|kred|art|club)$/i;
const BTC_LEGACY = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
const BTC_BECH32 = /^(bc1)[02-9ac-hj-np-z]{11,87}$/i;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BLOCK = /^\d{1,12}$/;

/**
 * Classify a free-form search string. Pure function, no network. The caller
 * decides how to resolve ambiguity (e.g. a 32-byte hex can be an EVM tx or a
 * Bitcoin tx; both families are returned and probed).
 */
export function detectInput(rawInput: string): DetectedInput {
  const input = rawInput.trim();
  if (!input) return { kind: 'unknown', value: '', families: [], hint: 'Enter an address, transaction hash, ENS name or block number.' };

  if (EVM_ADDR.test(input)) {
    const value = isAddress(input) ? getAddress(input) : input;
    return { kind: 'evm-address', value, families: ['evm'], hint: 'EVM address (checked on every supported chain)' };
  }

  if (/^[0-9a-fA-F]{40}$/.test(input)) {
    // Bare 40-hex: an EVM address pasted without its prefix (the same leniency HEX32 gives hashes).
    return { kind: 'evm-address', value: getAddress(`0x${input}`), families: ['evm'], hint: 'EVM address (0x prefix added)' };
  }

  if (HEX32.test(input)) {
    const value = input.startsWith('0x') ? input.toLowerCase() : input.toLowerCase();
    if (value.startsWith('0x')) {
      return { kind: 'evm-tx', value, families: ['evm'], hint: 'EVM transaction hash (chain auto-detected)' };
    }
    // Bare 64-hex: Bitcoin txid, or an EVM hash missing its prefix.
    return { kind: 'btc-tx', value, families: ['bitcoin', 'evm'], hint: 'Bitcoin txid (or EVM hash without 0x)' };
  }

  if (ENS.test(input)) {
    return { kind: 'ens-name', value: input.toLowerCase(), families: ['evm'], hint: 'ENS name — resolved on Ethereum' };
  }

  if (BTC_BECH32.test(input)) {
    return { kind: 'btc-address', value: input.toLowerCase(), families: ['bitcoin'], hint: 'Bitcoin bech32 address' };
  }

  if (BTC_LEGACY.test(input)) {
    // Legacy BTC addresses are base58 too; prefer Bitcoin but allow Solana probing.
    return { kind: 'btc-address', value: input, families: ['bitcoin', 'solana'], hint: 'Bitcoin legacy / P2SH address' };
  }

  if (BLOCK.test(input)) {
    return { kind: 'block-number', value: input, families: ['evm'], hint: 'Block number' };
  }

  if (BASE58.test(input)) {
    // Solana signatures are 64-byte base58 (86-88 chars); pubkeys 32-byte (32-44 chars).
    if (input.length >= 86 && input.length <= 90) {
      return { kind: 'sol-tx', value: input, families: ['solana'], hint: 'Solana transaction signature' };
    }
    if (input.length >= 32 && input.length <= 44) {
      return { kind: 'sol-address', value: input, families: ['solana'], hint: 'Solana account address' };
    }
  }

  return { kind: 'unknown', value: input, families: [], hint: 'Not recognised as an address, hash, ENS name or block number.' };
}

export function isEvmAddress(s: string): boolean {
  return EVM_ADDR.test(s);
}

export function isTxHash(s: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(s);
}
