import { TrackedMap } from "./trackedMap";

describe("facade cost against the built-in", () => {
	it("guards against a future order-of-magnitude regression against native", () => {
		const size = 20_000;
		const keys = Array.from({ length: size }, (_, index) => `k${index}`);

		const time = (run: () => void): number => {
			const started = performance.now();

			run();

			return performance.now() - started;
		};

		const native = new Map<string, number>();
		const facade = new TrackedMap<string, number>();

		const nativeInsert = time(() => {
			for (let index = 0; index < size; index += 1) native.set(keys[index] as string, index);
		});
		const facadeInsert = time(() => {
			for (let index = 0; index < size; index += 1) facade.set(keys[index] as string, index);
		});

		const nativeLookup = time(() => {
			for (const key of keys) native.get(key);
		});
		const facadeLookup = time(() => {
			for (const key of keys) facade.get(key);
		});

		const nativeIterate = time(() => {
			for (const entry of native) void entry;
		});
		const facadeIterate = time(() => {
			for (const entry of facade) void entry;
		});

		const nativeDelete = time(() => {
			for (const key of keys) native.delete(key);
		});
		const facadeDelete = time(() => {
			for (const key of keys) facade.delete(key);
		});

		const floor = 1;
		const ratio = (facadeCost: number, nativeCost: number): number =>
			Math.max(facadeCost, floor) / Math.max(nativeCost, floor);

		expect(ratio(facadeInsert, nativeInsert)).toBeLessThan(60);
		expect(ratio(facadeLookup, nativeLookup)).toBeLessThan(60);
		expect(ratio(facadeIterate, nativeIterate)).toBeLessThan(60);
		expect(ratio(facadeDelete, nativeDelete)).toBeLessThan(60);
		expect(facade.size).toBe(0);
	});
});
