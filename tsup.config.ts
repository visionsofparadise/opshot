import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/react.tsx"],
  format: ["esm"],
  dts: true,
  treeshake: true,
  clean: true,
  splitting: false,
  external: ["react"],
});
