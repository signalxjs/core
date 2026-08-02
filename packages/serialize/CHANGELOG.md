# Changelog

## [Unreleased]

### Added

- **`@sigx/serialize/bytes` — an opt-in binary vocabulary (#569).** One
  handler, `bytesHandler` (tag `$bytes`), round-trips `Uint8Array`
  (including Node `Buffer`, which revives as a plain `Uint8Array`), every
  standard typed-array kind, `DataView`, and bare `ArrayBuffer` to their
  exact constructors, as base64 (`{"$bytes":"AQID"}` for `Uint8Array`, a
  `[kind, base64]` tuple for the rest). A view encodes its window, never
  the whole backing buffer; multi-byte kinds carry raw host-order bytes.
  Opt-in rather than built-in, deliberately: the root entry is 1 KB-budgeted
  with no ignore list possible and is bundled by `@sigx/server/client`'s
  dependency-free stubs, so a built-in `$bytes` would tax every client
  bundle — and would silently start admitting binary into the SSR state
  blob. Registering it (`serverPlugin({ types: [bytesHandler] })`, or
  `registerWireTypeHandlers` / `provideTypeHandlers` on a single seam)
  silences the #565 encode warning for exactly what it claims; the warning
  now also names the subpath as the remedy. `Blob`/`File` stay out of scope
  (the codec is synchronous), as do `SharedArrayBuffer` and `Float16Array` —
  those keep warning.

- **Dev warning for values the codec cannot carry (#565).** Class instances
  lose their prototype, typed arrays and `ArrayBuffer` encode as
  `{"0":…,"1":…}`, `Error` and `Promise` and `WeakMap` as `{}`, and
  `NaN`/`±Infinity` as `null`. Every one of those is a **lossy success** — the
  encode returns, the value looks like data, and nothing in the stack can
  notice. `encodeWithHandlers` now walks the value in `__DEV__` and reports the
  offending property paths in one warning (up to three, node-budgeted so a huge
  payload cannot stall a dev server), skipping anything a registered or
  built-in handler claims: it consults the same chain the encoder does, so it
  cannot scold an app that taught the codec its type.

  A separate dev walk rather than a path argument threaded through `encode`:
  `__DEV__` is stripped from the prod dist, so production pays nothing — no
  parameter, no branch, and the prod bundle provably contains none of it.
  Circular structures are deliberately NOT reported, despite a path being
  useful: they already throw, and callers that encode speculatively to test
  admissibility (`admitPayloadEntry`) catch that throw and report their own
  message — warning here would double-report the one failure that was never
  silent.

### Fixed

- **Revive no longer turns a surviving `__proto__` key into a prototype
  swap (#548).** `out[key] = value` with the key `__proto__` does not
  create an own property — it sets the prototype of the object being
  rebuilt, invisibly (gone from `Object.keys`, `JSON.stringify`, and a
  `toEqual` assertion; `Object.getPrototypeOf` is the only witness). Every
  in-repo caller pre-filtered the key so this was never exploitable, but
  the safety lived entirely one layer up, one forgotten pre-filter from a
  hole — and the codec is the one place that sees every boundary (the SSR
  state blob, resume boundary props, the cache seed, the RPC wire). Revive
  now skips an own `__proto__` key at both of its object rebuilds, with a
  dev warning naming the drop.

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
