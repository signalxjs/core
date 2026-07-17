# @sigx/server-renderer

Server-side rendering and client hydration for SignalX. Supports streaming and string-based rendering, a plugin-driven architecture, and head management.

The SSR platform's *boundary model* lives here: plugins decide a component's
`flush` (inline / stream / skip) and `hydrate` (load / idle / visible / media /
interaction / never) axes through the pre-setup `resolveBoundary` hook, core
records them in the per-request `__SIGX_BOUNDARIES__` table, and the built-in
boundary hydrator schedules each one client-side — selective hydration without
a framework switch. `@sigx/ssr-islands` is the first-party pack on these seams.

📚 **Full guides, API reference and live examples → <https://sigx.dev/server/>**

## Install

```bash
npm install @sigx/server-renderer
```

## A taste

```tsx
import { renderToStream } from '@sigx/server-renderer/server';
import App from './App';

// Streaming (recommended)
const stream = renderToStream(<App />);
```

```tsx
// Client hydration
import { defineApp } from 'sigx';
import { ssrClientPlugin } from '@sigx/server-renderer/client';
import App from './App';

defineApp(<App />).use(ssrClientPlugin).hydrate('#root');
```

## The request handler

Production servers are static assets plus one handler over the public
document API — crawlers get blocking documents, everyone else shell-first
streaming, with useResponse's status/headers/redirect written before the
first byte (the dev twin lives in `@sigx/vite/ssr`):

```ts
import { createRequestHandler } from '@sigx/server-renderer/node';

app.use(createRequestHandler({
    template,
    app: (url) => createApp(url),   // fresh app per request
    document: { assets }            // manifest preloads (collectAssets)
}));
```

### The fetch handler (edge runtimes)

`createFetchHandler` is the WinterCG sibling (rfc-deploy §2) — the same
dispatch decisions expressed as `(Request) => Promise<Response>`, the shape
Cloudflare Workers, Deno Deploy, Bun, Vercel Edge, and Netlify all consume
natively. It lives on the WinterCG-clean `./server` entry (and the root
`.`), so it runs wherever the render path runs:

```ts
import { createFetchHandler } from '@sigx/server-renderer/server';

const handler = createFetchHandler<{ env: Env; ctx: ExecutionContext }>({
    template,
    app: (url) => createApp(url),   // same frozen entry contract
    document: { assets }
});

export default {
    // static assets → server functions → document render: the composition
    // stays in YOUR entry — no sigx handler serves files or mounts the
    // server-fn endpoint for you.
    fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
        handler(request, { env, ctx })
};
```

The optional second argument is the platform context — opaque to sigx,
threaded verbatim into the `template`/`app`/`document` callbacks
(instantiate the generic for typed bindings). A redirect from `useResponse`
returns a bodyless `Response` and releases the render; cancelling the
`Response` body (client disconnect) does the same. A shell failure yields a
minimal 500 — there is no `next()` in the fetch world; a custom error page
is a `try/catch` wrapper around the returned handler.

Shared with the Node handler: `defaultIsBot` (the crawler regex behind the
bot → blocking dispatch) and `chunksToBytes` (the pull-based
string-chunks → UTF-8 `ReadableStream<Uint8Array>` encoder under both the
fetch handler and `renderDocumentToWebStream`) — both exported from
`./server` for hand-written servers.

## Runtime portability & request isolation

The `.` and `./server` entries are **WinterCG-clean** — no Node builtins on
the string / Web-stream / document paths, verified in CI by an edge smoke
test that forbids every `node:` import while streaming a document through
the production dist. Node-only Readable shapes (`renderToNodeStream`,
`renderDocumentToNodeStream`, the `toNodeStream` adapter) live in
`@sigx/server-renderer/node`.

Request isolation is a contract, not a runtime feature: **the per-request
`SSRContext` is the isolation mechanism — AsyncLocalStorage is never
required.** Everything a request collects (head configs, response state,
async results, the boundary table) lives on its own context, created per
render call; concurrent renders share nothing. AsyncLocalStorage remains
only a best-effort backstop for user code reading `getCurrentInstance()`
after an `await` inside setup, which is dev-warned.

## The eager scheduler vs the lazy hydration core

Client-side selective hydration is split in two, so deferred pages execute
zero runtime JS at load:

- **`@sigx/server-renderer/client/scheduler`** — the eager half: reads the
  boundary table, wires `load`/`idle`/`visible`/`media`/`interaction`
  triggers, listens for streamed boundaries. It imports nothing from the
  sigx family (~2 kB, size-limit-guarded).
- **The hydration core** — the executor (`hydrateComponent`, the renderer,
  mount/hydrate primitives) lives in a separate chunk that
  `loadHydrationCore()` dynamically imports on the first strategy that
  actually fires. The component chunk and the executor fetch in parallel.

`registerClientPlugin` (part of the scheduler surface) accepts either a
plugin object or a lazy source — `{ name, load: () => import('...') }` —
resolved together with the hydration core, so a pack's client hooks ride the
same lazily-fetched chunk as the renderer. Registrations dedupe by `name`,
first-wins. Packs that hydrate through their own wake-up (rather than the
boundary scheduler) should register plugin objects, or await
`resolveClientPlugins()` before hydrating.

Server plugins can contribute `<link rel="modulepreload">` URLs to the
document shell via the optional `assets(ctx)` hook — the intended pairing is
to preload the lazily-imported runtime chunk whenever the request recorded
schedulable boundaries, keeping the fetch off the critical path while
execution still waits for the first trigger.

The `./client` barrel re-exports the full surface (scheduler + executor +
`ssrClientPlugin`) for app-rooted hydration, where the runtime is loaded by
definition.

## 📚 Documentation

Streaming and string rendering, the plugin system, hydration, head management — full guides, the complete API reference and live examples → **<https://sigx.dev/server/>**

## License

[MIT](https://github.com/signalxjs/core/blob/main/LICENSE)
