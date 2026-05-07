# SPA

A minimal hash-routed single-page app in SignalX. Three pages, no router package — just a signal driving conditional render.

```bash
pnpm install
pnpm build           # builds the workspace packages
pnpm --filter @sigx/spa-example dev
```

Open http://localhost:5173 — click the nav, refresh on `#/counter`, hit back/forward. Hash routing means it works on any static host with no server fallback.

## What's in here

| File | Role |
|---|---|
| `src/main.tsx` | One `render(<App />, container)` call. |
| `src/App.tsx` | Header + nav + a `<main>` that picks a page from `route.path`. |
| `src/router.ts` | A signal that mirrors `location.hash` and a `navigate()` helper (~25 LOC). |
| `src/pages/Home.tsx` | Welcome and links. |
| `src/pages/Counter.tsx` | Object-signal counter and primitive-signal counter side-by-side. |
| `src/pages/Forms.tsx` | Native `model` bindings, child component with `Define.Prop` + `Define.Event`, and a custom `Define.Model<number>` rating component. |
| `src/pages/About.tsx` | Short note on the example's shape. |

## Why no router package?

There isn't one in `@sigx/core` — routers ship in their own repo under [`signalxjs`](https://github.com/signalxjs). A signal-backed conditional render is enough for most small apps.
