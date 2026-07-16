import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/resnapshot.tsx"],
  format: ["esm"],
  dts: true,
  treeshake: true,
  clean: true,
  splitting: false,
  external: ["react"],
});
