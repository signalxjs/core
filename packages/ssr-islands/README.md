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

```tsx
// Client entry — islands mode is declared by using the plugin
import { defineApp } from 'sigx';
import { ssrClientPlugin } from '@sigx/server-renderer/client';
import { islandsPlugin } from '@sigx/ssr-islands';

defineApp(<App />).use(ssrClientPlugin).use(islandsPlugin()).hydrate('#app');
```

Under the hood each directive maps onto an *SSR boundary* record in the
`__SIGX_BOUNDARIES__` table emitted by `@sigx/server-renderer` — this pack is
a drop-in equal of any third-party strategy pack, built only on the public
`resolveBoundary` seam and the core boundary hydrator.

See the [docs](https://sigx.dev/server/) for the Vite plugin setup and the full list of hydration strategies.

## Run the example

A runnable reference app lives in [`example/`](./example) — one server-rendered page with an island per strategy, the `sigxIslands()` Vite plugin, and the dev/prod request handlers:

```bash
pnpm --filter @sigx/ssr-islands-example dev     # dev: Vite middleware + createDevRequestHandler
pnpm --filter @sigx/ssr-islands-example build   # client + server bundles, islands manifest
pnpm --filter @sigx/ssr-islands-example start   # prod: static assets + createRequestHandler
```

## License

MIT © Andreas Ekdahl
