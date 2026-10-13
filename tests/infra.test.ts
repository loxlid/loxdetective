import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * playwright.config.ts must derive the preview URL from the same VITE_BASE
 * that vite.config.ts builds for, otherwise the e2e run hits a 404 outside
 * the preview server's base.
 */
async function loadConfig(base: string | undefined) {
  vi.resetModules();
  if (base === undefined) delete process.env.VITE_BASE;
  else process.env.VITE_BASE = base;
  const mod = await import('../playwright.config');
  return mod.default as { use?: { baseURL?: string }; webServer?: { url?: string } | { url?: string }[] };
}

const ORIGINAL = process.env.VITE_BASE;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.VITE_BASE;
  else process.env.VITE_BASE = ORIGINAL;
  vi.resetModules();
});

function serverUrl(cfg: Awaited<ReturnType<typeof loadConfig>>): string | undefined {
  const ws = cfg.webServer;
  return Array.isArray(ws) ? ws[0]?.url : ws?.url;
}

describe('playwright.config.ts follows VITE_BASE', () => {
  it('defaults to the GitHub Pages base', async () => {
    const cfg = await loadConfig(undefined);
    expect(cfg.use?.baseURL).toBe('http://127.0.0.1:4173/loxdetective/');
    expect(serverUrl(cfg)).toBe(cfg.use?.baseURL);
  });

  it.each(['/my-fork/', '/'])('uses VITE_BASE=%s for both the baseURL and the readiness probe', async (base) => {
    const cfg = await loadConfig(base);
    expect(cfg.use?.baseURL).toBe(`http://127.0.0.1:4173${base}`);
    expect(serverUrl(cfg)).toBe(cfg.use?.baseURL);
  });
});
