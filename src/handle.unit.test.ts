import { applyOperations } from "./ops/applyOperations";
import { subscribe } from "./subscribe";
import { transact } from "./transact/transact";

describe("requireHandle", () => {
	it("transact rejects a plain object", () => {
		expect(() => transact({}, () => undefined)).toThrow("opshot: transact requires a state");
	});

	it("subscribe rejects a plain object", () => {
		expect(() => subscribe({}, () => undefined)).toThrow("opshot: subscribe requires a state");
	});

	it("applyOperations rejects a plain object", () => {
		expect(() => applyOperations({}, [], "do")).toThrow("opshot: applyOperations requires a state");
	});
});
