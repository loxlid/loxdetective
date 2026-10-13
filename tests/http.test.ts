import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COOLDOWN_MS,
  clearEndpointCooldowns,
  fetchJson,
  HttpError,
  isEndpointCooling,
  isEndpointFailure,
  jsonRpc,
  jsonRpcBatch,
  markEndpointFailed,
  orderByCooldown,
  quoteBigInts,
  redactUrl,
  RpcError,
  withFallback,
} from '@/lib/http';

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

describe('jsonRpcBatch', () => {
  const CALLS = [{ method: 'eth_getBalance', params: ['0x1', 'latest'] }, { method: 'eth_getTransactionCount', params: ['0x1', 'latest'] }];

  it('matches results by id and turns error payloads into RpcError entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init?: RequestInit) => {
      const reqs = JSON.parse(String(init?.body)) as { id: number; method: string }[];
      // Answer out of order to exercise the id matching.
      const out = reqs.map((r) => (r.method === 'eth_getBalance' ? { jsonrpc: '2.0', id: r.id, result: '0x5' } : { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'nope' } })).reverse();
      return response(JSON.stringify(out));
    }));
    const out = await jsonRpcBatch('https://rpc', CALLS);
    expect(out[0]).toBe('0x5');
    expect(out[1]).toBeInstanceOf(RpcError);
    expect((out[1] as RpcError).message).toBe('nope');
    await expect(jsonRpcBatch('https://rpc', [])).resolves.toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['null', 'null'],
    ['html', '<html>challenge</html>'],
    ['array of junk', '[null, 1, "x", {"result": 1}]'],
    ['single object without id', '{"jsonrpc":"2.0","error":{"code":-32600,"message":"batch not supported"}}'],
  ])('resolves to one missing-batch-response RpcError per request for a 2xx %s body', async (_label, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => response(body)));
    const out = await jsonRpcBatch('https://rpc', CALLS);
    expect(out).toHaveLength(2);
    for (const r of out) {
      expect(r).toBeInstanceOf(RpcError);
      expect((r as RpcError).message).toBe('missing batch response');
      expect((r as RpcError).code).toBeUndefined();
    }
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

// ---------------------------------------------------------------------------
// Endpoint cooldown
// ---------------------------------------------------------------------------

describe('endpoint cooldown', () => {
  const A = 'https://a.example/rpc';
  const B = 'https://b.example/rpc';
  const C = 'https://c.example/rpc';

  beforeEach(() => {
    clearEndpointCooldowns();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearEndpointCooldowns();
  });

  /** `fn` for withFallback: throws `failures[url]` when set, otherwise resolves with the url. */
  function tryUrls(failures: Record<string, unknown>, tried: string[]) {
    return async (url: string) => {
      tried.push(url);
      if (url in failures) throw failures[url];
      return url;
    };
  }

  it('marks an endpoint after a network error and skips it on later calls', async () => {
    const tried: string[] = [];
    const fn = tryUrls({ [A]: new TypeError('fetch failed') }, tried);
    await expect(withFallback([A, B], fn)).resolves.toBe(B);
    expect(isEndpointCooling(A)).toBe(true);
    expect(isEndpointCooling(B)).toBe(false);

    tried.length = 0;
    await expect(withFallback([A, B], fn)).resolves.toBe(B);
    expect(tried).toEqual([B]);
  });

  it.each([
    ['HTTP 500', new HttpError('HTTP 500', 500)],
    ['HTTP 503', new HttpError('HTTP 503', 503)],
    ['HTTP 429', new HttpError('HTTP 429', 429)],
    ['timeout', new Error('timeout after 6000ms')],
    ['network error', new TypeError('Failed to fetch')],
  ])('marks the endpoint on %s', async (_label, err) => {
    await expect(withFallback([A, B], tryUrls({ [A]: err }, []))).resolves.toBe(B);
    expect(isEndpointCooling(A)).toBe(true);
    expect(isEndpointFailure(err)).toBe(true);
  });

  it.each([
    ['a revert', new RpcError('execution reverted', 3)],
    ['invalid params', new RpcError('invalid params', -32602)],
    ['a malformed JSON-RPC envelope', new RpcError('Malformed JSON-RPC response')],
    ['HTTP 404', new HttpError('HTTP 404', 404)],
    ['HTTP 400', new HttpError('HTTP 400', 400)],
  ])('does not mark the endpoint on %s', async (_label, err) => {
    await expect(withFallback([A, B], tryUrls({ [A]: err }, []))).resolves.toBe(B);
    expect(isEndpointCooling(A)).toBe(false);
    expect(isEndpointFailure(err)).toBe(false);
  });

  it('does not mark the endpoint when the caller aborted', async () => {
    const ctrl = new AbortController();
    const fn = async (url: string) => {
      ctrl.abort(new Error('cancelled'));
      throw new TypeError(`fetch aborted on ${url}`);
    };
    await expect(withFallback([A, B], fn, { signal: ctrl.signal })).rejects.toThrow('cancelled');
    expect(isEndpointCooling(A)).toBe(false);
    expect(isEndpointCooling(B)).toBe(false);

    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(isEndpointFailure(abortErr)).toBe(false);
  });

  it('tries cooled-down endpoints last, so a request only fails when every endpoint fails', async () => {
    markEndpointFailed(A);
    markEndpointFailed(B);
    expect(orderByCooldown([A, B, C])).toEqual([C, A, B]);

    const tried: string[] = [];
    await expect(withFallback([A, B, C], tryUrls({ [C]: new HttpError('HTTP 502', 502) }, tried))).resolves.toBe(A);
    expect(tried).toEqual([C, A]);
    // A answered, so it is healthy again; C is now cooling.
    expect(isEndpointCooling(A)).toBe(false);
    expect(isEndpointCooling(C)).toBe(true);
  });

  it('keeps the original order when every endpoint is cooling down', async () => {
    for (const u of [A, B, C]) markEndpointFailed(u);
    expect(orderByCooldown([A, B, C])).toEqual([A, B, C]);
    const tried: string[] = [];
    await expect(withFallback([A, B, C], tryUrls({ [A]: new TypeError('down'), [B]: new TypeError('down') }, tried))).resolves.toBe(C);
    expect(tried).toEqual([A, B, C]);
  });

  it('expires after COOLDOWN_MS', () => {
    vi.useFakeTimers();
    expect(COOLDOWN_MS).toBe(60_000);
    markEndpointFailed(A);
    vi.advanceTimersByTime(COOLDOWN_MS - 1);
    expect(isEndpointCooling(A)).toBe(true);
    expect(orderByCooldown([A, B])).toEqual([B, A]);
    vi.advanceTimersByTime(1);
    expect(isEndpointCooling(A)).toBe(false);
    expect(orderByCooldown([A, B])).toEqual([A, B]);
  });

  it('clearEndpointCooldowns forgets every mark', () => {
    markEndpointFailed(A);
    markEndpointFailed(B);
    clearEndpointCooldowns();
    expect(isEndpointCooling(A)).toBe(false);
    expect(isEndpointCooling(B)).toBe(false);
  });

  it('a fetchJson timeout inside withFallback marks the endpoint', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_u: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );
    const p = withFallback([A], (url) => fetchJson(url, { timeoutMs: 50 }));
    const settled = p.then(
      () => 'ok',
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(60);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timeout after 50ms/);
    expect(isEndpointCooling(A)).toBe(true);
  });
});
