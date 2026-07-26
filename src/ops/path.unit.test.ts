import { appendOperationPath, createOperationPath, formatOperationPath } from "./path";

describe("operation paths", () => {
	it("formats root, escaped strings, and numbers", () => {
		expect(formatOperationPath(createOperationPath([]))).toBe("");
		expect(formatOperationPath(createOperationPath(["a/b", "c~d", 3, "3"]))).toBe("/a~1b/c~0d/3/3");
	});

	it("retains number and string segments as distinct values", () => {
		const path = createOperationPath([1, "1"]);

		expect(path[0]).toBe(1);
		expect(path[1]).toBe("1");
	});

	it("formats flat string and number segment paths", () => {
		expect(formatOperationPath(createOperationPath(["index", "sa", "slots", 0]))).toBe("/index/sa/slots/0");
	});

	it("stores shallow-frozen copies detached from the source array", () => {
		const source = ["root", "child"];
		const path = createOperationPath(source);
		const appended = appendOperationPath(path, "leaf");

		source[0] = "changed";

		expect(path).toEqual(["root", "child"]);
		expect(Object.isFrozen(path)).toBe(true);
		expect(appended).toEqual(["root", "child", "leaf"]);
		expect(Object.isFrozen(appended)).toBe(true);
		expect(() => (appended as Array<unknown>).push("nope")).toThrow(TypeError);
	});
});
