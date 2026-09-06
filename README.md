<p align="center"><img src="https://raw.githubusercontent.com/visionsofparadise/opshot/main/logo.svg" width="200" alt="The React logo holding a smoking revolver" /></p>

# opshot

Mutable state for React, with re-render for only the components that read what changed. (It's like [valtio](https://github.com/pmndrs/valtio), but not a footgun.)

## Install

```sh
npm install opshot
```

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

`ignore(value, false)` and `unsafeTrack(value, false)` undo these effects on the value.

## Constraints

opshot tracks plain data.

It can't track:

- Hidden stores (language-level features like in Map)
- #private fields
- Own function properties on class instances
- Non-writable properties that hold an object

By default opshot throws when it meets one of these, naming the value that caused it. Passing `strict: false` turns off those errors but may cause unpredictable behaviour.

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

interface Meta {
	source: string;
}

const Counter = () => {
	const counter = useMutableState({ count: 0 });

	useEffect(
		() =>
			subscribe<Meta | undefined>(counter, (operations) => {
				// operations: [{ kind: "change", node, key: "count", before: 0, after: 1, meta: undefined }]
			}),
		[counter],
	);

	// ...
};
```

## Operations

An operation is one key's change on one node:

```ts
interface AddOperation<Meta = unknown> {
	readonly kind: "add";
	readonly node: Record<string, unknown>; // The live state being applied to
	readonly key: string;
	readonly after: unknown;
	readonly meta: Meta;
}

interface ChangeOperation<Meta = unknown> {
	readonly kind: "change";
	readonly node: Record<string, unknown>;
	readonly key: string;
	readonly before: unknown;
	readonly after: unknown;
	readonly meta: Meta;
}

interface DeleteOperation<Meta = unknown> {
	readonly kind: "delete";
	readonly node: Record<string, unknown>;
	readonly key: string;
	readonly before: unknown;
	readonly meta: Meta;
}

type Operation<Meta = unknown> = AddOperation<Meta> | ChangeOperation<Meta> | DeleteOperation<Meta>;
```

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

Undo and redo are a switch on `kind`. Revert an emission in reverse and apply it forward.

## Emission

A state gathers its writes and delivers them together, in order. The window is a microtask by default, so everything you change in one go arrives as one emission carrying the net change — a listener hears where a field ended up, not every step it took there.

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

`batch` runs a callback and tags every write inside it with your `meta`, so a listener can tell its own writes from everyone else's.

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

## Identity

```tsx
const object = { name: "Ada", age: 36 };
const state = useMutableState(object);

object === state; // false
isSameIdentity(object, state); // true

isState(object); // false
isState(state); // true
```

```tsx
// The state's identity changes when the state or anything nested inside it changes.
useEffect(() => {
	// ...
}, [state]);
```

## License

[MIT](LICENSE)
