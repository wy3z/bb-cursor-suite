import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const panels = dirname(fileURLToPath(import.meta.resolve("react-resizable-panels")));

export default {
  resolve: {
    alias: {
      "react-resizable-panels": join(panels, "react-resizable-panels.browser.cjs.js"),
    },
  },
  test: {
    silent: "passed-only",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", "dist/**", "generated/**"],
  },
};
