import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL: "http://127.0.0.1:4174",
    hasTouch: true,
    isMobile: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "photo-chromium", use: { browserName: "chromium", viewport: { width: 375, height: 667 } } },
    { name: "photo-webkit", use: { browserName: "webkit", viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: "npm run start -- --host 127.0.0.1 --port 4174",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
