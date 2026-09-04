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
import { ignore, unsafeTrack, useMutableState } from "opshot";

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

## Constraints

opshot tracks plain data.

It can't track:

- Hidden stores (language-level features like in Map)
- #private fields
- Own function properties on class instances
- Non-writable properties that hold an object

By default opshot throws when it meets one of these, naming the value that caused it. Passing `strict: false` turns off those errors but may cause unpredictable behaviour.

`ignore(value)` stores a value without state inside it being tracked, and `ignore(value, false)` undoes that. `unsafeTrack(value)` does the reverse: it takes a value strict mode would reject, tracking the plain data on it and quietly missing the rest. Either mark only affects states the value enters afterwards.

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
			subscribe(counter, (operations) => {
				// operations: [{ node, key: "count", before: 0, after: 1, meta: undefined }]
			}),
		[counter],
	);

	// ...
};
```

## Operations

An operation is one key's change on one node:

```ts
interface Operation {
	readonly node: object;
	readonly key: string;
	readonly before?: unknown;
	readonly after?: unknown;
	readonly meta: unknown;
}
```

`before` and `after` are absent properties when the key was absent.

## Emission

A state gathers its writes and delivers them together. The window is a microtask by default, so everything you change in one go arrives as one emission carrying the net change — a listener hears where a field ended up, not every step it took there.

`emitOn` sets the window instead. opshot hands you a `flush`, and the state waits until you call it.

```tsx
import { useEffect } from "react";
import { subscribe, useMutableState } from "opshot";

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

Separate from that callback, the `flush(state)` export ends the window from outside, whether it is the default microtask or one your scheduler holds: subscribers hear what the state has gathered before it returns, and any callback your scheduler still holds for that window delivers nothing when it runs.

## Batches

`batch` runs a callback and tags every write inside it with your `meta`, so a listener can tell its own writes from everyone else's.

```tsx
import { useEffect } from "react";
import { batch, subscribe, useMutableState } from "opshot";

const TitleBar = () => {
	const doc = useMutableState({ title: "Untitled" });

	useEffect(
		() =>
			subscribe(doc, (operations) => {
				if (operations[0]?.meta === "replay") return;

				// ...
			}),
		[doc],
	);

	const rename = () => {
		batch(
			() => {
				doc.title = "Draft";
			},
			{ source: "editor" },
		);
	};

	// ...
};
```

## License

[MIT](LICENSE)
