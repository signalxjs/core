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

## 📚 Documentation

Streaming and string rendering, the plugin system, hydration, head management — full guides, the complete API reference and live examples → **<https://sigx.dev/server/>**

## License

[MIT](https://github.com/signalxjs/core/blob/main/LICENSE)
