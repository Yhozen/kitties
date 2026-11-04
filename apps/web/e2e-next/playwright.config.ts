import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 30000,
  use: {
    locale: "es-ES",
    baseURL: process.env.KITTIES_TEST_URL ?? "http://localhost:1337",
    launchOptions: {
      executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome",
      args: ["--no-sandbox"],
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
