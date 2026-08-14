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
		} finally {
			await rm(outDir, { recursive: true, force: true });
		}
	}, 120_000);
});
