# @sigx/cloudflare

Cloudflare Workers deployment adapter for [SignalX](https://github.com/signalxjs/core) —
the flagship platform adapter of the deployment RFC (`docs/rfc-deploy.md`).
A pack in the established sense: it rides `@sigx/vite`'s public `SigxAdapter`
seam with no privileged access. The runtime story is `createFetchHandler`
(WinterCG-clean, CI-enforced); everything here is **build glue**.

## Install

```sh
pnpm add -D @sigx/cloudflare
```

## Usage

```ts
// vite.config.cloudflare.ts
import { defineConfig } from 'vite';
import sigx from '@sigx/vite';
import { cloudflare } from '@sigx/cloudflare';

export default defineConfig({
    plugins: [sigx({ ssr: { entry: 'src/entry-server.tsx', adapter: cloudflare() } })]
});
```

`vite build --app` then produces a **fully bundled** workerd-conditioned
worker (`serverBuild: 'bundled'`, conditions `['workerd', 'worker']` — the
`node` condition is deliberately dropped; the render path is `node:`-free by
CI guarantee) plus the client assets. Deploy with `wrangler deploy` —
wrangler's own bundling is a pass-through for the prebundled output
(`no_bundle` is the escape hatch if it ever isn't).

## The platform entry — yours, scaffolded once

The first build scaffolds `src/entry.cloudflare.ts` **iff absent** and never
touches it again (the same posture as `wrangler.jsonc` below). It is the
`server.mjs` of the edge world — the composition order is your app's routing
policy and stays visible in your file:

```
static assets  →  server functions  →  document render
```

Static assets never reach the worker: wrangler's `assets` config serves
matching files before it runs. Using server functions (`sigxServer()`)?
Mount the endpoint before the document render — the scaffold carries the
three-line block as a comment:

```ts
if (matchesServerFn(request)) {
    return handleServerFnRequest(request, {
        resolve: (symbol) => serverFns[symbol]?.() ?? null
    });
}
return handler(request);
```

In a bundled build the `virtual:sigx-app` artifacts and the
`virtual:sigx-server-fns` registry **inline into the one worker file** — no
separate chunks, one module graph.

## wrangler.jsonc — written once, validated after

`generate()` writes a starter config iff absent (name from your
package.json, `main` → the built worker, `assets.directory` → the client
outDir, a pinned `compatibility_date`); when present it only warns on drift.
One default is load-bearing:

```jsonc
"assets": { "directory": "dist/client", "html_handling": "none" }
```

`html_handling: "none"` limits the asset router to exact file paths. The
client outDir contains `index.html` — the raw outlet template — and with the
default handling the router would serve it for `GET /` *before the worker
runs*. (`run_worker_first` routing is the wrangler ≥ 4.20 alternative.)
`nodejs_compat` is not required by sigx; it is a concern for your own
dependencies only.

## Dev — one loop, optional bindings

`vite dev` + `createDevRequestHandler` stays the dev loop; adapters change
builds, not dev. Apps that read Cloudflare bindings during render opt into
local proxies:

```ts
// vite config
sigx({ ssr: { entry, adapter: cloudflare({ devProxy: true }) } })
```

```js
// server.mjs (dev branch) — the composition stays visible
import { getDevPlatform } from '@sigx/cloudflare';

app.use(await createDevRequestHandler(vite, {
    entry: '/src/entry-server.tsx',
    platform: getDevPlatform(vite)   // { env, cf, ctx, caches } — wrangler's local sims
}));
```

`devProxy` boots wrangler's `getPlatformProxy()` (install `wrangler` as a
dev dependency) and disposes it with the dev server. For binding-heavy apps
that want dev inside real workerd, `@cloudflare/vite-plugin` is the
escalation path.

## Reference apps

`examples/resume` (full composition including the server-fn mount) and
`examples/storefront` (islands + resume) in the SignalX core repo each ship
a committed `entry.cloudflare.ts`, `vite.config.cloudflare.ts`, and
`wrangler.jsonc` — CI serves both from real workerd (Miniflare) and asserts
they behave identically to the Node servers.

## License

MIT
