import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// The CI container ships Chromium at /opt/pw-browsers; fall back to a plain
// `playwright install chromium` elsewhere.
const bundled = '/opt/pw-browsers/chromium';
const executablePath = existsSync(bundled) ? bundled : undefined;

// Mirror vite.config.ts: the preview server serves the build under VITE_BASE
// (default `/loxdetective/`), so the e2e URLs must follow the same base.
const base = process.env.VITE_BASE ?? '/loxdetective/';
const origin = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: origin + base,
    headless: true,
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: origin + base,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
