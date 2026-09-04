# @sigx/resume

**Resumability** for SignalX SSR — the second first-party strategy
pack riding `@sigx/server-renderer`'s public plugin API.

Server pages render fully; the browser ships only a tiny delegation loader.
Event handlers are extracted at build time by `sigxResume()`
(`@sigx/vite/resume`) into lazily-imported QRL chunks that run against a
resumed scope of named signals — component setup never re-runs on load, and
the component chunk itself loads only when a handler writes state
(**upgrade-on-write**):

1. **0 JS on load** — the page's only script is the generated loader entry.
2. **First interaction** — the handler chunk (runtime-free, usually <1 kB)
   loads and runs with `$scope.signals.<name>` rebuilt from serialized state.
   The triggering event is replayed.
3. **State changes** — only then does the component chunk load and that one
   boundary hydrate; buffered writes replay through the live signals.

## Server

The pack installs on the app — `app.use(...)` is the one install shape
(#413). The natural home is the entry-server's per-request app factory; the
manifest comes from `virtual:sigx-manifests` (inlined by the SSR build,
`undefined` under dev, where resume runs manifest-less):

```ts
// src/entry-server.tsx
import { defineApp } from 'sigx';
import { resumePlugin } from '@sigx/resume';
import { resumeManifest } from 'virtual:sigx-manifests';

export function createApp(url: string) {
    return defineApp(<App />).use(resumePlugin({ manifest: resumeManifest }));
}
```

Any render method that receives the App picks the pack up from there —
`createSSR().render(app)`, `createRequestHandler({ app })`,
`createFetchHandler({ app })`.

With a manifest, the document also gets `<link rel="modulepreload">` for the
handler chunk of every resume boundary the request actually rendered
(`ResumeManifest.handlers`, #410) — the bytes arrive off the critical path,
execution still waits for the first interaction, and the loader stays the
page's only script. A page without a resume boundary emits nothing; the
component (upgrade) chunk is never warmed — upgrade-on-write is lazy on
purpose. Dev renders manifest-less, so it preloads nothing there.

Components stamped by the transform (`__resumeId`) become boundaries with
`hydrate: 'never'` — core schedules nothing; the pack's delegation owns all
waking. Fully-extracted components resume through their QRL attributes;
components whose handlers could not all be extracted carry `data-sigx-wake:*`
attributes instead, and the first interaction fully hydrates them (no
replay). A component used with a `client:*` directive belongs to
`@sigx/ssr-islands` — register `islandsPlugin()` first when combining the
packs.

### Single-flight boundary refresh (rfc-server §6.3)

`createBoundaryRefresh` builds the server half of single-flight refresh: a
mutation server function names boundaries to refresh, and the endpoint hands
their client descriptors here to be re-rendered — fresh HTML plus fresh
tracking-signal state in one response, so a never-hydrated boundary can
update without ever loading its chunk.

```ts
import { createBoundaryRefresh } from '@sigx/resume/server';

const renderBoundaries = createBoundaryRefresh({
    plugins: [resumePlugin({ manifest })], // or omit and let `app` carry them
    components: { Tracker, Cart }          // registry key → server component
});
// handleServerFnRequest(request, { fns, renderBoundaries })  (wire phase of #313)
```

**`refreshComponents` is wired in two places, and both must agree.** The
prod entry (`entry.cloudflare.ts` / `entry.node.ts` / …) builds
`createBoundaryRefresh({ components })` for `handleServerFnRequest`, and the
dev half is the module `sigxServer({ renderBoundaries: '/src/dev-refresh.ts' })`
points at (`examples/resume/src/dev-refresh.ts`). Both take the same
export-name-keyed registry (`examples/resume/src/entry-server.tsx` exports
it once as `refreshComponents` for that reason). A component missing from
the registry is not an error: its descriptor is declined and the boundary
converges through `$cache` invalidation — one round trip slower, and the
chunk loads after all. Missing it in only one of the two places is the
classic "works in dev, not in prod" (or the reverse).

**The `plugins:` form never sees app-level DI** (rfc-1.0 §4.3). It builds
its re-render from the listed plugins only — `serverPlugin({ types })`,
`provideTypeHandlers`, anything `app.use` installed on the page's app, is
invisible to it, so a boundary whose props or state need those handlers
re-renders without them. An app that installs any of those passes the app
factory instead, and the app's plugins win:

```ts
const renderBoundaries = createBoundaryRefresh({
    app: () => createApp(),      // the entry-server's factory — plugins, type handlers and all
    components: refreshComponents
});
```

(The callback receives whatever the endpoint passes through — its
`ServerFnContext` when riding `handleServerFnRequest({ renderBoundaries })` —
for a factory that needs the request.)

`plugins:` stays the documented default for the zero-JS examples because
those pages have no app to hand.

The registry is explicit — same posture as the server-fn registry, never
ambient. Descriptors the re-render cannot honor (unknown key, a snapshot the
render can't reproduce, a component failure) are omitted, never errors: the
mutation already succeeded, and declined boundaries converge through
`$cache` invalidation. Boundaries whose usage-site props don't serialize
(children/slots/render props) are stamped `refreshable: false` at initial
SSR and decline the same way.

The client half is automatic: `@sigx/resume/client` stamps the
`__SIGX_SERVERFN_BOUNDARIES__` seam when it loads, so any
`invalidates`-declaring mutation sends the page's boundary inventory
(each boundary's recorded `useData` deps included — the endpoint admits
on deps ∩ `invalidates`) and
applies the fresh entries — a never-hydrated boundary is DOM-swapped
(delegation re-wires itself off the fresh attributes; its chunk never
loads), an upgraded one gets live-signal writes. An in-flight upgrade,
buffered writes, or a focused text field inside the boundary all win over
a refresh — drops converge through cache invalidation. In dev, pass
`sigxServer({ renderBoundaries: '/src/dev-refresh.ts' })` a module
exporting the same `createBoundaryRefresh` result (see
`examples/resume/src/dev-refresh.ts`).

## Client

Two postures, and picking the wrong one is silent — so pick deliberately.

### Coexisting with a hydrated app (the common case)

An app that has a root — a shell, a router, ordinary interactive components —
and *also* wants some resumable components on the page. Install the plugin on
the **server** app, and on the client import only the generated loader entry:

```ts
// entry-client.tsx
import { defineApp } from 'sigx';
import 'virtual:sigx-resume/entry';   // the delegation loader — that's it
import { App } from './App';

const app = defineApp(<App />);
app.hydrate(document.getElementById('app')!);
```

Nothing else is needed, and that is the point: `hydrate()` walks the root as
usual and **skips** resume boundaries on the way past — they are recorded
`hydrate: 'never'` by the server plugin — while everything around them
hydrates normally. The loader wakes a boundary on first interaction.

You *may* also `app.use(resumePlugin())` on the client (it is harmless — the
client half only registers provides), but it is not required.

> **Before #483 this was a trap.** `resumePlugin()`'s install declared
> `boundaries: 'explicit'` unconditionally, which switches `hydrate()` to the
> no-root-walk path. Combined with `hydrate: 'never'` records, that meant an
> app installing the plugin on the client hydrated **nothing at all** — a dead
> shell, with no error and no warning. The plugin no longer declares a mode
> unless you ask for one.

### App-less resumable pages

A page whose entire bootstrap is the generated loader entry — no root app, no
hydration walk, ~1 KB of JS. Nothing to configure; just don't create an app.
If you *do* have an app and deliberately want no root walk (the islands
posture), say so explicitly:

```ts
app.use(resumePlugin({ boundaries: 'explicit' }));
```

## Writing resumable components

Ordinary sigx components in resume modules (`*.resume.tsx` or under a
`resume/` directory — configurable on the Vite plugin):

```tsx
export const Counter = component<{ label: string }>((ctx) => {
    const count = ctx.signal(0);
    return () => (
        <button onClick={() => count.value++}>
            {ctx.props.label}: {count.value}
        </button>
    );
});
```

No QRL API, no registration — the transform derives everything. Named =
transferred: signals declared as `const x = ctx.signal(…)` are keyed by their
declaration name and serialized; anything else stays local. A handler is
resumable when its captures can be expressed through the resumed scope (named
signals, `ctx.props` reads, imports, globals); anything else (loop variables,
setup helpers, `ctx.emit`, …) makes the whole component fall back to
wake-on-interaction — first interaction hydrates it, with a build-time
warning naming the capture.

### The contract

These are the rules the transform and the runtime rely on. Transform-time
violations are **build errors** (rfc-1.0 §4.5) — never a warning that leaves
the component silently broken in prod; runtime ones are `__DEV__` warnings,
because a throw in the browser would take the page down.

**Build errors (`sigxResume()`):**

- **Named exports only.** A component that leaves the module as
  `export default` — `export default component(...)`,
  `export default Counter`, `export { Counter as default }` — is a build
  error: `resume components must be named exports`. A default export has no
  name to key the registry and manifest, so it used to be silently
  non-resumable. A default export that is *not* a component (a config
  object, a helper) is fine; so is a named export that is *also* aliased to
  default.
- **Export names are app-wide keys.** The export name is the `__resumeId`
  — the registry key on the client and the manifest key on the server — so
  two resume modules exporting the same name is a build error naming both
  files. Rename one. (Names in non-resume files don't count.)
- **`$scope` and `$el` are reserved.** Inside a resumable handler, `$scope`
  *is* the resumed scope (handlers are re-emitted as `($scope, …) => …`)
  and `$el` the delegated element. A handler that binds either — as a
  parameter, a local, a named signal or a destructured prop — or reads it
  as a free reference is a build error. `obj.$scope` and `{ $scope: 1 }`
  (member and key positions) are not references and stay allowed.

**Dev warnings (runtime, `@sigx/resume/client`):**

- **Single-element root.** The upgrade hydrates the element immediately
  before the boundary's trailing marker as the component's root, so a
  resumable component must render exactly one root element. A fragment root
  does not match that element, and a root with no element at all (text
  only, or a conditional that rendered nothing) leaves the boundary **not
  upgraded**: the QRL ran and its write is buffered, the scope resets so the
  next write retries — against the same DOM, with the same result — and the
  page never updates. Dev warns
  `Cannot upgrade boundary N: no element before its marker`.
- **Renaming a signal drops buffered writes.** Writes made before the
  component chunk loads are buffered by *name* and replayed once the live
  signal exists. If the component no longer declares a named signal of that
  name (renamed since the page was rendered — a deploy in between), the
  buffered value is dropped; dev warns `Buffered write to "x" has no live
  signal after upgrade`.
- **Wake swallows the triggering event.** A component in wake-on-interaction
  mode (any ineligible handler, or `ctx.slots`) fully hydrates on its first
  interaction and does **not** replay that event — its listeners only exist
  after hydration. If the first click must count, keep the handler
  resumable (see `DealOfTheDay` in `examples/storefront` for the pattern),
  or design the first interaction to be harmless to lose.

Server-side, `refreshComponents` must be wired in both the dev and the prod
refresh entry — see "Single-flight boundary refresh" above.

## Verification

The full ladder is verified in a real browser: `examples/resume/smoke.mjs`
asserts (via JS coverage — execution, not fetches) that only the loader
executes on load, the first click replays through its QRL and upgrades on
write, read-only handlers never execute their component chunk, and
wake-on-interaction hydrates without replay. The server half is
WinterCG-clean: after `pnpm build`, `pnpm test:edge` renders a resumable
boundary from the prod dist with `node:` imports forbidden.

Platform findings from building this pack: `docs/resume-stress-test-findings.md`.

## Credits

The resumability model — serialized handler references, global event
delegation with replay, and no client re-execution of component setup — was
pioneered by [Qwik](https://qwik.dev/). This pack adapts it to sigx signals
and the `@sigx/server-renderer` plugin platform.
