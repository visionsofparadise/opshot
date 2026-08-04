import { describe, expect, it } from "vitest";
import { proxy, snapshot } from "valtio/vanilla";

import { ignore } from "../ignore";
import { installBoundary } from "../valtio/boundary";
import { createReadTracker, isReadProxy } from "./readTracker";
import { peelReadProxy } from "./peelReadProxy";

installBoundary();

const createLive = <T extends object>(properties: T): T => proxy(properties);

describe("ReadTracker", () => {
	it("returns live values, forwards set/delete, and preserves read-your-writes", () => {
		const state = createLive({ count: 0, nested: { value: 1 } });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		expect(readProxy.count).toBe(0);
		readProxy.count += 1;
		expect(readProxy.count).toBe(1);
		expect(state.count).toBe(1);
		readProxy.nested.value = 2;
		expect(readProxy.nested.value).toBe(2);
		delete (readProxy as { count?: number }).count;
		expect("count" in state).toBe(false);
	});

	it("is a registered readProxy peelable by peelReadProxy", () => {
		const state = createLive({ count: 0 });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		expect(isReadProxy(readProxy)).toBe(true);
		expect(peelReadProxy(readProxy)).toBe(state);
		expect(isReadProxy(state)).toBe(false);
	});

	it("tracks enumerable public fields and stays silent for siblings", () => {
		const state = createLive({ a: 1, b: 2 });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		void readProxy.a;
		expect(readTracker.readsChanged(state)).toBe(false);

		state.b = 3;
		expect(readTracker.readsChanged(state)).toBe(false);

		state.a = 4;
		expect(readTracker.readsChanged(state)).toBe(true);
	});

	it("detects nested tracked reads and alias mutations", () => {
		const shared = { value: 1 };
		const state = createLive({ left: shared, right: shared });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		void readProxy.left.value;
		expect(readTracker.readsChanged(state)).toBe(false);

		state.right.value = 2;
		expect(readTracker.readsChanged(state)).toBe(true);
	});

	it("keeps empty reads silent", () => {
		const state = createLive({ count: 0 });
		const readTracker = createReadTracker();

		readTracker.wrap(state);
		state.count = 1;
		expect(readTracker.readsChanged(state)).toBe(false);
	});

	it("compares against the value stored at read time, not the value live at comparison", () => {
		const state = createLive({ count: 0 });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		void readProxy.count;
		readProxy.count = 5;
		expect(readTracker.readsChanged(state)).toBe(true);
	});

	it("compares against the value stored at the first read of the window, not the last", () => {
		const state = createLive({ count: 0 });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		void readProxy.count;
		readProxy.count = 5;
		void readProxy.count;

		expect(readTracker.readsChanged(state)).toBe(true);
	});

	it("resets read lifecycle without clearing readProxy identity", () => {
		const state = createLive({ nested: { value: 1 } });
		const readTracker = createReadTracker();
		const first = readTracker.wrap(state);
		const nestedFirst = first.nested;

		void nestedFirst.value;
		readTracker.resetReads();

		const second = readTracker.wrap(state);
		const nestedSecond = second.nested;

		expect(second).toBe(first);
		expect(nestedSecond).toBe(nestedFirst);
	});

	it("remints a readProxy whose node's version moved and retains untouched siblings", () => {
		const state = createLive({ left: { value: 1 }, right: { value: 2 } });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);
		const left = readProxy.left;
		const right = readProxy.right;

		void left.value;
		void right.value;

		state.left.value = 9;

		const next = readTracker.wrap(state);

		expect(next.left).not.toBe(left);
		expect(next.right).toBe(right);
	});

	it("partitions reads by source root", () => {
		const a = createLive({ count: 0 });
		const b = createLive({ count: 0 });
		const readTracker = createReadTracker();
		const wrapA = readTracker.wrap(a);
		const wrapB = readTracker.wrap(b);

		void wrapA.count;
		void wrapB.count;

		b.count = 1;
		expect(readTracker.readsChanged(a)).toBe(false);
		expect(readTracker.readsChanged(b)).toBe(true);
	});

	it("covers array index, push, length growth, and truncation", () => {
		const state = createLive({ items: [1, 2] as Array<number | undefined> });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		void readProxy.items.length;
		void readProxy.items[0];

		state.items.push(3);
		expect(readTracker.readsChanged(state)).toBe(true);

		readTracker.resetReads();
		const again = readTracker.wrap(state);

		void again.items.length;
		state.items.length = 10;
		expect(readTracker.readsChanged(state)).toBe(true);
		expect((snapshot(state.items) as Array<unknown>).length).toBe(10);

		readTracker.resetReads();
		const third = readTracker.wrap(state);

		void third.items[0];
		state.items.length = 1;
		expect(readTracker.readsChanged(state)).toBe(false);

		readTracker.resetReads();
		const fourth = readTracker.wrap(state);

		void fourth.items.length;
		state.items.length = 0;
		expect(readTracker.readsChanged(state)).toBe(true);
	});

	it("passes through ignore and frozen leaves without wrapping", () => {
		const ignored = ignore({ secret: 1 });
		const frozen = Object.freeze({ n: 1 });
		const state = createLive({ ignored, frozen });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		expect(readProxy.ignored).toBe(ignored);
		expect(readProxy.frozen).toBe(frozen);
		expect(isReadProxy(readProxy.ignored)).toBe(false);
	});

	it("binds clean-class prototype methods to the readProxy so interiors record", () => {
		class Counter {
			count = 0;

			bump(): number {
				this.count += 1;

				return this.count;
			}
		}

		const state = createLive(new Counter());
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		const first = readProxy.bump;
		const second = readProxy.bump;

		expect(first).toBe(second);
		expect(first()).toBe(1);
		expect(state.count).toBe(1);
		expect(readTracker.readsChanged(state)).toBe(true);
	});

	it("records own function fields as leaves so replacement is visible", () => {
		const first = () => 1;
		const second = () => 2;
		const state = createLive({ run: first, count: 0 });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		expect(readProxy.run).toBe(first);
		expect(readTracker.readsChanged(state)).toBe(false);

		state.run = second;
		expect(readTracker.readsChanged(state)).toBe(true);
	});

	it("keeps a prototype-method lookup from ever comparing changed", () => {
		class Counter {
			count = 0;

			bump(): number {
				this.count += 1;

				return this.count;
			}
		}

		const state = createLive(new Counter());
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		void readProxy.bump;
		state.count = 9;
		expect(readTracker.readsChanged(state)).toBe(false);
	});

	it("records a nested object read only through a prototype method, so unread siblings stay silent", () => {
		class Counter {
			count = 0;

			other = 0;

			read(): number {
				return this.count;
			}
		}

		const state = createLive({ counter: new Counter() });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		void readProxy.counter.read;

		state.counter.other = 9;
		expect(readTracker.readsChanged(state)).toBe(false);
	});

	it("throws when wrap receives a non-proxy", () => {
		const readTracker = createReadTracker();

		expect(() => readTracker.wrap({ count: 0 })).toThrow("opshot: ReadTracker.wrap requires a write proxy");
	});

	it("wrap with no mutation returns the same root reference", () => {
		const state = createLive({ count: 0 });
		const readTracker = createReadTracker();
		const first = readTracker.wrap(state);
		const second = readTracker.wrap(state);

		expect(second).toBe(first);
	});

	it("remints the root readProxy after a read field mutates", () => {
		const state = createLive({ count: 0 });
		const readTracker = createReadTracker();
		const first = readTracker.wrap(state);

		void first.count;
		state.count = 1;

		expect(readTracker.wrap(state)).not.toBe(first);
	});

	it("remints the root readProxy after an unread field mutates", () => {
		const state = createLive({ count: 0, other: 0 });
		const readTracker = createReadTracker();
		const first = readTracker.wrap(state);

		void first.count;
		state.other = 1;

		expect(readTracker.wrap(state)).not.toBe(first);
	});

	it("keeps a nested readProxy whose subtree did not change across a root-level change", () => {
		const state = createLive({ other: 0, nested: { value: 1 } });
		const readTracker = createReadTracker();
		const first = readTracker.wrap(state);
		const nested = first.nested;

		void first.other;
		void nested.value;

		state.other = 1;

		const next = readTracker.wrap(state);

		expect(next).not.toBe(first);
		expect(next.nested).toBe(nested);
	});

	it("releases every partition on dispose", async () => {
		const readTracker = createReadTracker();
		const documents = Array.from({ length: 20 }, (_, index) => createLive({ id: index, body: { text: "x" } }));
		const retained = documents.map((document) => {
			const readProxy = readTracker.wrap(document);

			void readProxy.id;
			void readProxy.body.text;

			return readProxy;
		});

		expect(readTracker.readsChanged(documents[0] as object)).toBe(false);

		readTracker.dispose();
		await Promise.resolve();

		for (const document of documents) {
			expect(readTracker.readsChanged(document)).toBe(false);
		}

		for (const readProxy of retained) {
			expect(isReadProxy(readProxy)).toBe(true);
			expect(readProxy.body.text).toBe("x");
		}

		for (const document of documents) {
			expect(readTracker.readsChanged(document)).toBe(false);
		}
	});

	it("keeps its partitions when a dispose is retained before it settles", async () => {
		const readTracker = createReadTracker();
		const state = createLive({ shown: 0, hidden: 0 });
		const readProxy = readTracker.wrap(state);

		void readProxy.shown;

		readTracker.dispose();
		readTracker.retain();

		await Promise.resolve();

		state.shown = 1;

		expect(readTracker.readsChanged(state)).toBe(true);
	});

	it("stops reporting reads once a dispose has settled", async () => {
		const readTracker = createReadTracker();
		const state = createLive({ shown: 0 });
		const readProxy = readTracker.wrap(state);

		void readProxy.shown;

		readTracker.dispose();

		await Promise.resolve();

		state.shown = 1;

		expect(readTracker.readsChanged(state)).toBe(false);
	});
});
