import { defineConfig } from "tsup";

export default defineConfig({
	entry: { index: "src/index.ts", react: "src/react/index.ts" },
	format: ["esm"],
	dts: true,
	treeshake: true,
	clean: true,
	splitting: false,
	external: ["react"],
});
