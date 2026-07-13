# RFC: SSR platform — one boundary model, the request lifecycle, the last mile

Status: **proposed / under review — rev 1**. Tracking: signalxjs/core#171.
Pre-1.0, no-compat (same stance as `rfc-use-async.md` and the value-first async
RFC, #135/#136): one way to do it. One deliberate revision to a frozen contract
is called out explicitly (§1.3); everything else the `ssr-next` program froze
stays frozen.

Relationship to the other RFCs:

- **Builds on `rfc-use-async.md`** (implemented): keyed data transfer,
  `__SIGX_ASYNC__`, the `_useAsync`/`_useStream` provider seams, the layering
  rule ("runs standalone in a browser → `sigx`; needs a server →
  `@sigx/server-renderer`").
- **Consumes the value-first async RFC** (#135, **merged** as
  `docs/rfc-async.md`, rev 8): `useData`/`useAction`, `<Defer>` as the one
  positional primitive (during SSR streaming it observes pending data *and*
  chunks — rfc-async §5), the `match` state→arm mapping, `errorScope`. This
  RFC does not restate that design; it defines its **server half** (§2.2) and
  the streaming boundary it keys off (§1).
- **Depends on #119** (islands into the monorepo) and **resolves #122**
  (`client:only` cannot suppress the server render).

## Where the engine stands

After `ssr-next` (#61, `docs/ssr-review.md`) the rendering engine is not the
bottleneck: out-of-order streaming with mid-stream growth, `renderDocument`
with `blocking`/`stream` modes and a shell promise, keyed `useData`
serialization (shipped as `useAsync`; renamed by rfc-async), `useStream`
progressive text, hydration with mismatch recovery,
and an `SSRPlugin` surface good enough that islands shipped as an external
pack without core importing a line of strategy code.

This RFC deliberately adds **no new rendering capability**. It defines the
platform layer around the engine: one boundary concept, a request-lifecycle
contract, and the integration surface that makes the first hour of sigx SSR
not require reading `examples/spa-ssr/server.ts`.

## Problem — stated against the current code

1. **Three overlapping boundary concepts.** `<Defer>` (#135 §5:
   code-split + SSR flush), islands `client:*` directives (hydration
   scheduling, `@sigx/ssr-islands`), and streaming placeholders
   (`render-core.ts` `__suspense` → `_pendingAsync`,
   `<div data-async-placeholder>`) are one concept observed from three angles
   — each with its own markers, its own client scheduler, and (for islands)
   its own state blob.
2. **Pluggability worked, and found its exact limits.** Islands was built
   entirely on public seams — validation of the model — and hit three walls:
   - `client:only` renders + hydrates in place because `render-core` captures
     the component's setup **before** `transformComponentContext` runs, so no
     pack can suppress the server render (#122, "needs a core seam");
   - it ships a second serialized blob (`__SIGX_ISLANDS__`) with its own
     escaping/wire discipline next to `__SIGX_ASYNC__`;
   - its manifest option assumes a `@sigx/vite` islands plugin that does not
     exist.
3. **The DX cliff is at integration, not rendering.** `examples/spa-ssr`
   hand-wires the dev/prod server, builds the router per request by
   convention, and must **manually preload the route's lazy chunk before
   `hydrate()`** (`entry-client.tsx`) or hydration mismatches. ssr-manifest →
   `modulepreload` is the one deferred `ssr-next` item (`ssr-review.md`, F9
   remainder).
4. **Request-level gaps.**
   - A per-component server render error streams a hard-coded
     `<div style="color:red;">Error loading component</div>` (`ssr.ts`) and
     never reaches `DocumentOptions.onError` — only shell-phase and
     stream-level failures do (`document.ts`).
   - `errorScope` (#135) has no SSR semantics yet.
   - `ssr.ts` and `document.ts` import `node:stream` at module top, so even
     the Web-stream path drags Node builtins (the F8 dist breakage was this
     class of problem).
   - `useHead`'s script `innerHTML` is emitted **raw** (`head.ts`), and its
     `escapeAttr` escapes only `&` and `"`.

## The design

### 1. One boundary model

**Definition.** An *SSR boundary* is a position in the tree with two
orthogonal axes:

```ts
interface SSRBoundary {
  id: string;                       // stable per request (existing component-id scheme)
  flush: 'inline' | 'stream' | 'skip';
  //  inline: await content, emit in place (blocking/string modes)
  //  stream: emit fallback + placeholder now, $SIGX_REPLACE later
  //  skip:   do not server-render at all (client:only — the #122 case)
  hydrate: 'load' | 'idle' | 'visible' | 'media' | 'interaction' | 'never';
  fallback?: () => VNode;           // rendered while flush=stream is pending, or when flush=skip
  chunk?: string;                   // module ref for on-demand loading (lazy()/islands manifest)
  props?: Record<string, unknown>;  // serialized props — required whenever the boundary mounts
                                    // independently of the root hydration walk: every boundary
                                    // with hydrate ≠ 'load', and every flush:'skip' boundary
                                    // (client:only) regardless of its hydrate strategy
}
```

**Everything existing maps onto it:**

| Today | In the boundary model |
|---|---|
| `<Defer fallback>` (#135) | boundary: `flush` per render mode, `hydrate` inherited from the app default |
| island `client:visible` (etc.) | boundary: `flush: 'inline'`, `hydrate: 'visible'` |
| island `client:only` | boundary: `flush: 'skip'`, `hydrate: 'load'` — finally expressible (#122) |
| streaming placeholder + `$SIGX_REPLACE` | the `flush: 'stream'` rendering of any boundary |
| full-page SPA-SSR hydration | one implicit root boundary, `hydrate: 'load'` |
| islands page | root boundary `hydrate: 'never'`; components opt in via `client:*` |

**One model, two defaults.** A SPA-SSR app and an islands app stop being
different architectures: the app-level default hydrate strategy is `'load'`
(hydrate everything from the root — today's walk) or `'never'` (hydrate
nothing unless a boundary opts in — islands). Everything between the two —
"SPA app, but the comments widget hydrates on visibility" — becomes ordinary,
not a package switch.

**Authoring surfaces (unchanged where they exist):**

- `client:*` directives stay the per-component surface (Astro-familiar,
  already shipped by islands). They set the `hydrate` axis.
- `<Defer fallback>` stays the positional flush primitive (#135). It sets a
  flush point; its `hydrate` follows the app default.
- The app default is set where hydration starts (exact spelling: open
  question 5).

Internally all three produce the same `SSRBoundary` record; there is no
"island" type distinct from a "defer" type.

#### 1.1 The unified boundary table (blob)

The server emits **one boundary table** per request — id → hydrate strategy,
props snapshot, chunk ref — replacing `__SIGX_ISLANDS__`. `__SIGX_ASYNC__`
(data, keyed by user keys) is unchanged; the two concerns stay separately
addressed (per `rfc-use-async.md` open question 4's resolution) but share
**one serializer module**: one escaping discipline (`escapeJsonForScript`,
null-prototype targets, `DANGEROUS_KEYS`), one dev-mode serializability
warning path, and one **pluggable type-handler registry** (needed twice
already: the `@sigx/store` adapter spec'd in `rfc-use-async.md`, and the
cache pack contract of #135 (rfc-async §7) for which `__SIGX_ASYNC__`
becomes the seed). Whether the two blobs merge into one `__SIGX_SSR__` script is open
question 1.

#### 1.2 Selective hydration is the hydrator

The islands client machinery (registry, chunk loader,
`scheduleComponentHydration`, the `client:*` strategies) generalizes into
**the** hydrator: client hydration = read the boundary table, schedule each
boundary per its strategy. `hydrate: 'load'` boundaries hydrate immediately —
on a default SPA-SSR page that degenerates to exactly today's single walk, so
the common path pays nothing. The `beforeHydrate → false` hook is retained
unchanged as the resumability escape hatch for future packs.

#### 1.3 The core seam: `resolveBoundary` (the one contract revision)

A new server plugin hook that runs **before setup capture**:

```ts
resolveBoundary?(
  vnode: VNode,
  ctx: SSRContext
): Partial<Pick<SSRBoundary, 'flush' | 'hydrate' | 'fallback'>> | undefined;
```

First plugin to return wins (same convention as `handleAsyncSetup`). Core
consults it before touching `vnode.type.__setup`, which is precisely the seam
#122 asks for: a pack returning `{ flush: 'skip', fallback }` suppresses the
server render and records the boundary for client-side mounting.

This **supersedes `handleAsyncSetup`** (`'block' | 'stream' | 'skip'`) — it is
the same decision, currently made too late (at async-setup time, after setup
has been captured) and with only the flush axis. Folding it in rather than
adding a second hook keeps one decision point; this is the single deliberate
break to the frozen plugin-hook contract, taken pre-1.0 under the no-compat
stance. Marker formats (`<!--$c:ID-->`, `<!--t-->`, `<!---->`), the remaining
hook order, and `afterRenderComponent`'s `''`-for-streamed convention stay
frozen. (Keeping both hooks instead is open question 2.)

### 2. The request-lifecycle contract

`renderDocument` currently owns the document; this section grows it to own
the request.

#### 2.1 Status & redirects

The shell promise already exists (`renderDocumentToNodeStream` returns
`{ stream, shell }` so the status can be decided before the first byte). What
is missing is the app-side signal. Proposal: a per-request response seam on
the SSR context, surfaced as a composable:

```ts
const res = useResponse();     // no-op outside SSR (returns an inert object)
res.status(404);
res.redirect('/login', 302);   // short-circuits: shell resolves with the redirect
res.header('cache-control', 'no-store');
```

Collected on `SSRContext` (per-request, like head), readable from the shell
promise result. The router SSR contract (§3.2) feeds this — a route miss sets
404, a guard sets a redirect — but the seam is router-agnostic.

#### 2.2 Errors, end to end (the server half of #135)

- **Per-component render errors reach the app.** A failed component/boundary
  routes to `DocumentOptions.onError(err, info)` with
  `info: { componentId, boundaryId?, phase: 'shell' | 'stream' }`. The
  rendered HTML for the failure is a configurable
  `renderError(err, info) => string` — default: dev renders a diagnostic box,
  prod renders an empty boundary comment. The hard-coded red div is deleted.
- **`errorScope` on the server.** A server-side throw below a scope renders
  that scope's `fallback(e, retry)` HTML in place — same visual contract as
  the client. The boundary is marked in the boundary table so the client
  hydrator wires `retry` to a real remount + client re-render after
  hydration (the scope's pinned contract from #135 §4, honored
  cross-environment).
- **Data errors already have a home:** a keyed `useData` rejection renders
  `match`'s `error` arm server-side (rfc-async §6); nothing new needed.

#### 2.3 Edge portability as a tested guarantee

- Split Node-only APIs into a **`./node` entry** (`renderToNodeStream`,
  `renderDocumentToNodeStream`); `./server` becomes WinterCG-clean — no
  top-level `node:` imports on the string/Web-stream/document-Web-stream
  paths.
- Document the isolation guarantee as a contract: **per-request `SSRContext`
  is the isolation mechanism; AsyncLocalStorage is never required** (it is
  only the best-effort backstop for user code reading `getCurrentInstance()`
  after an `await` — dev-warned per `rfc-use-async.md`'s async-context
  section).
- CI gains an edge smoke test (workerd or equivalent) rendering the reference
  example through the Web-stream document path — F8 was exactly the class of
  bug that only a non-Node runtime catches.

#### 2.4 Head, graduated

`useHead` becomes part of the document contract: `htmlAttrs`/`bodyAttrs`,
`base`, `noscript`, and priority/ordering control; `escapeAttr` escapes
`<`/`>` as well; script/style raw content requires an explicit
`innerHTML:`-style opt-in and is never emitted raw by default. Collection
stays on the per-request context (the F3 fix); injection stays automatic only
under the document APIs.

### 3. The last mile

#### 3.1 `@sigx/vite` SSR mode

The plugin today handles module-singleton hygiene (`ssr.noExternal`, dedupe)
and HMR. It gains an SSR mode:

- **Dev**: middleware wiring (`transformIndexHtml` + `ssrLoadModule` +
  stack-mapped error overlay) so the dev server is
  `createServer` + one plugin call, not sixty hand-written lines.
- **Build**: orchestrated client + server builds emitting the **ssr-manifest**.
- **Asset preloads**: `renderDocument` gains an `assets` option fed by the
  manifest; every boundary chunk rendered during the walk emits
  `<link rel="modulepreload">` (+ stylesheet links) into the shell. This
  deletes the manual-preload sharp edge in `entry-client.tsx` and closes the
  deferred F9 item — and it is what makes `<Defer>` + islands feel native
  rather than assembled.
- **`sigxIslands()`**: the Vite plugin the islands manifest option already
  anticipates (component name → `{ chunkUrl, exportName }`).

#### 3.2 Router SSR contract (spec'd here, built in the router repo)

Same precedent as the `@sigx/store` adapter in `rfc-use-async.md`: core specs
the contract, the router repo implements it against public seams.

- The per-request pattern in `examples/spa-ssr`
  (`app.defineProvide(useRouter, () => createRouter(parseUrl(url)))`) is
  promoted from convention to documented API.
- Route resolution exposes the matched route's **lazy chunk refs** (feeding
  §3.1 preloads) and **status/redirect intent** (feeding §2.1).
- Client entry: the router preloads the matched route's chunk before
  `hydrate()` — automatically, inside the contract, not as user code.

#### 3.3 `createRequestHandler` reference

One copyable, documented request handler (dev + prod paths) built only on
public API — the "framework experience" without a framework. Where it lives
(`@sigx/vite`, a `@sigx/server-renderer/node` helper, or a documented
template) is open question 6. It is explicitly **not** a meta-framework: no
file-system routing, no conventions beyond the seams in this RFC.

## What this RFC does not do

- **Server functions / actions (RPC).** The value-first async RFC's manual
  writes (#135: `useAction` + `.run`) will eventually want a "fetcher
  runs on the server" transport. That is a compiler + transport problem — a separate,
  future RFC. Named here so reviewers see the door, not designed here.
- **Resumability.** The `beforeHydrate → false` seam already permits a
  Qwik-style pack; no design now.
- **A meta-framework.** sigx ships the platform contract + first-party packs
  (islands, head, vite-ssr, router contract). Meta-frameworks stay
  third-party — viable precisely because the seams are public and frozen.

## Compatibility

- Marker formats and the streaming wire protocol (`$SIGX_REPLACE`,
  `$SIGX_APPEND`) unchanged.
- `__SIGX_ASYNC__` wire format unchanged; `__SIGX_ISLANDS__` is replaced by
  the boundary table (pre-1.0; islands is an external companion until #119
  lands, so the blast radius is one pack we own).
- One plugin-surface break: `handleAsyncSetup` → `resolveBoundary` (§1.3).
- `renderToString` / `renderToStream` / `renderToNodeStream` / `createSSR` /
  document APIs: additive only, except `renderToNodeStream` and
  `renderDocumentToNodeStream` moving to the `./node` entry (§2.3).

## Phasing

- **Phase 0:** this document.
- **Phase 1 — Boundary model:** `SSRBoundary` + `resolveBoundary` seam
  (supersedes `handleAsyncSetup`; resolves #122); unified boundary table +
  shared pluggable serializer; islands refactored onto the model (after
  #119); per-boundary selective hydration as the hydrator (root-walk fast
  path preserved).
- **Phase 2 — Request lifecycle:** `useResponse` (status/redirect/headers);
  per-component error routing + `renderError` + server `errorScope`
  semantics; `./node` entry split + edge CI smoke test; head upgrade.
- **Phase 3 — Last mile:** `@sigx/vite` SSR mode + ssr-manifest preloads +
  `sigxIslands()`; router SSR contract (built in the router repo);
  `createRequestHandler` reference; `examples/spa-ssr` collapses to the new
  integration as the end-to-end proof.

Sequencing: both prerequisites have merged — #136 (the value-first async RFC
this RFC keys off: `<Defer>`, `errorScope`) and #119 (islands in-tree) — so
Phase 1 is unblocked once this RFC is approved. Each phase = its own issue →
worktree → PR → Copilot review → merge.

## Open questions

1. **Blob layout** — boundary table as its own `__SIGX_BOUNDARIES__` script
   beside `__SIGX_ASYNC__` (proposed: concerns stay independently versioned),
   or one merged `__SIGX_SSR__` blob with sections?
2. **`resolveBoundary` supersedes `handleAsyncSetup`** (proposed: one
   decision point, one deliberate break) — or keep `handleAsyncSetup` as a
   deprecated alias for one release even pre-1.0?
3. **Hydrate-strategy authoring** — `client:*` directives as the only
   per-component surface (proposed), or also a `hydrate` prop on `<Defer>`
   (`<Defer hydrate="visible">`)? The prop reads well but creates two
   spellings for one axis.
4. **Serializer format** — keep JSON-round-trip semantics with a pluggable
   type-handler registry (proposed: incremental, the store adapter only needs
   plain objects), or adopt a devalue-style rich format (Date/Map/Set,
   references) now, before the Phase-3 cache freezes the wire format?
5. **Islands-mode default** — where does the app say `hydrate: 'never'` by
   default? An option at the hydration entry (`app.hydrate(el, { boundaries:
   'explicit' })`), or implied by installing the islands plugin (today's
   implicit behavior)? Explicit is proposed: package installation should not
   change page semantics.
6. **`createRequestHandler` home** — `@sigx/vite` (it already owns the dev
   server relationship), `@sigx/server-renderer/node`, or a documented
   template in `examples/`? Proposed: `@sigx/vite` for dev/build coupling,
   with the prod handler in `@sigx/server-renderer/node`.
