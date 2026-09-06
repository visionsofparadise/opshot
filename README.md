<p align="center"><img src="https://raw.githubusercontent.com/visionsofparadise/opshot/main/logo.svg" width="200" alt="The React logo holding a smoking revolver" /></p>

# opshot

Mutable state for React, with re-render for only the components that read what changed. (It's like [valtio](https://github.com/pmndrs/valtio), but not a footgun.)

## Install

```sh
npm install opshot
```

`opshot` is the state package. `useMutableState` and `scope` import from `opshot/react`; the root entry needs no React.

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

Wrap a memoized child that reads state in `scope`, so it owns its subscriptions when React skips a render. `scope(memo(Child))` keeps those subscriptions with the child as its parent re-renders.

## Creating State

```tsx
import { ignore, unsafeTrack } from "opshot";
import { useMutableState } from "opshot/react";

interface PlayerState {
	position: number;
	element: HTMLAudioElement;
	queue: Playlist;
	seek: (position: number) => void;
}

const Player = () => {
	const player: PlayerState = useMutableState({
		position: 0,

		// ignore() stores it as-is; opshot never looks inside.
		element: ignore(new Audio()),

		// unsafeTrack() takes it anyway, tracking the plain data on it.
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

`createMutableState(properties, options)` creates the same state outside a component, for a store or a process with no React.

## Identity

A component holds its own view of a state: the same object across its renders until a change lands at or beneath it, and a different object from the state held outside it. A dependency array can name a state or a field object and re-runs only when something under it changed. `subscribe` and `flush` accept a component's view of the root state. Any view can be assigned into a state. `isSameIdentity(a, b)` says whether two objects are one state, `identify(state)` returns one stable token per state for a dependency array or a Map key, and `isState(value)` tells a state from a plain object.

## Constraints

opshot tracks plain data.

It can't track:

- Hidden stores (language-level features like in Map)
- #private fields
- Own function properties on class instances
- Non-writable properties that hold an object

By default opshot throws when it meets one of these, naming the value that caused it. Passing `strict: false` turns off those errors but may cause unpredictable behaviour.

`ignore(value)` stores a value without state inside it being tracked, and `ignore(value, false)` undoes that. `unsafeTrack(value)` does the reverse: it takes a value strict mode would reject, tracking the plain data on it and quietly missing the rest. Either mark only affects states the value enters afterwards. Reads inside an ignored value are untracked too, so a component does not re-render for them.

## Tracked collections

`TrackedMap`, `TrackedSet`, and `TrackedDate` stand in for the built-ins opshot rejects. They have the exact same API as their counterparts.

```ts
import { TrackedMap } from "opshot";
import { useMutableState } from "opshot/react";

const state = useMutableState({ index: new TrackedMap<string, number>() });

state.index.set("a", 1);
```

## Subscribe

`subscribe` hears every change to a state.

```tsx
import { useEffect } from "react";
import { subscribe } from "opshot";
import { useMutableState } from "opshot/react";

const Counter = () => {
	const counter = useMutableState({ count: 0 });

	useEffect(
		() =>
			subscribe(counter, (operations) => {
				// operations: [{ kind: "change", node, key: "count", before: 0, after: 1, meta: undefined }]
			}),
		[counter],
	);

	// ...
};
```

Type the meta your batches carry with `subscribe<Meta>(state, listener)`.

## Operations

An operation is one key's change on one node:

```ts
interface AddOperation<Meta = unknown> {
	readonly kind: "add";
	readonly node: Record<string, unknown>;
	readonly key: string;
	readonly after: unknown;
	readonly meta: Meta;
}

// ChangeOperation carries before and after; DeleteOperation carries before.
type Operation<Meta = unknown> = AddOperation<Meta> | ChangeOperation<Meta> | DeleteOperation<Meta>;
```

`node` is the live state, so writing through it is tracked like any other write. Operations arrive in the order of the first write each contains. An edit to an array that changes its length also emits a `length` operation. For an array edit with one operation per key, applying the emission's values back in any order converges.

Undo and redo are a switch on `kind`:

```ts
const revert = (operation: Operation) => {
	if (operation.kind === "add") delete operation.node[operation.key];
	else operation.node[operation.key] = operation.before;
};

const apply = (operation: Operation) => {
	if (operation.kind === "delete") delete operation.node[operation.key];
	else operation.node[operation.key] = operation.after;
};
```

Revert an emission in reverse and apply it forward. The package's tests replay push, splice, and a whole-array assignment both ways.

## Emission

A state gathers its writes and delivers them together. The window is a microtask by default, so everything you change in one go arrives as one emission carrying the net change — a listener hears where a field ended up, not every step it took there.

`emitOn` sets the window instead. opshot hands you a `flush`, and the state waits until you call it.

```tsx
import { useEffect } from "react";
import { subscribe } from "opshot";
import { useMutableState } from "opshot/react";

const Chart = () => {
	// One emission per frame, however many writes land in between.
	const cursor = useMutableState({ x: 0, y: 0 }, { emitOn: (flush) => requestAnimationFrame(flush) });

	useEffect(
		() =>
			subscribe(cursor, (operations) => {
				// ...
			}),
		[cursor],
	);

	// ...
};
```

Separate from that callback, the `flush(state, ...states)` export ends each state's window from outside.

## Batches

`batch` runs a callback and tags every write inside it with your `meta`, so a listener can tell its own writes from everyone else's. Writes to one key fold into one operation only when their metas are the same value, so pass a string or an object you hold rather than a fresh literal.

The callback must be synchronous and return no value. Use a block body for a write expression that returns a value; a returned promise throws because the batch's metadata ends when the callback returns.

```tsx
import { useEffect } from "react";
import { batch, subscribe } from "opshot";
import { useMutableState } from "opshot/react";

const TitleBar = () => {
	const doc = useMutableState({ title: "Untitled" });

	useEffect(
		() =>
			subscribe(doc, (operations) => {
				const edits = operations.filter((operation) => operation.meta !== "replay");

				// ...
			}),
		[doc],
	);

	const rename = () => {
		batch(() => {
			doc.title = "Draft";
		}, "editor");
	};

	// ...
};
```

## License

[MIT](LICENSE)
