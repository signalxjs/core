# SignalX resume example

The resumability reference app (#241): seven resumable components, each one
rung of the ladder — `Counter` (replay + upgrade-on-write), `Tracker`
(read-only handler, no component chunk ever), `Quote` (a server function
from a resumed handler), `Catalog` (rich types through the boundary codec),
`Poll` (single-flight boundary refresh), `Feedback` (form submit with
synchronous `preventDefault` and a zero-JS `action`), `Legacy` (the
deliberate wake-on-interaction fallback).

```sh
pnpm build                                   # workspace dists (once)
pnpm --filter @sigx/resume-example dev       # dev server
# or production:
pnpm --filter @sigx/resume-example build
pnpm --filter @sigx/resume-example start
node smoke.mjs                               # browser verification, prod (after build)
node smoke.mjs --dev                         # the same ladder against the dev server
```

Dev runs the **same ladder** as prod: the transform runs for the dev SSR
render, the dev server serves the handler modules as virtuals, the registry
lazily imports the component modules, and the only script that boots is the
loader entry. Open the console — `@sigx/resume/client` narrates every
replay, upgrade and wake with a `[sigx resume]` line. What is prod-only is
bundle *shape* (chunk files, the manifest, modulepreload hints), never
behaviour; `pnpm smoke:resume` at the repo root proves both modes.

Entries for Cloudflare, Deno, Vercel and Netlify sit next to the Node
server (`entry.*.ts`, `vite.config.*.ts`) — see `docs/rfc-deploy.md`.
