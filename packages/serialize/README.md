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
| class instances | prototype lost unless you register a handler |
| circular structures | ❌ throws, same as `JSON.stringify` |

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

Register a handler for your own classes. Inside a sigx app, use the per-app
registry from `sigx/internals` (it is consulted **before** the built-ins, so a
pack can own a type they also cover):

```ts
import { provideTypeHandlers } from 'sigx/internals';

const money = {
    name: 'money', tag: '$money',
    test: (v) => v instanceof Money,
    serialize: (v) => v.cents,
    revive: (c) => new Money(c),
};

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
