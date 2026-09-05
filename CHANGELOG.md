# Changelog

Notable changes to opshot, from 0.6.0 on. The format follows Keep a Changelog, and a minor carries breaking changes while the package is pre-1.0.

## 0.6.0 - 2026-09-05

### Changed

- **Breaking:** `scope` and `useMutableState` import from `opshot/react`. The root entry imports nothing from React, so `createMutableState`, `subscribe`, and `batch` run without React installed, and React is an optional peer.
- **Breaking:** `Operation` is a union on `kind`: `add` carries `after`, `change` carries `before` and `after`, `delete` carries `before`. `before?` and `after?` are gone, so a `"before" in operation` test becomes `operation.kind !== "add"`.
- **Breaking:** `batch` refuses an async callback. The callback type is `() => void | undefined`, and a returned promise throws, since writes after an `await` would carry no meta. Use a block body for a write expression that returns a value.
- A component's value for a state or a field object keeps its identity across renders until a change lands at or beneath it (spec §6.4), so a dependency array naming one re-runs on change rather than on every render. `identify` remains for comparing across components.
- **Breaking:** Memoized children that read state use `scope(memo(Child))` to own their subscriptions. This keeps their reads tracked across parent renders that reuse an unchanged object and lets subscriptions end when the child unmounts.
- `Operation.node` is typed `Record<string, unknown>`, so a replay writes through it without a cast.

### Added

- `Operation<Meta>` and `subscribe<Meta>` type the meta a listener receives.
- `flush(state, ...states)` flushes several states in argument order.
- README sections for `createMutableState`, identity, emission order, meta identity in `batch`, per-operation meta filtering, reads inside `ignore`, and a two-way replay recipe.
- This changelog, shipped in the package, and a GitHub release per version.
