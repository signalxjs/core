# Changelog

## [Unreleased]

### Changed

- **Both halves refuse values nesting deeper than 256 levels (#559).**
  `encode` and `revive` are recursive where `JSON.parse`/`JSON.stringify`
  are not, and wire data is attacker-typable — ~1 MiB of `[[[[…` spells
  hundreds of thousands of levels and used to overflow the stack. Each half
  now throws a `TypeError` ("Value nests deeper than 256 levels") instead.
  A value that legitimately nests past 256 levels stops round-tripping —
  no in-repo payload comes within an order of magnitude (the deepest bench
  fixture is 12; boundary records nest single digits). The cap also turns a
  cyclic *live* value handed to `reviveWithHandlers` (possible in the mixed
  hydration blob, which revive walks idempotently) from an infinite
  recursion into that same clean throw.

- **Shared subtrees are encoded once (#559).** The cycle-detection set is
  now an in-progress/done memo: a plain object or array reachable through
  N paths (diamond/DAG) encodes once instead of once per path — two-way
  sharing N levels deep was 2^N work. Wire text is byte-for-byte unchanged
  (`JSON.stringify` re-expands the shared identity per reference, exactly
  as the re-walk produced), and cycles still throw. Two observable edges:
  `encodeWithHandlers`' RETURN VALUE now carries shared object identity
  where the input did (every in-repo consumer stringifies immediately), and
  handler `test`/`serialize` run once per unique plain-structure subtree
  rather than once per path. Handler-claimed values stay un-memoized —
  sharing routed through them is bounded by the depth cap instead.

### Performance

- **`encodeWithHandlers` skips the handler sweep for JSON-native scalars, and
  neither half allocates a merged handler array (#470).** `encode` ran every
  handler's `test()` against every node — including strings, numbers and
  booleans, which no built-in handler can own — so a payload with no rich
  types paid ~7 `instanceof`/`typeof` checks per leaf for nothing. It now
  returns a string/number/boolean/null immediately after consulting any
  *registered* handlers (which may own a scalar), skipping the built-in
  sweep. Separately, `encode`/`revive` take the custom and built-in handler
  lists directly instead of merging them into one array per top-level call.
  On a 1 000-row plain payload the encode walk is ~2.4x faster; same output,
  same handler-precedence semantics (registered still win). No API change.

### Added

- **Generic `TypeHandler<T = unknown, Encoded = unknown>` and
  `defineTypeHandler` (#435).** The handler interface is now generic over the
  handled type and its wire form; `defineTypeHandler` infers both from a
  type-guard `test` (`(v): v is Money => …`), so `serialize`/`revive` are
  typed without a single cast and their pairing is checked. Members stay
  method-declared on purpose — that is what lets a `TypeHandler<Date, number>`
  flow into every `readonly TypeHandler[]` chain — and bare `TypeHandler` is
  exactly the pre-generic shape, so existing handler objects compile
  unchanged. `reviveWithHandlers<T = unknown>` gained an assertion-only result
  type parameter. The built-in vocabulary now type-checks against its own
  interface (`satisfies`, per handler) instead of hand-casting.

- **Initial release** (#364). The boundary codec: `encodeWithHandlers` /
  `reviveWithHandlers` around a `TypeHandler` interface, plus a built-in
  vocabulary that works with zero configuration — `$date`, `$map`, `$set`,
  `$bigint`, `$url`, `$regexp`, `$undef`.

  The serialize half already existed inside `@sigx/runtime-core` as a
  registry seam; the **revive half did not exist anywhere**, so every consumer
  that read state back got raw undecoded JSON — a `Date` arrived as a string,
  a `Map` as `{}`, an explicit `undefined` vanished, and a `BigInt` threw. Both
  halves now live here, extracted so the four consumers that need them
  (`server-renderer`, `runtime-core`'s hydration restore, `resume`, `cache`)
  and the RPC layer (`@sigx/server`) share **one** implementation rather than
  runtime-core carrying a codec plus `@sigx/server` duplicating it.

  Zero dependencies, permanently: `@sigx/server/client` imports this package
  and is dependency-free by contract. The per-app handler registry
  (`provideTypeHandlers`) stays in `@sigx/runtime-core`, which needs its
  `createToken`.

  Registered handlers are consulted **before** the built-ins, so a pack can
  own a type they also cover. A user object whose sole key starts with `$` is
  escaped as `{ $esc: original }` and unwrapped without interpreting the inner
  key. An unrecognized tag passes through with a `__DEV__` warning rather than
  throwing, so the format needs no version field. Circular structures throw,
  matching `JSON.stringify`.
