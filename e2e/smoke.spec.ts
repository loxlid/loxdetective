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
 * docs/UI_TESTIDS.md (the 28 core ids plus the additive round-2 and round-3 ids).
 */
import { ADDRESS, CASES_KEY, CUSTOM_RPC, escapeRegExp, EVM_MAINNET_CHAINS, expect, expectNoConsoleErrors, hashRoute, LABELS_KEY, LOAD_TIMEOUT, overrideRpc, rpcErrorFor, SETTINGS_KEY, test, TX_HASH } from './mocks';

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

  test('skip link moves focus to the main region without navigating the hash router', async ({ page, consoleErrors }) => {
    await page.goto(hashRoute('/about'));
    const main = page.locator('main#main');
    await expect(main).toContainText('About LoxDetective', { timeout: LOAD_TIMEOUT });

    // The skip link is the first focusable element; activating it must not turn `#main` into a route.
    await page.keyboard.press('Tab');
    await expect(page.locator('a.skip-link')).toBeFocused();
    await page.keyboard.press('Enter');

    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/about');
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main');
    await expect(main).toContainText('About LoxDetective');
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

  test('address overview probes every EVM chain and shows the mocked activity', async ({ page, consoleErrors }) => {
    await page.goto(hashRoute(`/address/ethereum/${ADDRESS}`));
    const strip = page.getByTestId('address-activity-strip');
    await expect(strip).toBeVisible({ timeout: LOAD_TIMEOUT });

    // One tile per EVM mainnet, each answered by the batched [eth_getBalance, eth_getTransactionCount] fixture (1 native unit, nonce 0x5).
    const tiles = strip.locator('.activity-tile');
    const total = EVM_MAINNET_CHAINS.length;
    await expect(tiles).toHaveCount(total, { timeout: LOAD_TIMEOUT });
    await expect(strip.locator('.activity-tile__txs')).toHaveText(Array<string>(total).fill('5 txs'), { timeout: LOAD_TIMEOUT });
    await expect(strip).toContainText(`Active on ${total} of ${total} chains`);
    await expect(strip).toContainText('in native balances');

    // The Ethereum tile is the current chain, carries the mocked balance and its DefiLlama USD value.
    const ethereum = strip.locator('.activity-tile.is-current');
    await expect(ethereum).toHaveCount(1);
    await expect(ethereum).toContainText('1 ETH');
    await expect(ethereum).toContainText('$2,500');
    await expect(ethereum).toHaveAttribute('href', new RegExp(`#/address/ethereum/${ADDRESS}`, 'i'));
    await expect(strip.locator('.activity-tile.is-failed')).toHaveCount(0);
    // Active everywhere, so the "active elsewhere" callout stays hidden.
    await expect(page.getByTestId('address-active-elsewhere')).toHaveCount(0);
    expectNoConsoleErrors(consoleErrors);
  });

  test('approvals tab warns when the RPC refuses the approval log query', async ({ page, consoleErrors }) => {
    await overrideRpc(page, rpcErrorFor('eth_getLogs', 'query exceeds max block range'));
    await page.goto(hashRoute(`/address/ethereum/${ADDRESS}`));
    await expect(page.getByTestId('address-native-balance')).toContainText('ETH', { timeout: LOAD_TIMEOUT });

    const tab = page.getByTestId('address-tab-approvals');
    await tab.click();
    const banner = page.getByTestId('approvals-incomplete');
    await expect(banner).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(banner).toHaveAttribute('role', 'alert');
    await expect(banner).toContainText('Approval scan incomplete');
    await expect(banner).toContainText('The Ethereum RPC refused the approval log query (query exceeds max block range)');
    await expect(banner).toContainText('were not scanned');
    await expect(banner.getByRole('link', { name: /custom RPC in Settings/i })).toHaveAttribute('href', /#\/settings$/);

    // Partial result: the empty state says so and the tab counter is a lower bound.
    await expect(page.getByText('No approvals in the scanned part')).toBeVisible();
    await expect(tab).toContainText('0+');
    await expect(tab).toHaveAttribute('title', /lower bound/i);
    expectNoConsoleErrors(consoleErrors);
  });

  test('a trace can be saved to a case and reopened from the Cases page', async ({ page, consoleErrors }) => {
    await page.goto(hashRoute(`/trace/ethereum/${ADDRESS}`));
    await expect(page.getByTestId('trace-page')).toBeVisible({ timeout: LOAD_TIMEOUT });
    const save = page.getByTestId('trace-save-case');
    await expect(save).toBeDisabled();

    await page.getByTestId('trace-run').click();
    await expect(page.getByTestId('flow-graph')).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(page.getByTestId('trace-page')).toContainText(/Done:/, { timeout: LOAD_TIMEOUT });
    await expect(save).toBeEnabled();

    // No case exists yet: saving creates "New case" and stores the graph JSON with the options the trace ran with.
    await save.click();
    await expect(page.locator('.toast-stack')).toContainText('Trace saved to "New case"');
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), CASES_KEY)).toContain('"kind":"trace"');

    await page.goto(hashRoute('/cases'));
    const casesPage = page.getByTestId('cases-page');
    await expect(casesPage).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(casesPage).toContainText('New case');
    const row = page.getByTestId('case-attachment');
    await expect(row).toBeVisible();
    await expect(row).toContainText(/Ethereum trace of 0x742d/i);
    await expect(page.getByTestId('case-attachment-stats')).toContainText('1 address');
    await expect(page.getByTestId('case-attachment-stats')).toContainText('2 hops');

    // "Open trace" re-enters the tracer with the saved options in the query string.
    await page.getByTestId('case-attachment-open').click();
    await expect(page).toHaveURL(new RegExp(`#/trace/ethereum/${ADDRESS}\\?(?=.*hops=2)(?=.*fanout=8)(?=.*direction=both)`, 'i'), { timeout: LOAD_TIMEOUT });
    await expect(page.getByTestId('trace-page')).toBeVisible();
    await expect(page.getByTestId('trace-max-hops')).toHaveValue('2');
    await expect(page.getByTestId('trace-max-fanout')).toHaveValue('8');
    expectNoConsoleErrors(consoleErrors);
  });

  test('a custom label imported in Settings shows as a chip on the address profile', async ({ page, consoleErrors }) => {
    const wallet = '0x1111111111111111111111111111111111111111';
    await page.goto(hashRoute('/settings'));
    await expect(page.getByTestId('settings-page')).toBeVisible({ timeout: LOAD_TIMEOUT });

    await page.getByTestId('settings-labels-csv').fill(`${wallet},My test wallet,wallet,evm`);
    await page.getByTestId('settings-labels-import').click();
    await expect(page.getByTestId('settings-labels-count')).toContainText('1 custom label active');
    await expect(page.getByTestId('settings-labels-errors')).toHaveCount(0);
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), LABELS_KEY)).toContain('My test wallet');

    await page.goto(hashRoute(`/address/ethereum/${wallet}`));
    await expect(page.getByTestId('address-page')).toBeVisible({ timeout: LOAD_TIMEOUT });
    const chip = page.locator('.page-header__chips .chip', { hasText: 'My test wallet' });
    await expect(chip).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(chip).toHaveClass(/chip--wallet/);
    await expect(chip).toHaveAttribute('title', /My test wallet · wallet · user/);

    // The label must survive a full reload: main.tsx re-applies it from localStorage before the first render.
    await page.reload();
    await expect(page.locator('.page-header__chips .chip', { hasText: 'My test wallet' })).toBeVisible({ timeout: LOAD_TIMEOUT });
    expectNoConsoleErrors(consoleErrors);
  });
});
