# The resumability stress test — platform findings (#241)

`@sigx/server-renderer` claims to be a strategy-agnostic plugin platform, with
`@sigx/ssr-islands` as the first-party reference pack. To test that claim for
real, we built a second, architecturally different strategy pack:
`@sigx/resume` — resumability (serialized handler references in the HTML, a
sub-kilobyte delegation loader, no client re-execution of component setup,
component code loaded only when state actually changes). If the public plugin
API could express that, the platform claim holds; where it couldn't, each gap
becomes a finding.

Verified end to end in a real browser (`examples/resume/smoke.mjs`): the only
script that executes on page load is the ~500 B loader; the first interaction
loads a runtime-free handler chunk and replays the triggering event; a state
write loads and hydrates exactly one boundary; read-only handlers never cost a
component chunk.

## Verdict

**The claim substantially survives.** The entire pack rides public seams:

| Need | Public seam that carried it |
|---|---|
| Claim components, opt out of core scheduling | `resolveBoundary` → `{ hydrate: 'never' }` (skipped by every core scheduling path) |
| Capture named-signal state during SSR | `transformComponentContext` (signal factory swap) + `afterRenderComponent` / `onAsyncComponentResolved` → `record.state` |
| Ship QRL references in the HTML | ordinary string props — `serializeOpenTagProps` renders `data-sigx-on:*` verbatim and drops `on*` (guarded by `resume-attr-guard.test.tsx`) |
| Per-element boundary identity | a transform-injected dynamic prop reading a context field the pack sets (`data-sigx-b={ctx.$sigxB}`) — lexical ownership, no core hook |
| Load component chunks on demand | core's `loadBoundaryComponent` / registry / `__registerIslandChunk` |
| Hydrate one boundary on upgrade | core's exported `hydrateComponent` + the client-plugin `transformComponentContext` for state restore |
| Streaming | nothing extra — the table patch re-emission (`onAsyncComponentResolved`) and document-level delegation make streamed content interactive on arrival |

The compile transform absorbed everything that would otherwise have required
per-element render hooks in core's hottest loop — the platform's intentional
boundary: **packs that need per-element metadata put it there at build time,
not at render time.**

## Gaps found (each small, none architectural)

1. **`ResolvedBoundary` cannot name a boundary.** Core derives
   `record.component` from `__islandId || __name`; a pack with its own stamp
   vocabulary must mutate the record in `transformComponentContext`. Found by
   the browser smoke: `loadBoundaryComponent` refuses anonymous records, so
   neither dev-registry nor prod-chunk resolution worked until the pack set
   `record.component` itself. *Proposed seam: add `component` to
   `ResolvedBoundary`.*
2. **`afterRenderComponent`'s docstring lies.** It claims the hook "receives
   the accumulated HTML string… can transform it" — the implementation passes
   `''` and appends the return value (render-core buffers into one shared
   string; per-component interception would defeat streaming). *Fix the doc;
   a true HTML-transform hook is deliberately not proposed.*
3. **Single-boundary hydration helpers are private.** `findBoundaryMarker` and
   the container-location walk (`hydrateBoundaryInPlace`) are exactly what
   upgrade-on-write needs; the pack replicates ~30 lines. *Proposed seam:
   export them from `@sigx/server-renderer/client`.*
4. **No CSP nonce anywhere.** `emitBoundaryTable`, `boundaryPatchJs`, and the
   streaming scripts emit bare `<script>` tags — strict-CSP apps can't use
   islands or resume. *Proposed seam: `SSRContextOptions.nonce` threaded
   through `serialize.ts` and `streaming.ts`.*
5. **The tracking/restoring signal pair is duplicated.** The capture/restore
   mechanism is strategy-agnostic, but it lives in `@sigx/ssr-islands`, so
   resume carries a copy. *Proposed seam: hoist into `@sigx/server-renderer`
   (e.g. a `/state` sub-entry); both packs re-export.*
6. **Boundary-chunk preloading is unconditional.** The document engine
   modulepreloads every recorded `chunk.url` from the shell. For islands
   that's right (the chunk will load); for resume it's a speculative warm —
   acceptable as a prefetch hint (bytes, not execution — the browser smoke
   asserts execution), but packs may want to opt out per record.

## Transform-layer findings (for future pack authors)

- **Run `enforce: 'pre'`** if your transform reads JSX: rolldown's
  full-bundle mode compiles JSX natively *before* normal-phase transforms.
  (`sigxIslands()` survives on regexes that tolerate compiled output; AST
  extraction does not.)
- Rolldown can run `transform` more than once per module (scan + build) —
  make transforms idempotent AND never let the echo pass clobber cached
  analysis.
- oxc ESTree spans are UTF-16 string indices, not UTF-8 byte offsets.
- Handler chunks stay runtime-free only if the extraction forbids captures of
  same-file module scope — eligibility rules are the chunk graph.

## What resumability deliberately does NOT do here

No closure serialization (Qwik's optimizer territory): handlers capturing
view-scope locals (loop variables) fall back to wake-on-interaction — full
hydration on first interaction, no replay, dev-warned at build time. That
boundary is honest: "named = transferred" extends from state to handlers.
