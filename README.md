<p align="center"><img src="https://raw.githubusercontent.com/visionsofparadise/opshot/main/logo.svg" width="200" alt="The React logo holding a smoking revolver" /></p>

# opshot

Mutable state for React, with re-render for only the components that read what changed. (It's [valtio](https://github.com/pmndrs/valtio), but not a footgun.)

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

opshot state is mutable: you assign the field.

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

opshot re-renders only what read the change. Wrap a child in `retrack` and it subscribes to the fields it reads. **Where the mutation happens doesn't matter** — here Parent writes, and only Child re-renders, because renders follow reads, not writes.

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
import { ignore, type Ignored } from "opshot";
import { useTrackedState } from "opshot/react";

interface PlayerState {
	position: number;
	element: Ignored<HTMLAudioElement>;
	seek: (position: number) => void;
}

const Player = () => {
	const player = useTrackedState<PlayerState>((mutate, get) => ({
		position: 0,

		// ignore() keeps a value out of reactivity and ops.
		element: ignore(new Audio()),

		seek: (position: number) => {
			get().element.currentTime = position;

			if (get().position === position) return;

			mutate((mutable) => (mutable.position = position));
		},
	}));

	// ...
};
```

Without `ignore`, that `new Audio()` would throw. The next section is why.

## Constraints

opshot tracks plain objects, plain arrays, and primitives.

It can't track:

- `Map`, `Set`, and `Date` (use `TrackedMap`, `TrackedSet`, `TrackedDate`)
- Class instances
- Array subclasses

Use `ignore` to store one of these by reference, untracked.

## Tracked collections

`TrackedMap`, `TrackedSet`, and `TrackedDate` stand in for the built-ins opshot rejects. They have the same API as their counterparts.

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
	//   isPatch: true,
	//   do:   { op: "replace", path: "/count", value: 1 },
	//   undo: { op: "replace", path: "/count", value: 0 },
	// }]
	// emission.meta is the writer's meta, or the write is a side effect
});

// State references are not reliable for equality: every mutation produces a new one. Use this instead.
counter.op.isSameState(other);

// True while a mutate callback is running.
counter.op.isMutating;

// The current values as your plain object, op and mutate stripped: for serializing and reads outside render.
counter.op.unwrap();

// The underlying valtio proxy, typed object: an escape hatch.
counter.op.unsafeMutable;
```

## Ops

An op is an invertible pair of halves. `applyOps(state, halves)` applies one direction's halves, already selected and ordered by you, in a single `mutate`.

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

		applyOps(
			counter,
			[...ops].reverse().map((op) => op.undo),
			replay,
		);
	};

	return (
		<>
			<button onClick={() => counter.mutate((mutable) => mutable.count++)}>+</button>
			<button onClick={undo}>Undo</button>
		</>
	);
};
```

A subscriber must not write to the state it subscribes to; writing to a different state is fine.

Ops cost nothing until someone listens: a state with no subscribers, on itself or its group, skips computing them entirely.

## Meta

`mutate`'s optional second argument rides the emission to every subscriber.

To type it, declare a meta token once and pass it in. `createMeta<M>()` is a type carrier; `createMeta<M>(defaults)` also merges defaults under each call's meta.

```tsx
import { useEffect } from "react";
import { createMeta } from "opshot";
import { useTrackedState } from "opshot/react";

interface DocumentMeta {
	replay?: boolean;
}

const documentMeta = createMeta<DocumentMeta>();

const Editor = () => {
	const doc = useTrackedState({ title: "Untitled" }, documentMeta);

	const undo = () => doc.mutate((mutable) => (mutable.title = "Untitled"), { replay: true });

	useEffect(
		() =>
			doc.op.subscribe((state, ops, emission) => {
				if (emission.isSideEffect || emission.meta.replay) return;

				// ...
			}),
		[doc.op],
	);

	// ...
};
```

## Groups

A group creates states and hears every op from the states it created: one stream for history, sync, and persistence.

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
