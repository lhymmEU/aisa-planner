import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      "eve-tool": "src/eve-tool.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    entry: {
      cli: "src/cli.ts",
      mcp: "src/mcp.ts",
      "catalog-build": "src/catalog-build.ts",
    },
    format: ["esm"],
    splitting: true,
    sourcemap: true,
  },
]);
