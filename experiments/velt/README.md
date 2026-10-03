# sigx on Velt — proof of concept

**Question:** what does it take for sigx to run on [Velt](https://github.com/velt-lang/velt), and is
the performance worth it?

**Answer from this POC:** sigx's server rendering can be written in Velt today. The HTML is
byte-identical to `@sigx/server-renderer`, hydration markers included, so the unchanged sigx
browser client hydrates it. It renders **2–11× faster with ~10× less memory** than sigx on Node.
What stands between this and "write a sigx app once, render it with Velt" is a short, concrete list
of Velt compiler work and sigx API decisions (below).

## What "sigx on Velt" means

Velt is not a JavaScript engine: it is TypeScript syntax compiled to native code, without
`undefined`, proxies, mutable module state or a GC. So sigx cannot be *loaded* by Velt; the server
half of sigx is *re-implemented* in Velt (a JSX provider in Velt's `jsxImportSource` model), and
components are compiled by Velt. The browser keeps running sigx in JavaScript:

```
          shared component source (TS/Velt common subset)
              │                                 │
        velt build                          vite / tsc
              │                                 │
   native server: SSR, state, API      browser: sigx client
   (this POC: sigx/*.vlt)               hydrates the HTML (unchanged)
```

Velt's own TSX design already names sigx as its first intended provider
(velt `docs/internals/design/tsx.md`) and requires framework adapters to live in the framework's
repository, which is why this POC is here.

## What is in this directory

| Path | What |
|---|---|
| `sigx/` | The sigx JSX provider for Velt. `reactivity.vlt`: signals, computed values, effects and batching. `component.vlt`: setup then render. `node.vlt`: the element tree and the SSR renderer. `jsx-runtime.vlt`: the provider contract. `precompile/`: the same provider plus Velt's SSR precompile mode. |
| `app/` | The `benchmarks/` SSR scenarios ported to Velt: the same data (mulberry32 in `u32`) and the same components. |
| `node/reference.ts` | Renders the same scenarios with sigx on Node (`benchmarks/src/scenarios/build.ts`), which is the reference output. |
| `tests/` | `velt test`: reactivity unit tests, plus SSR output tests whose expected strings were taken from real sigx output. |
| `run.sh` | Runs everything end to end: tests, builds, both runtimes, the byte comparison and the timing table. |

```sh
pnpm install && pnpm build            # at the repo root: sigx's prod dist for the Node reference
# Velt: a toolchain on PATH (clang 16+ for --release), e.g. from a velt checkout:
#   cargo build --release -p veltc -p velt_rt && export PATH=$PWD/target/release:$PATH
experiments/velt/run.sh 30            # iterations per scenario
```

## Results

Linux x86_64 VM, 4 vCPUs, Node 22, `velt build --release` (LLVM -O3). Median render time,
including building the tree, for the same input data. The output of every row is byte-identical
across all three columns.

| scenario | bytes | Node + sigx | Velt (generic) | Velt (precompile) |
|---|---:|---:|---:|---:|
| small-page (3 components) | 873 | 0.069 ms | 0.010 ms (7.0×) | 0.006 ms (11.3×) |
| large-table-1k (1k components) | 191 822 | 5.3 ms | 3.2 ms (1.7×) | 1.3 ms (4.1×) |
| large-table (10k components) | 1 950 560 | 72.9 ms | 33.3 ms (2.2×) | 13.0 ms (5.6×) |
| deep-tree (265 720 components) | 12 554 896 | 605.7 ms | 174.7 ms (3.5×) | 164.4 ms (3.7×) |

Peak memory for the whole run (all four scenarios, both table data sets resident): **Node 698 MB,
Velt 67 MB** (79 MB with precompile).

Caveats: this is a shared VM, so Node numbers moved ±30% between runs (the 10k table measured
73–104 ms). These are single-threaded render times. Velt's multi-core request handling, which is
where its HTTP numbers come from, is not measured here. The Velt side has had no tuning (see
"Performance headroom").

## How the provider works

- **Components run lazily, parent first.** `jsxComponent` never runs setup. A sigx component's
  element holds a `setup` thunk that the renderer calls when it reaches it, handing it the
  per-render `Renderer`. This gives sigx's pre-order component ids (`<!--$c:N-->`, the hydration
  anchors). It is also how per-render state (the id counter, the reactive runtime, later
  `provide`/`inject`) reaches components, since Velt has no module-level mutable state.
- **Reactivity carries its context.** JavaScript sigx tracks dependencies through a module-global
  "active subscriber"; Velt forbids that (and runs handlers on many cores). Every `Signal<T>`
  holds its `Runtime` instead, with one runtime per render or app instance. The rest is sigx's
  model: `.value` reads subscribe, writes notify, computed values are lazy and cached, and effects
  are deferred by `batch`.
- **Eager strings, lazy components.** Any subtree without a component is concatenated into one
  string while the JSX is built, so only component boundaries are nodes at render time. In
  precompile mode the compiler turns those subtrees into constant strings with escaped slots.
- **Exact sigx output.** Escaping follows `escapeHtml` (five characters). `<!--t-->` goes between
  adjacent text nodes, also across fragment and part boundaries. `true`, `false` and `null`
  children render as `<!---->` placeholders. Plain function components carry no marker; only
  `component()` instances do. Every one of these rules was checked against real sigx output.

What a component looks like:

```ts
// JavaScript sigx                              // Velt sigx (this POC)
const Counter = component<P>((ctx) => {         function Counter(props: P): JSX.Element {
  const count = signal(ctx.props.start);          return component(props, (ctx) => {
  return () => <p>Count: {count.value}</p>;         const count = ctx.signal(ctx.props.start);
});                                                 return () => <p>Count: {count.value}</p>;
                                                  });
                                                }
```

The setup and render bodies are the same code. The differences are the definition form and
`ctx.signal`; both are on the list below.

## The road from here: what is missing

Tracked in signalxjs/core#745 (the sigx side) and velt-lang/velt#379 (the Velt side, with a
minimal repro for every item). Last verified against Velt `d382199`: still byte-identical, same
speedups. Velt can rerun `run.sh` after a change to check an item.

### Velt compiler and language (to raise upstream; ordered by impact for sigx)

1. **Precompile loses text-node boundaries.** The precompile mode folds `<p>Count: {n}</p>` into one
   string, so a provider cannot emit the `<!--t-->` that sigx's hydration needs between the
   static and dynamic text. This is the biggest performance lever measured here (2.5× on the
   tables). Proposed fix: an optional provider export such as
   `const jsxTextSeparator = "<!--t-->"`, which the compiler inserts between adjacent text parts
   when folding. Until then `sigx/precompile` is only safe for trees without adjacent text
   children (true of every benchmark scenario, not of real apps).
2. **`count.value++` and `+=` on a tracking getter are rejected** ("this call may modify it
   through another argument"), because the getter records a subscriber, which counts as a
   mutation. `count.value = count.value + 1` in two statements works. `state.count++` is the
   most common sigx idiom, so this needs a language answer (for example, getters may mutate
   reference-counted fields).
3. **Module constants must be literals**, so `const Counter = component(setup)` cannot be written.
   Allowing pure calls and closures in `const` initializers (or a dedicated component definition
   form) removes the main syntactic difference from JavaScript sigx.
4. **No proxies or dynamic properties.** sigx's deep object signals (`signal({ count: 0 })`, then
   `state.count++`) cannot be ported as they are. Options: a compiler-derived reactive form of an
   object type (each field a signal), or limiting the shared subset to primitive signals plus
   `toSignals`-style per-field signals. This is the largest semantic gap.
5. **Reference cycles leak without `weak` (semantics stage 3).** An effect's closure captures its
   signals while the signals list the effect. SSR renders run no effects in this POC, but a
   long-lived Velt app state would leak. Interim options: a per-request `velt:arena`, or
   explicit dispose.
6. **The provider contract says booleans and `null` "render nothing"**; sigx renders `<!---->`.
   The provider can already do this; only the contract wording needs to allow it.
7. **Event handler attributes.** `IntrinsicElements` from `velt:jsx` has no `onClick`, and a
   the docs show no way for a provider to extend an imported object type (no intersections or
   mapped types).
   A shared component with handlers will not compile until a provider can declare
   `IntrinsicElements` as "std's plus `on*` handlers" without copying the full list. On the
   server sigx drops handlers, or turns them into resumable `data-sigx-on:*` references.
8. **Style objects.** `style={{ color }}` needs an object type in `AttrValue`; the POC uses
   string styles.
9. **`s += x` is quadratic.** Every append copies the whole string, both `+=` and
   `` `${s}${x}` `` on any variable or field: 100k appends take 3.4 s, push and join takes
   18 ms. The deep tree took 8 minutes until the renderer switched to `string[]` plus `join`.
   Smaller: there is no `Array.shift`.

### sigx side (decisions for this repo)

1. **Define the Velt-compatible component subset**, the "common subset" of Velt's TSX design:
   typed props, `null` instead of `undefined`, no truthiness on numbers or strings, primitive
   signals via `.value`, and children as a prop. This means deciding how `slots.default()` maps
   to the `children` prop that Velt passes.
2. **One source, two compilers.** For the same `.tsx` file to build with Vite for the client and
   with Velt for the server, the client `component()` must accept the Velt definition form (or a
   Vite transform rewrites it), and `.vlt`/`.tsx` naming needs a convention.
3. **The rest of the SSR protocol**: async components and streaming (`data-async-placeholder`,
   matching Velt's `jsxAsyncComponent` and `renderToStream`), the state blob and boundary props
   through `@sigx/serialize`'s wire format (Velt has typed `JSON`), and the islands and resume
   markers (`data-sigx-b`, `data-sigx-on:*`). All of this lives inside the provider, with no new
   compiler work.
4. **Dev loop.** `@sigx/vite` keeps the client: Vite, HMR, the browser bundle. For SSR it proxies
   document requests to a `velt dev` process, which hot-swaps changed server functions while
   keeping state and connections. Production is a single native binary (`velt:http`) serving
   the HTML next to the client assets; it becomes a deploy target next to Cloudflare, Vercel
   and Netlify.

### Performance headroom (not tried yet)

- The generic lowering allocates a `Builder` and an `Element` per intrinsic element. Folding
  attribute strings at compile time, as precompile does, removes most of that.
- Component cost dominates the deep tree (about 0.6 µs per component, and precompile barely
  helps there): two closures and a `SetupContext` per instance. Calling setup without the
  intermediate closures is the first thing to profile.
- Rendering writes into a `string[]`; streaming straight into a `velt:http` response buffer
  (`renderToStream`) avoids the final `join` copy (12.5 MB on the deep tree).

## Suggested next steps

1. In velt-lang/velt#379, the precompile text separator, getter `++`, module constants from calls,
   and extending `IntrinsicElements` are small compiler changes. They unlock precompile mode,
   `count.value++`, the JavaScript-shaped `const X = component(...)` definition and event
   handler attributes.
2. Decide the shared component subset (sigx item 1) and prove it on one example app, rendering
   `examples/spa-ssr`'s pages from Velt and hydrating them with the real client in a Playwright
   check, the same way `pnpm smoke:hydration` does.
3. Port async components and streaming, then the resume and islands markers.
4. Wire `@sigx/vite` to `velt dev` for the dev loop, then add a Velt deployment adapter.
