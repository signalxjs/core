# @sigx/netlify

Netlify deployment adapter for [SignalX](https://github.com/signalxjs/core)
— the final platform phase of the deployment RFC (`docs/rfc-deploy.md`
§4.5). A pack riding `@sigx/vite`'s public `SigxAdapter` seam; the runtime
story is `createFetchHandler` (WinterCG-clean, CI-enforced) — everything
here is **build glue**.

## Install

```sh
pnpm add -D @sigx/netlify
```

## Usage

```ts
// vite.config.netlify.ts
import { defineConfig } from 'vite';
import sigx from '@sigx/vite';
import { netlify } from '@sigx/netlify';

export default defineConfig({
    plugins: [sigx({ ssr: { entry: 'src/entry-server.tsx', adapter: netlify() } })]
});
```

`vite build --app` produces a fully bundled function and generates the
**Frameworks API** channel — Netlify's recommended target for build-tool
adapters:

```
.netlify/v1/functions/sigx-ssr/
├── sigx-ssr.mjs        # the v2 function: bare default fetch fn + in-source config
├── <bundled entry>.js  # your entry, fully self-contained (+ any chunks)
└── package.json        # {"type":"module"}
```

The generated in-source config is the routing policy made declarative:
`path: '/*'` (the catch-all), `preferStatic: true` (CDN files win before
the function runs), `nodeBundler: 'none'` (the output is final — Netlify
ships the directory as-is). Two details are load-bearing:

- **`index.html` is removed from the publish dir** after the build — it is
  the raw outlet template, and `preferStatic` would serve it for `/`,
  shadowing the document render. (The template is already inlined into the
  bundle via `virtual:sigx-app`.)
- **`netlify.toml` is printed, never written** — the config is yours from
  its first character. All it needs:

```toml
[build]
  publish = "dist/client"
  command = "npm run build"
```

Deploy with `netlify deploy --prod` (builds by default) or
`netlify deploy --prod --no-build` for prebuilt output.

## The platform entry — yours, scaffolded once

The first build scaffolds `src/entry.netlify.ts` iff absent and never
touches it again. It keeps the same `export default { fetch }` shape as
every sigx platform entry — the Netlify-specific contract (bare default
function + `export const config`) lives in the generated wrapper, so your
composition stays portable:

```
static assets  →  server functions  →  document render
```

## Verification posture

Structural, not emulation: CI asserts the generated layout and invokes the
function's default export directly under Node with real `Request`s (a pure
fetch handler — the `context` argument is optional sugar it never touches).
Reference wiring: `examples/resume` (`vite.config.netlify.ts`, committed
`entry.netlify.ts`, `netlify.toml`).

## License

MIT
