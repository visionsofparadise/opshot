<p align="center"><img src="https://raw.githubusercontent.com/visionsofparadise/opshot/main/logo.svg" width="200" alt="The React logo holding a smoking revolver" /></p>

# opshot

Plain-object state for React: mutate it directly, re-render only the components that read what changed, and track every change operation.

- **Self-contained**: a state carries its data, its methods, and its own subscription; pass it around like any object.
- **Reactive reads**: components read plain properties, and reads are tracked per component: a component re-renders only when a property it read changes.
- **Safe mutation**: write by mutating the actual object directly inside `mutate`.
- **Ops events**: every mutation emits its changes as `{ do, undo }` JSON Patch pairs, ready for history, sync, and persistence.

## Install

```sh
npm install opshot
```

## Quick start

```tsx
import { useCreateState } from "opshot/react";

const Counter = () => {
	const counter = useCreateState({ count: 0 });

	// Mutate the object directly: assignments, push, delete all work.
	const increment = () => counter.op.mutate((proxy) => proxy.count++);

	return <button onClick={increment}>{counter.count}</button>;
};
```

## Creating state

```tsx
import { ref } from "opshot";
import { useCreateState } from "opshot/react";

const Player = () => {
	const player = useCreateState((mutate, get) => ({
		position: 0,

		// ref() keeps a value out of reactivity and ops.
		element: ref(new Audio()),

		// get() reads the current values.
		seek: (position: number) => {
			get().element.currentTime = position;

			mutate((proxy) => (proxy.position = position));
		},
	}));

	// ...
};
```

## state.op

Everything opshot attaches lives under one reserved key, `op`.

```ts
// The write path. An optional second argument is passed to every subscriber.
counter.op.mutate((proxy) => {}, { transactionKey: "drag" });

// Hears every op this state emits; returns an unsubscribe.
const unsubscribe = counter.op.subscribe((state, ops, options) => {
	// ...
});

// State references are not reliable for equality: every mutation produces a new one. Use this instead.
counter.op.isSameState(other);

// True while a mutate callback is running.
counter.op.isMutating;

// The current values as your plain object, op stripped: for serializing and reads outside render.
counter.op.unwrap();

// The underlying valtio proxy, typed object: an escape hatch.
counter.op.proxy;
```

## Ops

```ts
const unsubscribe = counter.op.subscribe((state, ops, options) => {
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

## Groups

A group creates states and hears every op from the states it created: one stream for history, sync, and persistence.

```tsx
import { useEffect } from "react";
import { useCreateGroup, useCreateState } from "opshot/react";

const Editor = () => {
	// A lifetime-stable group.
	const group = useCreateGroup();

	// Created through the group, so its ops reach the group's subscribers.
	const doc = useCreateState({ items: new Array<string>() }, group);

	useEffect(
		() =>
			// Fires for doc and every other state the group created.
			group.subscribe((state, ops, options) => {
				// ...
			}),
		[group],
	);

	// ...
};
```

## resnapshot

A component re-renders when a property it read changes. Reads belong to the nearest subscribed component above them: `useCreateState` subscribes the component that created the state, and `resnapshot` subscribes the component it wraps.

This is a lever for bounding re-renders. Here `CounterButton` is plain, so its `count` read belongs to `App`, and every click re-renders `App` and everything under it:

```tsx
import type { State } from "opshot";
import { useCreateState } from "opshot/react";

interface Counter {
	title: string;
	count: number;
}

// Every click re-renders App and its whole subtree.
const App = () => {
	const counter = useCreateState<Counter>({ title: "Hits", count: 0 });

	return (
		<>
			<h1>{counter.title}</h1>
			<CounterButton counter={counter} />
		</>
	);
};

const CounterButton = ({ counter }: { counter: State<Counter> }) => (
	<button onClick={() => counter.op.mutate((proxy) => proxy.count++)}>{counter.count}</button>
);
```

Wrapping `CounterButton` in `resnapshot` subscribes it, so its `count` read becomes its own. A click now re-renders `CounterButton` alone:

```tsx
import { resnapshot } from "opshot/react";

// A click re-renders only CounterButton. A title change would still re-render App.
const CounterButton = resnapshot<{ counter: State<Counter> }>(({ counter }) => (
	<button onClick={() => counter.op.mutate((proxy) => proxy.count++)}>{counter.count}</button>
));
```

Subscribed components re-render independently: had `App` also read `count`, both would re-render.
