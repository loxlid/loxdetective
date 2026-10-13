/**
 * LoxDetective smoke tests (Playwright).
 *
 * They run against the production build served by `vite preview` (see
 * playwright.config.ts) with every external request answered from the
 * fixtures in ./mocks.ts (JSON-RPC, Blockscout, Esplora, DefiLlama, OFAC).
 * Every test collects console errors and uncaught page errors and asserts at
 * the end that none occurred (resource 404s and favicon noise are tolerated).
 *
 * The data-testids used here are the UI contract documented in
 * docs/UI_TESTIDS.md.
 */
import { ADDRESS, CASES_KEY, CUSTOM_RPC, escapeRegExp, expect, expectNoConsoleErrors, hashRoute, LOAD_TIMEOUT, SETTINGS_KEY, test, TX_HASH } from './mocks';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('LoxDetective smoke', () => {
  test('home renders the hero heading, search bar and navigation', async ({ page, consoleErrors }) => {
    await page.goto('./');
    await expect(page).toHaveTitle(/LoxDetective/);
    await expect(page.locator('h1').first()).toBeVisible();

    const input = page.getByTestId('search-input');
    await expect(input).toBeVisible();
    await expect(page.getByTestId('search-submit')).toBeVisible();
    for (const id of ['nav-home', 'nav-cases', 'nav-settings', 'nav-about']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }

    await input.fill('vitalik.eth');
    await expect(input).toHaveValue('vitalik.eth');
    expectNoConsoleErrors(consoleErrors);
  });

  test('searching an EVM address opens the profile with the mocked native balance', async ({ page, consoleErrors }) => {
    await page.goto('./');
    await page.getByTestId('search-input').fill(ADDRESS);
    await page.getByTestId('search-submit').click();

    await expect(page).toHaveURL(new RegExp(`#/address/ethereum/${ADDRESS}`, 'i'), { timeout: LOAD_TIMEOUT });
    await expect(page.getByTestId('address-page')).toBeVisible({ timeout: LOAD_TIMEOUT });

    const balance = page.getByTestId('address-native-balance');
    await expect(balance).toContainText('1', { timeout: LOAD_TIMEOUT });
    await expect(balance).toContainText('ETH');
    expectNoConsoleErrors(consoleErrors);
  });

  test('transaction page shows the mocked status and decoded ERC-20 transfer', async ({ page, consoleErrors }) => {
    await page.goto(hashRoute(`/tx/ethereum/${TX_HASH}`));
    await expect(page.getByTestId('tx-page')).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(page.getByTestId('tx-status')).toContainText(/success/i, { timeout: LOAD_TIMEOUT });
    await expect(page.getByTestId('tx-transfers')).toContainText('USDC', { timeout: LOAD_TIMEOUT });
    expectNoConsoleErrors(consoleErrors);
  });

  test('settings persist a custom Ethereum RPC across reloads', async ({ page, consoleErrors }) => {
    await page.goto(hashRoute('/settings'));
    await expect(page.getByTestId('settings-page')).toBeVisible({ timeout: LOAD_TIMEOUT });

    await page.getByTestId('settings-rpc-ethereum').fill(CUSTOM_RPC);
    await page.getByTestId('settings-save').click();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY)).toContain(CUSTOM_RPC);

    await page.reload();
    await expect(page.getByTestId('settings-rpc-ethereum')).toHaveValue(new RegExp(escapeRegExp(CUSTOM_RPC)), { timeout: LOAD_TIMEOUT });
    expectNoConsoleErrors(consoleErrors);
  });

  test('cases: a new case and its note survive a reload', async ({ page, consoleErrors }) => {
    await page.goto(hashRoute('/cases'));
    const casesPage = page.getByTestId('cases-page');
    await expect(casesPage).toBeVisible({ timeout: LOAD_TIMEOUT });

    await page.getByTestId('case-title-input').fill('Test case');
    await page.getByTestId('case-create').click();
    await expect(casesPage).toContainText('Test case');

    await page.getByTestId('case-note-input').fill('hello');
    await page.getByTestId('case-add-note').click();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), CASES_KEY)).toContain('hello');

    await page.reload();
    await expect(casesPage).toContainText('Test case', { timeout: LOAD_TIMEOUT });
    await expect(casesPage).toContainText('hello');
    expectNoConsoleErrors(consoleErrors);
  });
});
