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
});
