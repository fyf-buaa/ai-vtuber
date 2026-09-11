import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["pi/**", "node_modules/**", "dist/**", "web/dist/**"],
  },
});
