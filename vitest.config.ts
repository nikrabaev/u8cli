import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Integration tests spawn real daemons/processes; keep them from stampeding.
    pool: "forks",
    poolOptions: { forks: { singleFork: false, maxForks: 4 } },
  },
});
