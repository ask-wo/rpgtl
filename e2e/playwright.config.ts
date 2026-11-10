import { availableParallelism } from "node:os";
import { defineConfig } from "@playwright/test";

const smallMachine = availableParallelism() < 4;

export default defineConfig({
  testDir: ".",
  outputDir: "../.e2e-results",
  // Each worker starts its own RPGTL; from a checkout it builds the page on its first request.
  workers: smallMachine ? 1 : 2,
  // On 2 CPUs, a test that plays MV's real engine takes 1.5 to 2.5 minutes.
  timeout: smallMachine ? 300_000 : 120_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    // A click on a locator that matches nothing fails after this, not at the test's timeout.
    actionTimeout: 10_000,
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
