import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const harnessFile = (name: string): string => fileURLToPath(new URL(`tests/harness/${name}`, import.meta.url));

const fixturePackage = (version: string, pkg: "react" | "react-dom"): string =>
	fileURLToPath(new URL(`fixtures/react${version}/node_modules/${pkg}`, import.meta.url));

const reactFixtureAliases = (
	version: "16" | "17" | "18",
	adapter: "adapterLegacy.ts" | "adapterModern.ts",
): Array<{ find: RegExp; replacement: string }> => {
	const reactPath = fixturePackage(version, "react");
	const reactDomPath = fixturePackage(version, "react-dom");
	const aliases: Array<{ find: RegExp; replacement: string }> = [];

	if (version === "16") {
		const jsxRuntimeShim = harnessFile("jsxRuntimeShim.ts");

		aliases.push(
			{ find: /^react\/jsx-runtime$/, replacement: jsxRuntimeShim },
			{ find: /^react\/jsx-dev-runtime$/, replacement: jsxRuntimeShim },
		);
	}

	aliases.push(
		{ find: /^react\/(.*)$/, replacement: `${reactPath}/$1` },
		{ find: /^react$/, replacement: reactPath },
		{ find: /^react-dom\/(.*)$/, replacement: `${reactDomPath}/$1` },
		{ find: /^react-dom$/, replacement: reactDomPath },
		{ find: /^opshot-react-adapter$/, replacement: harnessFile(adapter) },
	);

	return aliases;
};

const sharedReactTests = ["src/react/*.integration.test.tsx", "src/scenarios/valueMatrixScope.integration.test.tsx"];

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
				resolve: {
					alias: [{ find: /^opshot-react-adapter$/, replacement: harnessFile("adapterModern.ts") }],
				},
				test: {
					name: "integration",
					globals: true,
					environment: "node",
					include: ["src/**/*.integration.test.{ts,tsx}", "tests/**/*.integration.test.{ts,tsx}"],
					exclude: ["**/node_modules/**"],
				},
			},
			{
				resolve: {
					alias: reactFixtureAliases("16", "adapterLegacy.ts"),
				},
				test: {
					name: "react16",
					globals: true,
					environment: "node",
					include: sharedReactTests,
				},
			},
			{
				resolve: {
					alias: reactFixtureAliases("17", "adapterLegacy.ts"),
				},
				test: {
					name: "react17",
					globals: true,
					environment: "node",
					include: sharedReactTests,
				},
			},
			{
				resolve: {
					alias: reactFixtureAliases("18", "adapterModern.ts"),
				},
				test: {
					name: "react18",
					globals: true,
					environment: "node",
					include: sharedReactTests,
				},
			},
		],
	},
});
