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

// Immediately preceding block comment for a declaration match, or undefined.
const jsdocBefore = (source: string, declaration: RegExp): string | undefined => {
	const match = source.match(declaration);

	if (match?.index === undefined) return undefined;

	const prefix = source.slice(0, match.index);
	const blocks = prefix.match(/\/\*\*[\s\S]*?\*\//g);

	if (blocks === null) return undefined;

	const last = blocks.at(-1);

	if (last === undefined) return undefined;

	const lastIndex = prefix.lastIndexOf(last);
	const between = prefix.slice(lastIndex + last.length);

	if (between.trim() !== "") return undefined;

	return last;
};

// Flatten jsdoc line-prefix stars so multi-line phrases match as prose.
const jsdocProse = (block: string): string => block.replace(/\n\s*\*\s?/g, "\n").replace(/\n+/g, " ");

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
				jsdocBefore(declaration, /declare\s+function\s+createMutableState\b/) !== undefined,
				"createMutableState must be preceded by a /** */ block",
			).toBe(true);

			expect(
				jsdocBefore(declaration, /readonly\s+emitOn\s*\?/) !== undefined,
				"emitOn must be preceded by a /** */ block",
			).toBe(true);

			const createMutableStateBlock = jsdocBefore(declaration, /declare\s+function\s+createMutableState\b/);
			expect(createMutableStateBlock, "createMutableState jsdoc block present").toBeDefined();
			const createMutableStateProse = jsdocProse(createMutableStateBlock!);
			expect(
				createMutableStateProse,
				"closed-graph definition: reachable from its root through tracked edges",
			).toMatch(/reachable from its root through tracked edges/);
			expect(createMutableStateProse, "endpoint vocabulary").toMatch(/endpoint/);
			expect(createMutableStateProse, "strictness join refusal").toMatch(/differing strictness refuse to join/);
			expect(createMutableStateProse, "cycle retirement").toMatch(/no cycle throws/);
			expect(createMutableStateProse, "batch-scoped stream contract").toMatch(
				/self-contained unit is the transaction batch/,
			);
			expect(createMutableStateProse, "link-carried sharing in stream clause").toMatch(/link ops/);

			const applyOperationsBlock = jsdocBefore(declaration, /declare\s+function\s+applyOperations\b/);
			expect(applyOperationsBlock, "applyOperations jsdoc block present").toBeDefined();
			const applyOperationsProse = jsdocProse(applyOperationsBlock!);
			expect(applyOperationsProse, "batch is the self-contained unit").toMatch(/self-contained unit/i);
			expect(applyOperationsProse, "link verb in algebra").toMatch(/\blink\b/);
			expect(applyOperationsProse, "target-path ordering rule").toMatch(/target-path/i);
			expect(applyOperationsProse, "batch-scoped ref resolvability").toMatch(/batch-scoped/i);
			expect(applyOperationsProse, "scoped JSON: link-carried sharing survives").toMatch(
				/Link-carried sharing survives serialization/i,
			);
			expect(applyOperationsProse, "projection recipe includes ref").toMatch(/\.ref/);

			const diffObjectsBlock = jsdocBefore(declaration, /declare\s+function\s+diffObjects\b/);
			expect(diffObjectsBlock, "diffObjects jsdoc block present").toBeDefined();
			const diffObjectsProse = jsdocProse(diffObjectsBlock!);
			expect(diffObjectsProse, "plain-object value diffing with severance").toMatch(/severance/i);
			expect(diffObjectsProse, "no links on public plain diff").toMatch(/mints no links/);

			const stateSubscribeBlock = jsdocBefore(declaration, /declare\s+function\s+subscribe\s*\(\s*state:/);
			expect(stateSubscribeBlock, "subscribe state-overload jsdoc block present").toBeDefined();
			const stateSubscribeProse = jsdocProse(stateSubscribeBlock!);
			expect(stateSubscribeProse, "reachable-graph emission doctrine").toMatch(
				/every change in its reachable graph/,
			);
			expect(stateSubscribeProse, "delivery-before-unsubscribe contract").toMatch(
				/delivered before unsubscribe returns/,
			);

			const groupSubscribeBlock = jsdocBefore(declaration, /declare\s+function\s+subscribe\s*\(\s*group:/);
			expect(groupSubscribeBlock, "subscribe group-overload jsdoc block present").toBeDefined();
			const groupSubscribeProse = jsdocProse(groupSubscribeBlock!);
			expect(groupSubscribeProse, "subscribe group-overload best-effort line").toMatch(
				/best-effort at the group edge/,
			);

			const ignoreBlock = jsdocBefore(declaration, /declare\s+const\s+ignore\b/);
			expect(ignoreBlock, "ignore jsdoc block present").toBeDefined();
			expect(jsdocProse(ignoreBlock!), "ignore as endpoint").toMatch(/endpoint/);

			const strictBlock = jsdocBefore(declaration, /readonly\s+strict\s*\?/);
			expect(strictBlock, "strict option jsdoc present").toBeDefined();
			expect(jsdocProse(strictBlock!), "strictness-join remedies").toMatch(/refuse to join/);
		} finally {
			await rm(outDir, { recursive: true, force: true });
		}
	}, 120_000);
});
