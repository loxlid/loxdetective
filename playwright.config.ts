import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// The CI container ships Chromium at /opt/pw-browsers; fall back to a plain
// `playwright install chromium` elsewhere.
const bundled = '/opt/pw-browsers/chromium';
const executablePath = existsSync(bundled) ? bundled : undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4173/loxdetective/',
    headless: true,
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/loxdetective/',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
