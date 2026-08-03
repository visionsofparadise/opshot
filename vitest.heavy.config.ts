import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "heavy",
		globals: true,
		environment: "node",
		include: ["src/**/*.integration.heavy.test.{ts,tsx}", "tests/**/*.integration.heavy.test.{ts,tsx}"],
		fileParallelism: false,
		testTimeout: 60_000,
	},
});
