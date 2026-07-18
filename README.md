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
import { ref } from "opshot";
import { useTrackedState } from "opshot/react";

const Player = () => {
	const player = useTrackedState((mutate, get) => ({
		position: 0,

		// ref() keeps a value out of reactivity and ops.
		element: ref(new Audio()),

		// get() reads the current values.
		seek: (position: number) => {
			get().element.currentTime = position;

			mutate((mutable) => (mutable.position = position));
		},
	}));

	// ...
};
```

## Tracked State

Everything opshot attaches lives under two reserved keys, `mutate` and `op`.

```ts
// The write path. An optional second argument is passed to every subscriber.
counter.mutate((mutable) => mutable.count++, { transactionKey: "drag" });

// Hears every op this state emits; returns an unsubscribe.
const unsubscribe = counter.op.subscribe((state, ops, meta) => {
	// ...
});

// State references are not reliable for equality: every mutation produces a new one. Use this instead.
counter.op.isSameState(other);

// True while a mutate callback is running.
counter.op.isMutating;

// The current values as your plain object, op stripped: for serializing and reads outside render.
counter.op.unwrap();

// The underlying valtio proxy, typed object: an escape hatch.
counter.op.unsafeMutable;
```

## Ops

```ts
const unsubscribe = counter.op.subscribe((state, ops, meta) => {
	// state: the snapshot these ops produced
	// ops: [{
	//   do:   { op: "replace", path: "/count", value: 1 },
	//   undo: { op: "replace", path: "/count", value: 0 },
	// }]
});
```

An op is a pair of [RFC 6902](https://datatracker.ietf.org/doc/html/rfc6902) patch operations, each half carrying its own value, so any JSON Patch tool applies and inverts them.

A subscriber must not write to the state it subscribes to; writing to a different state is fine.

Ops cost nothing until someone listens: a state with no subscribers, on itself or its group, skips computing them entirely.

## Meta

`mutate`'s optional second argument is delivered to every subscriber alongside the ops.

To type it, declare a meta token once and pass it in.

```tsx
import { useEffect } from "react";
import { createMeta } from "opshot";
import { useTrackedState } from "opshot/react";

interface DocumentMeta {
	replay?: boolean;
}

// Declared once, at module scope.
const documentMeta = createMeta<DocumentMeta>();

const Editor = () => {
	const doc = useTrackedState({ title: "Untitled" }, documentMeta);

	// A history replaying an undone op marks the write, so recorders can tell it apart.
	// The meta argument is typed DocumentMeta.
	const undo = () => doc.mutate((mutable) => (mutable.title = "Untitled"), { replay: true });

	useEffect(
		() =>
			// The subscriber's meta parameter is typed DocumentMeta.
			doc.op.subscribe((state, ops, meta) => {
				// A recorder skips its own replays.
				if (meta.replay) return;

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
	// A lifetime-stable group.
	const group = useGroup();

	// Created through the group, so its ops reach the group's subscribers.
	const doc = useTrackedState({ items: new Array<string>() }, group);

	useEffect(
		() =>
			// Fires for doc and every other state the group created.
			group.subscribe((state, ops, meta) => {
				// ...
			}),
		[group],
	);

	// ...
};
```
