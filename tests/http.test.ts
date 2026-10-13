import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson, HttpError, jsonRpc, quoteBigInts, redactUrl, RpcError } from '@/lib/http';

function response(body: string, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('redactUrl', () => {
  it('masks key-bearing query parameters and keeps the rest', () => {
    const out = redactUrl('https://api.etherscan.io/v2/api?chainid=1&apikey=SECRET&module=account');
    expect(out).not.toContain('SECRET');
    expect(out).toContain('apikey=REDACTED');
    expect(out).toContain('chainid=1');
    expect(redactUrl('https://mainnet.helius-rpc.com/?api-key=SECRET')).toBe('https://mainnet.helius-rpc.com/?api-key=REDACTED');
  });

  it('falls back to stripping the query string for unparsable URLs', () => {
    expect(redactUrl('not a url?apikey=SECRET')).toBe('not a url');
  });
});

describe('fetchJson', () => {
  it('never puts an API key into the HttpError message or url', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('forbidden', 403)));
    const err = await fetchJson('https://api.etherscan.io/v2/api?apikey=SECRET&chainid=1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const http = err as HttpError;
    expect(http.status).toBe(403);
    expect(http.message).not.toContain('SECRET');
    expect(http.message).toContain('HTTP 403 from https://api.etherscan.io/v2/api?apikey=REDACTED');
    expect(http.url).not.toContain('SECRET');
    expect(http.body).toBe('forbidden');
  });
});

describe('jsonRpc', () => {
  it('unwraps result and throws RpcError on an error payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (req.method === 'fail') return response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'nope' } }));
      return response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: null }));
    }));
    await expect(jsonRpc('https://rpc', 'ok')).resolves.toBeNull();
    await expect(jsonRpc('https://rpc', 'fail')).rejects.toMatchObject({ name: 'RpcError', code: -32000, message: 'nope' });
  });

  it.each([
    ['html', '<html>challenge</html>'],
    ['json without envelope', '{"message":"x"}'],
    ['array', '[]'],
    ['empty body', ''],
  ])('throws a codeless RpcError for a 2xx %s body', async (_label, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => response(body)));
    const err = await jsonRpc('https://rpc?apikey=SECRET', 'eth_getCode', []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBeUndefined();
    expect((err as RpcError).message).toMatch(/Malformed JSON-RPC response/);
    expect((err as RpcError).message).not.toContain('SECRET');
  });
});

describe('quoteBigInts', () => {
  it('quotes bare integers of 16+ digits and leaves everything else alone', () => {
    const src = '{"a":10133099161583617,"b":[1,-12345678901234567,2],"c":123456789012345,"d":1.2345678901234567,"e":12345678901234567e2,"f":-9007199254740993}';
    const out = quoteBigInts(src);
    expect(out).toBe('{"a":"10133099161583617","b":[1,"-12345678901234567",2],"c":123456789012345,"d":1.2345678901234567,"e":12345678901234567e2,"f":"-9007199254740993"}');
    expect(JSON.parse(out)).toEqual({ a: '10133099161583617', b: [1, '-12345678901234567', 2], c: 123456789012345, d: 1.2345678901234567, e: 12345678901234567e2, f: '-9007199254740993' });
  });

  it('never touches string contents, including escaped quotes', () => {
    const src = '{"log":"counter:12345678901234567, done","q":"say \\"12345678901234567\\" ok","n":12345678901234567}';
    expect(quoteBigInts(src)).toBe('{"log":"counter:12345678901234567, done","q":"say \\"12345678901234567\\" ok","n":"12345678901234567"}');
  });

  it('handles whitespace-separated values and pretty-printed bodies', () => {
    const src = '[ 12345678901234567 ,\n  12345678901234567\n]';
    expect(JSON.parse(quoteBigInts(src))).toEqual(['12345678901234567', '12345678901234567']);
  });
});

describe('fetchJson quoteBigInts option', () => {
  it('parses big integers as digit strings only when the option is set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('{"lamports":10133099161583617,"note":"x:10133099161583617"}')));
    await expect(fetchJson('https://rpc')).resolves.toEqual({ lamports: 10133099161583616, note: 'x:10133099161583617' });
    await expect(fetchJson('https://rpc', { quoteBigInts: true })).resolves.toEqual({ lamports: '10133099161583617', note: 'x:10133099161583617' });
  });
});
