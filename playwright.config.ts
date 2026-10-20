import { defineConfig } from "@playwright/test";

const browserName =
  process.env.PLAYWRIGHT_BROWSER === "webkit" ? "webkit" : "chromium";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  use: {
    browserName,
    baseURL: "http://127.0.0.1:1420",
    viewport: { width: 1360, height: 860 },
    ...(browserName === "chromium" && process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? {
          launchOptions: {
            executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
          },
        }
      : {}),
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
  },
});
