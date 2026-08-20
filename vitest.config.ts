import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					globals: true,
					environment: "node",
					include: ["src/**/*.unit.test.{ts,tsx}"],
				},
			},
			{
				test: {
					name: "integration",
					globals: true,
					environment: "node",
					include: ["src/**/*.integration.test.{ts,tsx}", "tests/**/*.integration.test.{ts,tsx}"],
					exclude: ["**/node_modules/**"],
				},
			},
		],
	},
});
