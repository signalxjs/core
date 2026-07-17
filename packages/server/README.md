# @sigx/server

Server functions (RPC) for SignalX — typed client↔server calls, extracted at
build time by `@sigx/vite/server`. The design RFC is
[`docs/rfc-server.md`](../../docs/rfc-server.md).

Not to be confused with `@sigx/server-renderer`, which renders documents —
this package is how your app **talks to** the server.

## The model

A server function lives in a `*.server.ts` module. The whole module is
server-only: it can import database clients, secrets, `node:` builtins —
none of it ships. The client build swaps the module for typed fetch stubs;
on the server the import is the real module, so a call is a direct
invocation. Same import, both sides, types flow through untouched.

```ts
// src/cart.server.ts
import { serverFn, ServerFnError } from '@sigx/server';
import { db } from './db';
import { sessionFrom } from './auth';

export const addToCart = serverFn(async (rq, productId: string, qty: number) => {
    const user = await sessionFrom(rq.request);
    if (!user) throw new ServerFnError(401, 'sign in first');
    return db.cart.add(user.id, productId, qty);
});
```

```tsx
// any component — it's just an async function
import { useData, useAction } from 'sigx';
import { getCart, addToCart } from './cart.server';

const cart = useData(() => ['cart'], getCart, { cache: { staleTime: 30_000 } });
const add  = useAction(addToCart,   { cache: { invalidates: [['cart']] } });
```

Because a wrapped function is a plain async function, `useData`/`useAction`
and the whole `@sigx/cache` pack (staleTime, `invalidate()`, optimistic
`mutate`) compose with zero integration code. And a resumed handler
(`@sigx/resume`) that imports a server function works as-is — the handler
chunk gets the stub, the page still ships ~1 KB of JS, and the first click
POSTs to the server.

### Inline form (co-location)

For one-offs where a separate file is ceremony, declare a `serverFn` at
**module scope** of any component file — the transform lifts it the same
way:

```tsx
// Search.tsx — co-located
import { component, useData } from 'sigx';
import { serverFn } from '@sigx/server';
import { searchIndex } from './search-index';   // server-only dep

const search = serverFn(async (rq, q: string) => searchIndex.query(q));

export const Search = component((ctx) => {
    const q = ctx.signal('');
    const results = useData(() => ['search', q.value], () => search(q.value));
    /* … */
});
```

The client build swaps the initializer for the fetch stub and strips
imports that were only used inside the body (`searchIndex` never loads in
the browser); the server keeps the body in place. One strict rule makes
this safe: an inline body may capture **imports and globals only** —
touching component scope, signals, props, or file-local bindings is a
compile-time error telling you to pass the value as an argument. Two
placement rules follow from it: `serverFn` must be a module-scope `const`
(never created inside a component), and resume files should keep importing
from `*.server.ts` modules instead (a module-scope const is not a legal
capture for extracted QRL handlers).

There is **no closure serialization** — data crosses the boundary only as
typed arguments (I consider Qwik's captured-value round-trip an injection
surface, not a convenience). Validate them: the options form takes a
[Standard Schema](https://standardschema.dev) validator that always runs
server-side, plus a per-function middleware chain no transport can skip:

```ts
export const quote = serverFn({
    input: QuoteInput,            // Zod/Valibot/ArkType — rejects with a 400
    use: [requireAuth],           // runs on EVERY transport
    async handler(rq, input) {
        return priceQuote(rq.locals.user, input);
    }
});
```

## Context

Every server function receives the request context as its **first
parameter** — no `this`, no ambient globals:

```ts
serverFn(async (rq, ...args) => {
    rq.request;          // WinterCG Request (headers, cookies via headers)
    rq.url;              // parsed URL
    rq.abortSignal;      // fires on client disconnect (never a reactive signal)
    rq.responseHeaders;  // mutable response headers
    rq.status(201);      // success status override
    rq.locals;           // guard hand-off (auth results)
});
```

In-process calls (during SSR) run the same pipeline against a detached
context — no network hop; `rq.request` throws a descriptive error there
(ambient request context is the designed v1.1 follow-up).

## The endpoint

`POST /_sigx/fn/<symbol>` with `{"args": [...]}` → `{"data": ...}` or
`{"error": {message, status, data?}}`. Symbols are content-hashed, so a
stale client gets a typed version-skew error, never a silent wrong call.

Dev needs no wiring — the `sigxServer()` Vite plugin serves the endpoint
from `vite.middlewares`. Production mounts the handler beside the document
handler, fed by the build's registry chunk:

```js
import { createServerFnHandler } from '@sigx/server/node';

const { serverFns } = await import('./dist/server/sigx-server-fns.js');
app.use(createServerFnHandler({ functions: serverFns, guard: requireSession }));
app.use(createRequestHandler({ /* documents, unchanged */ }));
```

On WinterCG runtimes (Cloudflare, Deno, Bun) skip the adapter —
`handleServerFnRequest(request, options)` from `@sigx/server/server` is
already fetch-handler-shaped. Route with its sibling predicate:

```js
if (matchesServerFn(request)) return handleServerFnRequest(request, opts);
return renderDocument(request);   // your document handler
```

(`matchesServerFn(request, base?)` matches the pathname under the mount
path — deliberately a predicate, not a combinator; composition stays in
your entry.)

## Native clients — transport config

A lynx or terminal app calling a remote sigx server — or a bearer-auth web
SPA — configures its stubs' transport once at startup (rfc-server rev 2):

```ts
import { configureServerFn } from '@sigx/server/client';

configureServerFn({
    endpoint: 'https://api.example.com/_sigx/fn',
    headers: () => ({ authorization: `Bearer ${token()}` })
});
```

Stubs resolve the transport at **call time**: one build serves
dev/staging/prod, header factories (sync or async) can rotate credentials,
and a custom `fetch` slots in where the platform provides its own.
`content-type` always merges last — the endpoint accepts nothing but JSON.
`configureServerFn(null)` restores the build-time target; with no config,
requests are byte-identical to v1.

Native clients authenticate with token headers (CSRF-immune by
construction) and never send `Origin` — serve them with
`origin: 'verify-when-present'` (below).

Server bodies must never execute in a live client: `declareLiveClient()`
(the platform-identity call lynx/terminal make) stamps a global marker,
and the real `serverFn` wrapper **throws** if invoked there — a build that
skipped the stub swap fails loudly, matching the browser condition's
posture.

A native-client build declares itself in the Vite plugin:
`sigxServer({ role: 'client', endpoint: 'https://api.example.com/_sigx/fn' })`
— every environment gets stubs and no registry is emitted (there is no
server in that build). Shared `*.server.ts` packages outside the app's
Vite root are discovered with `scan: ['../packages/api']`.

## Stable routes — backend deploys never break installed apps

Every function is registered under TWO symbols. The content-hashed one
(`addToCart_fn_9f3a01cc`) is what web builds fetch — version skew is a
typed 404 and a reload fixes it. The hash-free **stable symbol**
(`@acme/api/src/cart.server.ts#addToCart`) is what `role: 'client'` builds
fetch — an installed lynx app or terminal CLI cannot reload, so its routes
survive every backend redeploy. Symbol seeds are package-qualified, so
every app build of one solution mints identical symbols for a shared
server module.

Moving or renaming a server module changes its stable symbol — a breaking
API change for native clients, exactly like changing a REST route. Published
APIs pin an explicit id instead: `serverFn({ id: 'cart/add', handler })`
(string literal — the build reads it statically) keeps both routes stable
across file moves. Contract safety lives in the `input` validator (argument
changes surface as a 400 the client can show as "update the app"), and
semantic changes are explicit versioning — a new export or a new `id`.

Deploy note: stable symbols URL-encode into one path segment
(`%2F`-encoded slashes). A proxy or CDN that decodes or merges encoded
slashes will mangle them — hashed symbols are immune; configure the proxy
to pass encoded paths through untouched.

## Security defaults

Every server function is a public HTTP endpoint; the defaults assume that:

- **POST-only**, required `application/json` media type, and a same-origin
  `Origin` check (CSRF posture). `origin: 'verify-when-present'` verifies
  the header when present and admits header-less programmatic clients
  (native apps, CLIs, server-to-server) — browser CSRF stays independently
  blocked by the non-safelisted JSON content-type, and `Origin: null` is a
  present header and still rejected. Never deploy an Origin-stripping
  proxy in front of a cookie-authenticated app under that policy. An
  allowlist or `origin: false` makes it a deliberate public API.
- **`guard` hook** runs before every function, for every transport — the
  app-wide auth seam. Per-function `use` chains compose on top.
- **`maxBodyBytes`** (1 MiB default) enforced while reading.
- **Error masking**: only `ServerFnError` crosses the wire verbatim; other
  throws become a generic 500 in production.
- **Prototype-pollution keys dropped** from parsed values on both parse
  sites (a reviver removes `__proto__`/`constructor`/`prototype`; the
  request itself is not rejected).

## Entry points

| Entry | Runs on | What |
|---|---|---|
| `@sigx/server` | server (browser condition throws) | `serverFn`, `ServerFnError`, `isServerFnError`, types |
| `@sigx/server/client` | any client (browser, lynx, terminal) | the generated stubs' runtime + `configureServerFn` (dependency-free) |
| `@sigx/server/server` | anywhere (WinterCG) | `handleServerFnRequest(request, options)` |
| `@sigx/server/node` | Node | `createServerFnHandler(options)` — connect-style |

The runnable example is `examples/resume` (the "server function from a
resumed handler" card).
