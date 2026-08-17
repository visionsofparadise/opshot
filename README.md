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

**opshot** state is mutable: you assign the field.

```tsx
const user = useTrackedState({ name: "Ada", age: 36 });

user.mutate((mutable) => (mutable.age = 37));
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

**opshot** re-renders only what read the change. Wrap a child in `retrack` and it subscribes to the fields it reads. **Where the mutation happens doesn't matter** — here Parent writes, and only Child re-renders, because renders follow reads, not writes.

```tsx
const Parent = () => {
	const user = useTrackedState<User>({ name: "Ada", age: 36 });

	const birthday = () => user.mutate((mutable) => mutable.age++);

	// A click re-renders only Child.
	return (
		<>
			<button onClick={birthday}>+</button>
			<Child user={user} />
		</>
	);
};

const Child = retrack<{ user: State<User> }>(({ user }) => <p>{user.age}</p>);
```

This is how you optimize re-rendering across your component tree: place `retrack` boundaries where you want re-renders contained, and each boundary re-renders only when a field it read changes. `useTrackedState` is a boundary itself.

## Creating State

```tsx
import { ignore, unsafeTrack, type Ignored, type UnsafeTracked } from "opshot";
import { useTrackedState } from "opshot/react";

interface PlayerState {
	position: number;
	element: Ignored<HTMLAudioElement>;
	queue: UnsafeTracked<Playlist>;
	seek: (position: number) => void;
}

const Player = () => {
	const player = useTrackedState<PlayerState>((mutate, get) => ({
		position: 0,

		// ignore() keeps a value out of reactivity and ops.
		element: ignore(new Audio()),

		// unsafeTrack() tracks all the values it can, even if there is weird behaviour
		queue: unsafeTrack(new Playlist()),

		seek: (position: number) => {
			get().element.currentTime = position;

			if (get().position === position) return;

			mutate((mutable) => (mutable.position = position));
		},
	}));

	// ...
};
```

## Constraints

opshot tracks plain data.

It can't track:

- Hidden stores (language-level features like in Map)
- #private fields
- Own function properties on class instances
- Non-writable properties that hold an object

Use `ignore` or `unsafeTrack` when dealing with these.

## Tracked collections

`TrackedMap`, `TrackedSet`, and `TrackedDate` stand in for the built-ins opshot rejects. They have the exact same API as their counterparts.

```ts
import { TrackedMap, createState } from "opshot";

const state = createState({ index: new TrackedMap<string, number>() });

state.mutate((mutable) => mutable.index.set("a", 1));
```

## Tracked State

Everything opshot attaches lives under two reserved keys, `mutate` and `op`.

```ts
// The write path. An optional second argument is meta, delivered with the emission.
counter.mutate((mutable) => mutable.count++, { transactionKey: "drag" });

// Hears every emission from this state; returns an unsubscribe.
const unsubscribe = counter.op.subscribe((state, ops, emission) => {
	// ops: [{
	//   do:   { op: "replace", path: ["count"], value: 1 },
	//   undo: { op: "replace", path: ["count"], value: 0 },
	// }]
	// emission.meta is the writer's meta, or the write is a side effect
});

// True while a mutate callback is running.
counter.op.isMutating;

// The current values as your plain object, op and mutate stripped.
counter.op.unwrap();

// The underlying valtio proxy: an escape hatch.
counter.op.unsafeMutable;
```

## Ops

An op is an invertible pair of halves. Every half uses one of three verbs:

```ts
type OperationPath = ReadonlyArray<string | number>;

type Operation =
	| { readonly op: "add"; readonly path: OperationPath; readonly value: unknown }
	| { readonly op: "replace"; readonly path: OperationPath; readonly value: unknown }
	| { readonly op: "remove"; readonly path: OperationPath };

interface Op {
	readonly do: Operation;
	readonly undo: Operation;
}
```

`applyOps` puts one direction's halves back on a state, so a history is a list of ops and an undo is `applyOps` of the undo halves.

```tsx
import { useEffect, useRef } from "react";
import { applyOps, type Emission, type Op } from "opshot";
import { useTrackedState } from "opshot/react";

const replay = { replay: true };

const Counter = () => {
	const counter = useTrackedState({ count: 0 });
	const history = useRef<Array<Array<Op>>>([]);

	useEffect(
		() =>
			counter.op.subscribe((state, ops, emission: Emission<{ replay?: boolean }>) => {
				if (emission.isSideEffect || emission.meta.replay) return;

				history.current.push(ops);
			}),
		[counter.op],
	);

	const undo = () => {
		const ops = history.current.pop();

		if (!ops) return;

		applyOps(counter, [...ops].reverse().map((op) => op.undo), replay);
	};

	return (
		<>
			<button onClick={() => counter.mutate((mutable) => mutable.count++)}>+</button>
			<button onClick={undo}>Undo</button>
		</>
	);
};
```

Replay is exact for anything opshot can see: plain data. State behind a constraint is the exception.

## Groups

A group creates states and hears every op from the states it created: one stream for history, sync, persistence, etc.

```tsx
import { useEffect } from "react";
import { useGroup, useTrackedState } from "opshot/react";

const Editor = () => {
	const group = useGroup();

	const doc = useTrackedState({ items: new Array<string>() }, group);

	useEffect(
		() =>
			group.subscribe((state, ops, emission) => {
				// ...
			}),
		[group],
	);

	// ...
};
```

## License

[MIT](LICENSE)
