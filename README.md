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

`retrack` finds states anywhere in props — nested objects, arrays, Maps, Sets, class instances, any key — stopping only at React elements, functions, and cycles. It walks props up to 10 levels deep; a state nested deeper won't be found — pass `maxDepth` to raise it: `retrack(Component, { maxDepth: 20 })`.

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

		// ignore() keeps a value out of reactivity and ops: stored by reference, untreated.
		element: ignore(new Audio()),

		seek: (position: number) => {
			// An ignored value's interior stays writable on every snapshot.
			get().element.currentTime = position;

			// get() reads the current values.
			if (get().position === position) return;

			mutate((mutable) => (mutable.position = position));
		},
	}));

	// ...
};
```

Without `ignore`, that `new Audio()` would throw. The next section is why.

## The value model

Tracked state is plain data: plain objects, plain arrays, primitives. That is what the op stream can promise faithful, invertible ops for. Everything else declares its treatment at the moment it enters state, or the assignment throws:

```ts
state.mutate((mutable) => (mutable.index = new Map()));
// Error: opshot: Map cannot be tracked (its state lives in internal slots).
// Options: use TrackedMap for a tracked equivalent; ignore(value) to store it by reference, untracked.

state.mutate((mutable) => (mutable.job = new UploadJob()));
// Error: opshot: UploadJob cannot be tracked (its state is hidden in private fields).
// Options: ignore(value) to store it by reference, untracked.
```

The throw is synchronous at the assigning line (or at `createState` when the initializer carries the value), and the message carries the fix: `Map`/`Set`/`Date` name their tracked equivalents, classes and array subclasses name `ignore()`. There is no silent lane — nothing is stored raw to misbehave later, far from the cause.

| Lane | Values | Treatment |
| --- | --- | --- |
| Tracked automatically | plain objects, plain arrays, primitives | proxied, diffed, fine-grained ops |
| Admitted by rule | frozen plain objects; symbol-keyed and non-enumerable properties; functions; own getters | present, no ops (rules below) |
| Declaration required | `Map`/`Set`/`Date`, class instances, array subclasses, everything else | throws until you pick `TrackedMap`/`TrackedSet`/`TrackedDate` or `ignore()` |

The admitted-by-rule lane holds values that carry an in-band declaration of their own:

- **Frozen plain objects** are auto-ignored: `Object.freeze` declares immutability, so there is nothing to miss. (A shallow-frozen root with mutable children is the caveat — the children are shared, and writes to them are on you.)
- **Symbol-keyed and non-enumerable properties** ride along: present in snapshots, never walked, never diffed. The symbol key and the enumerable flag are the language's own not-data markers.
- **Functions** are identity leaves: domain methods and function fields never produce ops, and replacing one is a tracked identity replace.
- **Own getters** stay live on snapshots: a getter declares derived, so it recomputes per generation and emits no ops.

Two regimes ship today: **tracked** (records what changed — ops) and **ignored** (present, untreated). A third, **watched** — reactivity without op values, for class instances free of hidden state — is designed but not yet available; today class instances take `ignore()`.

Also refused on tracked state: `Object.defineProperty` (define properties in the `createState` literal) and `Object.setPrototypeOf` both throw — meta-mutating tracked data is bug-shaped.

## ignore

`ignore(value)` stores a value by reference, fully outside the system: readable through every snapshot, no reactivity, no ops.

When part of an ignored value is worth reacting to, project it: reflect the reactive parts into plain fields beside the leaf, and concentrate the two-line discipline into a domain method.

```tsx
interface AudioPlayer {
	element: HTMLAudioElement;
	isPlaying: boolean;
	play: () => void;
}

const player = useTrackedState<AudioPlayer>((mutate) => {
	const element = ignore(new Audio());

	return {
		element,

		// The projection: a plain field beside the leaf carries what the UI reads.
		isPlaying: false,

		play: () => {
			void element.play();

			mutate((mutable) => (mutable.isPlaying = true));
		},
	};
});
```

The degenerate projection is a plain `revision` counter incremented by the mutating method: the op is faithful and invertible, and every reader re-renders.

External processes — promise settlements, socket events, DOM changes — wire in the same way: subscribe to the source and write plain projections through `mutate`, which makes them owned changes carrying meta like any other.

```ts
const upload = createState({ status: "idle" as "idle" | "sending" | "done" });

socket.addEventListener("message", (event) => {
	upload.mutate((mutable) => (mutable.status = parseStatus(event)), { source: "socket" });
});
```

## Tracked collections

`TrackedMap`, `TrackedSet`, and `TrackedDate` are the tracked equivalents the boundary errors name. Each subclasses its built-in — reads, iteration, `size`, and `instanceof` are the real thing — with the mutating methods overridden to emit ops.

```ts
import { createState, TrackedMap } from "opshot";

const state = createState({ index: new TrackedMap<string, number>() });

state.mutate((mutable) => mutable.index.set("a", 1));
// ops: [{ isPatch: true, do: { op: "mapSet", path: "/index", key: "a", value: 1 }, undo: { op: "mapDelete", path: "/index", key: "a" } }]
```

- The wrapper is identity-stable across generations: every snapshot hands back the same live object, so reads are always current.
- A call inside `mutate` joins that mutate's emission, meta included. A call outside `mutate` — including through code that received the wrapper as a plain `Map` — arrives on the next microtask as a side effect (below).
- Every key type gets fine per-key ops: the path names the wrapper and the key or member rides the op by identity, so an object-keyed `Map` or an object-membered `Set` inverts as cleanly as string keys. `clear` is the one whole-representation shape — a `mapEntries`/`setEntries` pair whose undo carries the prior entries — and `TrackedDate` emits its epoch as a `dateSet` pair.
- Replay is `applyOps`'s job: it resolves the op's path to the wrapper and calls the method the op names, so collection ops go through the same call as everything else (below).

## Tracked State

Everything opshot attaches lives under two reserved keys, `mutate` and `op`.

```ts
// The write path. An optional second argument is meta, delivered with the emission.
counter.mutate((mutable) => mutable.count++, { transactionKey: "drag" });

// Hears every emission from this state; returns an unsubscribe.
const unsubscribe = counter.op.subscribe((state, ops, emission) => {
	// ...
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

```ts
const unsubscribe = counter.op.subscribe((state, ops, emission) => {
	// state: the snapshot these ops produced
	// ops: [{
	//   isPatch: true,
	//   do:   { op: "replace", path: "/count", value: 1 },
	//   undo: { op: "replace", path: "/count", value: 0 },
	// }]
});
```

An op is an invertible pair of `Operation` halves. Plain data emits `add`/`replace`/`remove` at an [RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901) pointer, each half carrying its own value; tracked collections emit their method vocabulary — `mapSet`/`mapDelete`/`mapEntries`, `setAdd`/`setDelete`/`setEntries`, `dateSet` — with the path naming the wrapper and the method's arguments riding the op. `isPatch` is `true` on every op today; a marker variant joins the union, discriminated on it, when the watched regime ships.

`applyOps(state, operations, meta?)` is the whole replay surface: it applies one direction's halves — already selected and ordered by you — in a single `mutate`, forwarding `meta` to the emission, routing each op to plain-data application or the wrapper method it names.

Ops are live objects, not JSON: each value rides behind a per-read accessor, so every application gets a fresh copy and nothing can rewrite a recorded half. Copy an op — spread it, JSON round-trip it, `structuredClone` it — and the copy loses its value along with its brand, so `applyOps` throws naming the cause and the fix. (A `structuredClone` of an op carrying a function payload doesn't even get that far — it throws its own `DataCloneError`.) Apply the op objects the listener delivered; never copy them.

Arrays are dense by contract: holes read as `undefined`, and a presence change at unchanged length — `delete arr[1]`, or a hole becoming a stored `undefined` — escalates to one whole-array `replace`, as a length change already does. Dense same-length changes emit per-index ops.

Cycles in tracked data throw a named error instead of emitting a record that couldn't invert: the diff throws `opshot: cyclic value at /node/self; use ignore() for back-linked structures, or ids` at the observed mutate touching a cyclic region, and an op value that captured a freshly created cycle throws the same error when read. Back-links want identity, which is `ignore()`'s job; ids are the other route.

A subscriber must not write to the state it subscribes to; writing to a different state is fine.

Ops cost nothing until someone listens: a state with no subscribers, on itself or its group, skips computing them entirely.

## Side effects

`mutate` is ownership: it marks the changes it makes as owned and carries the caller's meta. Everything else the traps can see still reaches the stream — a write through `op.unsafeMutable`, a mutation of an object shared with another state, a tracked-collection call outside `mutate` — arriving one microtask later as faithful ops labeled a side effect. The emission settles which case you have before meta exists to read:

```ts
doc.op.subscribe((state, ops, emission) => {
	if (emission.isSideEffect) {
		// Not made through this state's mutate: no meta. The ops are still faithful.
		return;
	}

	emission.meta; // typed, and only reachable here
});
```

The ceiling is trap visibility. Writes no trap can see are invisible to reactivity and ops both:

- writes through a retained original — keep no reference to the object you hand `createState` or assign into state, because writes through the original bypass the proxy (**the don't-retain rule**);
- the interior of an `ignore()`d value, which is what `ignore` means;
- closure state, which no scan can see.

## Meta

`mutate`'s optional second argument rides the emission to every subscriber.

To type it, declare a meta token once and pass it in. `createMeta<M>()` is a pure type carrier; `createMeta<M>(defaults)` also merges defaults under each call's meta, so callers pass only what deviates while subscribers receive the whole.

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
			// The emission's meta is typed DocumentMeta.
			doc.op.subscribe((state, ops, emission) => {
				// A recorder skips side effects and its own replays.
				if (emission.isSideEffect || emission.meta.replay) return;

				// ...
			}),
		[doc.op],
	);

	// ...
};
```

A subscriber outside the token's reach types the emission itself: annotate the parameter — `(state, ops, emission: Emission<DocumentMeta>) => ...` — and `emission.meta` is fully typed. An explicit value type composes with either binding: `useTrackedState<Doc>(initializer, group)` and `useTrackedState<Doc>(initializer, documentMeta)` both compile.

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
			group.subscribe((state, ops, emission) => {
				// ...
			}),
		[group],
	);

	// ...
};
```

## History

A history is a subscriber: record the ops you hear, replay them with `applyOps`.

```ts
import { applyOps, type Emission, type Op, type State } from "opshot";

interface HistoryEntry {
	state: State<object>;
	ops: Array<Op>;
}

const stack: Array<HistoryEntry> = [];
let index = -1;

group.subscribe((state, ops, emission: Emission<{ replay?: boolean }>) => {
	// Record owned changes only: skip side effects and our own replays.
	if (emission.isSideEffect || emission.meta.replay === true) return;

	stack.length = index + 1;
	stack.push({ state, ops });
	index = stack.length - 1;
});

const undo = () => {
	const entry = stack[index];

	if (!entry) return;

	applyOps(entry.state, [...entry.ops].reverse().map((op) => op.undo), { replay: true });

	index -= 1;
};
```

Redo is the mirror: apply `stack[index + 1]`'s `do` halves in order and advance. One recipe covers everything — plain data and tracked collections replay through the same call. Coalescing a drag into one entry is yours — `transactionKey`, or any meta key you declare, arrives with the ops for you to merge on.
