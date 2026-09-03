# RFC: 1.0 — the stability contract

Status: **proposed**. Tracking: signalxjs/core#633 (phase 3), umbrella
signalxjs/core#676.
Ends the "pre-1.0, no-compat" stance every earlier RFC opens with: from
`v1.0.0` on, what a package exports is a promise, and the promise is
semver's.

Everything below is stated against the code as it exists at `9dea6e6`
(v0.15.6), with `file:line` evidence. Where this document and the code
disagree after 1.0.0 ships, the code is a bug.

---

## Problem — three things 1.0 has to say, and one it has to fix

1. **What is frozen.** Every package has a root entry, some have subpaths,
   two have `/internals`, and `docs/seams.md` lists thirteen `globalThis`
   seams that packs coordinate through. Which of those is a contract and
   which is plumbing has never been written down; consumers found out by
   breaking (#449: `@sigx/store` depends on `peekRestored` through a door
   labelled "may change without notice", `runtime-core/src/internals.ts:1-9`).
2. **What semver means here.** `CHANGELOG.md:5` says breaking changes may
   land in minors while on `0.x`. That sentence ends at 1.0.0 and needs a
   replacement that also covers the things semver does not settle on its
   own: Node and TypeScript floors, deprecations, wire formats.
3. **Which packages the version line covers.** #633 phase 3 proposed freezing
   only the base singleton (`@sigx/reactivity` + `@sigx/runtime-core`) and
   letting packs keep a faster cadence. Decided differently, below (§1.1).
4. **The duplicate-copy failure class** (#633). `^0.Y.0` is single-minor by
   definition, so two ecosystem packages one core minor apart cannot share
   a copy of reactivity, and today every package carries core as a plain
   `dependency` (`packages/runtime-core/package.json`: `dependencies:
   { "@sigx/reactivity": "workspace:^", "@sigx/serialize": "workspace:^" }`,
   no `peerDependencies`; the same shape in runtime-dom, cache,
   server-renderer, resume, server). Two
   copies of reactivity is a silent install and an incomprehensible
   runtime. 1.0 is what makes the range wide enough to dedupe; peers are
   what make the app own the copy; a guard is what makes the failure loud
   in the meantime.

---

## §1 Scope of the freeze

### 1.1 One version line, all fourteen packages

All fourteen packages in `docs/ecosystem.json` → `corePackages` ship
`1.0.0` together and stay on one version line, as today
(`scripts/bump-version.js`, `scripts/publish.js` `PACKAGES`).

Considered and rejected: #633's "freeze the base singleton, packs keep
their cadence". Two reasons.

- A pack's public API is what an application is written against. An app
  on `@sigx/resume` cares about `resumePlugin()`'s contract exactly as much
  as about `signal()`'s; a 1.0 that only promises the bottom two layers
  promises nothing to the app.
- Split cadence means split tooling: `bump-version.js`, `publish.js`,
  `verify-pack.js`, the ecosystem manifest, the release runbook and
  `release.yml` all assume one version. The cost is real and the benefit
  (packs iterate faster) is what minors are for.

The peer-dependency argument in #633 does not need the split: it needs
wide ranges, which `^1.0.0` gives every package.

### 1.2 What is public — the three tiers

**Tier A — the public API. Semver applies in full.**

- Every value and type exported from a package's root entry
  (`packages/<pkg>/src/index.ts`) and from every subpath listed in its
  `package.json` `exports` **except** `./internals`.
- The compile-time surface: the `sigx` / `@sigx/runtime-core` JSX runtime
  and the `JSX` namespace contribution each package makes (§4.1); the
  `virtual:sigx-*` modules `@sigx/vite` provides (`packages/vite/client.d.ts`);
  the `client:*` island directives; the `*.server.ts` file convention and
  the `serverFn` / `serverStream` option forms; the `data-sigx-*`
  attribute names resume stamps (an app's CSP and tooling see them).
- Documented behaviour: what a public function does with an input it
  already accepted. A change to what an existing accessor returns is
  `Changed`, not `Added` (AGENTS.md conventions — #476/#534 is the
  precedent).
- The SSR plugin contract a strategy pack rides: `SSRPack`, `SSRContext`'s
  typed methods (`currentComponentId()`, `boundaries()`), `createSSRContext`,
  the plugin hooks (`rfc-ssr-platform.md`). Third-party packs are written
  against this, so it is Tier A even though only first-party packs use it
  today.

**Tier B — the pack contract. Additive in minors, breaking only in majors,
but narrower than Tier A.**

- The `globalThis` seams registered in `docs/seams.md`. Each seam's row
  (name, direction, writer, reader, contract) is the promise; a seam
  without a row does not exist. Seams are how third-party packs coordinate
  without importing each other, so their *shape* is frozen — but they are
  reached only through the one accessor the row names, and a pack that
  reads the global directly is outside the contract (the `@sigx/actors`
  direct read of `__SIGX_SERVER_APP__` noted in #628 is a violation to fix
  there, not a guarantee here).
- The DI tokens (`provideAsyncEngine`, `provideTypeHandlers`) and the
  engine interfaces behind them (`rfc-async.md` §7).

**Not covered. May change in any release, called out in the changelog
when they do.**

- `./internals` subpaths (`@sigx/runtime-core/internals`,
  `@sigx/reactivity/internals`). Anything a first-party pack needs from
  them is promoted before 1.0.0 — #449 does that for the restore
  accessors, #651 already did for `deepTrack` — so that at 1.0.0 no
  first-party pack imports `/internals` for anything a third-party pack
  could not also get publicly. The #416 guard test stays the enforcement.
- Wire formats between server and client: the SSR state blob
  (`__SIGX_ASYNC__`, `__SIGX_BOUNDARIES__` payloads), resume's
  `data-sigx-on:*` handler descriptors and the `$sigxB` boundary props, the
  server-fn envelope and its `$cache`/`$boundaries` fields, the stable
  symbol encoding. Both ends ship from the same build; a page rendered by
  1.2 is hydrated by 1.2. The *names* are Tier A (an app sees them); the
  *bytes* are not.
- `__DEV__`-only warning text, the devtools hook payloads
  (`__SIGX_DEVTOOLS_HOOK__` carries its own `version: 1` field and
  versions itself), bundle sizes, benchmark numbers, `dist/` file layout,
  and the *structure* of exported types beyond what an annotation on a
  public name observes — a TypeScript brand's spelling is not public
  (#535 exports aliases precisely so nobody has to depend on one).

### 1.3 The freeze date

The API is frozen at `v1.0.0-rc.0`. Between rc and 1.0.0 only bugs found
by the ecosystem alignment are fixed; a breaking change found then either
ships in rc.1 with its own migration note or waits for 2.0.

---

## §2 Semver policy from 1.0.0

Replaces `CHANGELOG.md:5`'s `0.x` sentence.

- **Breaking changes only at a major.** A breaking change is anything that
  makes an existing, non-deprecated, Tier A or Tier B usage fail to
  compile, throw, or observably do something different — including a
  stricter type, a warn that becomes a throw, and a changed return value
  for an input that already worked.
- **Deprecate before removing.** A Tier A API slated for removal is marked
  `@deprecated` with the replacement named, warns once under `__DEV__`
  when called, and keeps working through at least one minor before the
  next major removes it. No compat shims for things that never shipped
  (AGENTS.md conventions) — that rule is about unreleased designs and
  stands.
- **Node**: the floor is the oldest Node LTS still in maintenance at the
  time of a release. Raising the floor to drop an EOL Node line is a
  **minor**, announced in the changelog one minor ahead. Dropping a
  supported line is a major.
- **TypeScript**: raising the minimum supported TypeScript version is a
  **minor**, announced one minor ahead, and never past the latest stable
  minus two minors.
- **Vite**: `@sigx/vite` peers on a Vite major (`vite: ">=8.0.0"` today).
  Following a new Vite major is a **minor** as long as the previous one
  keeps working; dropping one is a major.
- **Security fixes** may tighten behaviour in a patch (a narrower accepted
  input, an added guard) when the loosened behaviour was the vulnerability;
  the changelog says so under `### Security`.
- **Changelog**: every user-facing change lands in the root `CHANGELOG.md`
  under `[Unreleased]` in the PR that makes it, with the issue number,
  under `Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` /
  `Security` — and `Changed` is read with the AGENTS.md rule: tabulate old
  vs new for every input that already worked.

---

## §3 Dependencies: the app owns the copy (#633 phase 2)

### 3.1 Singleton packages

Two packages carry per-process state that must exist exactly once:
`@sigx/reactivity` (the tracking context, the batch queue, brands) and
`@sigx/runtime-core` (the current instance, app contexts, DI tokens, the
async restore blob accessors). Everything else is either stateless
(`@sigx/serialize` — two copies are harmless) or reaches its state through
one of those two.

### 3.2 The shape

| Package | Core deps as `dependencies` | Core deps as `peerDependencies` (`^1.0.0`) |
|---|---|---|
| `sigx` (the app install) | `@sigx/reactivity`, `@sigx/runtime-core`, `@sigx/runtime-dom` | — |
| `@sigx/runtime-core` | `@sigx/serialize` | `@sigx/reactivity` |
| `@sigx/runtime-dom` | — | `@sigx/reactivity`, `@sigx/runtime-core` |
| `@sigx/server-renderer` | `@sigx/serialize` | `sigx` |
| `@sigx/ssr-islands`, `@sigx/resume` | `@sigx/serialize` (resume) | `sigx`, `@sigx/server-renderer` |
| `@sigx/cache` | — | `@sigx/reactivity`, `@sigx/runtime-core` |
| `@sigx/server` | `@sigx/serialize` | `sigx` |
| `@sigx/vite` | — | `sigx` (`^1.0.0`, was `*`); the four strategy/server packs stay optional peers, tightened from `*` to `^1.0.0` |
| `@sigx/cloudflare`, `@sigx/vercel`, `@sigx/netlify` | — | `@sigx/vite` (`^1.0.0`, was `*`) |
| `@sigx/serialize`, `@sigx/reactivity` | — | — |

The rule in one line: **`sigx` is the one package that brings the
singletons in; every other package peers on them.** An application installs
`sigx` (plus the packs it uses) and owns the single copy; a library — any
ecosystem package, and every core pack — declares what it needs as a peer
and resolves against the app's copy. A lagging library surfaces as a named
unmet-peer warning at install instead of a second copy at runtime.

Locally every peer is also a `devDependencies: "workspace:^"` entry so the
monorepo keeps building and testing against source; `pnpm publish` rewrites
`workspace:^` to the concrete `^1.0.0` in every dependency field (#363's
`verify-pack` assertion, PR-3, is what proves no literal `workspace:` or
`catalog:` reaches a tarball — in `peerDependencies` included).

`@sigx/serialize` stays a plain `dependency` wherever it is used: it is the
zero-dependency leaf, duplicates are harmless, and forcing every app to
install it by hand buys nothing.

### 3.3 The ecosystem side

Consumer repos (`docs/ecosystem.json`) move core from `dependencies` to
`peerDependencies: "^1.0.0"` + `devDependencies: "catalog:"` in the
alignment PR the `1.0.0` rollout opens. That is a repo-template change
(`sync-core.mjs` writes the peer block; `check-catalog.mjs` asserts it) and
one line in `docs/ecosystem-release.md`. Apps keep `sigx` in
`dependencies`.

### 3.4 The guard (#633 phase 1)

Each singleton package stamps one hidden-class seam on first evaluation:

| Seam | Writer | Value |
|---|---|---|
| `__SIGX_REACTIVITY__` | `@sigx/reactivity` module init | `{ version: string, url: string }` |
| `__SIGX_RUNTIME_CORE__` | `@sigx/runtime-core` module init | `{ version: string, url: string }` |

A second copy evaluating finds the stamp and **throws under `__DEV__`**,
naming both versions and both module URLs; in prod it warns once and
continues (a prod page that half-works beats one that is blank, and the
dev throw is what catches it before deploy). Both rows go into
`docs/seams.md` as hidden-class seams with exactly one accessor each.

Rejected: `Symbol.for`-tagged brands (the graphql-js pattern). Making
`isSignal` recognise a foreign copy's signals would let two copies
*half*-work — tracking would still split across two contexts — and the
point of the guard is that a duplicate fails loudly, not politely. Brands
stay module-local `Symbol()`s.

---

## §4 Contract decisions bundled here, so they are decided once

Each of these is an issue whose *code* is small but whose *answer* freezes
at 1.0.0. The answer is recorded here; the implementation PR references
this section.

### 4.1 The JSX namespace — who owns what (#529)

Today `packages/runtime-core/src/index.ts:161` imports `./jsx-types.d.ts`,
a global `declare namespace JSX` carrying `Element`, `IntrinsicAttributes`,
`ElementChildrenAttribute` and an `IntrinsicElements` index signature of
`any`. `tsc` never emits it (declaration files under `rootDir` are not
copied), yet `dist/index.d.ts` keeps the import — a dangling module
reference that only `skipLibCheck` hides. Meanwhile `@sigx/runtime-dom`
(`src/jsx.tsx:168-`) declares the real, typed `IntrinsicElements` and its
own `IntrinsicAttributes` by global merging.

Decided:

- **`@sigx/runtime-core` owns the platform-neutral base of the global JSX
  namespace** — `Element`, `IntrinsicAttributes` (`key`),
  `ElementChildrenAttribute` — and ships it in its emitted types (move the
  declarations into an emitted `.ts` module that `index.ts` imports for
  side effects, or into `jsx-runtime.ts`'s own `declare global`).
- **`@sigx/runtime-core` never declares `IntrinsicElements`.** A platform
  renderer (`@sigx/runtime-dom`, `@sigx/runtime-terminal`, lynx) declares
  the elements it can render, by global merging, exactly as runtime-dom
  does now. The `any` index signature is deleted: it would make `<anything>`
  typecheck for every consumer and silently defeat runtime-dom's typing the
  moment it *did* reach them. runtime-core's own tests get a test-only
  ambient `IntrinsicElements` (`__tests__/env.d.ts`, not in `files`).
- Consumers configure `jsxImportSource: "sigx"` (apps) or
  `"@sigx/runtime-core"` (headless renderers), as the examples already do.

### 4.2 `ServerFeatureContext.enter()` stays (#628)

`serverFeature().enter(request, fn, options?)` (`packages/server/src/app-config.ts:346-350`;
`options` is `{ allowAnonymous?: boolean }`)
has no consumer in the org today and is a five-line wrapper — but it is the
**only public path** for a feature that owns a raw `Request` to build a
context and run the prelude: `createRequestContext` is internal
(`packages/server/src/server/index.ts:30`). Removing it would push the
first such feature (actors' HTTP surface) into `/internals`. It stays,
documented as "wire entry for a feature that owns the `Request`;
`prelude()` for one that already holds a context". The additive members
#628 proposes (`configured`, `wrap()`, the identity gate alone) are 1.x.

The middleware cadence sentence and the `__sigxAnon` cross-reference land
in PR-6 as documentation of the frozen behaviour: middleware runs per
operation, `authenticate` is memoized per request store.

### 4.3 `createBoundaryRefresh({ plugins })` does not see app DI (#595)

Guarantee, as written: the `plugins:` form builds its render from the
listed plugins only. App-level DI — `serverPlugin({ types })`,
`provideTypeHandlers`, anything installed by `app.use` — is **not**
visible to it. An app that installs any of those passes
`app: (rq) => createApp(...)` instead, and the app's plugins win. The
`plugins:` form remains the documented default for the zero-JS resume
examples because those pages have no app to hand; the entry comments
(`examples/resume/src/entry.*.ts`) already say this and the resume README
gets the same paragraph. The runnable `serverPlugin({ types })` example is
1.x.

### 4.4 `@sigx/cache` is app-rooted (#415)

`cachePlugin()` is installed with `app.use` (`packages/cache/src/index.ts:86`);
interactive `invalidate()` / `mutate()` therefore need an app-rooted entry.
On a zero-JS resumable page there is no cache client, and 1.0 says so
rather than inventing an app-less surface now. An app-less install seam is
additive and can arrive in 1.x if the full-stack showcase (#415) needs it.

### 4.5 Resume: transform-time problems are build errors, runtime ones warn (#409)

Silent-in-prod degradations are the wrong first impression for the pack.
Decided per site:

| Situation | Today | 1.0 |
|---|---|---|
| Duplicate resume component name across modules (`packages/vite/src/resume.ts:207-227`) | `console.warn`, first wins, rest dropped from the manifest | **build error** naming both files |
| `export default` in a resume module | silently non-resumable | **build error** ("resume components must be named exports") |
| `$scope` / `$el` used as a prop name | silent | **build error** |
| Single-element-root violation at upgrade (`client/upgrade.ts:144-152`) | `__DEV__` warn, boundary not upgraded | stays a `__DEV__` warn — a runtime throw would take the page down; the README documents it |
| Renamed signal drops buffered writes (`client/upgrade.ts:176-186`) | `__DEV__` warn | stays a `__DEV__` warn, documented |
| Wake swallows the first event | undocumented | documented; behaviour unchanged |

The three warn→error changes are breaking and land in PR-4, before rc.

### 4.6 Reactivity: no public `onWrite` (#653, from #546)

The deep-watch optimisation (re-traverse only when an object enters the
tree) is implemented with an internal notification flag or a second
internal dep, never as `signal(target, { onWrite })`. A per-signal write
hook on the public surface would be a second way to observe writes next to
`effect`/`watch`, and every later reactivity change would have to preserve
its timing. Rejected; 1.x is free to add the internal mechanism.

### 4.7 The props accessor returns reactive proxies for user objects (#274)

`isVNodeLike` (`runtime-core/src/utils/props-accessor.ts:14`) hands any
`{type, props, children, dom}`-shaped object to the renderer raw — a user
object of that shape silently loses reactivity. From 1.0.0 the contract is:
**only vnodes the runtime created bypass the proxy**, identified by an
internal brand stamped at every creation site. The brand is not exported;
`isVNode`-style detection stays internal. Lands in PR-7.

### 4.8 `ResumeManifest.handlers` does what it says (#410)

A required field on an exported interface documented as "modulepreload
hints" is wired (the pack implements `assets()` like
`ssr-islands/src/plugin.ts:211-223`, gated on a recorded resume boundary)
rather than dropped. Lands in PR-4.

---

## §5 Release plan

1. **Phase 1 PRs** (parallel, tracked in #676): this RFC; #655; #552; #363;
   #410 + #409; #449 + #472 + #535; #606 + #628 docs.
2. **Phase 2 PRs** (after this RFC merges): #274; #529 per §4.1; #501;
   §3.4 guard; §3.2 peer shape + `verify-pack` + repo-template.
3. **`v1.0.0-rc.0`**, published under the `next` dist-tag: README banner,
   `CHANGELOG.md:5` replaced by §2's policy, `release.yml` passes
   `--tag next` for prerelease tags. The ecosystem-release workflow runs
   in `dryRun` against it — every consumer aligns (with §3.3's peer
   migration) and reports; core fixes what surfaces.
4. **`v1.0.0`** under `latest`; the ecosystem-release workflow tier by
   tier; release comments on every open docs-site issue.

## §6 Non-goals

- A long-term-support branch for 1.x after 2.0. Decide when 2.0 is real.
- Freezing wire formats across versions (§1.2). If a deploy ever serves a
  page from one version and assets from another, that is an adapter
  problem (`rfc-deploy.md`) with its own design.
- Splitting the version line (§1.1).

## §7 Open questions

1. Should `sigx` also re-export `@sigx/serialize` so apps never install it
   directly? Today no app does; leave as is unless the rc alignment shows
   one needs to.
2. `pnpm publish` rewrites `workspace:` in `peerDependencies` — confirmed
   by PR-3's tarball assertion before Phase 2 lands. If it does not, Phase
   2 writes the concrete range itself in `scripts/publish.js`.
