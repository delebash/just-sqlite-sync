// SPDX-License-Identifier: MIT
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    pool: "forks",
    testTimeout: 60000,
    restoreMocks: true,
  },
});
