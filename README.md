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

## Constraints

opshot tracks plain data.

It can't track:

- Internal slots (language level features like in Map)
- #private fields (hidden at the language level)
- Array subclasses (the prototype is lost when copied)

And `this` for arrow methods on classes refers to the original and **not** the tracked state.

Use `ignore` or `unsafeTrack` when dealing with these.

## Tracked collections

`TrackedMap`, `TrackedSet`, and `TrackedDate` stand in for the built-ins opshot rejects. They have the exact same API as their counterparts.

```ts
import { TrackedMap, useMutableState } from "opshot";

const state = useMutableState({ index: new TrackedMap<string, number>() });

state.index.set("a", 1);
```

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
				//   do:   { op: "replace", path: ["count"], value: 1 },
				//   undo: { op: "replace", path: ["count"], value: 0 },
				// }]
				// meta: whatever the writer passed, or undefined for bare writes
			}),
		[counter],
	);

	// ...
};
```

## Ops

An op is an invertible pair of `Operation` halves. Every half uses one of three verbs:

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

`applyOps` puts them back on a state, so a history is a list of ops and an undo is their `undo` halves in reverse.

```tsx
import { useEffect, useRef } from "react";
import { applyOps, subscribe, useMutableState, type Op } from "opshot";

const replay = {};

const Counter = () => {
	const counter = useMutableState({ count: 0 });
	const history = useRef<Array<ReadonlyArray<Op>>>([]);

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

		applyOps(
			counter,
			[...ops].reverse().map((op) => op.undo),
			replay,
		);
	};

	return (
		<>
			<button onClick={() => counter.count++}>+</button>
			<button onClick={undo}>Undo</button>
		</>
	);
};
```

Replay is exact for anything opshot can see: plain data. State behind a constraint is the exception.

If your state is JSON serializable, **then ops are too**.

## Groups

A group creates states and hears every op from the states it created: one stream for history, sync, persistence, etc.

```tsx
import { useEffect } from "react";
import { subscribe, useGroup, useMutableState } from "opshot";

const Editor = () => {
	const group = useGroup();

	// Created through the group, so their ops reach the group's subscribers.
	const doc = useMutableState({ items: new Array<string>() }, group);
	const selection = useMutableState({ index: 0 }, group);

	useEffect(
		() =>
			// Fires for doc, selection, and every other state the group created.
			// state is whichever one changed.
			subscribe(group, (state, ops, meta) => {
				// ...
			}),
		[group],
	);

	// ...
};
```

## Channels

A channel binds `transact`, `subscribe`, and `applyOps` to a typed meta convention, so a listener can tell its own writes from everyone else's.

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
