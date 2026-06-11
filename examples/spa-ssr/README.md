# SPA-SSR

The reference SSR integration for SignalX: an Express server using the
document-streaming engine (`renderDocumentToNodeStream`), automatic state
serialization, `useHead` titles, Suspense + lazy chunks, AI token streaming
(`ssr.stream`), and a crawler/AI-agent blocking mode — with history-API
routing, client hydration, and per-request DI scoping.

```bash
pnpm install
pnpm build           # builds the workspace packages
pnpm --filter @sigx/spa-ssr-example dev
```

Open http://localhost:3000.

## What each route demonstrates

| Route | Shows |
|---|---|
| `/` | `ssr.load()` data fetched on the server, serialized into `window.__SIGX_STATE__`, restored during hydration — the browser never refetches (watch the server log / network tab). |
| `/counter` | Hydration is real — the button works because handlers attach to the server-rendered DOM. |
| `/forms` | Model bindings, props/events, custom `Define.Model`. |
| `/ai` | **AI token streaming**: `ssr.stream()` pushes fake-LLM tokens into the initial HTTP response word by word (server streaming, not client JS), then swaps in the final markup. Swap the generator for a real model SDK call. |
| `/about` | `<Suspense>` + `lazy()` section: fallback flushes with the shell, the code-split content streams in and replaces it. `entry-client.tsx` preloads the chunk before hydrating. |

## Verify SSR is real

```bash
curl http://localhost:3000/            # full markup + state blob + injected <title>
curl -N http://localhost:3000/ai      # watch tokens arrive over ~3s in one response
```

## Bot / AI-agent mode

Crawlers get the blocking document — complete content inline, zero
placeholders, zero `$SIGX_*` scripts:

```bash
curl -H "User-Agent: GPTBot" http://localhost:3000/ai
```

The server picks the mode per user-agent (`BOT_UA` in `server.ts`) and calls
`renderDocument(app, { template, mode: 'blocking' })` instead of streaming.

## Status codes with streaming

`renderDocumentToNodeStream` returns `{ stream, shell }`. The `shell` promise
settles before any byte is produced, so `server.ts` awaits it to decide
between `200` + pipe and a proper `500` page — no committed-headers problem.

## Production build

```bash
pnpm --filter @sigx/spa-ssr-example build
pnpm --filter @sigx/spa-ssr-example start
```

Builds two bundles — `dist/client/` (browser) and `dist/server/entry-server.js` (Node) — and serves them.

## Concurrent-SSR safety

The router lives behind a `defineInjectable` token (`useRouter`). Each request creates a fresh `defineApp(<App />)` and calls `app.defineProvide(useRouter, () => createRouter(parseUrl(url)))` — so every request gets its own router signal scoped to its own app context. Two requests for different URLs can't interleave their state, even though `entry-server.tsx` runs in a single Node process. Head tags are likewise collected per-request on the render context.

This is the same pattern the official `@sigx/router` package uses (separate repo, more features); the example reduces it to ~30 lines.

## What's in here

| File | Role |
|---|---|
| `server.ts` | Express app. Dev mode pipes through Vite SSR middleware; prod mode serves prebuilt assets. UA-based bot mode, shell-promise status codes. |
| `src/entry-server.tsx` | `render(url, template, { bot })` — fresh `defineApp` per request, per-request router, then `renderDocumentToNodeStream` (or blocking `renderDocument` for bots). |
| `src/entry-client.tsx` | One `defineApp`, per-page router, preloads route-relevant lazy chunks, `.use(ssrClientPlugin).hydrate('#app')`. |
| `src/router.ts` | `createRouter(initialPath)` factory + `useRouter` injectable token. No module-level state. |
| `src/App.tsx`, `src/pages/*.tsx` | Pages incl. `Ai.tsx` (`ssr.stream`) and the lazy `sections/TechDetails.tsx`. App sets `useHead` defaults; pages override titles. |
