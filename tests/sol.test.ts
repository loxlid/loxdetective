import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveNativeTransfers,
  deriveSplTransfers,
  KNOWN_SOL_MINTS,
  KNOWN_SOL_PROGRAMS,
  matchFlows,
  solAddressSummary,
  solSignatures,
  solTokenBalances,
  solTransaction,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@/lib/providers/sol/rpc';
import { useSettings } from '@/lib/settings/store';

const PAYER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const RECIPIENT = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS';
const VAULT = '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
const UNKNOWN_MINT = 'HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

interface RpcCall {
  url: string;
  method: string;
  params: unknown[];
}

/** JSON-RPC fetch stub: `handler(method, params)` returns the `result` (or throws an RPC error object). */
function mockRpc(handler: (method: string, params: unknown[], url: string) => unknown): RpcCall[] {
  const calls: RpcCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      calls.push({ url, method: req.method, params: req.params });
      try {
        const result = handler(req.method, req.params, url);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { status: 200 });
      } catch (err) {
        if (err instanceof Error && err.message === 'HTTP500') return new Response('bad gateway', { status: 500 });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: String(err) } }), { status: 200 });
      }
    }),
  );
  return calls;
}

const tokenBalance = (accountIndex: number, mint: string, owner: string, amount: string, decimals = 6) => ({
  accountIndex,
  mint,
  owner,
  programId: TOKEN_PROGRAM_ID,
  uiTokenAmount: { amount, decimals, uiAmount: Number(amount) / 10 ** decimals, uiAmountString: String(Number(amount) / 10 ** decimals) },
});

beforeEach(() => {
  vi.restoreAllMocks();
  useSettings.getState().reset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  useSettings.getState().reset();
});

describe('matchFlows', () => {
  it('pairs decreasers with increasers greedily, in order', () => {
    expect(
      matchFlows(
        [{ account: 'a', amount: 5n }],
        [
          { account: 'b', amount: 3n },
          { account: 'c', amount: 2n },
        ],
      ),
    ).toEqual([
      { from: 'a', to: 'b', amount: 3n },
      { from: 'a', to: 'c', amount: 2n },
    ]);
    expect(
      matchFlows(
        [
          { account: 'a', amount: 2n },
          { account: 'b', amount: 4n },
        ],
        [{ account: 'c', amount: 6n }],
      ),
    ).toEqual([
      { from: 'a', to: 'c', amount: 2n },
      { from: 'b', to: 'c', amount: 4n },
    ]);
    // Unmatched remainder (mint/burn) is dropped, zero entries ignored.
    expect(matchFlows([{ account: 'a', amount: 0n }], [{ account: 'b', amount: 7n }])).toEqual([]);
  });
});

describe('deriveNativeTransfers', () => {
  it('credits the fee back to the payer and pairs it with every increaser', () => {
    const t = deriveNativeTransfers([PAYER, RECIPIENT, VAULT, SYSTEM_PROGRAM_ID], [10_000_000_000, 1_000_000_000, 0, 1], [8_499_995_000, 2_000_000_000, 500_000_000, 1], 5_000n);
    expect(t).toEqual([
      { kind: 'native', from: PAYER, to: RECIPIENT, amount: { raw: 1_000_000_000n, decimals: 9, symbol: 'SOL' }, index: 0 },
      { kind: 'native', from: PAYER, to: VAULT, amount: { raw: 500_000_000n, decimals: 9, symbol: 'SOL' }, index: 1 },
    ]);
  });

  it('pairs other decreasers with increasers when the payer only paid the fee', () => {
    const t = deriveNativeTransfers([PAYER, VAULT, RECIPIENT], [1_000_000, 10_000_000, 0], [995_000, 7_000_000, 3_000_000], 5_000n);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ from: VAULT, to: RECIPIENT, amount: { raw: 3_000_000n } });
  });

  it('yields nothing for a failed transaction that only burned the fee', () => {
    expect(deriveNativeTransfers([PAYER, RECIPIENT], [1_000_000, 5], [995_000, 5], 5_000n)).toEqual([]);
  });
});

describe('deriveSplTransfers', () => {
  it('diffs per (owner, mint) and emits transfers between owners of the same mint', () => {
    const pre = [tokenBalance(3, USDC, PAYER, '5000000'), tokenBalance(5, UNKNOWN_MINT, PAYER, '10', 0)];
    // The recipient's USDC account was created inside the tx (no pre entry); the unknown-mint balance is unchanged.
    const post = [tokenBalance(3, USDC, PAYER, '3000000'), tokenBalance(4, USDC, RECIPIENT, '2000000'), tokenBalance(5, UNKNOWN_MINT, PAYER, '10', 0)];
    const t = deriveSplTransfers([PAYER, RECIPIENT], pre, post, 1);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({
      kind: 'SPL',
      from: PAYER,
      to: RECIPIENT,
      amount: { raw: 2_000_000n, decimals: 6, symbol: 'USDC' },
      token: { chain: 'solana', address: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, type: 'SPL' },
      index: 1,
    });
  });

  it('falls back to the token account key when owner is missing', () => {
    const noOwner = (i: number, amount: string) => ({ accountIndex: i, mint: UNKNOWN_MINT, uiTokenAmount: { amount, decimals: 2 } });
    const t = deriveSplTransfers(['k0', 'k1', 'k2'], [noOwner(1, '100'), noOwner(2, '0')], [noOwner(1, '40'), noOwner(2, '60')]);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ from: 'k1', to: 'k2', amount: { raw: 60n, decimals: 2 } });
    expect(t[0].token?.symbol).toBe('HhJp…eZg4');
  });
});

describe('solAddressSummary', () => {
  it('merges getAccountInfo and getBalance', async () => {
    const calls = mockRpc((method) => {
      if (method === 'getAccountInfo') {
        return { context: { slot: 1 }, value: { lamports: 5_000_000_000, owner: SYSTEM_PROGRAM_ID, executable: false, rentEpoch: 0, space: 0, data: ['', 'base64'] } };
      }
      if (method === 'getBalance') return { context: { slot: 1 }, value: 5_000_000_000 };
      throw new Error(`unexpected ${method}`);
    });
    const s = await solAddressSummary(PAYER);
    expect(s).toMatchObject({
      chain: 'solana',
      address: PAYER,
      isContract: false,
      executable: false,
      owner: SYSTEM_PROGRAM_ID,
      lamports: 5_000_000_000n,
      nativeBalance: { chain: 'solana', balance: 5_000_000_000n, decimals: 9, symbol: 'SOL' },
    });
    expect(calls.map((c) => c.method).sort()).toEqual(['getAccountInfo', 'getBalance']);
    expect(calls[0].url).toBe(DEFAULT_RPC);
    expect(calls[0].params[1]).toMatchObject({ encoding: 'jsonParsed' });
  });

  it('treats programs as contracts and reports the parsed account type', async () => {
    mockRpc((method) =>
      method === 'getAccountInfo'
        ? { value: { lamports: 1, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true, data: ['', 'base64'] } }
        : { value: 1 },
    );
    const s = await solAddressSummary(JUPITER);
    expect(s.isContract).toBe(true);
    expect(s.executable).toBe(true);
    expect(s.accountType).toBe('program');

    mockRpc((method) =>
      method === 'getAccountInfo'
        ? { value: { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, executable: false, data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals: 6 } } } } }
        : { value: 2_039_280 },
    );
    const mint = await solAddressSummary(USDC);
    expect(mint.accountType).toBe('mint');
    expect(mint.owner).toBe(TOKEN_PROGRAM_ID);
  });

  it('returns a zero balance for a non-existent account and rejects invalid addresses locally', async () => {
    const calls = mockRpc((method) => (method === 'getAccountInfo' ? { value: null } : { value: 0 }));
    const s = await solAddressSummary(RECIPIENT);
    expect(s.lamports).toBe(0n);
    expect(s.owner).toBeUndefined();
    await expect(solAddressSummary('0xdeadbeef')).rejects.toThrow(/Invalid Solana address/);
    expect(calls).toHaveLength(2);
  });

  it('falls back to the next RPC and prefers a configured Helius key', async () => {
    useSettings.getState().set({ heliusApiKey: 'test-key' });
    const calls = mockRpc((method, _params, url) => {
      if (url.includes('helius')) throw new Error('HTTP500');
      return method === 'getAccountInfo' ? { value: null } : { value: 7 };
    });
    const s = await solAddressSummary(PAYER);
    expect(s.lamports).toBe(7n);
    expect(calls[0].url).toBe('https://mainnet.helius-rpc.com/?api-key=test-key');
    expect(calls.some((c) => c.url === DEFAULT_RPC)).toBe(true);
  });
});

describe('solTokenBalances', () => {
  it('queries both token programs, aggregates per mint and drops empty accounts', async () => {
    const acct = (pubkey: string, mint: string, amount: string, decimals: number) => ({
      pubkey,
      account: { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, data: { program: 'spl-token', parsed: { type: 'account', info: { mint, owner: PAYER, tokenAmount: { amount, decimals, uiAmountString: '0' } } } } },
    });
    const calls = mockRpc((method, params) => {
      if (method !== 'getTokenAccountsByOwner') throw new Error(method);
      const programId = (params[1] as { programId: string }).programId;
      if (programId === TOKEN_PROGRAM_ID) {
        return { value: [acct('ta1', USDC, '1500000', 6), acct('ta2', USDC, '500000', 6), acct('ta3', UNKNOWN_MINT, '0', 9), acct('ta4', UNKNOWN_MINT, '123', 9)] };
      }
      if (programId === TOKEN_2022_PROGRAM_ID) return { value: [acct('ta5', PYUSD, '42000000', 6)] };
      throw new Error('bad program');
    });

    const balances = await solTokenBalances(PAYER);
    expect(calls).toHaveLength(2);
    expect(calls[0].params[2]).toMatchObject({ encoding: 'jsonParsed' });
    expect(balances.map((b) => [b.token.symbol, b.balance])).toEqual([
      ['PYUSD', 42_000_000n],
      ['USDC', 2_000_000n],
      ['HhJp…eZg4', 123n],
    ]);
    expect(balances[1].token).toEqual({ chain: 'solana', address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: 6, type: 'SPL' });
    expect(balances[2].token.type).toBe('SPL');
    expect(balances[2].token.decimals).toBe(9);
  });
});

describe('solSignatures', () => {
  const sigs = (n: number) => Array.from({ length: n }, (_, i) => ({ signature: `sig${i}`, slot: 1000 + i, err: i === 1 ? { InstructionError: [0, 'Custom'] } : null, blockTime: 1_700_000_000 + i, memo: i === 2 ? '[12] hello' : null, confirmationStatus: 'finalized' }));

  it('maps rows and returns the last signature as cursor for a full page', async () => {
    const calls = mockRpc((method) => (method === 'getSignaturesForAddress' ? sigs(25) : null));
    const page = await solSignatures(PAYER);
    expect(calls[0].params[1]).toEqual({ limit: 25, commitment: 'confirmed' });
    expect(page.source).toBe('solana-rpc');
    expect(page.items).toHaveLength(25);
    expect(page.items[0]).toEqual({ chain: 'solana', hash: 'sig0', timestamp: 1_700_000_000, blockNumber: 1000, from: PAYER, value: { raw: 0n, decimals: 9, symbol: 'SOL' }, status: 'success', methodName: undefined, direction: 'unknown' });
    expect(page.items[1].status).toBe('failed');
    expect(page.items[2].methodName).toBe('memo: [12] hello');
    expect(page.nextCursor).toBe('sig24');
  });

  it('passes the cursor as `before` and stops paging on a short page', async () => {
    const calls = mockRpc(() => sigs(3));
    const page = await solSignatures(PAYER, 'sig24', 10);
    expect(calls[0].params[1]).toEqual({ limit: 10, before: 'sig24', commitment: 'confirmed' });
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeUndefined();
  });
});

describe('solTransaction', () => {
  function rawTx(overrides: Record<string, unknown> = {}) {
    return {
      slot: 250_000_000,
      blockTime: 1_700_000_000,
      version: 0,
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [10_000_000_000, 1_000_000_000, 1, 2_039_280, 0, 1],
        postBalances: [8_997_955_720, 2_000_000_000, 1, 2_039_280, 2_039_280, 1],
        preTokenBalances: [tokenBalance(3, USDC, PAYER, '5000000')],
        postTokenBalances: [tokenBalance(3, USDC, PAYER, '3000000'), tokenBalance(4, USDC, RECIPIENT, '2000000')],
        logMessages: Array.from({ length: 25 }, (_, i) => `Program log: line ${i}`),
        computeUnitsConsumed: 4_200,
        innerInstructions: [],
        loadedAddresses: { writable: [], readonly: [] },
      },
      transaction: {
        message: {
          accountKeys: [
            { pubkey: PAYER, signer: true, writable: true, source: 'transaction' },
            { pubkey: RECIPIENT, signer: false, writable: true, source: 'transaction' },
            { pubkey: SYSTEM_PROGRAM_ID, signer: false, writable: false, source: 'transaction' },
            { pubkey: 'ta3payer111111111111111111111111111111111111', signer: false, writable: true, source: 'transaction' },
            { pubkey: 'ta4recipient11111111111111111111111111111111', signer: false, writable: true, source: 'transaction' },
            { pubkey: TOKEN_PROGRAM_ID, signer: false, writable: false, source: 'lookupTable' },
          ],
          instructions: [
            { programId: COMPUTE_BUDGET, program: 'compute-budget', accounts: [], data: '3gJqkocMWaMm' },
            { programId: SYSTEM_PROGRAM_ID, program: 'system', parsed: { type: 'transfer', info: { source: PAYER, destination: RECIPIENT, lamports: 1_000_000_000 } } },
            { programId: TOKEN_PROGRAM_ID, program: 'spl-token', parsed: { type: 'transferChecked', info: {} } },
          ],
          recentBlockhash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi',
        },
        signatures: [SIG],
      },
      ...overrides,
    };
  }

  it('derives native and SPL transfers, fee, method and logs', async () => {
    const calls = mockRpc((method, params) => {
      if (method !== 'getTransaction') throw new Error(method);
      expect(params[0]).toBe(SIG);
      expect(params[1]).toMatchObject({ encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 });
      return rawTx();
    });
    const t = await solTransaction(SIG);
    expect(calls).toHaveLength(1);
    expect(t.chain).toBe('solana');
    expect(t.hash).toBe(SIG);
    expect(t.status).toBe('success');
    expect(t.blockNumber).toBe(250_000_000);
    expect(t.timestamp).toBe(1_700_000_000);
    expect(t.from).toBe(PAYER);
    expect(t.to).toBe(SYSTEM_PROGRAM_ID);
    expect(t.methodId).toBe(SYSTEM_PROGRAM_ID);
    expect(t.methodName).toBe('System Program: transfer');
    expect(t.fee).toEqual({ raw: 5_000n, decimals: 9, symbol: 'SOL' });
    expect(t.gasUsed).toBe(4_200n);
    expect(t.value.raw).toBe(1_002_039_280n); // 1 SOL + rent for the new token account

    const native = t.transfers.filter((x) => x.kind === 'native');
    expect(native).toEqual([
      { kind: 'native', from: PAYER, to: RECIPIENT, amount: { raw: 1_000_000_000n, decimals: 9, symbol: 'SOL' }, index: 0 },
      { kind: 'native', from: PAYER, to: 'ta4recipient11111111111111111111111111111111', amount: { raw: 2_039_280n, decimals: 9, symbol: 'SOL' }, index: 1 },
    ]);
    const spl = t.transfers.filter((x) => x.kind === 'SPL');
    expect(spl).toHaveLength(1);
    expect(spl[0]).toMatchObject({ from: PAYER, to: RECIPIENT, amount: { raw: 2_000_000n, decimals: 6, symbol: 'USDC' }, token: { address: USDC }, index: 2 });

    expect(t.extra).toMatchObject({ slot: 250_000_000, version: '0', instructionCount: 3, accountCount: 6, computeUnitsConsumed: 4_200, logTruncated: true, error: null });
    expect(t.extra?.programs).toBe('Compute Budget Program, System Program, Token Program');
    const logs = String(t.extra?.logMessages).split('\n');
    expect(logs).toHaveLength(20);
    expect(logs[0]).toBe('Program log: line 0');
  });

  it('marks failed transactions and emits no transfers when only the fee moved', async () => {
    mockRpc(() =>
      rawTx({
        meta: {
          err: { InstructionError: [1, { Custom: 6001 }] },
          fee: 5_000,
          preBalances: [10_000_000_000, 1_000_000_000, 1],
          postBalances: [9_999_995_000, 1_000_000_000, 1],
          preTokenBalances: [],
          postTokenBalances: [],
          logMessages: ['Program failed'],
        },
      }),
    );
    const t = await solTransaction(SIG);
    expect(t.status).toBe('failed');
    expect(t.transfers).toEqual([]);
    expect(t.value.raw).toBe(0n);
    expect(t.extra?.error).toBe(JSON.stringify({ InstructionError: [1, { Custom: 6001 }] }));
    expect(t.extra?.logTruncated).toBe(false);
  });

  it('appends lookup-table addresses when accountKeys is shorter than the balance arrays', async () => {
    mockRpc(() =>
      rawTx({
        meta: {
          err: null,
          fee: 5_000,
          preBalances: [1_000_000_000, 1, 0],
          postBalances: [899_995_000, 1, 100_000_000],
          preTokenBalances: [],
          postTokenBalances: [],
          logMessages: [],
          loadedAddresses: { writable: [VAULT], readonly: [] },
        },
        transaction: {
          message: {
            accountKeys: [{ pubkey: PAYER, signer: true }, { pubkey: JUPITER, signer: false }],
            instructions: [{ programId: JUPITER, accounts: [], data: 'xx' }],
            recentBlockhash: 'abc',
          },
          signatures: [SIG],
        },
      }),
    );
    const t = await solTransaction(SIG);
    expect(t.transfers).toHaveLength(1);
    expect(t.transfers[0]).toMatchObject({ from: PAYER, to: VAULT, amount: { raw: 100_000_000n } });
    expect(t.methodName).toBe('Jupiter Aggregator v6');
    expect(t.extra?.accountCount).toBe(3);
  });

  it('throws a clear error for unknown signatures and RPC failures', async () => {
    mockRpc(() => null);
    await expect(solTransaction(SIG)).rejects.toThrow(/not found/);
    await expect(solTransaction('tooshort')).rejects.toThrow(/Invalid Solana transaction signature/);
    mockRpc(() => {
      throw new Error('Invalid param: WrongSize');
    });
    await expect(solTransaction(SIG)).rejects.toThrow(/Solana RPC getTransaction failed/);
  });
});

describe('tables', () => {
  it('expose the well-known programs and mints', () => {
    expect(KNOWN_SOL_PROGRAMS[JUPITER]).toBe('Jupiter Aggregator v6');
    expect(KNOWN_SOL_PROGRAMS['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8']).toMatch(/Raydium/);
    expect(KNOWN_SOL_PROGRAMS['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc']).toMatch(/Orca/);
    expect(KNOWN_SOL_MINTS[USDC]).toEqual({ symbol: 'USDC', name: 'USD Coin', decimals: 6 });
    expect(KNOWN_SOL_MINTS['So11111111111111111111111111111111111111112'].symbol).toBe('wSOL');
    for (const key of Object.keys({ ...KNOWN_SOL_PROGRAMS, ...KNOWN_SOL_MINTS })) expect(key).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});
