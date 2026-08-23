import { createMutableState } from "../createMutableState";
import { requireHandle } from "../handle";
import { internedIdOf } from "../intern";
import { additionPair, changePair, linkOperation, linkUndo, removalPair } from "./mintPairs";
import { createOperationPath } from "./path";

describe("mintPairs", () => {
	const path = createOperationPath(["slot"]);

	it("uses a delete undo when before is absent", () => {
		expect(linkUndo(path, undefined, false, undefined)).toMatchObject({ verb: "delete", path });
		expect(additionPair(path, 1)).toMatchObject({
			do: { verb: "assign", path, value: 1 },
			undo: { verb: "delete", path },
		});
		expect(linkOperation(path, 7, undefined, false, undefined)).toMatchObject({
			do: { verb: "link", path, ref: 7 },
			undo: { verb: "delete", path },
		});
	});

	it("uses an assign undo when before is a present scalar", () => {
		expect(linkUndo(path, 1, true, undefined)).toMatchObject({ verb: "assign", path, value: 1 });
		expect(changePair(path, 1, 2, undefined)).toMatchObject({
			do: { verb: "assign", path, value: 2 },
			undo: { verb: "assign", path, value: 1 },
		});
		expect(removalPair(path, 1)).toMatchObject({
			do: { verb: "delete", path },
			undo: { verb: "assign", path, value: 1 },
		});
	});

	it("uses a link undo when before is present and interned-occupied", () => {
		const state = createMutableState({ box: { n: 1 } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const before = state.box;
		const id = internedIdOf(handle, before);

		expect(id).toBeDefined();
		expect(linkUndo(path, before, true, handle)).toMatchObject({ verb: "link", path, ref: id });
		expect(changePair(path, before, { n: 2 }, handle)).toMatchObject({
			do: { verb: "assign", path, value: { n: 2 } },
			undo: { verb: "link", path, ref: id },
		});
		expect(linkOperation(path, 0, before, true, handle)).toMatchObject({
			do: { verb: "link", path, ref: 0 },
			undo: { verb: "link", path, ref: id },
		});
	});

	it("does not take the interned branch without a handle", () => {
		const before = { n: 1 };

		expect(linkUndo(path, before, true, undefined)).toMatchObject({ verb: "assign", path, value: before });
		expect(changePair(path, before, { n: 2 }, undefined)).toMatchObject({
			undo: { verb: "assign", path, value: before },
		});
		expect(linkOperation(path, 3, before, true, undefined)).toMatchObject({
			do: { verb: "link", path, ref: 3 },
			undo: { verb: "assign", path, value: before },
		});
	});
});
