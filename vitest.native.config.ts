import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["apps/desktop/src/**/*.native.test.ts"],
    pool: "forks",
    maxWorkers: 1,
  },
});
