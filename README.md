<p align="center"><img src="https://raw.githubusercontent.com/visionsofparadise/opshot/main/logo.svg" width="200" alt="The React logo holding a smoking revolver" /></p>

# opshot

Mutable state for React, with re-render for only the components that read what changed. (It's like [valtio](https://github.com/pmndrs/valtio), but not a footgun.)

## Install

```sh
npm install opshot
```

Node 20 or later. The build targets `ES2021`.

## Mutable state

React state is immutable: changing one field means spreading the old object into a new one.

```tsx
const [user, setUser] = useState({ name: "Ada", age: 36 });

setUser((prev) => ({ ...prev, age: 37 }));
```

**opshot** state is a live mutable object: you assign the field.

```tsx
const user = useMutableState({ name: "Ada", age: 36 });

user.age = 37;
```

The state is created once, on the first render. Pass a function to build the properties once as well, exactly as `useState` does:

```tsx
const navigation = useMutableState(createNavigation);
```

## Bounded re-renders

React re-renders a component and its children when its state changes.

```tsx
interface User {
	name: string;
	age: number;
}

const Parent = () => {
	const [user, setUser] = useState<User>({ name: "Ada", age: 36 });

	const birthday = () => setUser((prev) => ({ ...prev, age: prev.age + 1 }));

	// A click re-renders Parent and Child.
	return (
		<>
			<button onClick={birthday}>+</button>
			<Child user={user} />
		</>
	);
};

const Child = ({ user }: { user: User }) => <p>{user.age}</p>;
```

**opshot** re-renders only what read the change. Wrap a child in `scope` and it subscribes to the fields it reads. **Where the mutation happens doesn't matter** — here Parent writes, and only Child re-renders, because renders follow reads, not writes.

```tsx
const Parent = () => {
	const user = useMutableState<User>({ name: "Ada", age: 36 });

	const birthday = () => {
		user.age++;
	};

	// A click re-renders only Child.
	return (
		<>
			<button onClick={birthday}>+</button>
			<Child user={user} />
		</>
	);
};

const Child = scope<{ user: User }>(({ user }) => <p>{user.age}</p>);
```

This is how you optimize re-rendering across your component tree: place `scope` boundaries where you want re-renders contained, and each boundary re-renders only when a field it read changes. `useMutableState` is a boundary itself.

`scope` searches props for states through plain data, following the same constraints as state creation, and ignoring React internals.

## Creating State

```tsx
import { ignore, unsafeTrack, useMutableState, type Ignored, type UnsafeTracked } from "opshot";

interface PlayerState {
	position: number;
	element: Ignored<HTMLAudioElement>;
	queue: UnsafeTracked<Playlist>;
	seek: (position: number) => void;
}

const Player = () => {
	const player = useMutableState<PlayerState>({
		position: 0,

		// ignore() keeps a value out of reactivity and ops.
		element: ignore(new Audio()),

		// unsafeTrack() tracks all the values it can, even if there is weird behaviour
		queue: unsafeTrack(new Playlist()),

		seek(position: number) {
			this.element.currentTime = position;

			if (this.position === position) return;

			this.position = position;
		},
	});

	// ...
};
```

Creation takes an options bag: `{ group?, emitOn?, strict? }`.

### `emitOn`

Bare writes emit on a microtask. Pass `emitOn` to choose a different window:

```ts
const state = createMutableState({ x: 0, y: 0 }, { emitOn: (flush) => requestAnimationFrame(flush) });
```

Ops are the net diff over a window either way.

Call `flush` exactly once. A pending flush pins its state until it runs — about 380 KB for a 200-row state — so a scheduler that discards the callback retains what it was given.

## Constraints

opshot tracks plain data.

It can't track:

- Internal slots (language level features like in Map)
- #private fields (hidden at the language level)
- Array subclasses (the prototype is lost when copied)

And `this` for arrow methods on classes refers to the original and **not** the tracked state.

Use `ignore` or `unsafeTrack` when dealing with these.

You can set `strict: false` when creating state to admit to unsafely tracking everything.

## Tracked collections

`TrackedMap`, `TrackedSet`, and `TrackedDate` stand in for the built-ins opshot rejects. They have the exact same API as their counterparts.

```ts
import { TrackedMap, useMutableState } from "opshot";

const state = useMutableState({ index: new TrackedMap<string, number>() });

state.index.set("a", 1);
```

## Transact

`transact` runs a callback as one cohesive unit of work. Every covering subscriber hears one net diff with the optional `meta`, and listeners run before it returns — except when it is called from inside a listener, or from one running while a transaction reports, in which case it returns before its own listeners run.

```ts
import { createMutableState, subscribe, transact } from "opshot";

const state = createMutableState({ x: 0, y: 0 });

subscribe(state, (ops, meta) => {
	// one delivery for both writes; meta is { source: "editor" }
});

transact(
	state,
	() => {
		state.x = 1;
		state.y = 2;
	},
	{ source: "editor" },
);
```

**Nesting is banned.** A `transact` reached while another is open throws. Domain methods should mutate, not transact — the caller owns the transaction boundary. Run transactions in sequence, or call `applyOperations` at top level.

**A throwing `transact` rolls back** its tracked writes and emits nothing, except a record that already carried unflushed bare writes when the transaction first touched it: that record keeps all of its writes, this transaction's included, and reports them bare. Rollback covers only tracked state: a request fired in the callback, an `ignore()`d value, or a write below `unsafeTrack()` is not undone.

## Subscribe

`subscribe` hears every change to a state.

```tsx
import { useEffect } from "react";
import { subscribe, useMutableState } from "opshot";

const Counter = () => {
	const counter = useMutableState({ count: 0 });

	useEffect(
		() =>
			subscribe(counter, (ops, meta) => {
				// ops: [{
				//   do:   { verb: "assign", path: ["count"], value: 1 },
				//   undo: { verb: "assign", path: ["count"], value: 0 },
				// }]
				// meta: whatever the writer passed, or undefined for bare writes
			}),
		[counter],
	);

	// ...
};
```

Any tracked object node is subscribable. A listener on `state.a` hears only changes at or below `a`, at paths relative to `a`.

```ts
subscribe(state.a, (ops) => {
	// path ["x"] for a write to state.a.x
});
```

Do not mutate the subscribed state inside the listener — that re-enters the listener and loops forever. A `transact` from a listener is not nested: the open transaction has already closed before delivery runs.

## Ops

An op is an opaque invertible pair. The public type is `Operation`; each half uses one of two verbs:

```ts
type OperationPath = ReadonlyArray<string | number>;

// Halves are structural; prefer treating Operation as opaque.
type Mutation =
	| { readonly verb: "assign"; readonly path: OperationPath; readonly value: unknown }
	| { readonly verb: "delete"; readonly path: OperationPath };

interface Operation {
	readonly do: Mutation;
	readonly undo: Mutation;
}
```

`applyOperations(state, ops, direction, meta?)` puts ops back on a state. It runs through `transact`, so it belongs at top level — not inside another transaction. Pass the operation pairs the listener delivered and a direction: `"do"` applies do halves in delivery order; `"undo"` applies undo halves in reverse delivery order. The library owns that ordering — do not reverse or map halves yourself.

```tsx
import { useEffect, useRef } from "react";
import { applyOperations, subscribe, useMutableState, type Operation } from "opshot";

const replay = {};

const Counter = () => {
	const counter = useMutableState({ count: 0 });
	const history = useRef<Array<ReadonlyArray<Operation>>>([]);

	useEffect(
		() =>
			subscribe(counter, (ops, meta) => {
				// Skip our own replays, so undo doesn't record itself.
				if (meta === replay) return;

				history.current.push(ops);
			}),
		[counter],
	);

	const undo = () => {
		const ops = history.current.pop();

		if (!ops) return;

		applyOperations(counter, ops, "undo", replay);
	};

	return (
		<>
			<button onClick={() => counter.count++}>+</button>
			<button onClick={undo}>Undo</button>
		</>
	);
};
```

Replay is exact for anything opshot can see: plain data. State behind a constraint is the exception. The same bound applies to rollback: a throwing `transact` undoes only tracked state.

Ops are **idempotent**.

If your state is JSON serializable, **then ops are too**. Project `verb` and `path` from a half; read `.value` explicitly on assign halves (it clones). Never spread, `JSON` round-trip, or `structuredClone` an op before applying it.

## Groups

A group hears every op from the states it created.

```tsx
import { useEffect } from "react";
import { subscribe, useGroup, useMutableState } from "opshot";

const Editor = () => {
	const app = useGroup();
	const docGroup = useGroup(app);

	// Ops reach docGroup and, through nesting, app.
	const doc = useMutableState({ items: new Array<string>() }, { group: docGroup });
	const selection = useMutableState({ index: 0 }, { group: docGroup });

	useEffect(
		() =>
			// Per-document stream: doc and selection.
			subscribe(docGroup, (state, ops, meta) => {
				// ...
			}),
		[docGroup],
	);

	useEffect(
		() =>
			// App-wide stream: every state under app, including nested groups.
			subscribe(app, (state, ops, meta) => {
				// ...
			}),
		[app],
	);

	// ...
};
```

## Channels

A channel binds `transact`, `subscribe`, and `applyOperations` to a typed meta convention, so a listener can tell its own writes from everyone else's.

```tsx
import { useEffect } from "react";
import { createChannel, useMutableState } from "opshot";

interface DocumentMeta {
	replay?: boolean;
	source?: string;
}

const docChannel = createChannel<DocumentMeta>({ source: "editor" }); // set defaults

const TitleBar = () => {
	const doc = useMutableState({ title: "Untitled" });

	useEffect(
		() =>
			docChannel.subscribe(doc, (ops, context) => {
				// A bare write, or a transact from another channel: meta is unknown.
				if (!context.isTransaction) return;

				// Own-channel transaction: meta is typed, with defaults merged.
				if (context.meta.replay) return;

				// ...
			}),
		[doc],
	);

	const rename = () => {
		docChannel.transact(doc, () => {
			doc.title = "Draft";
		});
	};

	// ...
};
```

## License

[MIT](LICENSE)
