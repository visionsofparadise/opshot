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

`retrack` finds states anywhere in props — nested object fields, plain arrays, `TrackedMap` keys and values, `TrackedSet` members, and own enumerable data fields on clean class instances (including the facades, which are ordinary clean classes). It throws when a state is found inside a private-field or native-slotted class, behind an own enumerable accessor on a class instance, or inside an array subclass. It does not walk React elements, functions, or cycles. It walks props up to 10 levels deep; a state nested deeper won't be found — pass `maxDepth` to raise it: `retrack(Component, { maxDepth: 20 })`.

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

Two regimes: **tracked** (records what changed — ops) and **ignored** (present, untreated). Tracked state is plain data, clean class instances, and anything you deliberately admit with `unsafeTrack`. That is what the op stream can promise — faithfully for plain data and clean classes, lossily when you opted in with `unsafeTrack`. Everything else declares its treatment at the moment it enters state, or the assignment throws:

```ts
state.mutate((mutable) => (mutable.index = new Map()));
// Error: opshot: Map cannot be tracked (its state lives in internal slots).
// Options: use TrackedMap for a tracked equivalent; unsafeTrack(value) to track it lossily; ignore(value) to store it by reference, untracked.

state.mutate((mutable) => (mutable.job = new UploadJob()));
// Error: opshot: UploadJob cannot be tracked (its state is hidden in private fields).
// Options: unsafeTrack(value) tracks public fields while private methods throw on snapshots and undo drops that state; ignore(value) to store it by reference, untracked.
```

The throw is synchronous at the assigning line (or at `createState` when the initializer carries the value), and the message carries the fix. There is no silent lane — nothing is stored raw to misbehave later, far from the cause.

| Lane | Values | Treatment |
| --- | --- | --- |
| Tracked automatically | plain objects, plain arrays, primitives, clean class instances (no own-enumerable functions) | proxied, diffed, fine-grained ops |
| Admitted by rule | frozen plain objects; symbol-keyed and non-enumerable properties; functions; own getters | present, no ops (rules below) |
| Declaration required | `Map`/`Set`/`Date`, classes with own-enumerable functions or hidden state, array subclasses, everything else | throws until you pick a facade, `unsafeTrack()`, or `ignore()` |

The admitted-by-rule lane holds values that carry an in-band declaration of their own:

- **Frozen plain objects** are auto-ignored: `Object.freeze` declares immutability, so there is nothing to miss. (A shallow-frozen root with mutable children is the caveat — the children are shared, and writes to them are on you.)
- **Symbol-keyed and non-enumerable properties** ride along: present in snapshots, never walked, never diffed. The symbol key and the enumerable flag are the language's own not-data markers.
- **Functions** are identity leaves: domain methods and function fields never produce ops, and replacing one is a tracked identity replace.
- **Own getters** stay live on snapshots: a getter declares derived, so it recomputes per generation and emits no ops.

**Clean classes track.** A class whose entire state is own-enumerable data with prototype methods rides the same copy / diff / replay path as a plain object: fine-grained reactivity, faithful ops, undo/replay. A clean class that carries an own-enumerable function (constructor-bound arrow methods are the common case) throws instead: those arrow-method writes would bypass the proxy undetected. The throw offers `unsafeTrack()` or `ignore()`.

**`unsafeTrack(value)`** is the universal loud opt-in. It suppresses the boundary throw and admits any otherwise-rejected value to the copy-tracking path, accepting whatever breaks:

- clean class with arrow fields — public data tracks; arrow-method writes are not recorded
- `#private` / native-slotted class — public fields track; methods that read hidden state throw on snapshots; whole-instance undo drops that state
- raw `Map`/`Set`/`Date` — lossy; prefer the facade (`TrackedMap`/`TrackedSet`/`TrackedDate`) for correct, full tracking

For `Map`/`Set`/`Date`, the throw leads with the facade, then `unsafeTrack`, then `ignore`. For classes and array subclasses, it offers `unsafeTrack` and `ignore`.

Also refused on tracked state: `Object.defineProperty` (define properties in the `createState` literal) and `Object.setPrototypeOf` both throw — meta-mutating tracked data is bug-shaped.

## Identity

A stored object has one storage identity and three kinds of handles: the raw object that entered state, its mutable proxy inside `mutate`, and read-only snapshot copies across generations. `===` and `Object.is` compare handles, so they are intentionally false across those domains and across changed snapshot generations.

`identify(value)` returns one opaque token for the storage identity behind any of those handles. Use the token as a `Map` or `Set` key. `isSameIdentity(a, b)` answers the same question directly without minting a token.

Storage replacement is observable even when the old and new objects have equal content. It emits a whole-value operation so replay can restore the displaced target. Fine diff recursion continues only through an unchanged storage identity; an interior mutation on the same target emits the deepest operation for the changed field.

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

`TrackedMap`, `TrackedSet`, and `TrackedDate` are plain-data clean classes that stand in for the built-ins the boundary rejects. They keep familiar methods, iteration, `size`, and `Symbol.toStringTag`. They are not subclasses: `map instanceof Map`, `set instanceof Set`, and `date instanceof Date` are false. Their entire functional state is own-enumerable tracked data, so they ride the generic boundary, diff, replay, and `retrack` paths with no special casing.

```ts
import { createState, TrackedMap } from "opshot";

const state = createState({ index: new TrackedMap<string, number>() });

state.mutate((mutable) => mutable.index.set("a", 1));
// membership lands as ordinary plain-data ops at index / slots / count
// (small maps often compact to one whole-container replace)
```

Backing (Map; Set is the single-element analogue):

- `slots` — ordered entry array, append-only, with bare `null` tombstones so slot numbers stay stable
- `index` — tagged address → slot map (`s`/`n`/`i`/`b`/`u`/`z`/`r`/`o…` for key type); identity-typed keys use a module-level intern table keyed on `resolveIdentity`
- `count` — live size; a prototype `size` getter reads it

`TrackedDate` is one own-enumerable `epochMs` field with the Date surface derived on read.

- Collection contents follow the value model. Plain objects and clean class instances in keys, values, and members are tracked; values the boundary rejects throw at attach. Use `ignore()` when a key, value, or member should stay an identity-only leaf, or `unsafeTrack()` to admit a caveated value.
- Membership uses storage identity. A raw original, a mutable proxy, and any snapshot generation of the same object all address the same key or member through `has`, `get`, `set`, `add`, and `delete`. Interior content changes never re-key it.
- Membership reactivity is granular: `has`/`get` read `index[address]`, so an unrelated add wakes nobody and the probed key appearing wakes exactly its readers. Whole-map aggregates (`size`, full iteration) are coarse by semantics.
- Map keys, map values, and set members are walked like any stored data — a state stored as a Map key is discovered by `retrack`.
- Delete, undo, and redo restore an entry at its original slot (tombstones keep positions stable), so iteration order survives arbitrary replay. A minimal clean-class clone (`Object.create(prototype)` plus own-enumerable copy) remains a fully functional facade.
- A call inside `mutate` joins that emission and meta. A call outside `mutate` arrives on the next microtask as a side effect.

## Tracked State

opshot attaches two reserved, non-enumerable keys: `mutate` and `op`. They stay out of spreads and `JSON.stringify` while remaining readable through every tracked boundary.

```ts
// The write path. An optional second argument is meta, delivered with the emission.
counter.mutate((mutable) => mutable.count++, { transactionKey: "drag" });

// Hears every emission from this state; returns an unsubscribe.
const unsubscribe = counter.op.subscribe((state, ops, emission) => {
	// ...
});

// Compare or key storage identity across raw, mutable, and snapshot handles.
isSameIdentity(counter, other);
identify(counter);

// True while a mutate callback is running.
counter.op.isMutating;

// The current cached snapshot generation, for serialization and reads outside render.
counter.op.unwrap();

// The underlying valtio proxy, typed object: an escape hatch.
counter.op.unsafeMutable;
```

## Ops

```ts
const unsubscribe = counter.op.subscribe((state, ops, emission) => {
	// state: the snapshot these ops produced
	// ops: [{
	//   do:   { op: "replace", path: ["count"], value: 1 },
	//   undo: { op: "replace", path: ["count"], value: 0 },
	// }]
});
```

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

The exported `AddOperation`, `ReplaceOperation`, and `RemoveOperation` types give the exact union members. Paths are state-relative sequences of string and numeric segments over plain data:

| Resolved parent | Segment | Address |
| --- | --- | --- |
| plain object / clean class | string | enumerable own data property |
| plain array | non-negative integer | indexed presence and value, with no shifting |
| plain array | enumerable non-index string | ordinary data property |
| plain array | `"length"` | conceptual array length |
| `TrackedMap` / `TrackedSet` | `"index"` / `"slots"` / `"count"` | facade backing fields (addresses are tagged strings inside `index`) |
| `TrackedDate` | `"epochMs"` | epoch milliseconds |

`[]` names the logical state root, but a half cannot add, replace, or remove that stable root. Every constructed path is a shallow-frozen copy. `add` requires an absent address and makes it present; `replace` requires a present address and changes its value; `remove` requires a present address and makes it absent. Presence is distinct from a stored `undefined`.

Arrays are sparse and never use splice semantics during replay. Indexed add fills a hole without shifting, indexed remove creates a hole without shifting, and `"length"` changes length. Growth emits the length replacement before new-tail additions. Shrink emits present-tail removals before the length replacement. Reversing undo halves therefore restores the required length before restoring truncated entries.

Facades emit ordinary plain-data ops at their backing fields. A growing Map membership add typically lands as four atomic ops (`slots.length`, `slots[n]`, `index[addr]`, `count`); a delete as three (tombstone, index remove, count). Small facades often compact to one whole-container replace. Undo of a delete restores the entry at its original slot because the recorded index value and tombstone keep the position. Date mutations are ordinary scalar replaces of `epochMs`.

Diffing recurses through an object only while its storage identity is unchanged. A whole-value `replace` means the value at that address changed wholesale: the diff emits it when the storage target is replaced, and when a container's atomic operations would retain more than the container's full contents (small containers included). It does not by itself mean the storage target changed. Replay reattaches the recorded target and restores its recorded content, preserving identity and DAG aliases, so identity-keyed consumers are unaffected. If code edited a detached target after the operation was recorded, replay overwrites those edits with the recorded generation. Consumers that need per-field granularity must handle container-level replaces, which was already true of target replacement.

Ops in an emission are ordered. Apply `do` halves in delivered order and `undo` halves in reverse order. Path-keyed coalescing is unsound: operations sharing a path can address different identities or depend on earlier operations in the entry (arrays especially).

`applyOps(state, operations, meta?)` applies one direction's already selected, correctly ordered halves in one `mutate`, forwarding `meta`. Replay restores registered storage targets instead of donating clones. It reattaches each target and stomps its recorded content exactly, deleting target-only data and restoring array holes. If code edited a detached object after the operation was recorded, undo overwrites those edits with the recorded generation.

Ops are live runtime objects. Public value accessors return defensive copies, while `applyOps` reaches the registered originals needed for identity restoration. Spreading the outer `{ do, undo }` pair is harmless because it preserves the original halves. Spreading an individual half, or copying a pair or half through JSON, produces brandless halves that `applyOps` rejects with the cause and fix. `structuredClone` can throw `DataCloneError` first when an operation carries a non-cloneable payload; otherwise its copied halves are likewise brandless and rejected. Apply the operation halves the listener delivered.

**Serializability scope:** JSON-serializable state yields JSON-serializable ops, round-trip consistent — that is the whole guarantee. Facades carry methods, so they are never JSON-serializable state; interned object addresses appear only in facade ops, which already sit outside the guarantee.

Opshot promises no serializer, whole-contents selector, public path classifier, or foreign applier. No wire format or encoder ships.

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
- assigning a snapshot generation into a draft throws at that assignment because the copy is a read-view and would create a dead region; clone it for new storage, or replay its recorded operation through `applyOps`;
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

A history is a subscriber: record each listener-delivered op pair as an opaque ordered replay record, then replay its original halves with `applyOps`.

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

Redo is the mirror: apply `stack[index + 1]`'s `do` halves in order and advance. One recipe covers plain data, sparse arrays, and tracked facades. Keep each listener-delivered pair intact and do not inspect, rewrite, copy, classify, or coalesce its path: each half already carries the identity and content needed to restore exact state, including facade iteration order through recorded slot indexes and tombstones.

Coalescing a drag into one entry is yours. A `transactionKey`, or any meta key you declare, arrives with the ops to guide a domain-aware merge. Do not merge into a map keyed only by `path`; ordered operations at the same path are not interchangeable.
