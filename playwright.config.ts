import { defineConfig, devices } from '@playwright/test';

// See https://playwright.dev/docs/test-configuration
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI, // a stray test.only fails CI instead of silently skipping the rest
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'html',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    // A fixed zone with daylight saving time and a fixed locale: date labels must not depend on the machine.
    timezoneId: 'America/Los_Angeles',
    locale: 'en-US',
    trace: 'on-first-retry',
    // A service worker's own fetches are not page 'request' events; block them so the egress test sees every request.
    serviceWorkers: 'block',
  },
  projects: [
    // The server's input-handling tests need no browser, so they run once, in their own project.
    { name: 'server', testMatch: /server\.spec\.ts/ },
    { name: 'chromium', testIgnore: /server\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', testIgnore: /server\.spec\.ts/, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', testIgnore: /server\.spec\.ts/, use: { ...devices['Desktop Safari'] } },
  ],
  // Serve ./demo before the tests and stop it afterwards, so the suite does not depend on a deployed site.
  webServer: {
    // SERVE_DEMO: scripts/mutants.js points this at a mutated copy, so the tracked server file is never edited.
    command: 'node ' + (process.env.SERVE_DEMO || 'scripts/serve-demo.js'),
    url: 'http://127.0.0.1:4173',
    // Never reuse a running server when DEMO_ROOT is set: scripts/mutants.js must test the broken copy it serves.
    reuseExistingServer: !process.env.CI && !process.env.DEMO_ROOT && !process.env.SERVE_DEMO,
  },
});
