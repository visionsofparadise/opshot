import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// A real node ESM process, not vitest's own import: vitest's module runner interops CommonJS deps
// differently from node and hid the original broken bare import (a named import from a CJS-resolved
// dependency). Requires `npm run build`; skips when dist is absent.
const distDir = resolve(process.cwd(), "dist");
const hasDist = existsSync(resolve(distDir, "index.js")) && existsSync(resolve(distDir, "react.js"));

const importedExports = (entry: string): Array<string> => {
	const url = pathToFileURL(resolve(distDir, entry)).href;
	const script = `import(${JSON.stringify(url)}).then((module) => { process.stdout.write(Object.keys(module).sort().join(",")); }).catch((error) => { process.stderr.write(String(error && error.message ? error.message : error)); process.exit(1); });`;

	return execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).split(",");
};

describe.skipIf(!hasDist)("built package imports in a real node ESM context", () => {
	it("loads dist/index.js and exposes its public surface", () => {
		const exports = importedExports("index.js");

		expect(exports).toContain("applyOps");
		expect(exports).toContain("createMutableState");
		expect(exports).toContain("transact");
		expect(exports).toContain("subscribe");
		expect(exports).toContain("createChannel");
	});

	it("loads dist/react.js and exposes its public surface", () => {
		const exports = importedExports("react.js");

		expect(exports).toContain("scope");
		expect(exports).toContain("useMutableState");
		expect(exports).toContain("useGroup");
	});
});
