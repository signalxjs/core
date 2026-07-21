# The router SSR contract

Status: **specified — implemented in the router repo**. Part of Phase 3 of
`docs/rfc-ssr-platform.md` (§3.2, signalxjs/core#203; tracked by #171). Same
precedent as the `@sigx/store` adapter in `rfc-use-async.md`: **core specs
the contract, the router repo builds it against public seams.** Nothing in
this document requires — or grants — privileged access to
`@sigx/server-renderer`; a third-party router can satisfy the same contract
identically.

`examples/spa-ssr` implements every clause with a hand-rolled router and is
the reference for the shapes below.

## 1. The per-request provide

A router is **per-request state**. It is provided at app level, never held
in module scope:

```ts
// Shared token — the default factory throws on purpose:
export const useRouter = defineInjectable<Router>(() => {
    throw new Error('useRouter() called without a Router provided. …');
});

// Server (the entry factory, per request):
export function createApp(url: string) {
    const app = defineApp(<App />);
    app.defineProvide(useRouter, () => createRouter(parseUrl(url)));
    return app;
}

// Client (once, from the current location):
app.defineProvide(useRouter, () => createRouter(parseUrl(location.pathname)));
```

This is what makes concurrent SSR safe: each request's router lives on its
own app context; the per-request `SSRContext` carries everything else
(rfc-ssr-platform §2.3 — AsyncLocalStorage is never required).

**The entry contract.** The SSR entry module exports `createApp(url)` — the
per-request app factory both request handlers consume
(`createDevRequestHandler` from `@sigx/vite/ssr` in dev,
`createRequestHandler` from `@sigx/server-renderer/node` in production).

Two **optional** further arguments carry per-request context, identically in
dev and production:

```ts
export function createApp(url: string, req?: IncomingMessage, platform?: unknown) {
    const session = req && sessionFrom(req);   // cookies, headers, auth
    // …
}
```

- **`req`** — the incoming request. `IncomingMessage` under
  `createDevRequestHandler` and `createRequestHandler`; a WHATWG `Request`
  under `createFetchHandler`. This is how a factory reads a session cookie
  without reaching for AsyncLocalStorage.
- **`platform`** — opaque platform context (rfc-deploy §4.6), e.g.
  Cloudflare's `{ env, ctx }`.

A factory that declares only `(url)` is unaffected — extra arguments are
ignored. Dev used to drop `req` and pass `platform` second, so an app with
per-request auth rendered logged-out in dev while working in production
(#304); both handlers now agree.

## 2. Route resolution exposes chunk refs

Routes that render `lazy()` components declare their chunks, so the
integration — not user code — can warm and settle them:

```ts
interface RouteDefinition {
    path: string;
    /** Lazy chunks this route renders. */
    chunks?: () => Promise<unknown>[];
}
```

Two consumers:

- **Server, shell preloads:** the matched route's chunk refs (mapped through
  the client build manifest via `collectAssets` from `@sigx/vite/ssr`) feed
  `DocumentOptions.assets`, so `<link rel="modulepreload">` for the route's
  code ships in the first flush. Boundary chunks (islands) are preloaded
  automatically by `renderDocument`; route chunks are the router's
  contribution.
- **Client, pre-hydration settling (the F9 rule):** server-resolved `<Defer>`
  content must hydrate against the *real* component. The client entry awaits
  the matched route's chunks before `hydrate()`:

  ```ts
  await Promise.all(routeChunks(parseUrl(location.pathname)));
  app.use(ssrClientPlugin).hydrate('#app');
  ```

  Inside the router package this await lives **inside the contract** (the
  router's hydrate helper performs it) — it is never user code.

## 3. Route resolution feeds the response

Route matching carries HTTP intent, expressed through `useResponse()`
(rfc-ssr-platform §2.1) during the server render:

- a route **miss** sets `useResponse().status(404)` and renders the
  not-found view;
- a **guard** redirect calls `useResponse().redirect(target, status?)` —
  the document short-circuits (no body bytes) and the shell promise carries
  `{ redirect }` for the HTTP layer.

The seam is router-agnostic: any component may call `useResponse()`; the
router is simply the natural owner of the miss/guard decisions.

## 4. What the router repo implements

- `createRouter` / route table / matching (its own design space).
- The provide helper and the `createApp` wiring sugar.
- The client hydrate helper that performs §2's pre-hydration chunk settling.
- Guard → `useResponse` redirect plumbing; miss → 404 + not-found view.
- Exposure of the matched route's chunk refs in a shape `collectAssets`
  consumes.

What it must **not** do: reach into `@sigx/server-renderer` internals, own a
second state blob, or require its own plugin hook — the public seams above
are the whole surface.
