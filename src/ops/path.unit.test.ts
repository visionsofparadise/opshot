import {
	appendOperationPath,
	createKeyOfPathSegment,
	createOperationPath,
	createValueOfPathSegment,
	formatOperationPath,
	getPathSelector,
} from "./path";

describe("operation paths", () => {
	it("formats root, escaped strings, numbers, and opaque identity segments", () => {
		const object = { toString: () => {
			throw new Error("must not convert identity segments");
		} };

		expect(formatOperationPath(createOperationPath([]))).toBe("");
		expect(formatOperationPath(createOperationPath(["a/b", "c~d", 3, "3"]))).toBe("/a~1b/c~0d/3/3");
		expect(formatOperationPath(createOperationPath([object, () => undefined, Symbol("member")]))).toBe("/<identity>/<identity>/<symbol>");
	});

	it("retains number and string segments as distinct values", () => {
		const path = createOperationPath([1, "1"]);

		expect(path[0]).toBe(1);
		expect(path[1]).toBe("1");
	});

	it("brands and freezes keyOf and valueOf selectors while retaining payload identity", () => {
		const value = { id: 1 };
		const keyOf = createKeyOfPathSegment(value);
		const valueOf = createValueOfPathSegment(value);

		expect(getPathSelector(keyOf)).toEqual({ kind: "keyOf", value });
		expect(getPathSelector(valueOf)).toEqual({ kind: "valueOf", value });
		expect(getPathSelector(keyOf)?.value).toBe(value);
		expect(getPathSelector(valueOf)?.value).toBe(value);
		expect(Object.keys(keyOf)).toEqual(["kind", "value"]);
		expect(Object.isFrozen(keyOf)).toBe(true);
		expect(Object.isFrozen(valueOf)).toBe(true);
		expect(formatOperationPath(createOperationPath([keyOf, valueOf]))).toBe("/<keyOf>/<valueOf>");
	});

	it("does not accept structurally similar user data as a selector", () => {
		const forged = { kind: "keyOf", value: { id: 1 } };

		expect(getPathSelector(forged)).toBeUndefined();
		expect(formatOperationPath(createOperationPath([forged]))).toBe("/<identity>");
	});

	it("unwraps one selector level and leaves a branded selector payload as data", () => {
		const dataSelector = createKeyOfPathSegment("stored");
		const escaped = createValueOfPathSegment(dataSelector);
		const selector = getPathSelector(escaped);

		expect(selector?.kind).toBe("valueOf");
		expect(selector?.value).toBe(dataSelector);
		expect(getPathSelector(selector?.value)).toEqual({ kind: "keyOf", value: "stored" });
	});

	it("stores shallow-frozen copies and preserves raw object identity", () => {
		const object = { id: 1 };
		const source = ["root", object];
		const path = createOperationPath(source);
		const appended = appendOperationPath(path, "leaf");

		source[0] = "changed";

		expect(path).toEqual(["root", object]);
		expect(path[1]).toBe(object);
		expect(Object.isFrozen(path)).toBe(true);
		expect(appended).toEqual(["root", object, "leaf"]);
		expect(Object.isFrozen(appended)).toBe(true);
		expect(() => (appended as Array<unknown>).push("nope")).toThrow(TypeError);
	});
});
