# RFC: deployment — `createFetchHandler` + platform adapters

Status: **proposed**. Tracking: signalxjs/core#321. Pre-1.0, no-compat (same
stance as `rfc-async.md`, `rfc-ssr-platform.md`, `rfc-server.md`): one way to
do it.

Relationship to the other RFCs:

- **Resolves `rfc-ssr-platform.md` open question 6** ("`createRequestHandler`
  home"). The answer that emerged in practice — dev handler in `@sigx/vite`,
  prod connect handler in `@sigx/server-renderer/node` — is confirmed here and
  completed with the missing third sibling: a fetch handler in
  `@sigx/server-renderer/server`. Dev, Node, and WinterCG are now the three
  documented homes of one dispatch.
- **Cashes the check `rfc-ssr-platform.md` §2.3 wrote.** "Edge portability as
  a tested guarantee" split `./node` from the WinterCG-clean `./server` and
  gave CI the `test:edge` hook forbidding `node:*` on the render path. That
  guarantee has had no consumer: nothing in the repo actually *runs* a sigx
  app on an edge runtime. This RFC is the consumer — and upgrades the smoke
  from "Node pretending to be workerd" to the real thing.
- **Builds on `rfc-server.md`, and rev 2 depends on it.**
  `handleServerFnRequest(request): Promise<Response>` is already
  fetch-handler-shaped ("On WinterCG runtimes skip the adapter" —
  `packages/server/README.md`). Rev 2's product model — *native clients
  always talk to the backend; one solution ships web + native + terminal
  apps against **one deployed server*** — presumes that server is deployable
  somewhere real. This RFC is how it gets deployed; §5 adopts rev 2's
  `origin` postures for endpoints that serve native clients, verbatim.
- **Stays out of core.** Platform adapters are packs in the established
  sense: they ride the public seams (`createFetchHandler`, the `SigxAdapter`
  build contract, the registry chunk) and get no privileged access.
  `AGENTS.md` already reserved the slot: "Platform adapters
  (cloudflare/deno/bun) would be separate top-level packages — `./node` is
  interface bridging, not platform integration."

## Problem — stated against the current code

1. **The only production story is a hand-written Express server on a Node
   host.** Every SSR example ships a two-mode `server.mjs`
   (`examples/storefront/server.mjs` is the maximal case): dev = Vite
   middleware + `createDevRequestHandler`; prod = `express.static` +
   `createRequestHandler` + four `readFile`/JSON reads (template, client
   manifest, islands manifest, resume manifest). Deploying means shipping
   `dist/` + `server.mjs` + `node_modules` and running
   `node --conditions production`. That works — and excludes every platform
   that is not "a Node process with a filesystem and node_modules."
2. **The fetch-shaped document handler does not exist.**
   `createRequestHandler` (`packages/server-renderer/src/node.ts`) is
   connect-shaped: `IncomingMessage`/`ServerResponse`, `writeHead`,
   `.pipe(res)`. Cloudflare Workers, Deno Deploy, Bun, Vercel Edge, and
   Netlify Edge all speak one shape: `(Request) => Promise<Response>`. The
   primitives beneath it are already WinterCG-clean and CI-enforced
   (`renderDocumentChunks`, `renderDocumentToWebStream`, the `shell`
   status/redirect decision point) — the ~60 lines of dispatch on top are
   Node-only. Meanwhile `handleServerFnRequest` proves the pattern: the
   server-functions endpoint shipped fetch-shaped from day one.
3. **Prod servers read the filesystem; edge runtimes have none.** Template
   and manifests arrive via `readFile` at boot. A worker cannot do that —
   the data must arrive as *modules*. The repo already made this exact move
   once: the server-fn registry is a build-emitted chunk
   (`dist/server/sigx-server-fns.js`), "explicitly passed, never ambient."
   The document-side artifacts (template, `collectAssets` output, islands/
   resume manifests) need the same treatment.
4. **The orchestrated ssr build cannot produce an edge bundle.**
   `sigx({ ssr })` deliberately sets `resolve.external: true` on the ssr
   environment (`packages/vite/src/index.ts` — the DI-token-identity
   comment): the server bundle resolves `@sigx/*` from `node_modules` so it
   shares one module graph with the request handler loaded there. Correct
   for Node; fatal for workerd, which cannot resolve bare imports at
   runtime. Edge needs a **fully bundled** server build — which is equally
   safe for DI-token identity, for the opposite reason: one bundle *is* one
   module graph, handler included.
5. **Nothing verifies any of this end-to-end.** `test:edge` is honest about
   what it is: Node import-hooks simulating a WinterCG runtime against the
   prod dist. It has caught real dist breakage (the F8 class), but it never
   executes a *built app* under real workerd, never serves a static asset,
   never round-trips a server function. `rfc-ssr-platform.md` §2.3 asked
   for "workerd or equivalent"; this RFC delivers it.

## §1 Design thesis

### 1.1 One fetch handler finishes the runtime story for every platform at once

Cloudflare Workers, Deno Deploy, Bun, Vercel (edge and Node runtimes via
web handlers), and Netlify Functions all natively consume
`(Request) => Promise<Response>`. Ship `createFetchHandler` once, on the
already-CI-enforced WinterCG-clean entry, and the per-platform *runtime*
code drops to a ~20-line user-owned entry file. Everything platform-specific
that remains is **build glue**: output layout, config files, static-asset
wiring. Adapters are therefore build-time packages, not runtime layers.

### 1.2 The user authors the entry; adapters never hide composition

The platform entry is the `server.mjs` of the edge world — and it stays
user-owned and copyable, exactly like `createRequestHandler`'s "the dispatch
every hand-written server repeats" posture. The SSR strategy packs install in
the entry-server's app factory (`app.use(pack())`, #413); the server-fn
mount and its `guard`, `isBot`, and
the static-asset fallthrough are app decisions the user should see in their
own file. The composition order is fixed and documented everywhere:

```
static assets  →  server functions  →  document render
```

— expressed in the platform entry (or the platform's own routing config),
never inside a sigx handler. No sigx handler serves static files, ever
(§5.2). No all-in-one "start" handler exists (see "What this RFC does not
do").

### 1.3 Adapters are separate top-level packages in this monorepo

Per platform, as `AGENTS.md` reserved: `@sigx/cloudflare`
(`packages/cloudflare`), `@sigx/vercel` (`packages/vercel`),
`@sigx/netlify` (`packages/netlify`). Node, Bun, and Deno get documentation
and entries, not packages, until real friction proves otherwise — their
runtimes consume the fetch handler (or today's Node handler) directly.

Rejected alternatives, recorded: a single `@sigx/deploy` umbrella with
per-platform subpaths (fewer docs rounds, but couples release cadence of
unrelated platforms and contradicts the reserved naming);
`@sigx/deploy-<platform>` naming (the bare `@sigx/cloudflare` matches the
`@astrojs/cloudflare`-style ecosystem convention and the AGENTS.md
phrasing); a separate `signalxjs/deploy` repo (adapters are thin glue over
core seams and need the examples + edge CI harness that live here — but if
the platform count grows, spinning the packages out later is explicitly
kept open; nothing below depends on being in-repo).

## §2 `createFetchHandler` — the WinterCG sibling

New file `packages/server-renderer/src/server/fetch-handler.ts`, exported
from `@sigx/server-renderer/server` (and the root `.` entry, matching the
other render APIs). It is subject to the same `test:edge` discipline as
everything else on that entry.

```ts
export interface FetchHandlerOptions<TPlatform = unknown> {
    /**
     * The document template containing the outlet marker — a prebuilt
     * string (the `virtual:sigx-app` module, §3.2) or a per-request
     * resolver.
     */
    template:
        | string
        | ((url: string, request: Request, platform: TPlatform) => string | Promise<string>);

    /**
     * Per-request app factory: build a FRESH app for this URL — the same
     * frozen contract as the Node and dev handlers, so one
     * `entry-server.tsx` serves all three. `request` and `platform` ride
     * along for apps that need headers or platform bindings during render.
     */
    app: (
        url: string,
        request: Request,
        platform: TPlatform
    ) => App | JSXElement | Promise<App | JSXElement>;

    /** Static, or resolved per request. `template`/`mode` are handler-owned. */
    document?:
        | Omit<DocumentOptions, 'template' | 'mode'>
        | ((url: string, request: Request, platform: TPlatform) => Omit<DocumentOptions, 'template' | 'mode'>);

    /** Crawler detection → blocking mode. Default: the shared BOT_UA regex. */
    isBot?: (userAgent: string, request: Request) => boolean;

    /** The SSR instance to render with (plugins!). Default: shared plugin-less instance. */
    ssr?: Pick<SSRInstance, 'renderDocumentChunks'>;
}

export type FetchHandler<TPlatform = unknown> = (
    request: Request,
    platform?: TPlatform
) => Promise<Response>;

export function createFetchHandler<TPlatform = unknown>(
    options: FetchHandlerOptions<TPlatform>
): FetchHandler<TPlatform>;
```

### 2.1 Dispatch — the Node handler's, re-expressed in Web primitives

Byte-for-byte the same decisions as `createRequestHandler`
(`node.ts:198-260`):

- Resolve `template` / `app` in parallel; `mode = isBot(ua) ? 'blocking' :
  'stream'`; `ssr.renderDocumentChunks(input, { ...docOptions, template,
  mode })`.
- `await shell` — the status/redirect decision point (`rfc-ssr-platform`
  §2.1). A redirect returns a bodyless
  `Response(null, { status, headers: { location } })` and releases the
  generator (`chunks.return?.(undefined)`).
- Otherwise `new Response(body, { status: head.status, headers:
  { 'content-type': 'text/html; charset=utf-8', ...head.headers } })`,
  where `body` is the chunk generator encoded as a byte stream.
- Shell (or app-factory) failure — no byte written: a minimal 500 document,
  same as the Node handler's no-`next` branch. There is no `next()` in the
  fetch world; a custom error page is a wrapper (`try { return await
  handler(rq) } catch { … }`) — it is just a function.
- Mid-stream failure after the head: already routed to `onError` by the
  document generator; the stream ends visibly truncated (same semantics as
  the Node handler).

### 2.2 `platform` — opaque, generic, explicitly passed

The returned handler takes an optional second argument, threaded verbatim
into every callback. Cloudflare's `fetch(request, env, ctx)` maps as
`handler(request, { env, ctx })`; Deno/Bun/Node pass nothing. sigx never
interprets it — no ambient context, no `SigxPlatform` interface encoding
platform knowledge into core (rejected in Open Questions). Apps that want
typed bindings instantiate the generic:
`createFetchHandler<{ env: Env; ctx: ExecutionContext }>({ … })`.

### 2.3 Shared internals, not a shared abstraction

- **`BOT_UA` moves** from `node.ts` to a WinterCG-clean
  `src/server/bot.ts` (exported as `defaultIsBot`); both handlers import
  it. One regex, three handlers (the dev handler already defaults through
  the Node one).
- **The string→bytes encoding is extracted once.** `renderDocumentToWebStream`
  already contains the pull-based `ReadableStream<Uint8Array>` +
  `TextEncoder` machinery with backpressure honored in `pull()` and
  `chunks.return?.()` on `cancel()` (client disconnect). It becomes a
  shared helper (working name `chunksToBytes(chunks):
  ReadableStream<Uint8Array>`), exported from `./server` — the fetch
  handler, `renderDocumentToWebStream`, and hand-written servers all use
  the same encoder.
- **The Node handler is NOT refactored to wrap the fetch handler.**
  Double-bridging (`IncomingMessage → Request`, `Response →
  ServerResponse`) on every Node request would trade the direct
  `writeHead` + byte-mode `Readable` backpressure path (the `objectMode:
  false` rationale documented in `node.ts`) for ~45 lines of saved
  dispatch, and would force the dev handler's `(url, req)` callback
  contract to change. Thin siblings over shared primitives, like the
  server-fn pair.

### 2.4 Server-fn mounting stays sibling composition

`rfc-server.md` pinned it: *"the fn handler is a sibling middleware, not an
option of `createRequestHandler`."* The same holds for the fetch handler —
an option bag would also make `@sigx/server` and `@sigx/server-renderer`
phantom dependencies of each other. The mount is three visible lines in the
platform entry (§4.1), and the routing policy (prefix, order relative to
auth) belongs to the app.

One addition to `@sigx/server/server`, so the default base lives in one
place instead of being restated in every entry:

```ts
/** True when the request targets the server-fn endpoint under `base`. */
export function matchesServerFn(request: Request, base = '/_sigx/fn'): boolean;
```

Deliberately a predicate, not a combinator — composition stays in the
user's entry. `base` here is `rfc-server` rev 2's *server mount path* (the
`endpoint`/`base` split): stubs may target an absolute `endpoint`, but the
deployed handler matches on `base`.

## §3 The build seam — `SigxAdapter` and `virtual:sigx-app`

### 3.1 The adapter contract

`sigx({ ssr })` gains an `adapter` option. An adapter is a **plain object**
consumed by the sigx plugin's existing `config` build branch — not a second
Vite plugin. Rationale: the ssr environment's resolve behavior encodes the
module-graph/DI-token invariant this codebase documents obsessively (the
`resolve.external: true` comment in `packages/vite/src/index.ts`, the
module-graph notes in `vite/src/ssr.ts` and `server-fn.ts`); keeping one
authority over that environment keeps the invariant auditable in one file,
instead of depending on plugin-order `mergeConfig` semantics to overturn
`external: true` from a second package.

```ts
// packages/vite/src/adapter.ts — types exported from @sigx/vite
export interface SigxAdapter {
    name: string; // 'node', 'cloudflare', …

    /**
     * 'external' — today's output: deps resolve from node_modules at
     *              runtime (Node/Bun hosts).
     * 'bundled'  — fully self-contained server build: resolve.noExternal:
     *              true, platform conditions, target 'esnext' (edge).
     * Binary on purpose: partially-external is the dangerous middle
     * ground for DI-token identity and is unrepresentable here.
     */
    serverBuild: 'external' | 'bundled';

    /** Extra resolve.conditions for the ssr environment, e.g. ['workerd', 'worker']. */
    conditions?: string[];

    /** Specifiers left as runtime imports in a bundled build (e.g. /^cloudflare:/). */
    runtimeExternal?: (string | RegExp)[];

    /** Platform entry module (project-relative). Default: ssr.entry (today's behavior). */
    entry?: string;

    /** Server-build target. Default 'esnext' for 'bundled'. */
    target?: string;

    /** After BOTH environments have written: copy statics, write platform
     *  config, validate. The .vercel/output assembly hook. */
    generate?(ctx: AdapterGenerateContext): void | Promise<void>;

    /** Dev-server hook for platform-binding proxies (§4.6). */
    dev?(server: ViteDevServer): void | Promise<void>;
}

export interface AdapterGenerateContext {
    root: string;
    clientOutDir: string; // absolute
    serverOutDir: string; // absolute
    ssrInput: string;     // the resolved server entry
    logger: { info(msg: string): void; warn(msg: string): void };
}
```

`ssr.adapter` defaults to the built-in `nodeAdapter()`
(`serverBuild: 'external'`) — zero-config output is byte-identical to
today's. Build ordering becomes explicit rather than assumed: the plugin
provides `builder.buildApp` (client → ssr → `adapter.generate(ctx)`), so
the ssr build can read the client artifacts it inlines (§3.2) and
`generate` can see both output trees.

`serverBuild: 'bundled'` is safe for DI-token identity *because it is
total*: the platform entry, `entry-server`, the strategy packs, the
handlers, and the registry land in one bundle = one module graph. The
existing single-`sigx`-chunk pinning continues to apply within it.

**Correctness requirement (verified in implementation, enforced by
`verify:pack` forever):** the bundled output must contain the **prod**
dists — the `development|production` condition token must resolve to
`production` per-environment, the `node` condition must be dropped for
workerd-targeted builds, and the output must contain no `node:` imports
(beyond `runtimeExternal`) and none of `verify-pack`'s FORBIDDEN dev
markers (`process.env.NODE_ENV`, devtools hooks).

### 3.2 `virtual:sigx-app` — the document-side artifacts as a module

The document-side sibling of `virtual:sigx-server-fns`, resolved by the
sigx plugin in the ssr environment (build only):

```ts
// virtual:sigx-app — what a fetch handler needs, with no filesystem
export const template: string;                     // dist/client/index.html, inlined
export const assets: CollectedAssets;              // collectAssets(manifest, [htmlEntry]), precomputed
export const manifest: ViteManifest;               // raw, for apps needing more than entry assets
export const islandsManifest: unknown | undefined; // .vite/sigx-islands-manifest.json, if emitted
export const resumeManifest: unknown | undefined;  // .vite/sigx-resume-manifest.json, if emitted
```

- `load()` reads the client outDir with `fs` **at build time** (the build
  always runs in Node; only the *output* must be fs-free) and inlines
  everything as literals. `assets` is precomputed via the existing
  `collectAssets` so entries that never touch the raw manifest tree-shake
  it away.
- **Also materialized for the external build** as
  `dist/server/sigx-app.js` (the `emitFile` chunk pattern the server-fn
  registry already uses). A Node `server.mjs` collapses from four
  `readFile`s to one import — one documented pattern across all six
  platforms.
- `serverFns` deliberately does **not** re-export through this module. The
  platform entry imports `virtual:sigx-server-fns` itself and visibly
  wires it into the fn handler — "explicitly passed, never ambient" stays
  literal, and the registry remains the single seam regardless of rev 2's
  stable-symbol scheme (dual registration changes the *keys*, not the
  contract).
- In `serve` mode the virtual module throws a descriptive error pointing
  at `createDevRequestHandler` — dev has no manifests and already solves
  template/assets live.

### 3.3 Interaction with rev 2's build modes

`rfc-server.md` rev 2 adds `role: 'client'` (the whole build is a
remote-server client: every environment stubbed, no registry emitted). The
combined option surface is coherent by exclusion: `role: 'client'`
describes a build **with no server in it**, so `ssr.adapter` (which shapes
the server build) does not apply — configuring both is a config-time
error with a message naming the conflict. A deployed-server build
(`role: 'auto'` + an adapter) is exactly the thing rev-2 clients point
their `endpoint` at. The two implementation tracks are otherwise
independent; neither blocks the other.

## §4 Platforms

| Platform | Package | serverBuild | Statics | Deploy |
|---|---|---|---|---|
| Node | — (docs; today's flow via `sigx-app.js`) | external | `express.static` / `node:http` | `node --conditions production server.mjs` |
| Cloudflare Workers | `@sigx/cloudflare` | bundled, `['workerd','worker']` | wrangler `assets: { directory: "dist/client" }` — served before the worker runs | `vite build && wrangler deploy` |
| Deno Deploy | docs + example first | bundled, `['deno']` | `serveDir` (`@std/http`) fallthrough | `vite build && deployctl deploy` |
| Bun | docs + example | external | `Bun.serve` routes / `Bun.file` | `bun --conditions=production server.ts` |
| Vercel | `@sigx/vercel` | bundled (`edge-light` or Node runtime option) | Build Output API `static/` + `filesystem` route | `vite build && vercel deploy --prebuilt` |
| Netlify | `@sigx/netlify` | bundled | publish dir `dist/client`; function catch-all | `vite build && netlify deploy` |

### 4.1 The copyable entry (Cloudflare shown; all platforms rhyme)

```ts
// src/entry.cloudflare.ts — user-owned, ~20 lines, THE documentation
import { createFetchHandler } from '@sigx/server-renderer/server';
import { handleServerFnRequest, matchesServerFn } from '@sigx/server/server';
import { template, assets } from 'virtual:sigx-app';
import { serverFns } from 'virtual:sigx-server-fns';
// The strategy packs install in createApp (app.use, #413); their manifests
// arrive there via virtual:sigx-manifests.
import { createApp } from './entry-server';

const handler = createFetchHandler<{ env: Env; ctx: ExecutionContext }>({
    template,
    app: (url) => createApp(url),
    document: { assets }
});

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
        if (matchesServerFn(request)) {
            return handleServerFnRequest(request, {
                resolve: (s) => serverFns[s]?.() ?? null
                // guard, origin: see §5
            });
        }
        return handler(request, { env, ctx });
    }
};
```

Static assets never reach this code on Cloudflare: with the wrangler
`assets` config (default `run_worker_first: false`), the platform serves
matching files before the worker is invoked. The `run_worker_first: true`
variant (`env.ASSETS.fetch(request)` fallthrough) is documented for apps
that must intercept everything.

### 4.2 `@sigx/cloudflare` (`packages/cloudflare`) — the flagship

Exports `cloudflare(options?): SigxAdapter` — `serverBuild: 'bundled'`,
`conditions: ['workerd', 'worker']`, `runtimeExternal: [/^cloudflare:/]`,
`entry` defaulting to the documented worker entry path. `generate()`
writes a starter `wrangler.jsonc` iff absent (`main` → the built worker,
`assets.directory` → the client outDir, a current `compatibility_date`);
when present, validates those fields and warns on drift — the config stays
user-owned. Because the build already resolved the prod condition and
bundled everything, wrangler's own bundling step is a pass-through
(verified in the smoke; `no_bundle` documented as the escape hatch if it
ever isn't). `nodejs_compat` is not required by sigx — the server path is
`node:`-free by CI guarantee — and is documented as a user concern for
their own deps.

### 4.3 Deno Deploy and Bun — documented entries

Both consume the fetch handler natively; neither gets a package until
friction proves otherwise.

```ts
// Deno: server.ts — the static tier is GET/HEAD-only: serveDir answers
// other methods with 405 (not 404), which would swallow server-fn POSTs.
// showIndex: false keeps the raw outlet template off '/'.
Deno.serve(async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
        const res = await serveDir(req, { fsRoot: 'dist/client', showIndex: false });
        if (res.status !== 404) return res;
    }
    if (matchesServerFn(req)) return handleServerFnRequest(req, { resolve });
    return handler(req);
});
```

Bun mirrors it with `Bun.serve({ fetch })` (external build — Bun resolves
node_modules and honors `--conditions=production`). Writing a sigx static
file server for these runtimes is rejected: `serveDir`/`Bun.file` are
first-class, and a hand-rolled one is security surface (traversal, ranges,
caching) the platforms already own.

### 4.4 `@sigx/vercel` (`packages/vercel`)

`vercel({ runtime?: 'edge' | 'node' })`. Unlike wrangler-style tools,
Vercel's Build Output API v3 *is* a generation contract — hand-writing
`.vercel/output` has no copyability value. `generate()` produces the full
layout: `static/` (copied from the client outDir), `functions/_render.func`
(the bundled server + `.vc-config.json`), and `config.json` routes — the
server-fn prefix FIRST (before the `filesystem` handle: the static tier
must never shadow fn POSTs — the same lesson §4.3's serveDir 405 taught),
then `filesystem`, then the catch-all to the function. `static/` omits
`index.html` (the filesystem handle would serve the raw outlet template
for `/`). Deploy is `vercel deploy --prebuilt`; the layout is inspectable
offline, which is what CI asserts (§6).

### 4.5 `@sigx/netlify` (`packages/netlify`)

Same pattern, Netlify's shapes: the SSR function emitted with
`export default handler; export const config = { path: '/*', preferStatic:
true }`, publish dir = the client outDir, starter `netlify.toml` printed
rather than owned. Lands last — after Vercel proves the generation shape.

### 4.6 Dev story

`vite dev` + `createDevRequestHandler` remains the one dev loop on every
platform — adapters change builds, not dev. The exception platforms
actually need: **Cloudflare bindings in dev.** `cloudflare({ devProxy:
true })` uses wrangler's `getPlatformProxy()` in the adapter's `dev()`
hook and threads `{ env, ctx }` through a new pass-through `platform`
option on `createDevRequestHandler` (forwarded to the `template`/`app`/
`document` callbacks like everything else). The official
`@cloudflare/vite-plugin` (dev inside real workerd) is documented as a
compatible alternative, not a dependency.

## §5 Security

1. **The server-fn endpoint's defaults are unchanged by deployment.**
   `handleServerFnRequest` enforces POST-only, required JSON content-type,
   same-origin `Origin`, `maxBodyBytes`, prototype-pollution revivers, and
   prod error masking regardless of platform — the entry templates add
   nothing and can subtract nothing.
2. **No sigx handler serves files, so no sigx handler can traverse.** The
   static tier is the platform's (CF assets, Vercel/Netlify CDN) or the
   runtime standard library's (`serveDir`, `express.static`). This is a
   deliberate refusal, not an omission.
3. **Deployed endpoints serving native clients adopt rev 2 verbatim.** A
   deployed server that rev-2 lynx/terminal clients call cross-origin uses
   `origin: 'verify-when-present'` + header auth via `guard` — the RFC's
   documented middle posture, including its caveats (never deploy an
   Origin-stripping proxy in front of cookie auth; `Origin: null` is
   present and rejected). The default stays `'same-origin'`; the entry
   templates show the opt-in as the reviewable one-liner it is.
4. **Prod builds must be provably prod.** Error masking, `__DEV__`
   stripping, and devtools removal all hinge on the bundler resolving the
   `production` condition (§3.1). `verify:pack` asserts it on the bundled
   output from real tarballs — the one place a condition-resolution
   regression cannot hide.
5. **Backend redeploys and installed clients.** Rev 2's stable symbols +
   dual registration are what make redeploying the *deployed* server safe
   for app-store clients; adapters inherit that by consuming the registry
   unchanged. Worth stating because it is a deployment property: hashed =
   deploy-coupled (web, reload fixes it), stable = deploy-durable
   (native, contract-governed).

## §6 Verification — tested guarantees, extended

- **`test:edge` grows two consumers**: a full `Request →
  createFetchHandler → Response` round-trip through the prod dist, and —
  closing a standing gap — `@sigx/server`'s `handleServerFnRequest` under
  the same no-`node:` import hooks (today only server-renderer and resume
  are guarded).
- **`scripts/deploy-smoke/`** — the honest end-to-end tier, asserting on
  *built app artifacts*:
  - `cloudflare.mjs`: build the reference app with `cloudflare()`, run the
    worker under **Miniflare** (programmatic `dispatchFetch`, real workerd,
    no ports/login): streamed document markers, a static asset through the
    assets config, a server-fn POST through the registry. This is the
    "workerd or equivalent" smoke `rfc-ssr-platform` §2.3 called for.
  - `node.mjs`: the built external output under
    `node --conditions production` — same assertions; runs on ubuntu +
    windows (the Node path must stay cross-platform).
  - `bun.mjs` / `deno.mjs`: same assertions on the documented entries
    (setup-bun / setup-deno actions; linux-only).
  - Vercel/Netlify: **structural verification, not emulation** — Vitest
    asserts the generated output layout (`config.json` routes,
    `.vc-config.json`, static copy) and invokes the generated function's
    fetch export directly under Node with a `Request` (it is WinterCG code;
    Node runs it). Live-deploy canaries are out of CI scope.
- **`verify:pack`** packs the new packages and adds the bundled-edge
  assertions from §3.1 on a scratch app built with `cloudflare()` — from
  real tarballs, the end-to-end proof no unit test can fake.
- **Exit criterion for the flagship phase**: the reference example serves
  identically — document markers, islands/resume attributes, server-fn
  round-trip — from `node server.mjs` and from Miniflare/workerd, each
  from one `vite build`.

## §7 Phasing

Each phase = its own issue → worktree → PR → Copilot review → merge.

- **Phase 0**: this document.
- **Phase 1 — `createFetchHandler`**: `fetch-handler.ts` + `bot.ts` +
  `chunksToBytes` extraction in `@sigx/server-renderer`; `matchesServerFn`
  in `@sigx/server/server`. Unit tests (redirect short-circuit,
  bot→blocking, header merge, cancel → generator release, shell failure →
  500); both `test:edge` extensions.
- **Phase 2 — build seam**: `SigxAdapter` + `ssr.adapter` + explicit
  `buildApp` ordering + `virtual:sigx-app` (+ `sigx-app.js` emission) +
  `nodeAdapter()` in `@sigx/vite`; the maximal example's prod server
  refactored onto `sigx-app.js` as proof the Node story shrinks too.
  Implementation verifies the flagged Vite 8 environment-API behaviors:
  per-environment `resolve.conditions` replace-vs-merge and the
  `development|production` token, plugin-returned `builder.buildApp`,
  `emitFile` chunk dedup when the entry also imports the virtual,
  `manualChunks` inheritance in the bundled environment.
- **Phase 3 — `@sigx/cloudflare`** (`packages/cloudflare`) + the reference
  app's worker wiring (`entry.cloudflare.ts`, `wrangler.jsonc`,
  `build:cloudflare`) + `deploy-smoke-cloudflare` (Miniflare) and
  `deploy-smoke-node` CI jobs + the `verify:pack` extension. Exit
  criterion above.
- **Phase 4 — Deno + Bun**: documented entries + examples + runtime smoke
  jobs; the "Deploying" docs-site page covering the full matrix (queued as
  a docs-repo issue, per process).
- **Phase 5 — `@sigx/vercel`**: Build Output API v3 generation +
  structural tests.
- **Phase 6 — `@sigx/netlify`**: same shape.

Monorepo mechanics per new package (the AGENTS.md docs table): Packages
section + README table + CONTRIBUTING layout + issue-template dropdowns +
tsconfig/vitest aliases + `verify:pack` list. **No `.size-limit.mjs`
entries** for the adapter packages — build-time-only Node code ships zero
browser bytes (the omission is deliberate; `createFetchHandler`'s bytes
land in server-renderer's existing budget line).

## What this RFC does not do

- **A unified "start" handler.** No `sigxStart({ statics, fns, document })`
  rolling static serving + fn mounting + rendering into one call. Users
  arriving from Next/SvelteKit will ask; the answer is deliberate: the
  three-line composition *is* the routing policy (rfc-server pinned fn
  mounting as sibling composition), an option bag would cross-wire
  `@sigx/server` and `@sigx/server-renderer` as phantom dependencies, and
  the all-in-one is the first step onto the meta-framework slope.
- **Static file serving in any sigx handler** (§5.2).
- **SSG / prerendering.** Out of scope for core — SSG lives in its own
  signalxjs repo; the adapters here are about *servers*. (An SSG that
  consumes `createFetchHandler` at build time is a natural fit — in that
  repo.)
- **File-system routing or route crawling** — unchanged stance since
  `rfc-ssr-platform`.
- **Platform SDK surface.** No bindings wrappers, no KV/D1/queue helpers,
  no typed `Env` generation — `platform` is opaque; the platforms' own
  tooling owns their APIs.
- **Platform bundler integrations beyond Vite** — rev 2's
  `@sigx/vite/server-extract` posture applies: non-Vite pipelines consume
  the public seams from their own repos.

## Compatibility

- Purely additive: new export `createFetchHandler` (+ `defaultIsBot`,
  `chunksToBytes`) on `@sigx/server-renderer/server`; new
  `matchesServerFn` on `@sigx/server/server`; new `ssr.adapter` option
  (default `nodeAdapter()` = today's output, byte-identical); new virtual
  module + emitted chunk; new packages.
- `createRequestHandler`, `createDevRequestHandler` (modulo the additive
  `platform` pass-through), the entry-module contract (`createApp(url)`),
  the wire formats, and the registry chunk: unchanged.
- Existing example `server.mjs` files keep working; they migrate to
  `sigx-app.js` imports as a simplification, not a requirement.

## Open questions

1. **`matchesServerFn`** — predicate (proposed) vs nothing vs a
   `(request) => Promise<Response | null>` combinator? The predicate
   centralizes only the base default; hono-style combinator ecosystems can
   layer on third-party.
2. **`platform` typing** — opaque generic (proposed) vs a module-augmented
   `SigxPlatform` interface? Augmentation reads nicer for CF `Env` but
   starts encoding platform knowledge in core types.
3. **A generic `ssr.target: 'webworker'`-style option in `@sigx/vite`**
   instead of adapter-supplied conditions? It might make `@sigx/cloudflare`
   almost unnecessary — attractive, but it grows core's option surface and
   every platform's condition set differs; adapter-supplied conditions are
   proposed.
4. **Where the deployment guides live** — docs site (proposed; queued via
   docs-repo issues per process) with the copyable entries in package
   READMEs and the reference example, vs a long-form in-repo
   `docs/deploy.md`.
5. **Cloudflare dev depth** — is `devProxy` (getPlatformProxy) enough, or
   should the docs steer binding-heavy apps to `@cloudflare/vite-plugin`
   (dev inside real workerd) as the primary path?
