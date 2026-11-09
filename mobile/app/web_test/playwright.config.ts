// The phone's Mermaid page (assets/mermaid/render.html) in Chromium, the engine of Android's WebView. No servers.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  timeout: 60_000,
  reporter: 'list',
  use: { channel: 'chrome', headless: true },
});
