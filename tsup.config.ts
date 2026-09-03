import { defineConfig } from "tsup";

export default defineConfig({
	entry: { index: "src/index.ts" },
	format: ["esm"],
	dts: true,
	treeshake: true,
	clean: true,
	splitting: false,
	external: ["react"],
});
