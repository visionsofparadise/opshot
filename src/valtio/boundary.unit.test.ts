import { createProxy } from "proxy-compare";
import { snapshot } from "valtio/vanilla";

import { installBoundary, unregisterTrackedRoot } from "./boundary";
import { createState, type State } from "../createState";
import { type Op } from "../ops/operation";
import { ignore } from "../ignore";

const recordEmissions = <T extends object>(state: State<T>): Array<{ state: State<T>; ops: Array<Op> }> => {
  const emissions = new Array<{ state: State<T>; ops: Array<Op> }>();

  state.op.subscribe((emittedState, ops) => {
    emissions.push({ state: emittedState, ops });
  });

  return emissions;
};

describe("boundary: tracked lane", () => {
  it("tracks nested plain objects and arrays with fine-grained ops", () => {
    const state = createState({ document: { title: "a", tags: ["x", "y"] } });
    const emissions = recordEmissions(state);

    state.mutate((mutable) => {
      mutable.document.title = "b";
    });

    state.mutate((mutable) => {
      mutable.document.tags[1] = "z";
    });

    expect(emissions.map((emission) => emission.ops)).toEqual([
      [{ do: { op: "replace", path: ["document", "title"], value: "b" }, undo: { op: "replace", path: ["document", "title"], value: "a" } }],
      [{ do: { op: "replace", path: ["document", "tags", 1], value: "z" }, undo: { op: "replace", path: ["document", "tags", 1], value: "y" } }],
    ]);
  });

  it("tracks an iterable plain object with fine-grained ops", () => {
    // Valtio's default predicate excluded any Symbol.iterator carrier, so this child was silently
    // untracked (writes landed raw, no emission). The boundary's plain-prototype test closes the hole.
    const state = createState({
      collection: {
        count: 0,
        [Symbol.iterator]: function* () {
          yield 1;
        },
      },
    });
    const emissions = recordEmissions(state);

    state.mutate((mutable) => {
      mutable.collection.count = 1;
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([
      { do: { op: "replace", path: ["collection", "count"], value: 1 }, undo: { op: "replace", path: ["collection", "count"], value: 0 } },
    ]);
    expect(state.op.unwrap().collection.count).toBe(1);
  });
});

describe("boundary: sparse-array snapshots", () => {
	it("restores a trailing-hole length after a proxied length write", () => {
		const state = createState({ values: [1, 2, 3] });

		state.mutate((mutable) => {
			mutable.values.length = 5;
		});

		const values = state.op.unwrap().values;

		expect(values).toHaveLength(5);
		expect(Object.hasOwn(values, 3)).toBe(false);
		expect(Object.hasOwn(values, 4)).toBe(false);
	});

	it("preserves mixed interior and trailing holes", () => {
		const state = createState({ values: [1, 2, 3] });

		state.mutate((mutable) => {
			delete mutable.values[1];
			mutable.values.length = 6;
		});

		const values = state.op.unwrap().values;

		expect(values).toHaveLength(6);
		expect(values[0]).toBe(1);
		expect(values[2]).toBe(3);
		expect([1, 3, 4, 5].map((index) => Object.hasOwn(values, index))).toEqual([false, false, false, false]);
	});

	it("leaves dense-array snapshots unchanged", () => {
		const values = createState({ values: [1, 2, 3] }).op.unwrap().values;

		expect(values).toEqual([1, 2, 3]);
		expect(Reflect.ownKeys(values)).toEqual(["0", "1", "2", "length"]);
	});
});

describe("boundary: snapshot donation", () => {
	it("throws at the assigned key before a snapshot copy creates a dead region", () => {
		const source = createState({ item: { value: 1 } });
		const destination = createState<{ box: unknown }>({ box: null });

		expect(() => {
			destination.mutate((mutable) => {
				mutable.box = source.item;
			});
		}).toThrow(
			'opshot: cannot assign a snapshot generation at "box": a snapshot generation is a read-view, and assigning it creates a dead region. Clone the value, or replay through applyOps.',
		);
		expect(destination.op.unwrap().box).toBe(null);
	});

	it("unwraps a tracking wrapper before rejecting its registered snapshot copy", () => {
		const source = createState({ item: { value: 1 } });
		const wrapped = createProxy(source.item, new WeakMap(), new WeakMap(), new WeakMap());
		const destination = createState<{ box: unknown }>({ box: null });

		expect(() => {
			destination.mutate((mutable) => {
				mutable.box = wrapped;
			});
		}).toThrow("Clone the value, or replay through applyOps");
		expect(destination.op.unwrap().box).toBe(null);
	});

	it("admits a raw object target", () => {
		const raw = { value: 1 };
		const state = createState<{ box: { value: number } | null }>({ box: null });

		state.mutate((mutable) => {
			mutable.box = raw;
		});

		expect(state.op.unwrap().box).toEqual({ value: 1 });
	});

	it("admits a popped proxy when the same target is reattached", () => {
		interface Item {
			value: number;
		}

		const target = { value: 1 };
		const state = createState<{ items: Array<Item> }>({ items: [target] });
		let popped: Item | undefined;

		state.mutate((mutable) => {
			popped = mutable.items.pop();
		});
		state.mutate((mutable) => {
			if (popped) mutable.items.push(popped);
		});

		expect(state.op.unwrap().items).toEqual([{ value: 1 }]);

		state.mutate((mutable) => {
			const item = mutable.items[0];

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

		expect(() => createState(protoData)).toThrow("reserved data path /__proto__");
		expect(() => createState({ constructor: { prototype: { polluted: true } } })).toThrow("reserved data path /constructor/prototype");
		expect(() => createState({ safe: aliasedPrototype, constructor: aliasedPrototype })).toThrow("reserved data path /constructor/prototype");

		const state = createState<{ value: unknown }>({ value: null });

		expect(() => {
			state.mutate((mutable) => {
				mutable.value = { constructor: { prototype: { polluted: true } } };
			});
		}).toThrow("reserved data path /value/constructor/prototype");
		expect(state.op.unwrap().value).toBeNull();

		const staged = createState<{ constructor: { prototype?: object; safe: boolean } }>({ constructor: { safe: true } });

		expect(() => {
			staged.mutate((mutable) => {
				mutable.constructor.prototype = { polluted: true };
			});
		}).toThrow("reserved data path /constructor/prototype");
		expect(staged.op.unwrap().constructor).toEqual({ safe: true });
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
		const state = createState<AliasedConstructor>({ alias: target, constructor: undefined });

		state.mutate((mutable) => {
			mutable.constructor = mutable.alias;
		});

		expect(() => {
			state.mutate((mutable) => {
				mutable.alias.prototype = { polluted: true };
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
		const state = createState({ first: { constructor: target } as Parent, second: { constructor: target } as Parent, alias: target });

		state.mutate((mutable) => {
			delete mutable.first.constructor;
		});

		expect(() => {
			state.mutate((mutable) => {
				mutable.alias.prototype = { polluted: true };
			});
		}).toThrow("reserved data path /constructor/prototype");

		state.mutate((mutable) => {
			delete mutable.second.constructor;
			mutable.alias.prototype = { safe: true };
		});

		expect(state.op.unwrap().alias.prototype).toEqual({ safe: true });
	});

	it("moves the reserved association when a constructor link is replaced", () => {
		interface ConstructorTarget {
			prototype?: object;
			safe: boolean;
		}

		const first: ConstructorTarget = { safe: true };
		const second: ConstructorTarget = { safe: true };
		const state = createState({ constructor: first, first, second });

		state.mutate((mutable) => {
			mutable.constructor = mutable.second;
			mutable.first.prototype = { safe: true };
		});

		expect(state.op.unwrap().first.prototype).toEqual({ safe: true });
		expect(() => {
			state.mutate((mutable) => {
				mutable.second.prototype = { polluted: true };
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
		const state = createState<Root>({ alias: target, branch: { constructor: target } });

		state.mutate((mutable) => {
			delete mutable.branch;
			mutable.alias.prototype = { safe: true };
		});

		expect(state.op.unwrap().alias.prototype).toEqual({ safe: true });
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

		const state = createState<Root>({ alias: target, branch });
		let detached: Branch | undefined;

		state.mutate((mutable) => {
			detached = mutable.branch;
			delete mutable.branch;
		});
		state.mutate((mutable) => {
			mutable.alias.prototype = { safe: true };
			delete mutable.alias.prototype;
		});
		state.mutate((mutable) => {
			if (detached) mutable.branch = detached;
		});

		expect(() => {
			state.mutate((mutable) => {
				mutable.alias.prototype = { polluted: true };
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

		const first = createState<Root>({ alias: target, branch });
		const second = createState<Root>({ alias: target, branch });

		first.mutate((mutable) => {
			delete mutable.branch;
		});

		expect(() => {
			first.mutate((mutable) => {
				mutable.alias.prototype = { polluted: true };
			});
		}).toThrow("reserved data path /constructor/prototype");

		second.mutate((mutable) => {
			delete mutable.branch;
		});
		first.mutate((mutable) => {
			mutable.alias.prototype = { safe: true };
		});

		expect(first.op.unwrap().alias.prototype).toEqual({ safe: true });
	});

	it("releases each root's constructor edges through the idempotent finalization path", () => {
		interface ConstructorTarget {
			prototype?: object;
			safe: boolean;
		}

		const target: ConstructorTarget = { safe: true };
		const first = createState({ alias: target, constructor: target });
		const second = createState({ alias: target, constructor: target });

		unregisterTrackedRoot(first.op.unsafeMutable);
		unregisterTrackedRoot(first.op.unsafeMutable);

		expect(() => {
			second.mutate((mutable) => {
				mutable.alias.prototype = { polluted: true };
			});
		}).toThrow("reserved data path /constructor/prototype");

		unregisterTrackedRoot(second.op.unsafeMutable);

		first.mutate((mutable) => {
			mutable.alias.prototype = { safe: true };
		});

		expect(first.op.unwrap().alias.prototype).toEqual({ safe: true });
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

		const state = createState({ alias: target, branches: [branch] });

		state.mutate((mutable) => {
			mutable.branches.length = 0;
			mutable.alias.prototype = { safe: true };
		});

		expect(state.op.unwrap().alias.prototype).toEqual({ safe: true });
	});

  it("throws for a Map in the define literal, naming TrackedMap, unsafeTrack, and ignore", () => {
    expect(() => createState({ lookup: new Map<string, number>() })).toThrow(
      "opshot: Map cannot be tracked (its state lives in internal slots). Options: use TrackedMap for a tracked equivalent; unsafeTrack(value) to track it lossily; ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for a Set, naming TrackedSet, unsafeTrack, and ignore", () => {
    expect(() => createState({ members: new Set<string>() })).toThrow(
      "opshot: Set cannot be tracked (its state lives in internal slots). Options: use TrackedSet for a tracked equivalent; unsafeTrack(value) to track it lossily; ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for a Date, naming TrackedDate, unsafeTrack, and ignore", () => {
    expect(() => createState({ createdAt: new Date() })).toThrow(
      "opshot: Date cannot be tracked (its state lives in internal slots). Options: use TrackedDate for a tracked equivalent; unsafeTrack(value) to track it lossily; ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for an offending value nested inside the define literal", () => {
    expect(() => createState({ outer: { m: new Map<string, number>() } })).toThrow("opshot: Map cannot be tracked");
  });

  it("throws at the assigning line inside mutate, leaving the state unchanged", () => {
    interface Box {
      box: unknown;
    }

    const state = createState<Box>(() => ({ box: null }));

    expect(() => {
      state.mutate((mutable) => {
        mutable.box = new Map<string, number>();
      });
    }).toThrow("opshot: Map cannot be tracked");

    expect(state.op.unwrap().box).toBe(null);
  });

  it("throws for a private-field class, naming unsafeTrack and ignore", () => {
    class Vault {
      #combination = 7;

      read() {
        return this.#combination;
      }
    }

    expect(() => createState({ vault: new Vault() })).toThrow(
      "opshot: Vault cannot be tracked (its state is hidden in private fields). Options: unsafeTrack(value) tracks public fields while private methods throw on snapshots and undo drops that state; ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for a Map subclass with the native-slot message under its own name", () => {
    class Cache extends Map<string, number> {}

    expect(() => createState({ cache: new Cache() })).toThrow(
      "opshot: Cache cannot be tracked (its state is hidden in internal slots). Options: unsafeTrack(value) tracks public fields while slot methods throw on snapshots and undo drops that state; ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for an array subclass instead of silently demoting it", () => {
    class Stack extends Array<number> {}

    expect(() => createState({ stack: new Stack() })).toThrow(
      "opshot: Stack cannot be tracked (array subclasses lose their prototype in snapshots). Options: unsafeTrack(value) to track its data anyway; ignore(value) to store it by reference, untracked.",
    );
  });

  it("tracks a clean class instance with fine-grained interior ops", () => {
    class Emitter {
      count = 0;
    }

    const state = createState({ emitter: new Emitter() });
    const emissions = recordEmissions(state);

    state.mutate((mutable) => {
      mutable.emitter.count = 1;
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([
      { do: { op: "replace", path: ["emitter", "count"], value: 1 }, undo: { op: "replace", path: ["emitter", "count"], value: 0 } },
    ]);
    expect(state.op.unwrap().emitter).toBeInstanceOf(Emitter);
    expect(state.op.unwrap().emitter.count).toBe(1);
  });

  it("throws for a clean class with an own-enumerable arrow method, naming unsafeTrack", () => {
    class Arrow {
      count = 0;
      bump = (): void => {
        this.count += 1;
      };
    }

    expect(() => createState({ arrow: new Arrow() })).toThrow(
      "opshot: Arrow cannot be tracked (arrow-method writes won't be tracked). Options: unsafeTrack(value) to track its data anyway; ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for a frozen Map: freezing does not freeze internal slots", () => {
    expect(() => createState({ lookup: Object.freeze(new Map<string, number>()) })).toThrow("opshot: Map cannot be tracked");
  });
});

describe("boundary: admitted by rule", () => {
  it("auto-ignores a frozen plain object: same reference through snapshots, no ops, interior write throws", () => {
    const frozen = Object.freeze({ value: 1 });
    const state = createState({ box: frozen, tick: 0 });
    const emissions = recordEmissions(state);

    expect(state.op.unwrap().box).toBe(frozen);

    state.mutate((mutable) => {
      mutable.tick = 1;
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([{ do: { op: "replace", path: ["tick"], value: 1 }, undo: { op: "replace", path: ["tick"], value: 0 } }]);
    expect(state.op.unwrap().box).toBe(frozen);

    expect(() => {
      state.mutate((mutable) => {
        (mutable.box as { value: number }).value = 2;
      });
    }).toThrow(TypeError);
  });

  it("carries a symbol-keyed prop into snapshots, bumping the version without emission on write", () => {
    const marker: unique symbol = Symbol("marker");

    interface Flagged {
      count: number;
      [marker]: string;
    }

    const state = createState<Flagged>(() => ({ count: 0, [marker]: "initial" }));
    const emissions = recordEmissions(state);

    expect(state[marker]).toBe("initial");

    state.mutate((mutable) => {
      mutable[marker] = "written";
    });

    expect(emissions).toHaveLength(0);
    expect(state.op.unwrap()[marker]).toBe("written");
  });

  it("carries a non-enumerable prop into snapshots, absent from ops, bumping the version without emission on write", () => {
    interface Counted {
      count: number;
      hidden?: number;
    }

    const literal: Counted = { count: 0 };

    Object.defineProperty(literal, "hidden", { value: 0, writable: true, enumerable: false, configurable: true });

    const state = createState<Counted>(() => literal);
    const emissions = recordEmissions(state);

    expect(Object.getOwnPropertyDescriptor(state, "hidden")).toMatchObject({ value: 0, enumerable: false });

    state.mutate((mutable) => {
      mutable.hidden = 5;
    });

    expect(emissions).toHaveLength(0);

    state.mutate((mutable) => {
      mutable.count = 1;
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

    const state = createState({ run: first });
    const emissions = recordEmissions(state);

    state.mutate((mutable) => {
      mutable.run = second;
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([{ do: { op: "replace", path: ["run"], value: second }, undo: { op: "replace", path: ["run"], value: first } }]);
    expect(state.op.unwrap().run).toBe(second);
  });
});

describe("boundary: ignore lane", () => {
  it("admits an ignored Map by reference, untracked and silent", () => {
    const lookup = ignore(new Map<string, number>());
    const state = createState({ lookup, tick: 0 });
    const emissions = recordEmissions(state);

    expect(state.op.unwrap().lookup).toBe(lookup);

    state.mutate((mutable) => {
      mutable.lookup.set("hits", 1);
    });

    expect(emissions).toHaveLength(0);
    expect(lookup.get("hits")).toBe(1);
  });

  it("admits an ignored value at the assigning line", () => {
    interface Box {
      box: Map<string, number> | null;
    }

    const state = createState<Box>(() => ({ box: null }));
    const emissions = recordEmissions(state);
    const kept = ignore(new Map([["k", 1]]));

    state.mutate((mutable) => {
      mutable.box = kept;
    });

    expect(emissions).toHaveLength(1);
    expect(state.op.unwrap().box).toBe(kept);
  });
});

describe("boundary: accessor preservation", () => {
  interface Temperature {
    celsius: number;
    readonly fahrenheit: number;
    other: { n: number };
  }

  const createTemperature = (): State<Temperature> =>
    createState<Temperature>({
      celsius: 0,
      other: { n: 1 },
      get fahrenheit() {
        return (this.celsius * 9) / 5 + 32;
      },
    });

  it("keeps an own getter live on state generations, recomputing per generation", () => {
    const state = createTemperature();
    const emissions = recordEmissions(state);

    expect(state.fahrenheit).toBe(32);
    expect(Object.getOwnPropertyDescriptor(state, "fahrenheit")?.get).toBeTypeOf("function");

    state.mutate((mutable) => {
      mutable.celsius = 20;
    });

    const second = emissions[0]?.state;

    if (!second) throw new Error("the subscriber heard no emission");

    expect(second.fahrenheit).toBe(68);
    expect(Object.getOwnPropertyDescriptor(second, "fahrenheit")?.get).toBeTypeOf("function");
    expect(state.fahrenheit).toBe(32);
  });

  it("preserves snapshot cache identity and untouched-subtree structural sharing", () => {
    const state = createTemperature();
    const emissions = recordEmissions(state);

    const first = snapshot(state.op.unsafeMutable);

    expect(snapshot(state.op.unsafeMutable)).toBe(first);

    state.mutate((mutable) => {
      mutable.celsius = 20;
    });

    const second = emissions[0]?.state;

    if (!second) throw new Error("the subscriber heard no emission");

    expect(second).not.toBe(first);
    expect(second.other).toBe(state.other);
  });
});

describe("boundary: meta-mutation trap gates", () => {
  it("throws when a consumer calls Object.defineProperty on tracked state", () => {
    const state = createState({ count: 0 });

    expect(() => Object.defineProperty(state.op.unsafeMutable, "extra", { value: 1 })).toThrow(
      "opshot: defineProperty is not supported on tracked state; define properties in the createState literal",
    );
  });

  it("throws when a consumer calls Object.setPrototypeOf on tracked state", () => {
    const state = createState({ count: 0 });

    expect(() => Object.setPrototypeOf(state.op.unsafeMutable, null)).toThrow("opshot: setPrototypeOf is not supported on tracked state");
  });

  it("keeps defineProperty rejection local to each proxy handler", () => {
    const second = createState({ count: 0 });
    const first = createState({
      get trigger(): number {
        return 0;
      },
      set trigger(value: number) {
        Object.defineProperty(second.op.unsafeMutable, "injected", { value });
      },
    });

    expect(() => {
      first.mutate((mutable) => {
        mutable.trigger = 1;
      });
    }).toThrow("opshot: defineProperty is not supported on tracked state");
    expect(Object.hasOwn(second.op.unsafeMutable, "injected")).toBe(false);
  });

  it("leaves ordinary set, delete, and nested writes through mutate unaffected", () => {
    interface Nested {
      count: number;
      hidden?: number;
      child: { value: number };
    }

    const state = createState<Nested>(() => ({ count: 0, hidden: 1, child: { value: 1 } }));
    const emissions = recordEmissions(state);

    state.mutate((mutable) => {
      mutable.count = 1;
      mutable.child.value = 9;
      mutable.child = { value: 20 };
      delete mutable.hidden;
    });

    expect(state.op.unwrap().count).toBe(1);
    expect(state.op.unwrap().child.value).toBe(20);
    expect(state.op.unwrap().hidden).toBeUndefined();
    expect(emissions).toHaveLength(1);
  });
});

describe("boundary: install", () => {
  it("installs idempotently", () => {
    installBoundary();
    installBoundary();

    const state = createState({ count: 0 });

    state.mutate((mutable) => {
      mutable.count = 1;
    });

    expect(state.op.unwrap().count).toBe(1);
    expect(() => createState({ lookup: new Map<string, number>() })).toThrow("opshot: Map cannot be tracked");
  });
});
