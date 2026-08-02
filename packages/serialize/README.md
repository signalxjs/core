# @sigx/serialize

The boundary codec for [SignalX](https://sigx.dev/) — how values JSON cannot
represent survive every boundary sigx moves data across.

You will rarely import this directly. It is what makes this work:

```ts
// src/orders.server.ts
export const getOrder = serverFn(async (rq, id: string) => ({
    id,
    createdAt: new Date(),          // arrives on the client as a Date
    tags: new Set(['priority']),    // arrives as a Set
    total: 1999n,                   // arrives as a BigInt
}));
```

…and the same for SSR state, resume boundary props, and the cache seed.

## Why it is its own package

Both halves run on **both sides**:

| | encode | revive |
|---|---|---|
| **server** | SSR state blob, RPC response, stream chunks | RPC arguments |
| **client** | RPC arguments | RPC result, SSR restore, resume props, cache seed |

That rules out every other home. It cannot live in `@sigx/server` — three of
its consumers (`server-renderer`, `resume`, `cache`) must never depend on the
RPC layer. It cannot live in `@sigx/server-renderer` — the revive half runs in
the browser, often with no renderer present. And a codec is not the component
model, so it does not belong in `@sigx/runtime-core`.

**Zero dependencies, permanently.** `@sigx/server/client` — the fetch stubs
the server-fn transform emits imports of — is dependency-free by contract, and
imports this package directly. Anything added here lands in a size-limited
entry that `@sigx/resume` handler chunks replicate.

## What round-trips

| Type | |
|---|---|
| `Date`, `Map`, `Set`, `BigInt`, `URL`, `RegExp` | ✅ |
| explicit `undefined` property or array slot | ✅ preserved, not dropped |
| plain objects, arrays, primitives | ✅ unchanged |
| `Uint8Array` / typed arrays / `ArrayBuffer` / `DataView` | opt-in via [`@sigx/serialize/bytes`](#binary-opt-in) — otherwise a dev-warned lossy plain object of indices |
| class instances | prototype lost unless you register a handler |
| circular structures | ❌ throws, same as `JSON.stringify` |
| nesting beyond 256 levels | ❌ throws, on encode AND revive — the codec is recursive where `JSON.parse`/`stringify` are not, so it bounds its own stack; wire data is attacker-typable (#559) |
| a property named `__proto__` | ❌ dropped at revive with a dev warning — rebuilding it by assignment would swap the revived object's prototype instead of creating a property (#548); `constructor`/`prototype` are plain data keys and round-trip |
| shared references (DAG) | ✅ as copies — each reference serializes independently, exactly like `JSON.stringify`; encode-phase work is memoized so a heavily shared tree costs linear time (#559) |

## API

```ts
import { encodeWithHandlers, reviveWithHandlers } from '@sigx/serialize';

const wire = JSON.stringify(encodeWithHandlers(value));
const back = reviveWithHandlers(JSON.parse(wire));
```

`reviveWithHandlers` is **not** a general-purpose deep copy — apply it only to
trees `encodeWithHandlers` produced. By design it reads any single-key
`$`-prefixed object as a tag, so foreign JSON containing `{"$date": 1}` would
come back a `Date`. Encoded trees are safe precisely because the encoder
escapes those shapes.

### Custom types

Author a handler with `defineTypeHandler` — declare `test` as a type guard
and `serialize`/`revive` infer their parameter types and pairing from it, no
casts:

```ts
import { defineTypeHandler } from '@sigx/serialize';

const money = defineTypeHandler({
    name: 'money', tag: '$money',
    test: (v): v is Money => v instanceof Money,
    serialize: (m) => m.cents,           // m: Money
    revive: (cents) => new Money(cents), // cents: number — serialize's output
});
```

(`TypeHandler<T, Encoded>` is generic; a plain object literal still works —
bare `TypeHandler` is exactly the pre-generic `unknown`-based shape. One
inference caveat: a compound test like
`(v) => typeof URL !== 'undefined' && v instanceof URL` infers `boolean`,
not a predicate — annotate it `(v): v is URL =>` explicitly.)

Inside a sigx app, register through the per-app registry from
`sigx/internals` (it is consulted **before** the built-ins, so a pack can
own a type they also cover):

```ts
import { provideTypeHandlers } from 'sigx/internals';

export const moneyPack = {
    install(app) {
        provideTypeHandlers(app._context, [money]);
    },
};
```

Apps using server functions should register through
`serverPlugin({ types })` from `@sigx/server/plugin` instead — ONE
registration covers both the per-app registry above AND the server-function
wire (#411). The wire's underlying seam is
`globalThis.__SIGX_SERVERFN_CODEC__` — the same global-seam pattern `$cache`
uses, which is what keeps the stub entry dependency-free; app-less contexts
can stamp it via `registerWireTypeHandlers` (or directly).

### Binary (opt-in)

Binary is not built in — this entry is 1 KB-budgeted and bundled by the
dependency-free fetch stubs, so a `$bytes` handler in the core vocabulary
would tax every client bundle and silently start admitting binary into the
SSR state blob. It ships as its own subpath instead; not registering it
costs zero bytes:

```ts
import { bytesHandler } from '@sigx/serialize/bytes';

// App/client side — the RPC wire AND the state/boundary registry, at once:
app.use(serverPlugin({ transport, types: [bytesHandler] }));

// Endpoint-only process (no app) — the RPC wire alone:
registerWireTypeHandlers([bytesHandler]);   // from '@sigx/server/plugin'

// SSR blob / boundary props without the server plugin:
provideTypeHandlers(app._context, [bytesHandler]);
```

`Uint8Array` (including Node `Buffer`, which revives as a plain
`Uint8Array`), every standard typed-array kind, `DataView`, and bare
`ArrayBuffer` round-trip to their exact constructor. The wire form is
base64 under one tag — `{"$bytes":"AQID"}` for `Uint8Array`,
`{"$bytes":["Int32Array","…"]}` for everything else — roughly 33 % over
raw; multi-megabyte payloads are better served as real file responses than
through an RPC envelope. A view encodes its window (`byteOffset`/
`byteLength`), never the whole backing buffer, and multi-byte kinds carry
raw host-order bytes (the `structuredClone` trade). Out of scope: `Blob`/
`File` (the codec is synchronous; they arrive inbound via `form: true` but
cannot go outbound), `SharedArrayBuffer`, and `Float16Array` — those keep
the dev warning, honestly. Registering the handler silences the encode
warning for exactly what it claims (#565/#569).

## Wire format

Encoded values take the single-key form `{ [tag]: payload }`:

```json
{ "createdAt": { "$date": 1700000000000 }, "tags": { "$set": ["priority"] } }
```

Two rules make the vocabulary safe to grow:

- A user object whose sole key starts with `$` is emitted as
  `{ "$esc": original }` and unwrapped on revive **without** interpreting the
  inner key — otherwise `{ "$date": "a string" }` would come back a `Date`.
- An unrecognized tag is left in its encoded shape rather than throwing, so a
  peer on a newer vocabulary degrades instead of breaking. That is why the
  format carries **no version field**.

## License

MIT
