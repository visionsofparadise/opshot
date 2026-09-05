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
		"./react": {
			import: string;
		};
	};
}

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
	it("emits the root and react entries over one shared chunk, and only the react entry imports React", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "opshot-build-"));

		try {
			await build({ ...(sharedConfig as Options), outDir, silent: true });

			const emitted = await readdir(outDir);
			const jsEntries = emitted.filter((name) => name.endsWith(".js"));

			const manifest = JSON.parse(
				await readFile(new URL("../package.json", import.meta.url), "utf8"),
			) as PackageManifest;
			const expectedEntry = basename(manifest.exports["."].import);
			const expectedReactEntry = basename(manifest.exports["./react"].import);

			expect(jsEntries).toHaveLength(3);
			expect(jsEntries).toContain(expectedEntry);
			expect(jsEntries).toContain(expectedReactEntry);

			const chunk = jsEntries.find((name) => name !== expectedEntry && name !== expectedReactEntry);

			expect(chunk).toMatch(/^chunk-[A-Z0-9]+\.js$/);

			if (chunk === undefined) throw new Error("missing shared chunk");

			const [rootSource, chunkSource, reactSource, rootDeclaration, reactDeclaration] = await Promise.all([
				readFile(join(outDir, expectedEntry), "utf8"),
				readFile(join(outDir, chunk), "utf8"),
				readFile(join(outDir, expectedReactEntry), "utf8"),
				readFile(join(outDir, "index.d.ts"), "utf8"),
				readFile(join(outDir, "react.d.ts"), "utf8"),
			]);

			expect(rootSource).not.toMatch(/from ["']react["']/);
			expect(chunkSource).not.toMatch(/from ["']react["']/);
			expect(reactSource).toMatch(/from ["']react["']/);
			expect(rootDeclaration).not.toContain("'react'");
			expect(reactDeclaration).toContain("scope");
			expect(reactDeclaration).toContain("useMutableState");
		} finally {
			await rm(outDir, { recursive: true, force: true });
		}
	}, 120_000);

	it("emits jsdoc on declarations and property signatures in index.d.ts", async () => {
		const outDir = await mkdtemp(join(tmpdir(), "opshot-build-jsdoc-"));

		try {
			await build({ ...(sharedConfig as Options), outDir, silent: true });

			const emitted = await readdir(outDir);
			const declarations = await Promise.all(
				emitted.filter((name) => name.endsWith(".d.ts")).map((name) => readFile(join(outDir, name), "utf8")),
			);
			const declaration = declarations.join("\n");

			expect(
				jsdocBefore(declaration, /declare\s+function\s+createMutableState\b/) !== undefined,
				"createMutableState must be preceded by a /** */ block",
			).toBe(true);

			expect(
				jsdocBefore(declaration, /readonly\s+emitOn\s*\?/) !== undefined,
				"emitOn must be preceded by a /** */ block",
			).toBe(true);

			expect(declaration.includes("A change to one key of a node."), "Operation must carry its summary line").toBe(
				true,
			);
		} finally {
			await rm(outDir, { recursive: true, force: true });
		}
	}, 120_000);
});
