import { transact } from "../transact";
import { createMutableState } from "../createMutableState";
import { unregisterTrackedRoot } from "./constructorPathGuard";

describe("constructorPathGuard: reachability and reclaim", () => {
	it("rejects a prototype write through an alias after a dynamic constructor link", () => {
		interface ConstructorTarget {
			prototype?: object;
			safe: boolean;
		}

		interface AliasedConstructor {
			alias: ConstructorTarget;
			constructor: ConstructorTarget | undefined;
		}

		const target: ConstructorTarget = { safe: true };
		const state = createMutableState<AliasedConstructor>({ alias: target, constructor: undefined });

		transact(state, () => {
			state.constructor = state.alias;
		});

		expect(() => {
			transact(state, () => {
				state.alias.prototype = { polluted: true };
			});
		}).toThrow("reserved data path /constructor/prototype");
	});

	it("keeps a constructor target reserved until its final concurrent link is deleted", () => {
		interface ConstructorTarget {
			prototype?: object;
			safe: boolean;
		}

		interface Parent {
			constructor?: ConstructorTarget;
		}

		const target: ConstructorTarget = { safe: true };
		const state = createMutableState({
			first: { constructor: target } as Parent,
			second: { constructor: target } as Parent,
			alias: target,
		});

		transact(state, () => {
			delete state.first.constructor;
		});

		expect(() => {
			transact(state, () => {
				state.alias.prototype = { polluted: true };
			});
		}).toThrow("reserved data path /constructor/prototype");

		transact(state, () => {
			delete state.second.constructor;
			state.alias.prototype = { safe: true };
		});

		expect(state.alias.prototype).toEqual({ safe: true });
	});

	it("moves the reserved association when a constructor link is replaced", () => {
		interface ConstructorTarget {
			prototype?: object;
			safe: boolean;
		}

		const first: ConstructorTarget = { safe: true };
		const second: ConstructorTarget = { safe: true };
		const state = createMutableState({ constructor: first, first, second });

		transact(state, () => {
			state.constructor = state.second;
			state.first.prototype = { safe: true };
		});

		expect(state.first.prototype).toEqual({ safe: true });
		expect(() => {
			transact(state, () => {
				state.second.prototype = { polluted: true };
			});
		}).toThrow("reserved data path /constructor/prototype");
	});

	it("releases constructor links when their containing subtree is detached", () => {
		interface ConstructorTarget {
			prototype?: object;
			safe: boolean;
		}

		interface Root {
			alias: ConstructorTarget;
			branch?: { constructor: ConstructorTarget };
		}

		const target: ConstructorTarget = { safe: true };
		const state = createMutableState<Root>({ alias: target, branch: { constructor: target } });

		transact(state, () => {
			delete state.branch;
			state.alias.prototype = { safe: true };
		});

		expect(state.alias.prototype).toEqual({ safe: true });
	});

	it("releases a cyclic subtree and restores its reservation when reattached", () => {
		interface ConstructorTarget {
			prototype?: object;
			safe: boolean;
		}

		interface Branch {
			constructor: ConstructorTarget;
			next?: Branch;
		}

		interface Root {
			alias: ConstructorTarget;
			branch?: Branch;
		}

		const target: ConstructorTarget = { safe: true };
		const branch: Branch = { constructor: target };

		branch.next = branch;

		const state = createMutableState<Root>({ alias: target, branch });
		let detached: Branch | undefined;

		transact(state, () => {
			detached = state.branch;
			delete state.branch;
		});
		transact(state, () => {
			state.alias.prototype = { safe: true };
			delete state.alias.prototype;
		});
		transact(state, () => {
			if (detached) state.branch = detached;
		});

		expect(() => {
			transact(state, () => {
				state.alias.prototype = { polluted: true };
			});
		}).toThrow("reserved data path /constructor/prototype");
	});

	it("keeps a shared cyclic subtree reserved until its final root detaches", () => {
		interface ConstructorTarget {
			prototype?: object;
			safe: boolean;
		}

		interface Branch {
			constructor: ConstructorTarget;
			next?: Branch;
		}

		interface Root {
			alias: ConstructorTarget;
			branch?: Branch;
		}

		const target: ConstructorTarget = { safe: true };
		const branch: Branch = { constructor: target };

		branch.next = branch;

		const first = createMutableState<Root>({ alias: target, branch });
		const second = createMutableState<Root>({ alias: target, branch });

		transact(first, () => {
			delete first.branch;
		});

		expect(() => {
			transact(first, () => {
				first.alias.prototype = { polluted: true };
			});
		}).toThrow("reserved data path /constructor/prototype");

		transact(second, () => {
			delete second.branch;
		});
		transact(first, () => {
			first.alias.prototype = { safe: true };
		});

		expect(first.alias.prototype).toEqual({ safe: true });
	});

	it("releases each root's constructor edges through the idempotent finalization path", () => {
		interface ConstructorTarget {
			prototype?: object;
			safe: boolean;
		}

		const target: ConstructorTarget = { safe: true };
		const first = createMutableState({ alias: target, constructor: target });
		const second = createMutableState({ alias: target, constructor: target });

		unregisterTrackedRoot(first);
		unregisterTrackedRoot(first);

		expect(() => {
			transact(second, () => {
				second.alias.prototype = { polluted: true };
			});
		}).toThrow("reserved data path /constructor/prototype");

		unregisterTrackedRoot(second);

		transact(first, () => {
			first.alias.prototype = { safe: true };
		});

		expect(first.alias.prototype).toEqual({ safe: true });
	});

	it("releases a cyclic subtree removed by array length truncation", () => {
		interface ConstructorTarget {
			prototype?: object;
			safe: boolean;
		}

		interface Branch {
			constructor: ConstructorTarget;
			next?: Branch;
		}

		const target: ConstructorTarget = { safe: true };
		const branch: Branch = { constructor: target };

		branch.next = branch;

		const state = createMutableState({ alias: target, branches: [branch] });

		transact(state, () => {
			state.branches.length = 0;
			state.alias.prototype = { safe: true };
		});

		expect(state.alias.prototype).toEqual({ safe: true });
	});
});
