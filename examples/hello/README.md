# Hello SignalX

The smallest possible SignalX app — one component, one signal, one button.

```bash
pnpm install
pnpm build           # builds the workspace packages
pnpm --filter @sigx/hello-example dev
```

Open http://localhost:5173 — the counter increments on click via direct mutation (`state.count++`, no `.value` for objects).

## What this shows

- **One reactive primitive.** `signal({ count: 0 })` returns a deeply reactive proxy; you mutate it directly.
- **One mount call.** `render(<Counter />, container)` — that's it.
- **TSX, not templates.** The factory returns a render closure; only that closure re-runs when `state.count` changes.

The component, Vite config, and TS config are all under 30 lines each. Copy this folder as a starter for a new SignalX app.
