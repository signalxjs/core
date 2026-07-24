# @sigx/ssr-islands

Islands architecture for SignalX SSR. Renders pages on the server and selectively hydrates only the components that need interactivity, controlled by `client:*` directives. Everything outside an island stays as static HTML — no JavaScript shipped, no hydration cost.

## 📚 Documentation

Full guides, API reference and live examples → **<https://sigx.dev/server/>**

## A taste

```bash
npm install @sigx/ssr-islands sigx vite
```

```tsx
<Counter client:load />         {/* hydrate immediately */}
<Counter client:idle />         {/* hydrate when the browser is idle */}
<Counter client:visible />      {/* hydrate when it scrolls into view */}
<Counter client:interaction />  {/* hydrate on first pointer/key/touch/focus */}
<Counter client:only />         {/* skip SSR — mount fresh on the client only */}
```

The `client:*` props type-check with no setup import. The augmentation is
program-wide: importing anything from `@sigx/ssr-islands` (server) or
`@sigx/ssr-islands/client` (client) — which your entry files already do —
registers the directives on every JSX component across the whole program, the
same way core's `use:*` directives light up (see `@sigx/runtime-dom`'s README
§"The augmentation is program-wide"). There is no `/jsx` import to add.

```tsx
// Server — the pack installs on the per-request app (#413: app.use is the
// one install shape); the manifest arrives via virtual:sigx-manifests.
import { defineApp } from 'sigx';
import { islandsPlugin } from '@sigx/ssr-islands';
import { islandsManifest } from 'virtual:sigx-manifests';

export function createApp(url: string) {
    return defineApp(<App />).use(islandsPlugin({ manifest: islandsManifest }));
}
```

```ts
// Client entry (app-less islands page) — one call is the whole bootstrap
import { hydrateIslands } from '@sigx/ssr-islands/client';

hydrateIslands();
```

The eager cost of that entry is only the boundary *scheduler* (~2 kB, no
sigx runtime): the hydration core and the islands state-restoration hooks
load together in one lazily-imported chunk, on the first `client:*`
strategy that actually fires. A page whose islands are all
`idle`/`visible`/`interaction`/`media` executes **zero** framework JS at
load — the chunk is still `modulepreload`ed (via the islands manifest), so
the first interaction pays no network round trip. Migrating from the old
two-call form? `registerClientPlugin(islandsPlugin()); hydrateIslands();`
still works, but importing `islandsPlugin` from the package root puts the
runtime back on the page's eager graph — drop it.

Pages that ship a root app declare islands mode with the plugin instead
(full runtime by definition — the app itself needs it):

```tsx
// Client entry — app-rooted islands mode
import { defineApp } from 'sigx';
import { ssrClientPlugin } from '@sigx/server-renderer/client';
import { islandsPlugin } from '@sigx/ssr-islands';

defineApp(<App />).use(ssrClientPlugin).use(islandsPlugin()).hydrate('#app');
```

Under the hood each directive maps onto an *SSR boundary* record in the
`__SIGX_BOUNDARIES__` table emitted by `@sigx/server-renderer` — this pack is
a drop-in equal of any third-party strategy pack, built only on the public
`resolveBoundary` seam and the core boundary hydrator.

## Island state

State an island builds up during the server render survives hydration
automatically — even when hydration fires minutes later:

```tsx
export const Counter = component((ctx) => {
    const count = ctx.signal(0);   // transfers: keyed "count" by the vite transform
    return () => <button onClick={() => count.value++}>{count.value}</button>;
});
```

The `sigxIslands()` Vite plugin keys each `const x = ctx.signal(…)`
declaration by its variable name; the server captures the signal's value under
that key in the island's boundary record and the client restores it when the
island hydrates. Keys are **per island instance** — every island calling its
signal `state` is fine, and two `<Counter>`s on one page each keep their own
count. The one rule: within a single component, give each transferred signal
its own variable name (duplicates keep the first and warn in dev).

Named = transferred. A signal the transform can't key — created outside a
plain declaration, or made with the bare `signal()` import from `'sigx'`
instead of `ctx.signal` — is ordinary local state: it starts fresh on the
client and ships nothing. Use that when restoring server state would be wrong
(a ticking clock, a "mounted yet?" flag).

Data you *fetch* doesn't need any of this: `useData(key, fetcher)` results
transfer through their own request-global key in `__SIGX_ASYNC__`, shared and
deduped across all components. Island state keys cover the rest — per-instance
state that isn't a fetch result.

See the [docs](https://sigx.dev/server/) for the Vite plugin setup and the full list of hydration strategies.

## Run the example

A runnable reference app lives in [`examples/ssr-islands/`](../../examples/ssr-islands) — one server-rendered page with an island per strategy, the `sigxIslands()` Vite plugin, and the dev/prod request handlers:

```bash
pnpm --filter @sigx/ssr-islands-example dev     # dev: Vite middleware + createDevRequestHandler
pnpm --filter @sigx/ssr-islands-example build   # client + server bundles, islands manifest
pnpm --filter @sigx/ssr-islands-example start   # prod: static assets + createRequestHandler
```

## License

MIT © Andreas Ekdahl
