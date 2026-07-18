# @sigx/vercel

Vercel deployment adapter for [SignalX](https://github.com/signalxjs/core) —
Build Output API v3 generation, per the deployment RFC (`docs/rfc-deploy.md`
§4.4). A pack riding `@sigx/vite`'s public `SigxAdapter` seam with no
privileged access; the runtime story is `createFetchHandler`
(WinterCG-clean, CI-enforced) — everything here is **build glue**.

## Install

```sh
pnpm add -D @sigx/vercel
```

## Usage

```ts
// vite.config.vercel.ts
import { defineConfig } from 'vite';
import sigx from '@sigx/vite';
import { vercel } from '@sigx/vercel';

export default defineConfig({
    plugins: [sigx({ ssr: { entry: 'src/entry-server.tsx', adapter: vercel() } })]
});
```

`vite build --app` produces a fully bundled function and then generates the
complete `.vercel/output` layout — unlike wrangler-style tools, the Build
Output API **is a generation contract**: hand-writing it has no copyability
value, so the layout is regenerated every build:

```
.vercel/output/
├── config.json                # routes: fn prefix → filesystem → catch-all
├── static/                    # the client outDir (minus index.html, .vite)
└── functions/_render.func/    # the bundled server + .vc-config.json
```

Deploy with `vercel deploy --prebuilt` (link the project first). Two layout
choices are load-bearing:

- **`static/` omits `index.html`** — the filesystem handle serves
  `static/index.html` for `/`, which would shadow the document render with
  the raw outlet template.
- **The server-fn route precedes the filesystem handle** — POSTs to
  `/_sigx/fn/*` must never be shadowed by files.

## The platform entry — yours, scaffolded once

The first build scaffolds `src/entry.vercel.ts` iff absent and never
touches it again. The `export default { fetch }` shape is load-bearing on
the Node runtime: Vercel's launcher detects a **web** handler by the `fetch`
*method* on the default export — a bare default function would be treated
as a legacy `(req, res)` handler. The composition order stays visible in
your file:

```
static assets  →  server functions  →  document render
```

## Options

```ts
vercel({
    // 'node' (default — Vercel's current guidance; Fluid compute) | 'edge'
    runtime: 'node',
    // .vc-config.json runtime string for the node runtime
    nodeVersion: 'nodejs22.x',
    // the platform entry, scaffolded iff absent
    entry: 'src/entry.vercel.ts'
})
```

For `runtime: 'edge'` the build resolves the `edge-light`/`worker`
conditions and `generate()` emits a tiny wrapper entrypoint (the edge
contract is a bare default fetch function; your entry keeps the `{ fetch }`
shape, identical across platforms).

## Verification posture

Structural, not emulation (there is no official Build Output API emulator):
CI asserts the generated layout and invokes the function's fetch export
directly under Node with real `Request`s — exactly what Vercel's launcher
calls. The reference wiring lives at `examples/resume`
(`vite.config.vercel.ts` + the committed `src/entry.vercel.ts`).

## License

MIT
