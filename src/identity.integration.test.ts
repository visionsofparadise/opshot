import { batch } from "./batch";
import { createMutableState } from "./createMutableState";
import { requireHandle } from "./handle";
import { internedIdOf } from "./intern";
import { applyOperations } from "./ops/applyOperations";
import { internedOccupied } from "./ops/internedOccupancy";
import type { AssignMutation, Operation } from "./ops/operation";
import { subscribe } from "./subscribe";

const record = <T extends object>(state: T): Array<Array<Operation>> => {
	const heard = new Array<Array<Operation>>();

	subscribe(state, (ops) => heard.push([...ops]));

	return heard;
};

const internId = (state: object, node: object): number => {
	const id = internedIdOf(requireHandle(state, "opshot: test requires a state"), node);

	if (id === undefined) throw new Error("opshot: test expected an interned node");

	return id;
};

const transport = (ops: ReadonlyArray<Operation>): Array<Operation> =>
	JSON.parse(JSON.stringify(ops)) as Array<Operation>;

describe("identity occupancy", () => {
	it("assign-then-delete in one window emits a link at the new path before the delete at the old and the replica aliases the same replica object", () => {
		const origin = createMutableState({
			dest: 0 as number | { n: number },
			src: { n: 1 },
		});
		const heard = record(origin);
		const originSrc = origin.src;

		batch(() => {
			origin.dest = origin.src;
			delete (origin as { src?: { n: number } }).src;
		});

		const delivered = heard[0] ?? [];

		expect(delivered[0]?.do).toMatchObject({
			verb: "link",
			path: ["dest"],
			ref: internId(origin, origin.dest as object),
		});
		expect(delivered[1]?.do).toMatchObject({ verb: "delete", path: ["src"] });
		expect(origin.dest).toBe(originSrc);

		const replica = createMutableState({
			dest: 0 as number | { n: number },
			src: { n: 1 },
		});
		const replicaSrc = replica.src;

		applyOperations(replica, transport(delivered), "do");

		expect(replica.dest).toBe(replicaSrc);
		expect(Object.hasOwn(replica, "src")).toBe(false);
		expect(internId(origin, origin.dest as object)).toBe(internId(replica, replica.dest as object));
	});

	it("delete-then-assign in one window emits a value assign with fresh ids", () => {
		const origin = createMutableState({
			dest: 0 as number | { n: number },
			src: { n: 1 },
		});
		const held = origin.src;
		const srcId = internId(origin, held);
		const heard = record(origin);

		batch(() => {
			delete (origin as { src?: { n: number } }).src;
			origin.dest = held;
		});

		const delivered = heard[0] ?? [];
		const destDo = delivered.find((operation) => operation.do.path[0] === "dest")?.do;

		expect(destDo?.verb).toBe("assign");
		expect((destDo as AssignMutation | undefined)?.ids).toBeDefined();
		expect((destDo as AssignMutation | undefined)?.ids).not.toContain(srcId);
		expect(internId(origin, origin.dest as object)).not.toBe(srcId);
	});

	it("a deleted container's op undo carries the ids to restore its interior on a replica", () => {
		const origin = createMutableState({ box: { inner: { n: 1 } } });
		const boxId = internId(origin, origin.box);
		const innerId = internId(origin, origin.box.inner);
		const heard = record(origin);

		batch(() => {
			delete (origin as { box?: { inner: { n: number } } }).box;
		});

		const delivered = heard[0] ?? [];

		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.undo.verb).toBe("assign");
		expect((delivered[0]?.undo as AssignMutation).ids).toEqual([boxId, innerId]);

		const replica = createMutableState({ box: { inner: { n: 1 } } });

		applyOperations(replica, transport(delivered), "do");
		expect(Object.hasOwn(replica, "box")).toBe(false);

		applyOperations(replica, transport(delivered), "undo");
		expect(internId(replica, replica.box)).toBe(boxId);
		expect(internId(replica, replica.box.inner)).toBe(innerId);
	});

	it("a detached two-node cycle remains interned-occupied with its byId entries retained", () => {
		const origin = createMutableState({
			a: { n: 1 } as { n: number; to?: { n: number; to?: object } },
		});
		const handle = requireHandle(origin, "opshot: test requires a state");

		batch(() => {
			origin.a.to = { n: 2, to: origin.a };
		});

		const a = origin.a;
		const b = origin.a.to!;
		const aId = internId(origin, a);
		const bId = internId(origin, b);

		batch(() => {
			delete (origin as { a?: { n: number; to?: { n: number; to?: object } } }).a;
		});

		expect(internedOccupied(handle, a)).toBe(true);
		expect(internedOccupied(handle, b)).toBe(true);
		expect(handle.byId.has(aId)).toBe(true);
		expect(handle.byId.has(bId)).toBe(true);
	});

	it("origin and replica byId and nextInternId converge through the explicit stream across a mint-evict-remint sequence", () => {
		const origin = createMutableState({} as { box?: { inner: { n: number } }; next?: { n: number } });
		const originHandle = requireHandle(origin, "opshot: test requires a state");
		const heard = record(origin);

		batch(() => {
			origin.box = { inner: { n: 1 } };
		});

		batch(() => {
			delete origin.box;
		});

		batch(() => {
			origin.next = { n: 2 };
		});

		const replica = createMutableState({} as { box?: { inner: { n: number } }; next?: { n: number } });
		const replicaHandle = requireHandle(replica, "opshot: test requires a state");

		for (const window of heard) applyOperations(replica, transport(window), "do");

		expect([...originHandle.byId.keys()].sort((left, right) => left - right)).toEqual(
			[...replicaHandle.byId.keys()].sort((left, right) => left - right),
		);
		expect(originHandle.nextInternId).toBe(replicaHandle.nextInternId);
		expect(internId(origin, origin.next!)).toBe(internId(replica, replica.next!));
	});

	it("keeps occupancy across a same-slot self-assign so a later alias is a link", () => {
		const origin = createMutableState({
			x: { n: 1 },
			y: 0 as number | { n: number },
		});
		const handle = requireHandle(origin, "opshot: test requires a state");
		const node = origin.x;
		const id = internId(origin, node);

		origin.x = origin.x;

		expect(internedOccupied(handle, node)).toBe(true);
		expect(internId(origin, origin.x)).toBe(id);
		expect(() => {
			(origin.x as { n: number; bad?: Map<unknown, unknown> }).bad = new Map();
		}).toThrow(/cannot be tracked/);

		const heard = record(origin);

		batch(() => {
			origin.y = origin.x;
		});

		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "link", path: ["y"], ref: id });
		expect(origin.y).toBe(origin.x);
	});
});
