import { defineConfig, devices } from "@playwright/test";
// Parallel checkouts each set their own E2E_PORT so their servers never mix.
const port = Number(process.env.E2E_PORT) || 5198;
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  timeout: 30000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    // Specs written against a blank first slide keep it: new presentations
    // start with the blank slide the app offers as a preference. Specs about
    // the Title Slide start (e2e/layouts.spec.js) clear this.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: `http://127.0.0.1:${port}`,
          localStorage: [{ name: "presentation:start", value: "blank" }],
        },
      ],
    },
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 960 },
      },
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
    {
      name: "tablet",
      use: { ...devices["iPad Mini"], defaultBrowserType: "chromium" },
    },
  ],
});
