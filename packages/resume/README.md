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
