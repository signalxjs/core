# SPA-SSR

A server-rendered SignalX app using Express and `@sigx/server-renderer`, with history-API routing, client hydration, and per-request DI scoping.

```bash
pnpm install
pnpm build           # builds the workspace packages
pnpm --filter @sigx/spa-ssr-example dev
```

Open http://localhost:3000.

## Verify SSR is real

```bash
curl http://localhost:3000/
curl http://localhost:3000/counter
curl http://localhost:3000/forms
```

Each response contains the rendered markup for that page — `<h1>`, the form fields with default values, the counter at zero. There's no `<div id="app"></div>` shell waiting for JS to fill it. After the page loads, navigating between routes uses `history.pushState` (no full reload); a hard refresh round-trips through the server again.

## Production build

```bash
pnpm --filter @sigx/spa-ssr-example build
pnpm --filter @sigx/spa-ssr-example start
```

Builds two bundles — `dist/client/` (browser) and `dist/server/entry-server.js` (Node) — and serves them.

## Concurrent-SSR safety

The router lives behind a `defineInjectable` token (`useRouter`). Each request creates a fresh `defineApp(<App />)` and calls `app.defineProvide(useRouter, () => createRouter(parseUrl(url)))` — so every request gets its own router signal scoped to its own app context. Two requests for different URLs can't interleave their state, even though `entry-server.tsx` runs in a single Node process.

This is the same pattern the official `@sigx/router` package uses (separate repo, more features); the example reduces it to ~30 lines.

## What's in here

| File | Role |
|---|---|
| `server.ts` | Express app. Dev mode pipes through Vite SSR middleware; prod mode serves prebuilt assets. |
| `src/entry-server.tsx` | `render(url)` — fresh `defineApp` per request, provides a per-request router, then `renderToString(app)`. |
| `src/entry-client.tsx` | One `defineApp`, provides a router built from `location.pathname`, `.use(ssrClientPlugin).hydrate('#app')`. |
| `src/router.ts` | `createRouter(initialPath)` factory + `useRouter` injectable token. No module-level state. |
| `src/App.tsx`, `src/pages/*.tsx` | Home, Counter, Forms, About. Forms shows model bindings + props/events + `Define.Model`. |
