import { appendOperationPath, createOperationPath, formatOperationPath } from "./path";

describe("operation paths", () => {
	it("formats root, escaped strings, numbers, and opaque identity segments", () => {
		const object = {
			toString: () => {
				throw new Error("must not convert identity segments");
			},
		};

		expect(formatOperationPath(createOperationPath([]))).toBe("");
		expect(formatOperationPath(createOperationPath(["a/b", "c~d", 3, "3"]))).toBe("/a~1b/c~0d/3/3");
		expect(formatOperationPath(createOperationPath([object, () => undefined, Symbol("member")]))).toBe(
			"/<identity>/<identity>/<symbol>",
		);
	});

	it("retains number and string segments as distinct values", () => {
		const path = createOperationPath([1, "1"]);

		expect(path[0]).toBe(1);
		expect(path[1]).toBe("1");
	});

	it("formats plain object segments as identity without selector machinery", () => {
		const forged = { kind: "keyOf", value: { id: 1 } };

		expect(formatOperationPath(createOperationPath([forged]))).toBe("/<identity>");
		expect(formatOperationPath(createOperationPath(["index", "sa", "slots", 0]))).toBe("/index/sa/slots/0");
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
