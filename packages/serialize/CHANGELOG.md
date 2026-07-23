# Changelog

## [Unreleased]

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
