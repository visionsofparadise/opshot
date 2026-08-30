import { applyOperations } from "./ops/applyOperations";
import { subscribe } from "./subscribe";

describe("requireHandle", () => {
	it("subscribe rejects a plain object", () => {
		expect(() => subscribe({}, () => undefined)).toThrow("opshot: subscribe requires a state");
	});

	it("applyOperations rejects a plain object", () => {
		expect(() => applyOperations({}, [], "do")).toThrow("opshot: applyOperations requires a state");
	});
});
