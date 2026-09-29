import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/native/**/*.test.ts", "test/native/**/*.test.tsx"],
    environment: "node",
    fileParallelism: false,
  },
});
