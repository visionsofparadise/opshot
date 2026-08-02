import { describe, expect, it } from "vitest";
import { proxy, snapshot } from "valtio/vanilla";

import { ignore } from "../ignore";
import { installBoundary } from "../valtio/boundary";
import { createBoundary, isWrapper } from "./boundary";
import { unwrapWrapper } from "./resolveWrapper";

installBoundary();

const createLive = <T extends object>(properties: T): T => proxy(properties);

describe("Boundary wrapper", () => {
	it("returns live values, forwards set/delete, and preserves read-your-writes", () => {
		const state = createLive({ count: 0, nested: { value: 1 } });
		const boundary = createBoundary();
		const wrapper = boundary.wrap(state);

		expect(wrapper.count).toBe(0);
		wrapper.count += 1;
		expect(wrapper.count).toBe(1);
		expect(state.count).toBe(1);
		wrapper.nested.value = 2;
		expect(wrapper.nested.value).toBe(2);
		delete (wrapper as { count?: number }).count;
		expect("count" in state).toBe(false);
	});

	it("is a registered wrapper peelable by unwrapWrapper", () => {
		const state = createLive({ count: 0 });
		const boundary = createBoundary();
		const wrapper = boundary.wrap(state);

		expect(isWrapper(wrapper)).toBe(true);
		expect(unwrapWrapper(wrapper)).toBe(state);
		expect(isWrapper(state)).toBe(false);
	});

	it("tracks enumerable public fields and stays silent for siblings", () => {
		const state = createLive({ a: 1, b: 2 });
		const boundary = createBoundary();
		const wrapper = boundary.wrap(state);

		void wrapper.a;
		expect(boundary.readsChanged(state)).toBe(false);

		state.b = 3;
		expect(boundary.readsChanged(state)).toBe(false);

		state.a = 4;
		expect(boundary.readsChanged(state)).toBe(true);
	});

	it("detects nested tracked reads and alias mutations", () => {
		const shared = { value: 1 };
		const state = createLive({ left: shared, right: shared });
		const boundary = createBoundary();
		const wrapper = boundary.wrap(state);

		void wrapper.left.value;
		expect(boundary.readsChanged(state)).toBe(false);

		state.right.value = 2;
		expect(boundary.readsChanged(state)).toBe(true);
	});

	it("keeps empty reads silent", () => {
		const state = createLive({ count: 0 });
		const boundary = createBoundary();

		boundary.wrap(state);
		state.count = 1;
		expect(boundary.readsChanged(state)).toBe(false);
	});

	it("compares against the value stored at the first read of the window", () => {
		const state = createLive({ count: 0 });
		const boundary = createBoundary();
		const wrapper = boundary.wrap(state);

		void wrapper.count;
		wrapper.count = 5;
		expect(boundary.readsChanged(state)).toBe(true);
	});

	it("resets read lifecycle without clearing wrapper identity", () => {
		const state = createLive({ nested: { value: 1 } });
		const boundary = createBoundary();
		const first = boundary.wrap(state);
		const nestedFirst = first.nested;

		void nestedFirst.value;
		boundary.resetReads();

		const second = boundary.wrap(state);
		const nestedSecond = second.nested;

		expect(second).toBe(first);
		expect(nestedSecond).toBe(nestedFirst);
	});

	it("remints a wrapper whose node's version moved and retains untouched siblings", () => {
		const state = createLive({ left: { value: 1 }, right: { value: 2 } });
		const boundary = createBoundary();
		const wrapper = boundary.wrap(state);
		const left = wrapper.left;
		const right = wrapper.right;

		void left.value;
		void right.value;

		state.left.value = 9;

		const next = boundary.wrap(state);

		expect(next.left).not.toBe(left);
		expect(next.right).toBe(right);
	});

	it("partitions reads by source root", () => {
		const a = createLive({ count: 0 });
		const b = createLive({ count: 0 });
		const boundary = createBoundary();
		const wrapA = boundary.wrap(a);
		const wrapB = boundary.wrap(b);

		void wrapA.count;
		void wrapB.count;

		b.count = 1;
		expect(boundary.readsChanged(a)).toBe(false);
		expect(boundary.readsChanged(b)).toBe(true);
	});

	it("covers array index, push, length growth, and truncation", () => {
		const state = createLive({ items: [1, 2] as Array<number | undefined> });
		const boundary = createBoundary();
		const wrapper = boundary.wrap(state);

		void wrapper.items.length;
		void wrapper.items[0];

		state.items.push(3);
		expect(boundary.readsChanged(state)).toBe(true);

		boundary.resetReads();
		const again = boundary.wrap(state);

		void again.items.length;
		state.items.length = 10;
		expect(boundary.readsChanged(state)).toBe(true);
		expect((snapshot(state.items) as Array<unknown>).length).toBe(10);

		boundary.resetReads();
		const third = boundary.wrap(state);

		void third.items[0];
		state.items.length = 1;
		expect(boundary.readsChanged(state)).toBe(false);

		boundary.resetReads();
		const fourth = boundary.wrap(state);

		void fourth.items.length;
		state.items.length = 0;
		expect(boundary.readsChanged(state)).toBe(true);
	});

	it("passes through ignore and frozen leaves without wrapping", () => {
		const ignored = ignore({ secret: 1 });
		const frozen = Object.freeze({ n: 1 });
		const state = createLive({ ignored, frozen });
		const boundary = createBoundary();
		const wrapper = boundary.wrap(state);

		expect(wrapper.ignored).toBe(ignored);
		expect(wrapper.frozen).toBe(frozen);
		expect(isWrapper(wrapper.ignored)).toBe(false);
	});

	it("binds clean-class prototype methods to the wrapper so interiors record", () => {
		class Counter {
			count = 0;

			bump(): number {
				this.count += 1;

				return this.count;
			}
		}

		const state = createLive(new Counter());
		const boundary = createBoundary();
		const wrapper = boundary.wrap(state);

		const first = wrapper.bump;
		const second = wrapper.bump;

		expect(first).toBe(second);
		expect(first()).toBe(1);
		expect(state.count).toBe(1);
		expect(boundary.readsChanged(state)).toBe(true);
	});

	it("records own function fields as leaves so replacement is visible", () => {
		const first = () => 1;
		const second = () => 2;
		const state = createLive({ run: first, count: 0 });
		const boundary = createBoundary();
		const wrapper = boundary.wrap(state);

		expect(wrapper.run).toBe(first);
		expect(boundary.readsChanged(state)).toBe(false);

		state.run = second;
		expect(boundary.readsChanged(state)).toBe(true);
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
		const boundary = createBoundary();
		const wrapper = boundary.wrap(state);

		void wrapper.bump;
		state.count = 9;
		expect(boundary.readsChanged(state)).toBe(false);
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
		const boundary = createBoundary();
		const wrapper = boundary.wrap(state);

		void wrapper.counter.read;

		state.counter.other = 9;
		expect(boundary.readsChanged(state)).toBe(false);
	});

	it("throws when wrap receives a non-proxy", () => {
		const boundary = createBoundary();

		expect(() => boundary.wrap({ count: 0 })).toThrow("opshot: Boundary.wrap requires a live Valtio proxy");
	});

	it("wrap with no mutation returns the same root reference", () => {
		const state = createLive({ count: 0 });
		const boundary = createBoundary();
		const first = boundary.wrap(state);
		const second = boundary.wrap(state);

		expect(second).toBe(first);
	});

	it("remints the root wrapper after a read field mutates", () => {
		const state = createLive({ count: 0 });
		const boundary = createBoundary();
		const first = boundary.wrap(state);

		void first.count;
		state.count = 1;

		expect(boundary.wrap(state)).not.toBe(first);
	});

	it("remints the root wrapper after an unread field mutates", () => {
		const state = createLive({ count: 0, other: 0 });
		const boundary = createBoundary();
		const first = boundary.wrap(state);

		void first.count;
		state.other = 1;

		expect(boundary.wrap(state)).not.toBe(first);
	});

	it("keeps a nested wrapper whose subtree did not change across a root-level change", () => {
		const state = createLive({ other: 0, nested: { value: 1 } });
		const boundary = createBoundary();
		const first = boundary.wrap(state);
		const nested = first.nested;

		void first.other;
		void nested.value;

		state.other = 1;

		const next = boundary.wrap(state);

		expect(next).not.toBe(first);
		expect(next.nested).toBe(nested);
	});

	it("releases every partition on dispose", async () => {
		const boundary = createBoundary();
		const documents = Array.from({ length: 20 }, (_, index) => createLive({ id: index, body: { text: "x" } }));
		const retained = documents.map((document) => {
			const wrapper = boundary.wrap(document);

			void wrapper.id;
			void wrapper.body.text;

			return wrapper;
		});

		expect(boundary.readsChanged(documents[0] as object)).toBe(false);

		boundary.dispose();
		await Promise.resolve();

		for (const document of documents) {
			expect(boundary.readsChanged(document)).toBe(false);
		}

		for (const wrapper of retained) {
			expect(isWrapper(wrapper)).toBe(true);
			expect(wrapper.body.text).toBe("x");
		}

		for (const document of documents) {
			expect(boundary.readsChanged(document)).toBe(false);
		}
	});

	it("keeps its partitions when a dispose is retained before it settles", async () => {
		const boundary = createBoundary();
		const state = createLive({ shown: 0, hidden: 0 });
		const wrapper = boundary.wrap(state);

		void wrapper.shown;

		boundary.dispose();
		boundary.retain();

		await Promise.resolve();

		state.shown = 1;

		expect(boundary.readsChanged(state)).toBe(true);
	});

	it("stops reporting reads once a dispose has settled", async () => {
		const boundary = createBoundary();
		const state = createLive({ shown: 0 });
		const wrapper = boundary.wrap(state);

		void wrapper.shown;

		boundary.dispose();

		await Promise.resolve();

		state.shown = 1;

		expect(boundary.readsChanged(state)).toBe(false);
	});
});
