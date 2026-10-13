/**
 * README screenshot capture (docs/screenshots/*.png).
 *
 * Skipped unless `SCREENSHOTS=1` so the regular smoke run stays fast and
 * deterministic. It reuses the smoke suite's network mocks, so the pictures
 * show the same fixture data (1 ETH balance, one USDC transfer, empty
 * history) and no blockchain API is contacted:
 *
 *   npm run build && SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { ADDRESS, expect, expectNoConsoleErrors, hashRoute, LOAD_TIMEOUT, test, TX_HASH } from './mocks';

const ENABLED = process.env.SCREENSHOTS === '1';
const OUT_DIR = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));

test.describe('README screenshots', () => {
  test.skip(!ENABLED, 'set SCREENSHOTS=1 to capture docs/screenshots/*.png');
  test.use({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });

  test.beforeAll(() => {
    if (ENABLED) mkdirSync(OUT_DIR, { recursive: true });
  });

  async function capture(page: Page, name: string): Promise<void> {
    // Let pending queries (prices, multi-chain balances) settle so no spinner is caught mid-way.
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await page.screenshot({ path: `${OUT_DIR}${name}.png`, animations: 'disabled' });
  }

  test('home', async ({ page, consoleErrors }) => {
    await page.goto('./');
    await expect(page.locator('h1').first()).toBeVisible();
    await expect(page.getByTestId('search-input')).toBeVisible();
    await capture(page, 'home');
    expectNoConsoleErrors(consoleErrors);
  });

  test('address', async ({ page, consoleErrors }) => {
    await page.goto(hashRoute(`/address/ethereum/${ADDRESS}`));
    await expect(page.getByTestId('address-native-balance')).toContainText('ETH', { timeout: LOAD_TIMEOUT });
    await expect(page.getByTestId('risk-badge')).toContainText(/none|low|medium|high|critical/i, { timeout: LOAD_TIMEOUT });
    await capture(page, 'address');
    expectNoConsoleErrors(consoleErrors);
  });

  test('tx', async ({ page, consoleErrors }) => {
    await page.goto(hashRoute(`/tx/ethereum/${TX_HASH}`));
    await expect(page.getByTestId('tx-status')).toContainText(/success/i, { timeout: LOAD_TIMEOUT });
    await expect(page.getByTestId('tx-transfers')).toContainText('USDC', { timeout: LOAD_TIMEOUT });
    await capture(page, 'tx');
    expectNoConsoleErrors(consoleErrors);
  });

  test('trace', async ({ page, consoleErrors }) => {
    await page.goto(hashRoute(`/trace/ethereum/${ADDRESS}`));
    await expect(page.getByTestId('trace-page')).toBeVisible({ timeout: LOAD_TIMEOUT });
    await page.getByTestId('trace-run').click();
    await expect(page.getByTestId('flow-graph')).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(page.getByTestId('trace-page')).toContainText(/Done:/, { timeout: LOAD_TIMEOUT });
    await capture(page, 'trace');
    expectNoConsoleErrors(consoleErrors);
  });

  test('cases', async ({ page, consoleErrors }) => {
    await page.goto(hashRoute('/cases'));
    await expect(page.getByTestId('cases-page')).toBeVisible({ timeout: LOAD_TIMEOUT });
    await page.getByTestId('case-title-input').fill('Bridge exploit follow-up');
    await page.getByTestId('case-create').click();
    await page.getByTestId('case-note-input').fill('Funds left the exploiter wallet in three hops; the last one lands on a CEX hot wallet.');
    await page.getByTestId('case-add-note').click();
    await expect(page.getByTestId('cases-page')).toContainText('three hops');
    await capture(page, 'cases');
    expectNoConsoleErrors(consoleErrors);
  });

  test('settings', async ({ page, consoleErrors }) => {
    await page.goto(hashRoute('/settings'));
    await expect(page.getByTestId('settings-page')).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(page.getByTestId('settings-rpc-ethereum')).toBeVisible();
    await capture(page, 'settings');
    expectNoConsoleErrors(consoleErrors);
  });
});
