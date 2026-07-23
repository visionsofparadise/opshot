import { subscribe } from "../subscribe";
import { transact } from "../transact";
import { createProxy } from "proxy-compare";
import { snapshot } from "valtio/vanilla";

import { installBoundary, unregisterTrackedRoot } from "./boundary";
import { createMutableState } from "../createMutableState";
import { type Op } from "../ops/operation";
import { ignore } from "../ignore";

const recordEmissions = <T extends object>(state: T): Array<{ state: T; ops: Array<Op> }> => {
  const emissions = new Array<{ state: T; ops: Array<Op> }>();

  subscribe(state, (ops) => {
    emissions.push({ state, ops: [...ops] });
  });

  return emissions;
};

describe("boundary: tracked lane", () => {
  it("tracks nested plain objects and arrays with fine-grained ops", () => {
    const state = createMutableState({ document: { title: "a", tags: ["x", "y"] } });
    const emissions = recordEmissions(state);

    transact(state, () => {
      state.document.title = "b";
    });

    transact(state, () => {
      state.document.tags[1] = "z";
    });

    expect(emissions.map((emission) => emission.ops)).toEqual([
      [{ do: { op: "replace", path: ["document", "title"], value: "b" }, undo: { op: "replace", path: ["document", "title"], value: "a" } }],
      [{ do: { op: "replace", path: ["document", "tags", 1], value: "z" }, undo: { op: "replace", path: ["document", "tags", 1], value: "y" } }],
    ]);
  });

  it("tracks an iterable plain object with fine-grained ops", () => {
    const state = createMutableState({
      collection: {
        count: 0,
        [Symbol.iterator]: function* () {
          yield 1;
        },
      },
    });
    const emissions = recordEmissions(state);

    transact(state, () => {
      state.collection.count = 1;
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([
      { do: { op: "replace", path: ["collection", "count"], value: 1 }, undo: { op: "replace", path: ["collection", "count"], value: 0 } },
    ]);
    expect(state.collection.count).toBe(1);
  });
});

describe("boundary: sparse-array snapshots", () => {
	it("restores a trailing-hole length after a proxied length write", () => {
		const state = createMutableState({ values: [1, 2, 3] });

		transact(state, () => {
			state.values.length = 5;
		});

		const values = state.values;

		expect(values).toHaveLength(5);
		expect(Object.hasOwn(values, 3)).toBe(false);
		expect(Object.hasOwn(values, 4)).toBe(false);
	});

	it("preserves mixed interior and trailing holes", () => {
		const state = createMutableState({ values: [1, 2, 3] });

		transact(state, () => {
			delete state.values[1];
			state.values.length = 6;
		});

		const values = state.values;

		expect(values).toHaveLength(6);
		expect(values[0]).toBe(1);
		expect(values[2]).toBe(3);
		expect([1, 3, 4, 5].map((index) => Object.hasOwn(values, index))).toEqual([false, false, false, false]);
	});

	it("leaves dense-array snapshots unchanged", () => {
		const values = createMutableState({ values: [1, 2, 3] }).values;

		expect(values).toEqual([1, 2, 3]);
		expect(Reflect.ownKeys(values)).toEqual(["0", "1", "2", "length"]);
	});
});

describe("boundary: snapshot donation", () => {
	it("throws at the assigned key before a snapshot copy creates a dead region", () => {
		const source = createMutableState({ item: { value: 1 } });
		const destination = createMutableState<{ box: unknown }>({ box: null });
		const donated = snapshot(source).item;

		expect(() => {
			transact(destination, () => {
				destination.box = donated;
			});
		}).toThrow(
			'opshot: cannot assign a snapshot generation at "box": a snapshot generation is a read-view, and assigning it creates a dead region. Clone the value, or replay through applyOps.',
		);
		expect(destination.box).toBe(null);
	});

	it("unwraps a tracking wrapper before rejecting its registered snapshot copy", () => {
		const source = createMutableState({ item: { value: 1 } });
		const donated = snapshot(source).item;
		const wrapped = createProxy(donated as object, new WeakMap(), new WeakMap(), new WeakMap());
		const destination = createMutableState<{ box: unknown }>({ box: null });

		expect(() => {
			transact(destination, () => {
				destination.box = wrapped;
			});
		}).toThrow("Clone the value, or replay through applyOps");
		expect(destination.box).toBe(null);
	});

	it("admits a raw object target", () => {
		const raw = { value: 1 };
		const state = createMutableState<{ box: { value: number } | null }>({ box: null });

		transact(state, () => {
			state.box = raw;
		});

		expect(state.box).toEqual({ value: 1 });
	});

	it("admits a popped proxy when the same target is reattached", () => {
		interface Item {
			value: number;
		}

		const target = { value: 1 };
		const state = createMutableState<{ items: Array<Item> }>({ items: [target] });
		let popped: Item | undefined;

		transact(state, () => {
			popped = state.items.pop();
		});
		transact(state, () => {
			if (popped) state.items.push(popped);
		});

		expect(state.items).toEqual([{ value: 1 }]);

		transact(state, () => {
			const item = state.items[0];

			if (item) item.value = 9;
		});

		expect(target.value).toBe(9);
	});
});

describe("boundary: throws at entry", () => {
	it("rejects reserved data paths during creation and mutation", () => {
		const protoData = {};
		const aliasedPrototype = { prototype: { polluted: true } };

		Object.defineProperty(protoData, "__proto__", { value: { polluted: true }, enumerable: true });

		expect(() => createMutableState(protoData)).toThrow("reserved data path /__proto__");
		expect(() => createMutableState({ constructor: { prototype: { polluted: true } } })).toThrow("reserved data path /constructor/prototype");
		expect(() => createMutableState({ safe: aliasedPrototype, constructor: aliasedPrototype })).toThrow("reserved data path /constructor/prototype");

		const state = createMutableState<{ value: unknown }>({ value: null });

		expect(() => {
			transact(state, () => {
				state.value = { constructor: { prototype: { polluted: true } } };
			});
		}).toThrow("reserved data path /value/constructor/prototype");
		expect(state.value).toBeNull();

		const staged = createMutableState<{ constructor: { prototype?: object; safe: boolean } }>({ constructor: { safe: true } });

		expect(() => {
			transact(staged, () => {
				staged.constructor.prototype = { polluted: true };
			});
		}).toThrow("reserved data path /constructor/prototype");
		expect(staged.constructor).toEqual({ safe: true });
	});

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
		const state = createMutableState({ first: { constructor: target } as Parent, second: { constructor: target } as Parent, alias: target });

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

  it("throws for a Map in the define literal, naming TrackedMap, unsafeTrack, and ignore", () => {
    expect(() => createMutableState({ lookup: new Map<string, number>() })).toThrow(
      "opshot: Map cannot be tracked (its state lives in internal slots). Options: use TrackedMap for a tracked equivalent; unsafeTrack(value) to track it lossily; ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for a Set, naming TrackedSet, unsafeTrack, and ignore", () => {
    expect(() => createMutableState({ members: new Set<string>() })).toThrow(
      "opshot: Set cannot be tracked (its state lives in internal slots). Options: use TrackedSet for a tracked equivalent; unsafeTrack(value) to track it lossily; ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for a Date, naming TrackedDate, unsafeTrack, and ignore", () => {
    expect(() => createMutableState({ createdAt: new Date() })).toThrow(
      "opshot: Date cannot be tracked (its state lives in internal slots). Options: use TrackedDate for a tracked equivalent; unsafeTrack(value) to track it lossily; ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for an offending value nested inside the define literal", () => {
    expect(() => createMutableState({ outer: { m: new Map<string, number>() } })).toThrow("opshot: Map cannot be tracked");
  });

  it("throws at the assigning line inside mutate, leaving the state unchanged", () => {
    interface Box {
      box: unknown;
    }

    const state = createMutableState<Box>({ box: null });

    expect(() => {
      transact(state, () => {
        state.box = new Map<string, number>();
      });
    }).toThrow("opshot: Map cannot be tracked");

    expect(state.box).toBe(null);
  });

  it("throws for a private-field class, naming unsafeTrack and ignore", () => {
    class Vault {
      #combination = 7;

      read() {
        return this.#combination;
      }
    }

    expect(() => createMutableState({ vault: new Vault() })).toThrow(
      "opshot: Vault cannot be tracked (its state is hidden in private fields). Options: unsafeTrack(value) tracks public fields while private methods throw on snapshots and undo drops that state; ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for a Map subclass with the native-slot message under its own name", () => {
    class Cache extends Map<string, number> {}

    expect(() => createMutableState({ cache: new Cache() })).toThrow(
      "opshot: Cache cannot be tracked (its state is hidden in internal slots). Options: unsafeTrack(value) tracks public fields while slot methods throw on snapshots and undo drops that state; ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for an array subclass instead of silently demoting it", () => {
    class Stack extends Array<number> {}

    expect(() => createMutableState({ stack: new Stack() })).toThrow(
      "opshot: Stack cannot be tracked (array subclasses lose their prototype in snapshots). Options: unsafeTrack(value) to track its data anyway; ignore(value) to store it by reference, untracked.",
    );
  });

  it("tracks a clean class instance with fine-grained interior ops", () => {
    class Emitter {
      count = 0;
    }

    const state = createMutableState({ emitter: new Emitter() });
    const emissions = recordEmissions(state);

    transact(state, () => {
      state.emitter.count = 1;
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([
      { do: { op: "replace", path: ["emitter", "count"], value: 1 }, undo: { op: "replace", path: ["emitter", "count"], value: 0 } },
    ]);
    expect(state.emitter).toBeInstanceOf(Emitter);
    expect(state.emitter.count).toBe(1);
  });

  it("throws for a clean class with an own-enumerable arrow method, naming unsafeTrack", () => {
    class Arrow {
      count = 0;
      bump = (): void => {
        this.count += 1;
      };
    }

    expect(() => createMutableState({ arrow: new Arrow() })).toThrow(
      "opshot: Arrow cannot be tracked (arrow-method writes won't be tracked). Options: unsafeTrack(value) to track its data anyway; ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for a frozen Map: freezing does not freeze internal slots", () => {
    expect(() => createMutableState({ lookup: Object.freeze(new Map<string, number>()) })).toThrow("opshot: Map cannot be tracked");
  });
});

describe("boundary: admitted by rule", () => {
  it("auto-ignores a frozen plain object: same reference through snapshots, no ops, interior write throws", () => {
    const frozen = Object.freeze({ value: 1 });
    const state = createMutableState({ box: frozen, tick: 0 });
    const emissions = recordEmissions(state);

    expect(state.box).toBe(frozen);

    transact(state, () => {
      state.tick = 1;
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([{ do: { op: "replace", path: ["tick"], value: 1 }, undo: { op: "replace", path: ["tick"], value: 0 } }]);
    expect(state.box).toBe(frozen);

    expect(() => {
      transact(state, () => {
        (state.box as { value: number }).value = 2;
      });
    }).toThrow(TypeError);
  });

  it("carries a symbol-keyed prop into snapshots, bumping the version without emission on write", () => {
    const marker: unique symbol = Symbol("marker");

    interface Flagged {
      count: number;
      [marker]: string;
    }

    const state = createMutableState<Flagged>({ count: 0, [marker]: "initial" });
    const emissions = recordEmissions(state);

    expect(state[marker]).toBe("initial");

    transact(state, () => {
      state[marker] = "written";
    });

    expect(emissions).toHaveLength(0);
    expect(state[marker]).toBe("written");
  });

  it("carries a non-enumerable prop into snapshots, absent from ops, bumping the version without emission on write", () => {
    interface Counted {
      count: number;
      hidden?: number;
    }

    const literal: Counted = { count: 0 };

    Object.defineProperty(literal, "hidden", { value: 0, writable: true, enumerable: false, configurable: true });

    const state = createMutableState<Counted>(literal);
    const emissions = recordEmissions(state);

    expect(Object.getOwnPropertyDescriptor(state, "hidden")).toMatchObject({ value: 0, enumerable: false });

    transact(state, () => {
      state.hidden = 5;
    });

    expect(emissions).toHaveLength(0);

    transact(state, () => {
      state.count = 1;
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([{ do: { op: "replace", path: ["count"], value: 1 }, undo: { op: "replace", path: ["count"], value: 0 } }]);

    const emitted = emissions[0]?.state;

    if (!emitted) throw new Error("the state heard no emission");

    expect(Object.getOwnPropertyDescriptor(emitted, "hidden")).toMatchObject({ value: 5, enumerable: false });
  });

  it("keeps functions as identity leaves", () => {
    const first = (): string => "a";
    const second = (): string => "b";

    const state = createMutableState({ run: first });
    const emissions = recordEmissions(state);

    transact(state, () => {
      state.run = second;
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([{ do: { op: "replace", path: ["run"], value: second }, undo: { op: "replace", path: ["run"], value: first } }]);
    expect(state.run).toBe(second);
  });
});

describe("boundary: ignore lane", () => {
  it("admits an ignored Map by reference, untracked and silent", () => {
    const lookup = ignore(new Map<string, number>());
    const state = createMutableState({ lookup, tick: 0 });
    const emissions = recordEmissions(state);

    expect(state.lookup).toBe(lookup);

    transact(state, () => {
      state.lookup.set("hits", 1);
    });

    expect(emissions).toHaveLength(0);
    expect(lookup.get("hits")).toBe(1);
  });

  it("admits an ignored value at the assigning line", () => {
    interface Box {
      box: Map<string, number> | null;
    }

    const state = createMutableState<Box>({ box: null });
    const emissions = recordEmissions(state);
    const kept = ignore(new Map([["k", 1]]));

    transact(state, () => {
      state.box = kept;
    });

    expect(emissions).toHaveLength(1);
    expect(state.box).toBe(kept);
  });
});

describe("boundary: accessor preservation", () => {
  interface Temperature {
    celsius: number;
    readonly fahrenheit: number;
    other: { n: number };
  }

  const createTemperature = (): Temperature =>
    createMutableState<Temperature>({
      celsius: 0,
      other: { n: 1 },
      get fahrenheit() {
        return (this.celsius * 9) / 5 + 32;
      },
    });

  it("keeps an own getter live on the live object, recomputing after writes", () => {
    const state = createTemperature();
    const emissions = recordEmissions(state);

    expect(state.fahrenheit).toBe(32);
    expect(Object.getOwnPropertyDescriptor(state, "fahrenheit")?.get).toBeTypeOf("function");

    transact(state, () => {
      state.celsius = 20;
    });

    const second = emissions[0]?.state;

    if (!second) throw new Error("the subscriber heard no emission");

    expect(second).toBe(state);
    expect(second.fahrenheit).toBe(68);
    expect(Object.getOwnPropertyDescriptor(second, "fahrenheit")?.get).toBeTypeOf("function");
    expect(state.fahrenheit).toBe(68);
  });

  it("preserves snapshot cache identity and untouched-subtree structural sharing", () => {
    const state = createTemperature();
    const emissions = recordEmissions(state);

    const first = snapshot(state);

    expect(snapshot(state)).toBe(first);

    transact(state, () => {
      state.celsius = 20;
    });

    const second = emissions[0]?.state;

    if (!second) throw new Error("the subscriber heard no emission");

    expect(second).not.toBe(first);
    expect(second.other).toBe(state.other);
  });
});

describe("boundary: meta-mutation trap gates", () => {
  it("throws when a consumer calls Object.defineProperty on tracked state", () => {
    const state = createMutableState({ count: 0 });

    expect(() => Object.defineProperty(state, "extra", { value: 1 })).toThrow(
      "opshot: defineProperty is not supported on tracked state; define properties in the createMutableState input",
    );
  });

  it("throws when a consumer calls Object.setPrototypeOf on tracked state", () => {
    const state = createMutableState({ count: 0 });

    expect(() => Object.setPrototypeOf(state, null)).toThrow("opshot: setPrototypeOf is not supported on tracked state");
  });

  it("keeps defineProperty rejection local to each proxy handler", () => {
    const second = createMutableState({ count: 0 });
    const first = createMutableState({
      get trigger(): number {
        return 0;
      },
      set trigger(value: number) {
        Object.defineProperty(second, "injected", { value });
      },
    });

    expect(() => {
      transact(first, () => {
        first.trigger = 1;
      });
    }).toThrow("opshot: defineProperty is not supported on tracked state");
    expect(Object.hasOwn(second, "injected")).toBe(false);
  });

  it("leaves ordinary set, delete, and nested writes through mutate unaffected", () => {
    interface Nested {
      count: number;
      hidden?: number;
      child: { value: number };
    }

    const state = createMutableState<Nested>({ count: 0, hidden: 1, child: { value: 1 } });
    const emissions = recordEmissions(state);

    transact(state, () => {
      state.count = 1;
      state.child.value = 9;
      state.child = { value: 20 };
      delete state.hidden;
    });

    expect(state.count).toBe(1);
    expect(state.child.value).toBe(20);
    expect(state.hidden).toBeUndefined();
    expect(emissions).toHaveLength(1);
  });
});

describe("boundary: install", () => {
  it("installs idempotently", () => {
    installBoundary();
    installBoundary();

    const state = createMutableState({ count: 0 });

    transact(state, () => {
      state.count = 1;
    });

    expect(state.count).toBe(1);
    expect(() => createMutableState({ lookup: new Map<string, number>() })).toThrow("opshot: Map cannot be tracked");
  });
});
