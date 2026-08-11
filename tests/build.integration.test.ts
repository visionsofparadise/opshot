import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { build, type Options } from "tsup";
import sharedConfig from "../tsup.config";

interface PackageManifest {
	exports: {
		".": {
			import: string;
		};
	};
}

const bareSpecifier = /(?:from|import|require)\s*\(?\s*['"](?:valtio|proxy-compare)(?:\/[^'"]*)?['"]/;

describe("package build", () => {
	it("emits one entry matching exports['.'] with no bare valtio or proxy-compare specifier", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "opshot-build-"));

		try {
			await build({ ...(sharedConfig as Options), outDir, silent: true });

			const emitted = await readdir(outDir);
			const jsEntries = emitted.filter((name) => name.endsWith(".js"));

			const manifest = JSON.parse(
				await readFile(new URL("../package.json", import.meta.url), "utf8"),
			) as PackageManifest;
			const expectedEntry = basename(manifest.exports["."].import);

			expect(jsEntries).toEqual([expectedEntry]);

			for (const name of emitted) {
				const contents = await readFile(join(outDir, name), "utf8");

				expect(bareSpecifier.test(contents), `${name} carries a bare valtio/proxy-compare specifier`).toBe(false);
			}
		} finally {
			await rm(outDir, { recursive: true, force: true });
		}
	}, 120_000);

	it("emits jsdoc on declarations and property signatures in index.d.ts", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "opshot-build-jsdoc-"));

		try {
			await build({ ...(sharedConfig as Options), outDir, silent: true });

			const declaration = await readFile(join(outDir, "index.d.ts"), "utf8");

			expect(
				/\/\*\*[\s\S]*?\*\/\s*declare\s+function\s+createMutableState\b/.test(declaration),
				"createMutableState must be preceded by a /** */ block",
			).toBe(true);

			expect(
				/\/\*\*[\s\S]*?\*\/\s*readonly\s+emitOn\s*\?/.test(declaration),
				"emitOn must be preceded by a /** */ block",
			).toBe(true);

			const createMutableStateBlock = declaration.match(
				/\/\*\*[\s\S]*?\*\/\s*declare\s+function\s+createMutableState\b/,
			)?.[0];
			expect(createMutableStateBlock, "createMutableState jsdoc block present").toBeDefined();
			expect(
				createMutableStateBlock,
				"closed-graph definition: reachable from its root through tracked edges",
			).toMatch(/reachable from its root through tracked edges/);
			expect(createMutableStateBlock, "endpoint vocabulary").toMatch(/endpoint/);
			expect(createMutableStateBlock, "strictness join refusal").toMatch(/differing strictness refuse to join/);
			expect(createMutableStateBlock, "cycle retirement").toMatch(/no cycle throws/);

			const applyOperationsBlock = declaration.match(
				/\/\*\*[\s\S]*?\*\/\s*declare\s+function\s+applyOperations\b/,
			)?.[0];
			expect(applyOperationsBlock, "applyOperations jsdoc block present").toBeDefined();
			expect(applyOperationsBlock, "idempotence guarantee").toMatch(/idempotent/i);
			expect(applyOperationsBlock, "root path /").toMatch(/"\/"/);
			expect(applyOperationsBlock, "JSON residue for carried sharing").toMatch(
				/in-memory sharing[\s\S]*replay-side/i,
			);

			const diffObjectsBlock = declaration.match(/\/\*\*[\s\S]*?\*\/\s*declare\s+function\s+diffObjects\b/)?.[0];
			expect(diffObjectsBlock, "diffObjects jsdoc block present").toBeDefined();
			expect(diffObjectsBlock, "carriage closure").toMatch(/closure/);
			expect(diffObjectsBlock, "per-route minting").toMatch(/k routes mints k ops/);

			const stateSubscribeBlock = declaration.match(
				/\/\*\*[\s\S]*?delivered before unsubscribe returns[\s\S]*?\*\/\s*declare\s+function\s+subscribe\s*\(\s*state:/,
			)?.[0];
			expect(stateSubscribeBlock, "subscribe state-overload delivery contract").toBeDefined();
			expect(stateSubscribeBlock, "reachable-graph emission doctrine").toMatch(
				/every change in its reachable graph/,
			);

			const groupSubscribeBlock = declaration.match(
				/\/\*\*[\s\S]*?best-effort at the group edge[\s\S]*?\*\/\s*declare\s+function\s+subscribe\s*\(\s*group:/,
			)?.[0];
			expect(groupSubscribeBlock, "subscribe group-overload best-effort line").toBeDefined();

			const ignoreBlock = declaration.match(/\/\*\*[\s\S]*?\*\/\s*declare\s+const\s+ignore\b/)?.[0];
			expect(ignoreBlock, "ignore jsdoc block present").toBeDefined();
			expect(ignoreBlock, "ignore as endpoint").toMatch(/endpoint/);

			const strictBlock = declaration.match(/\/\*\*[\s\S]*?\*\/\s*readonly\s+strict\s*\?/)?.[0];
			expect(strictBlock, "strict option jsdoc present").toBeDefined();
			expect(strictBlock, "strictness-join remedies").toMatch(/refuse to join/);
		} finally {
			await rm(outDir, { recursive: true, force: true });
		}
	}, 120_000);
});
