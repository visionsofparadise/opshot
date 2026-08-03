import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const react18File = "src/react/renderPhase18.integration.test.tsx";
const react18Modules = fileURLToPath(new URL("fixtures/react18/node_modules/", import.meta.url));

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
					exclude: ["**/node_modules/**", react18File],
				},
			},
			{
				resolve: {
					alias: {
						react: `${react18Modules}react`,
						"react-dom": `${react18Modules}react-dom`,
					},
				},
				test: {
					name: "react18",
					globals: true,
					environment: "node",
					include: [react18File],
				},
			},
		],
	},
});
