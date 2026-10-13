/**
 * Small fetch helpers shared by every provider: timeouts, retries with
 * backoff, ordered endpoint fallback and JSON-RPC plumbing.
 *
 * Keep this dependency-free so it is trivially unit-testable with a mocked
 * global `fetch`.
 */

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly url?: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface FetchJsonOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  /** Per-attempt timeout in ms. */
  timeoutMs?: number;
  /** Number of attempts against the same URL (default 1). */
  retries?: number;
  signal?: AbortSignal;
  /**
   * Quote bare integers of 16+ digits in the response body before `JSON.parse`
   * so values above 2^53 (lamport balances, u64 counters) keep their precision
   * as digit strings instead of silently rounding to a double.
   */
  quoteBigInts?: boolean;
}

const DEFAULT_TIMEOUT = 15_000;

function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`timeout after ${ms}ms`)), ms);
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    clear: () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Strip API keys from a URL before it goes into an error message or log. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/api[-_]?key|token|secret/i.test(k)) u.searchParams.set(k, 'REDACTED');
    return u.toString();
  } catch {
    return url.split('?')[0];
  }
}

const BIG_INT_DIGITS = 16;

/**
 * Wrap every bare JSON integer of {@link BIG_INT_DIGITS}+ digits (outside
 * string literals) in double quotes. Decimals and exponents are left alone;
 * string contents are never touched, so `"log: 12345678901234567,"` survives.
 */
export function quoteBigInts(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      // Copy the whole string literal verbatim, honouring escapes.
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') j += 2;
        else if (text[j] === '"') {
          j++;
          break;
        } else j++;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (text[j] === '-') j++;
      const digitsStart = j;
      while (j < n && text[j] >= '0' && text[j] <= '9') j++;
      const digits = j - digitsStart;
      let isInteger = true;
      if (j < n && (text[j] === '.' || text[j] === 'e' || text[j] === 'E')) {
        isInteger = false;
        // Consume the fraction / exponent so its digits are not re-scanned.
        while (j < n && /[0-9.eE+-]/.test(text[j])) j++;
      }
      const token = text.slice(i, j);
      const next = j < n ? text[j] : '';
      const terminated = next === '' || next === ',' || next === ']' || next === '}' || /\s/.test(next);
      out += isInteger && digits >= BIG_INT_DIGITS && terminated ? `"${token}"` : token;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Fetch a URL and parse JSON, throwing HttpError on non-2xx. */
export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.retries ?? 1);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const { signal, clear } = withTimeout(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT);
    try {
      const res = await fetch(url, {
        method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
        headers: {
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(opts.headers ?? {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal,
      });
      const text = await res.text();
      let parsed: unknown = undefined;
      if (text) {
        try {
          parsed = JSON.parse(opts.quoteBigInts ? quoteBigInts(text) : text);
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) {
        const safe = redactUrl(url);
        throw new HttpError(`HTTP ${res.status} from ${safe}`, res.status, safe, parsed);
      }
      return parsed as T;
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw err;
      // Do not retry client errors other than 429.
      if (err instanceof HttpError && err.status && err.status < 500 && err.status !== 429) throw err;
      if (i < attempts - 1) await sleep(250 * 2 ** i);
    } finally {
      clear();
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Try `fn` against each base URL in order until one succeeds. Throws the last
 * error if all fail. Useful for public RPC fallbacks.
 */
export async function withFallback<T>(
  urls: readonly string[],
  fn: (baseUrl: string) => Promise<T>,
  opts: { signal?: AbortSignal; onError?: (url: string, err: unknown) => void } = {},
): Promise<T> {
  if (urls.length === 0) throw new Error('No endpoints configured');
  let lastErr: unknown;
  for (const url of urls) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
    try {
      return await fn(url);
    } catch (err) {
      lastErr = err;
      opts.onError?.(url, err);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown[] | Record<string, unknown>;
}

let rpcId = 1;

/** Single JSON-RPC call. Throws RpcError on an `error` payload. */
export async function jsonRpc<T = unknown>(
  url: string,
  method: string,
  params: unknown[] | Record<string, unknown> = [],
  opts: Omit<FetchJsonOptions, 'body' | 'method'> = {},
): Promise<T> {
  const req: JsonRpcRequest = { jsonrpc: '2.0', id: rpcId++, method, params };
  const res = await fetchJson<{ result?: T; error?: { code: number; message: string; data?: unknown } }>(url, {
    ...opts,
    method: 'POST',
    body: req,
  });
  if (!res || typeof res !== 'object' || Array.isArray(res) || !('result' in res || 'error' in res)) {
    // 2xx with HTML/text/empty body (challenge page, proxy error): not a usable answer, let the caller fall back.
    throw new RpcError(`Malformed JSON-RPC response from ${redactUrl(url)}`, undefined, res);
  }
  if (res.error) {
    throw new RpcError(res.error.message || 'RPC error', res.error.code, res.error.data);
  }
  return res.result as T;
}

/** Batched JSON-RPC call; returns results in request order (errors become RpcError instances). */
export async function jsonRpcBatch(
  url: string,
  calls: { method: string; params?: unknown[] }[],
  opts: Omit<FetchJsonOptions, 'body' | 'method'> = {},
): Promise<(unknown | RpcError)[]> {
  if (calls.length === 0) return [];
  const reqs: JsonRpcRequest[] = calls.map((c) => ({ jsonrpc: '2.0', id: rpcId++, method: c.method, params: c.params ?? [] }));
  const res = await fetchJson<unknown>(url, { ...opts, method: 'POST', body: reqs });
  const arr = Array.isArray(res) ? res : [res];
  const byId = new Map<number, { result?: unknown; error?: { code: number; message: string; data?: unknown } }>();
  for (const r of arr as { id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }[]) {
    byId.set(r.id, r);
  }
  return reqs.map((r) => {
    const hit = byId.get(r.id);
    if (!hit) return new RpcError('missing batch response');
    if (hit.error) return new RpcError(hit.error.message, hit.error.code, hit.error.data);
    return hit.result;
  });
}

/** Simple concurrency limiter for fan-out requests. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Build a query string, skipping undefined values. */
export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}
