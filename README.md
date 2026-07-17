# opshot

Valtio state with one write path. Reads are snapshots, and every write runs through `mutate`, which diffs the before and after snapshots and emits each change as a `{ do, undo }` pair of JSON Patch operations.

React components read fresh snapshots through the `resnapshot` HOC, so prop identity stays a truthful change signal. History, sync, and persistence are subscribers to the op stream rather than wrappers around the write path.

## Install

```sh
npm install opshot
```

React is an optional peer dependency, needed only for the `opshot/react` entry. Core consumers never load React.

## Quick start

```ts
import { createState } from "opshot";

interface Counter {
  count: number;
  increment: () => void;
}

const counter = createState<Counter>((mutate) => ({
  count: 0,
  increment: () => {
    mutate((draft) => {
      draft.count += 1;
    });
  },
}));

const unsubscribe = counter.op.subscribe((state, ops, options) => {
  console.log(state.count, ops, options);
});

counter.increment();
// 1 [{ do: { op: "replace", path: "/count", value: 1 }, undo: { op: "replace", path: "/count", value: 0 } }] {}

counter.op.mutate((draft) => {
  draft.count = 10;
}, { source: "input" });
// 10 [{ do: { op: "replace", path: "/count", value: 10 }, undo: { op: "replace", path: "/count", value: 1 } }] { source: "input" }

unsubscribe();
```

A pure-data state with no domain methods takes a plain object directly:

```ts
const settings = createState({ count: 0 });
```

The callback form is for states with domain methods that need `mutate` and `get`; a plain-data state has neither, so it hands `createState` the object itself. Hand `createState` a literal you do not retain: reused nested objects are shared across states (top-level fields stay independent), exactly as with the callback form, and an inline literal is fully safe because nothing else references it.

`createState(define)` accepts either a plain object or a `define` callback. The callback form calls `define(mutate, get)`; both proxy the resulting object and hand back a snapshot of it. Data fields, domain methods, and getters live flat on the state; everything the library attaches lives under one reserved key, `op`:

```ts
interface OpshotHandle<T extends object> {
  readonly proxy: object; // escape hatch, typed object: using it takes a cast
  readonly isMutating: boolean;
  readonly mutate: Mutate<T>;
  readonly subscribe: (listener: StateListener<T>) => () => void;
  readonly isSameState: (other: unknown) => boolean;
}
```

A define literal that carries its own `op` field throws: `createState(() => ({ op: "pending" }))` raises `opshot: "op" is a reserved key on a state`.

- **Write through `mutate`.** Assigning to a state fails to compile: `counter.count = 9` raises `TS2540: Cannot assign to 'count' because it is a read-only property`.
- **Domain methods close over `mutate`, never `this`.** A detached reference (`const inc = counter.increment`) works.
- **Direct write and listen calls route through `op`.** `counter.increment()` is the common path; `counter.op.mutate(...)` and `counter.op.subscribe(...)` are for history extensions, persistence wiring, and tests reaching in directly.
- **Calling `mutate` or `get` during `define` throws.** Both close over a proxy that does not exist yet.
- **Nested `mutate` on the same state throws.** Mutating a *different* state from inside a callback is allowed and emits independently.

## Generations

Every `mutate` produces a new snapshot. The state you hold is one generation: its reads are that generation's values and stay fixed while the state moves on.

```ts
counter.increment();

counter.count;         // 0, the generation createState returned
unwrap(counter).count; // 1, the current generation
```

Staleness is the design, not a bug. A snapshot that changed under you would make prop identity a lie and `React.memo` useless. Fresh generations reach you three ways: `resnapshot` substitutes them into props, subscribers receive them, and `unwrap(state)` resolves the current generation for data reads.

`get` is the `define` callback's second argument, needed there because the state does not exist yet to call it on:

```ts
const counter = createState<Counter>((mutate, get) => ({
  count: 0,
  increment: () => {
    mutate((draft) => {
      draft.count += 1;
    });
  },
  incrementIfBelow: (limit: number) => {
    if (get().count < limit) {
      mutate((draft) => {
        draft.count += 1;
      });
    }
  },
}));
```

A method reading `this.count` instead reads its receiver's generation, which is whatever the caller held. Reach the current generation from outside `define` with `unwrap`.

### Identity

Snapshot identity is stable within a generation and changes across generations, so `===` between two generations is false. `state.op` is the `ref()`-wrapped survivor of every generation, so `a.op === b.op` is the identity test, and it is Map-keyable. `isSameState(other)` is the same comparison, named for discoverability:

```ts
import { createGroup, type State } from "opshot";

const group = createGroup();
const counter = group.createState<Counter>((mutate) => ({
  count: 0,
  increment: () => {
    mutate((draft) => {
      draft.count += 1;
    });
  },
}));

let fresh: State<object> = counter;

group.subscribe((state) => {
  fresh = state;
});

counter.increment();

fresh === counter;             // false, two generations of one state
fresh.op === counter.op;       // true
fresh.op.isSameState(counter); // true
```

`===` answers "is this the value I already rendered?" and must stay false across generations. `state.op` and `isSameState` answer "are these the same state?" and stay true across all of them.

`state.op` is the map key: `new Map([[counter.op, stack]])` is retrievable through any later generation's `.op`.

## createGroup and the ops stream

`createGroup()` returns `{ createState, subscribe }`. The group hears every state it minted:

```ts
import { createGroup } from "opshot";

const group = createGroup();
const grade = group.createState<Grade>(() => ({ exposure: 0 }));

group.subscribe((state, ops, options) => {
  console.log(state.op.isSameState(grade), ops, options);
});

grade.op.mutate((draft) => {
  draft.exposure = 5;
}, { source: "input" });
// true [{ do: { op: "replace", path: "/exposure", value: 5 }, undo: { op: "replace", path: "/exposure", value: 0 } }] { source: "input" }
```

The `state` a subscriber receives is the latest snapshot, the one those ops produced. `state.op.subscribe` hands its listener that state typed as `State<T>`, which is the route to a typed fresh generation outside React. `group.subscribe` sees `State<object>`, since a group mints states of many types.

Two rules fix the order listeners run in. A group listener fires ahead of every per-state listener, because `group.createState` registers the group's forwarding listener into the state's own listeners at mint, ahead of any subscription a consumer can make to that state; a group listener holds that position whenever it subscribed. Per-state listeners fire among themselves in subscription order.

Standalone `createState` is the same factory without the shared stream. A state the group never minted is inaudible to its subscribers, which is how you opt a state out of a recorder: make it standalone, do not flag its writes.

The `options` bag is the caller's, forwarded verbatim to every subscriber. Use it to carry call-site intent (a transaction key, a replay marker, an origin tag). Emission is never gated on it; subscribers implement their own policy.

## Ops

An op is a pair of [RFC 6902](https://datatracker.ietf.org/doc/html/rfc6902) patch operations, one forward and one inverse. Any 6902 tool applies them, and apply semantics are the RFC's: what an application does at some corner is answered there rather than here.

```ts
type PatchOperation =
  | { readonly op: "add"; readonly path: string; readonly value: unknown }
  | { readonly op: "replace"; readonly path: string; readonly value: unknown }
  | { readonly op: "remove"; readonly path: string };

interface Op {
  readonly do: PatchOperation;
  readonly undo: PatchOperation;
}
```

- Undo an emission with `ops.map((op) => op.undo).reverse()`, redo it with `ops.map((op) => op.do)`. Each half carries its own absolute value, so an op inverts standalone with no reference to the document.
- Paths are [RFC 6901](https://datatracker.ietf.org/doc/html/rfc6901) pointer strings, escaping `~` to `~0` and `/` to `~1`. The root path is `""`.
- Three verbs come out of the diff. `move`, `copy`, and `test` never do, and `PatchOperation` declares its own narrow union rather than importing a wider one, so the emission contract cannot widen by dependency.
- One emission per `mutate`, synchronous, after the callback returns. A mutation producing no change emits nothing.
- Ops are the net change, not a trace. `push` and `splice` emit the array's net difference, and same-path writes within one `mutate` collapse.
- `add` and `remove` mean the key's absence. A key present holding `undefined` diffs as `replace`, and the `op` discriminant is what carries presence: `value === undefined` cannot, because a key holding `undefined` is a real state.
- Arrays diff per index when lengths match, and as one whole-array `replace` when they differ.
- Leaves compare with `Object.is`. Functions, class instances, and `ref()` values are identity-compared leaves.
- Ops within one emission are order-independent.

```ts
doc.op.mutate((draft) => { draft.items.push("x") });
// [{ do: { op: "replace", path: "/items", value: ["x"] }, undo: { op: "replace", path: "/items", value: [] } }]

doc.op.mutate((draft) => { draft.meta.tag = 2 });
// [{ do: { op: "replace", path: "/meta/tag", value: 2 }, undo: { op: "replace", path: "/meta/tag", value: 1 } }]

doc.op.mutate((draft) => { draft.extra = true });
// [{ do: { op: "add", path: "/extra", value: true }, undo: { op: "remove", path: "/extra" } }]
```

### Reading a value

A `remove` half carries no `value` key, so a value read off a bare `Op` does not compile. Discriminate first:

```ts
op.do.value;
// TS2339: Property 'value' does not exist on type 'PatchOperation'.
//         Property 'value' does not exist on type '{ readonly op: "remove"; readonly path: string; }'.

if (op.do.op !== "remove") record(op.do.value);
```

`value` is a getter that returns a fresh deep clone of a frozen original on every read, because applying an op consumes its value: valtio's `proxy(value)` makes an assigned object the proxy's target, so a donated value stops being a record and becomes live state. One clone per application keeps the record truthful however many times it is applied.

```ts
if (op.do.op !== "remove") {
  op.do.value === op.do.value; // false for a cloneable value: each read mints its own clone
}
```

A write to a value you read lands on that throwaway clone, so the op still reads what it recorded. Identity comparison on a whole value is therefore meaningless by design. The clone stops where the diff stops: `ref()` values, functions, and class instances are carried by identity rather than copied, so two reads of one op hand back the same object even though the box around it is fresh. A `ref()` nested inside a cloneable value survives the clone, which is what makes `ref()` the door for shared identity through a replay. An un-ref'd class instance is valtio's per-generation copy of the one you assigned, since valtio rebuilds instances into every snapshot; its identity is stable within an op and means nothing outside one.

```ts
import { ref } from "opshot";

const bookkeeping = ref({ entries: [] });
```

opshot re-exports valtio's `ref`, and that is the one to import. `ref` marks a value in a `WeakSet` held by the valtio instance the call came from, so a `ref` taken from a second copy of valtio registers somewhere opshot's diff never looks, and the value is cloned and frozen like any other.

The halves are 6902 operations; the ops are not unconditionally JSON. A state holding `undefined` or a function value produces halves that are valid in memory and lose those keys under `JSON.stringify`.

## Replay

Ops replay through the state's own `mutate`, so a replay emits like any other write, and the `appliedOps` stamp is what lets recorders skip their own:

```ts
import { applyPatch } from "fast-json-patch";

grade.op.mutate((draft) => { applyPatch(draft, ops.map((op) => op.do)); }, { appliedOps: true });                  // redo
grade.op.mutate((draft) => { applyPatch(draft, [...ops].reverse().map((op) => op.undo)); }, { appliedOps: true }); // undo
```

`fast-json-patch` is one 6902 tool and the one opshot's own tests apply ops with. It is your choice and your install: `valtio` is opshot's only runtime dependency, and opshot ships no apply surface, because a pair of 6902 operations needs none.

`appliedOps` is the caller's stamp, carried in the options bag like any other call-site intent. Nothing in the library reads it.

Any generation works as the target: `mutate` closes over the proxy and survives snapshotting, so a state captured before the ops were recorded replays them correctly.

A replay does not consume its ops. Each half hands out a fresh clone per read, so the applied region is live and independent while the record stays frozen and reusable, and `ref()` values inside it keep their identity.

## unwrap

`unwrap(state)` resolves the current generation and returns your own object from it, stripping exactly `op`. Data fields, getters, and domain methods pass through. Because it resolves the current generation itself, `unwrap` returns current values from any generation you pass it, including a module-level state held since creation.

```ts
import { unwrap } from "opshot";

group.subscribe((state) => {
  void save(JSON.stringify(unwrap(state)));
});
```

Serializers should run through `unwrap` so the library-attached `op` key never reaches storage.

`unwrap` returns the same deep-readonly view a state exposes. Assigning a field fails to compile, but the result's nested objects are shared with the underlying snapshot, so a write that reaches past the type (`unwrap(state).items.push(x)`) corrupts it exactly as `state.items.push(x)` would.

## resnapshot

```tsx
import { resnapshot } from "opshot/react";
import type { State } from "opshot";

const CounterView = resnapshot<{ counter: State<Counter> }>(({ counter }) => (
  <button onClick={counter.increment}>{counter.count}</button>
));
```

The HOC finds states anywhere in props, substitutes the current generation for each behind a `React.memo` boundary, and re-renders when the underlying state changes. A stale state in props renders fresh, so callers never need to hold a current one. States nested inside a plain context object are found:

```tsx
const Panel = resnapshot<{ context: { counter: State<Counter> } }>(({ context }) => (
  <CounterView counter={context.counter} />
));
```

Prop traversal descends plain objects and arrays only. Class instances (an event emitter, a query client, an IPC surface) and the `children` key are skipped and arrive untouched.

**Wrap upward, not downward.** Each wrapped component pays a prop-tree walk per render and buys a memo boundary for its subtree. That trade is worth nothing at a leaf receiving primitives, which re-renders only when its inputs change anyway. Wrap where a subtree reads state; leave leaves plain.

Because the memo boundary short-circuits on prop identity, parents should `useMemo` context objects on stable inputs so unrelated re-renders do not invalidate wrapped subtrees.

## Factory hooks

`createState` and `createGroup` are plain factories, so a component that calls one in render mints a fresh instance every render. `opshot/react` ships `useCreateState` and `useCreateGroup`, each memoizing creation for the component's lifetime.

```tsx
import { useCreateGroup, useCreateState } from "opshot/react";

const Counter: FC = () => {
  const counter = useCreateState<Counter>((mutate) => ({
    count: 0,
    increment: () => mutate((draft) => (draft.count += 1)),
  }));

  return <button onClick={counter.increment}>{counter.count}</button>;
};
```

`useCreateState(define, group?)` takes the same `define` as `createState` (a plain object or a callback) with an optional `group` as its last argument; passing one mints the state through the group so its ops reach `group.subscribe`. `useCreateGroup()` returns a lifetime-stable group.

The plain `createState` and `createGroup` factories stay for loaders, module scope, and tests, where a hook cannot run.

## History extension

History is a subscriber. It records ops, skips its own replays, and undoes by replaying them reversed.

```ts
import { applyPatch } from "fast-json-patch";
import { type Group, type Op, type State } from "opshot";

interface HistoryEntry {
  state: State<object>;
  ops: Array<Op>;
}

interface History {
  stack: Array<HistoryEntry>;
  index: number;
  undo: () => void;
  redo: () => void;
}

export function createHistory(group: Group): History {
  const stack = new Array<HistoryEntry>();

  const history: History = {
    stack,
    index: -1,
    undo: () => {
      const entry = stack[history.index];

      if (!entry) return;

      entry.state.op.mutate((draft) => {
        applyPatch(draft, [...entry.ops].reverse().map((op) => op.undo));
      }, { appliedOps: true });

      history.index -= 1;
    },
    redo: () => {
      const entry = stack[history.index + 1];

      if (!entry) return;

      entry.state.op.mutate((draft) => {
        applyPatch(draft, entry.ops.map((op) => op.do));
      }, { appliedOps: true });

      history.index += 1;
    },
  };

  group.subscribe((state, ops, options) => {
    if (options.appliedOps === true) return;

    stack.length = history.index + 1;
    stack.push({ state, ops });
    history.index = stack.length - 1;
  });

  return history;
}
```

Each emission is one undo entry, `undo` and `redo` walk the stack, and a replay is skipped by its `appliedOps` stamp. `transactionKey` rides along on the options, so a consumer who wants a continuous gesture (a slider drag emitting one mutate per frame) to collapse into one undo entry coalesces those emissions themselves, against their own document shape. That coalescing is theirs; opshot forwards the key and coalesces nothing.

### `appliedOps` is a skip for one subscriber and a signal for another

The recorder must skip its own replays or undo corrupts the stack. Persistence must observe them, because an undo is a change worth saving. Same emission, opposite policies, which is why emission is never gated:

```ts
const history = createHistory(group);

// Fires for organic writes and for replays alike.
grade.op.subscribe((_state, ops, options) => {
  console.log(options.appliedOps === true ? "replay" : "organic", ops.length);
});
```

Across an organic mutate, then undo, then redo, that subscriber logs `organic 1`, `replay 1`, `replay 1` while the history stack stays at one entry.

### Topology is the opt-out

What gets recorded is decided by what history subscribes to. Non-undoable state (a selection, a hover target) is a standalone `createState`, never a flagged write on a recorded state. Hydration is ordering: populate the state, then attach the recorder.

## Footguns

**A state's readonly type is enforced at compile time, not by freezing.** `State<T>` and `unwrap`'s return are both `Snapshot<T>`: assigning a field, pushing into an array, and deleting a key all fail to compile.

```ts
state.count = 9        // TS2540: Cannot assign to 'count' because it is a read-only property
state.items.push(x)    // TS2339: Property 'push' does not exist on type 'readonly ...[]'
delete state.optional  // TS2704: The operand of a 'delete' operator cannot be a read-only property
```

Cast the type away and the underlying gap reappears: assigning an existing key still throws at runtime (valtio rejects it), but `push`, `delete`, and adding a new key succeed silently and corrupt the cached snapshot in place, which the cache then keeps handing back. Op values are the exception, from the other side: the diff deep-freezes the original each half closes over, and every read of `value` hands out a fresh clone, so a stray `push` into an undo baseline lands on a throwaway and the record stands.

**Never assign a snapshot into a `mutate` draft.** `draft.doc = someSnapshot` produces a region whose later writes are silently dropped. Clone it first: `structuredClone(value)` for a plain data subtree, or `unwrap` plus a JSON round-trip when the value carries domain methods (`structuredClone` throws on those; see below). Applying an op is already safe, because its `value` is a clone; a snapshot you hold yourself is not.

**An op that has lost its getter is single-use.** `{ ...op.do }` and `JSON.parse(JSON.stringify(op))` both read `value` once and store the result, so the copy carries one value for every application. The first application donates it into the draft, where it becomes live state, and the second replays whatever the document did to it in between. Apply the op object, never a copy of it.

**Derived getters appear in the op stream.** A `get doubled()` emits a `replace` op beside the `count` op that drove it. Replaying one is a harmless no-op, since the getter recomputes off the restored source field. A consumer serializing ops should ignore paths it knows are derived.

**A subscriber must not write to the state it subscribes to.** Its nested emission reaches the per-state listeners registered after it ahead of the ops that caused it, inverting a recorder's stack. A group listener holds the forwarder's first position and hears the causing ops first, so a group-tier recorder stands clear of this. Writing to a *different* state from a subscriber is fine.

**`structuredClone` throws on a state.** It is the reflex for "get a plain copy" and it fails with `DataCloneError`, naming whatever the walk hits first rather than the state. Use `unwrap` plus a JSON round-trip.

**A reused `define` literal shares its nested objects.** `createState` copies the literal's own descriptors onto a base it proxies, never the literal itself, so passing the same literal twice yields states with independent top-level fields (no `Cannot redefine property`, separate scalars). The copy is one level deep, though: nested objects are the same reference across both states and the literal, so a mutation of a nested field on one reaches the others. Hand `createState` a literal you do not retain; an inline literal is fully safe.

## Valtio

Valtio is pinned exact. opshot depends on behaviors valtio does not document as contract: snapshot structural sharing and caching, `ref()` and function fields surviving snapshots, getter preservation, snapshot property descriptors staying configurable, and userland subscription batching. Each is pinned by a probe test, so a valtio upgrade that breaks one fails loudly rather than corrupting the op stream. Do not override the pin.
