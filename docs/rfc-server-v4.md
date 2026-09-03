# RFC: rfc-server v4 — the middleware / authentication / authorization split, and the server platform

Status: **implemented** (tracking signalxjs/core#607 closed 2026-08-04; shipped
in 0.15.x). Frozen at 1.0 — see `rfc-1.0.md`.
Amends `rfc-server-v3.md` §1 (guard completeness), §2.8 (one naming paragraph)
and §3 (two non-goals), and `rfc-server.md` §2.1 (the guard block and
`serverFnPreset`). Pre-1.0, no-compat, same stance as the parent RFC: one way
to do it. This is a **breaking** revision — `use:`, `unguarded`,
`serverFnPreset` and `requireGuards` shipped in 0.14.0 and are removed here;
§8 is the migration.

Everything below is stated against the code as it exists at `73af7d1`, with
`file:line` evidence. Where this document and the code disagree, the code wins
until the implementation lands, and this document is corrected.

---

## Problem — one primitive, three jobs

`ServerFnGuard` is `(rq, info) => void | Promise<void>`
(`packages/server/src/types.ts:22`). One chain carries three concerns with
three different natural scopes:

| Concern | Decides | Natural scope | Anonymous is… |
|---|---|---|---|
| Middleware | nothing — it does work | global, ordered, always | irrelevant |
| Authentication | *who* is calling | global, once per request | a valid outcome |
| Authorization | *may this caller do this* | per-function | a decision input |

Because they share one switch, they can only be applied or not applied
together. The costs are not hypothetical; v3 recorded them as accepted:

- **The gate cannot ask the right question.** `requireGuards` verifies
  declaration, not correctness — `use: [logRequest]` passes
  (rfc-server-v3 §1.5). Necessarily: one primitive means both "auth chain"
  and "logging chain".
- **The vocabulary is one word short.** §1.3 chose `unguarded` over
  `unauthenticated` *because* the gate could only ask one question — "the
  pair should not use two vocabularies for one question. The cost, accepted:
  `unauthenticated` was the slightly better word." The two vocabularies were
  correct; they are genuinely two things.
- **The opt-out is a sledgehammer.** `unguarded: true` disables *everything* —
  including audit logging and rate limiting, which should never be
  per-function-disableable. The sign-in endpoint that motivated it
  (v3 §1.3's `submitPat`) needs to relax exactly one thing: the requirement
  that a principal exists.
- **`use` is the ecosystem outlier.** Per #413, `app.use(plugin)` is *the*
  install shape everywhere else in sigx. `ServerFnOptions.use` is the one
  place `use` means "guard chain" — and downstream it already bites:
  `@sigx/actors` has both `defineActorApp(...).use(plugin)` and
  `defineActor({ use: [guard] })`, and an app-level chain has nowhere to go
  because the obvious spelling is taken.
- **App-wide policy has no home.** v3 §1.1 answered #489 with per-module
  presets — Pulse's 14 repeated declarations became 3, "the price of a
  guarantee that has no runtime lookup in it." The price was paid because the
  global alternative was fail-open. §2 below removes that premise.

And one structural ask beyond #607: server-side capability is growing —
server functions today, API endpoint families later — and each addition must
not invent its own config mechanism. The platform (§3) is the one value that
holds middleware, authentication, authorization and endpoint posture for
everything mounted behind it.

---

## §1 The split

### 1.1 Three types replace `ServerFnGuard`

```ts
// packages/server/src/types.ts

/** Identity of the function being invoked, as the pipeline sees it. */
export interface ServerFnInfo {
    /** The content-hashed transport symbol (`<name>_fn_<hash8>`), or the
     *  stable id under `role: 'client'`. Empty when nothing stamped one
     *  (a unit test importing the source module). Pure identity — it no
     *  longer doubles as the transport discriminator. */
    symbol: string;
    /** The export name of the function. */
    name: string;
    /** The transport discriminator (replaces the `symbol === ''` contract):
     *  'wire' for the four HTTP transports, 'in-process' for SSR-time and
     *  direct calls. */
    transport: 'wire' | 'in-process';
}

/**
 * Middleware: global, ordered, runs on EVERY transport, before-only —
 * no `next()`, no around-ness (the parent RFC's non-goal stands; §9). Veto
 * by throwing (a `ServerFnError` sets the response status — a rate limiter
 * throws 429 here). Never sees arguments: on the wire it runs before
 * `reviveWire` on attacker-controlled bytes (`server/index.ts:840-857`,
 * the #559 ordering), and it loses nothing by going first.
 * Transport-specific behavior is the body's own branch:
 * `if (fn.transport !== 'wire') return;` exempts SSR renders.
 */
export type ServerMiddleware =
    (rq: ServerFnContext, fn: ServerFnInfo) => void | Promise<void>;

/**
 * An authorization policy — the per-operation requirement. Positional so the
 * dominant case reads bare: `(p) => p.role === 'admin'`. Policies in an
 * array AND together. The return type is `boolean` and the runtime is
 * strict: only the literal `true` allows — `false`, `undefined`, a forgotten
 * return, all deny (403; 401 when the principal is null). A thrown
 * `ServerFnError` passes through verbatim for custom status/message.
 */
export type ServerPolicy<P = unknown> = (
    principal: P | null,   // null reaches a policy only on an allowAnonymous fn
    rq: ServerFnContext,
    op: ServerPolicyOp
) => boolean | Promise<boolean>;

export interface ServerPolicyOp {
    fn: ServerFnInfo;
    /** VALIDATED single input (options-form fn / input-form stream) — the
     *  resource for resource-based policies ("may P edit post op.input.id").
     *  `undefined` on the direct form and no-input streams. */
    input?: unknown;
    /** The raw argument list — for multi-arg direct/stream forms this is
     *  unvalidated wire data, the same trust level the handler receives. */
    args: readonly unknown[];
    /** Filled by packs whose operations target an instance — `@sigx/actors`
     *  passes `{ kind: 'actor', type, key, method }` (§7). Core wire calls
     *  leave it undefined. */
    resource?: { kind: string; type: string; key: string; method: string };
}
```

`ServerMiddleware` over keeping "guard": v3 §2.8 kept `ServerFnGuard` because
"middleware implies around-ness, and these are before-only with no `next`".
The around-ness concern is real and is answered where it belongs — pinned in
the type's JSDoc and in §9 — rather than by naming one primitive against its
own function. "Guard" retires from the public vocabulary; the three jobs get
their three names.

Authentication needs no named type beyond its slot in the app config (§3):
`(rq) => P | null | Promise<P | null>`. `null` is anonymous — a valid
outcome, exactly what the guard model could not express. A *throw* from an
authenticator is an infrastructure failure (masked 500), never a deny: a bad
cookie is `null`, a broken session store is an error.

### 1.2 Per-definition options

```ts
export interface ServerFnOptions<S, R> {
    id?: string;
    input?: StandardSchemaV1<S>;
    /**
     * This function's policy chain — REPLACES the app default for this fn
     * (most-specific-wins). Presence is read statically by the build (§5);
     * the values are runtime.
     */
    authorize?: ServerPolicy | ServerPolicy[];
    /**
     * LITERAL `true`, read statically (the `form`/`unguarded` discipline,
     * #437). Waives ONLY the requirement that a principal exists. Middleware
     * and authentication still run — an existing session still yields a
     * principal, so rate limiting stays per-user and audit logs stay
     * attributed — and any declared `authorize` policies still run,
     * receiving a nullable principal. The greppable open surface:
     * `grep -rn allowAnonymous --include='*.server.ts' src/`.
     */
    allowAnonymous?: true;
    // invalidates, cache, form, handler — unchanged
}
```

Removed: `use?: ServerFnGuard[]`, `unguarded?: true`. The same edit applies to
`ServerStreamOptions` and `ServerStreamInputOptions`
(`packages/server/src/index.ts:516-565`).

Three consequences, each deliberate:

- **`allowAnonymous` resolves §1.3's regret.** The word now means what the
  better word meant: this function is reachable without a principal. And it
  is *true* in a stronger sense than `unguarded` ever was — the pipeline
  still runs; only the identity requirement is waived. v3's grep story
  survives with a more honest noun.
- **The `unguardedContradiction` throw (`index.ts:247-254`, raised at
  `:412-414` and `:610-612`) is removed with no analog.** `unguarded` on a
  preset was a lie — the preset's guards still ran. `allowAnonymous` under an
  authed app default is coherent: middleware and authentication run, the
  identity gate is waived, declared policies see a nullable principal. Legal,
  so no throw; the semantics are pinned by test instead.
- **There is no per-fn `middleware` key.** Middleware's scope is the app.
  Per-function "work before the handler" is the handler's first lines — which
  now see validated input, unlike a guard ever did. This keeps
  `authorize`/`allowAnonymous` the *entire* per-fn access vocabulary and the
  build gate's question single-valued.

**The direct form** (`serverFn(async (rq, a, b) => …)`) still has nowhere to
declare — unchanged posture (`examples/resume/src/api.server.ts:17-18`
already teaches it: "the direct form has nowhere to declare"). It inherits
the app default. A public function under an authed app therefore uses the
options form, same as today. The wrapper stamps `__sigxAnon: true` on the
callable when the option is present (beside `__sigxGet`/`__sigxForm`,
`types.ts:158-222`) so the endpoint can run the identity gate before decode
without the build's help.

### 1.3 The pipeline — one order, all five transports

```
[wire only]  endpoint hygiene: method, content-type, Origin, base/symbol,
             caps, JSON parse + __proto__ drop            (unchanged, server/index.ts:559-806)
     1  app middleware, in declared order                 — the old guard slot (:840), pre-revive
     2  authenticate                                      — memoized once per request store
     3  identity gate: 401 unless allowAnonymous          — "phase A"
[wire only]  reviveWire                                   (unchanged position, :852-867)
     4  arity gate (400)                                  (unchanged, index.ts:346-348)
     5  input validation (400, Standard Schema)           (unchanged, :350-357)
     6  authorize: fn's chain ?? app default ?? requireAuthenticated
        strict-true; 403 on deny (401 if principal null)  — "phase B"
     7  handler
```

Steps 1–3 run in the endpoint for wire calls (before attacker bytes reach the
codec — the #559 invariant preserved exactly) and inside `invoke` for
in-process calls. Steps 4–7 are `invoke`'s body on every transport. The
ownership contract, stated on `ServerFnInvoke` and pinned by test: **a
transport (`info.transport === 'wire'`) owns steps 1–3 before calling
`invoke`; `invoke` runs them itself only for in-process calls.** A hand-rolled
transport that calls `__sigxFn` without them loses middleware only —
authentication is pulled on demand by the gate and authorization is inside
`invoke`, so the security decision never depends on the transport behaving.

**Authorization is two-phase, and that is the design's answer to a real
tension.** Guards ran pre-revive so attacker payloads never reached the codec
(`server/index.ts:841-848`) — which is why a guard could never see arguments,
and why resource-based authorization ("may this user edit *this* post") was
impossible in the framework and pushed into every handler. The split
dissolves the conflict: the cheap identity decision (phase A) needs no
arguments and stays pre-revive — anonymous attacker payloads now never reach
the codec **or the validator**, strictly stronger than today, where `use`
chains ran pre-validation but nothing kept an anonymous caller off the
schema. The resource decision (phase B) runs post-validation, where
`op.input` is trustworthy. The cost, accepted: an authenticated-but-
unauthorized caller exercises the validator. Bounded by phase A in front of
it, and cheaper than the alternative — policies over raw wire bytes are
policies over lies.

**Authentication is memoized per request store** — the promise, under a
`Symbol.for` slot on `rq.locals`, with `perRequest`'s exact semantics
(`per-request.ts:296-302`: racing first touches share one resolution,
rejections are sticky). One wire request authenticates once. One SSR render
authenticates once *across every cell and the document shell*, because the
render shares one store (v3 §2's nested-scope merge, `scope.ts:145-187`) —
Pulse's repeated session decode per render, solved through the front door.
Detached contexts (`fn.with({ context })`, bare test calls) authenticate per
store identity, and an authenticator reading `rq.request` on a fully
detached context hits the existing descriptive throw
(`context.ts:157-191`) → authentication fails → deny. Correct: a unit test
injects a principal instead (§2.4).

### 1.4 Failure semantics

| condition | wire | in-process |
|---|---|---|
| middleware throws | `ServerFnError` verbatim; else masked 500 via `onError` (unchanged from `guard`) | thrown to caller |
| authenticator throws | masked 500 — infrastructure failure, never a deny | thrown |
| principal null, no `allowAnonymous` | `401 'Authentication required'` — **before revive** | `ServerFnError(401)` before validation |
| policy returns anything but `true` | `403 'Forbidden'` (`401` when principal null — reachable only on `allowAnonymous` fns with a policy) | same error, thrown |
| policy throws | `ServerFnError` verbatim; else masked 500 | thrown |
| no `createServerApp` ran, fn has no declaration | denies as above, plus a `__DEV__` once-per-process hint naming `createServerApp` | same |

One dev-only coherence check joins `warnPublicRequestTouch`
(`server/index.ts:870-871`): a `cache` read whose `Cache-Control` starts with
`public` and which is **not** `allowAnonymous` gets a once-per-fn warning — a
per-principal 200 under a shared-cache header is the §5.2a mistake wearing a
new coat, and under the split it is finally statically visible.

### 1.5 `serverFnPreset` is removed

The preset existed to share the auth chain per module without a global
mechanism — "the price of a guarantee that has no runtime lookup in it"
(v3 §1.1). §2 buys the guarantee without the price, so the preset's reason
evaporates. What remains of its use cases:

- App-wide policy → the app default (`createServerApp({ authorize })`).
- A module-scope policy → one imported identifier per fn:
  `authorize: adminOnly`. One line, the same line the preset saved, minus a
  concept.
- A deliberately-open module → `allowAnonymous: true` per fn — which is the
  point: the open surface is greppable *per function*, not hidden behind a
  module-level word.

Deleted with it: `preset.stream`, the preset-source hash-seeding
(`server-fn-extract.ts:706-718`), the same-module analysis (pass 1b,
`server-fn.ts:582-605`), the exported-preset warning, and the
`unguardedContradiction` machinery. The direct form loses its only
declaration seam (`index.ts:311-315`) and reverts to inheriting the app
default — which reaches it on every transport, which is what the preset loop
existed to guarantee.

---

## §2 App-wide config resolves through a fail-closed seam

### 2.1 The mechanism

`createServerApp(options)` (§3) stamps its config on
`globalThis.__SIGX_SERVER_APP__` at module evaluation. `invoke` and the
endpoint read it **lazily, per call**, through one accessor
(`resolveServerApp()`, new `packages/server/src/app-config.ts` — compiled
into both the root and `./server` entries, safe because the state lives on
`globalThis`, the exact reasoning at `context.ts:56-65`). Per layer, a miss:

- middleware absent → empty chain. A legitimate no-op — degraded
  observability, not a security property.
- authenticate absent → principal `null` → the identity gate denies
  everything not `allowAnonymous`.
- authorize absent → the built-in `requireAuthenticated` (exported by name),
  which requires a non-null principal — already guaranteed by the gate, so
  the pure default is "any authenticated caller".
- **nothing stamped at all, and the fn declares nothing** → the call fails
  with a definition-legible error ("no access policy declared and no server
  app configured"), masked to 500 on the wire.

**The invariant, which the whole section defends: a miss may only ever
remove permission, never add it.**

Zero-config apps whose functions are all `allowAnonymous`
(`examples/resume`'s six, today all `unguarded`) keep running with no
`createServerApp` at all — middleware and authentication are simply absent,
the gate is waived per declaration, and there is no policy to resolve.

### 2.2 v3 §1.1's four objections, inverted

v3 §1.1 rejected "a process-level registry consulted by `invoke`" with four
stacked objections (`rfc-server-v3.md:135-143`). They were correct — for a
registry that carried **the decision**. The split moves the decision out of
the registry: whether a function *requires* authorization is captured in the
definition (`authorize`/`allowAnonymous`), exactly where §1.1 put it. What
resolves globally is identity resolution and policy *bodies* — where a miss
denies. Each objection, re-run:

| §1.1 objection | Under the split |
|---|---|
| needs a `globalThis` seam — the dev dual module graph holds two copies of a module | The dual-graph hazard (`context.ts:56-65`) is about **module-level** state; `globalThis` is the documented *remedy*, used by every existing seam (`__SIGX_SERVERFN_CONTEXT__`, `__SIGX_SERVERFN_SCOPE__`, `__SIGX_SERVERFN_CODEC__`). The residue — the user's app module evaluating in both graphs and stamping twice — is idempotent last-wins over equivalent values (§3.4). |
| seams.md: a miss is a no-op → fail-open on the auth path | A miss **denies** at every layer (§2.1). The first seam in the registry whose absence is a *locked door*, not a hole. seams.md gains the class (§2.3). |
| behavior depends on process state — a unit test and production disagree | The disagreement is now one-directional: an unconfigured process denies strictly more, never less. A test injects a principal (§2.4) — which is the correct unit-test shape regardless: you test a handler under an identity, not through the cookie parser. |
| invoked before registration runs unguarded, undetectably | Invoked before registration **denies 401, very detectably**, with a `__DEV__` hint. And the requirement is definition-captured, so no ordering can change *what is required* — only whether resolution succeeds, which fails closed. |

The rule §1.1 actually established — *the decision lives in the definition,
never a lookup* — survives intact. What was wrong was reading it as "nothing
may resolve globally"; the correct reading is "nothing whose absence would
open a door may resolve globally". Identity and policy bodies pass that test
only because every miss is a deny.

### 2.3 The seams.md carve-out

`docs/seams.md` rule 3 ("Make a missing seam a no-op, never a throw",
`seams.md:339-340`) gains one exception, stated as a class:

> **Fail-closed control seam** — a seam whose absence must *deny a
> capability rather than grant one*. Its accessor still never throws on a
> miss — it returns `undefined`, and each reader maps absence to its layer's
> deny (a null principal, the default-deny policy, an empty middleware
> chain). The invariant is directional: **a miss may only ever remove
> permission, never add it.** `__SIGX_GUARDS_CHECKED__` was the half-step
> precedent ("absence is the alarm, so a miss degrades to silence, never a
> false pass" — `seams.md:286-289`); a fail-closed seam completes the
> inversion: absence changes behavior, to deny. A seam whose miss would
> *grant* remains forbidden.

Plus the registry row: `__SIGX_SERVER_APP__` — written by `createServerApp()`
(the app's server-app module); read by `resolveServerApp()` in
`packages/server/src/app-config.ts`, the only accessor, consulted lazily per
call by the endpoint and `invoke`; contract
`{ middleware?, authenticate?, authorize?, posture, codec? }`; **control,
fail-closed**. The `__SIGX_GUARDS_CHECKED__` row retires with its machinery
(§5).

Rule 4 ("swallow throws from the far side") does not apply to this seam and
the row says so: a throwing policy or authenticator is a *deny or an error*,
never swallowed — swallowing here would be the fail-open the class forbids.

### 2.4 The test surface

`@sigx/server/testing` (#570) gains:

```ts
/** As today, plus: seed the principal memo so `authenticate` never runs. */
export function createTestServerFnContext(
    init?: ServerFnContextInit, opts?: { principal?: unknown }
): TestServerFnContext;

/** Stamp a config for integration-shaped tests; returns the restore. */
export function stubServerApp(config: ServerAppOptions): () => void;
```

And `@sigx/server` (root) exports the runtime faces:

```ts
export function principal<P = unknown>(rq: ServerFnContext): Promise<P | null>;
export function requirePrincipal<P = unknown>(rq: ServerFnContext): Promise<P>; // throws ServerFnError(401)
export function setPrincipal(rq: Pick<ServerFnContext, 'locals'>, principal: unknown): void;
export const requireAuthenticated: ServerPolicy;
```

`principal()` reads the memo (resolving the authenticator on first touch);
`requirePrincipal()` is the throwing accessor v3 §2.8 recommended for the
narrowing gap, now supplied by the framework; `setPrincipal()` writes the
memo cell — the pre-seed for tests, and the hook §7 uses to install a
propagated principal on the callee side of an actor hop. All three read/write
the one `Symbol.for` slot; none closes over config (the accessor rule that
keeps the dual graph honest). `stampServerFnKey` keeps stamping `__sigxKey`
but loses its `__sigxGuardChecked` half (§5).

Nothing new reaches `@sigx/server/client`: stubs stay dependency-free, the
size-limit entry with no ignore list (`.size-limit.mjs:215-221`) stays the
enforcement, and `serverPlugin` stays client-side transport + types config
(`plugin.ts:6-11`). Constraint 2 of #607 holds by construction.

---

## §3 The platform: `createServerApp`

### 3.1 Shape

```ts
// @sigx/server/server — the WinterCG entry, beside handleServerFnRequest

export interface EndpointPosture {
    origin?; maxBodyBytes?; maxUrlBytes?; maxResponseBytes?; timeoutMs?;
    onError?(error: unknown, info: ServerFnInfo, ctx: ServerFnContext): void | Promise<void>;
}

export interface ServerAppOptions<P = unknown> extends EndpointPosture {
    /** Copied once at creation — a policy an app can push to is not a policy. */
    middleware?: ServerMiddleware[];
    authenticate?: (rq: ServerFnContext) => P | null | Promise<P | null>;
    /** The app default policy chain — applies where a definition declares
     *  nothing. Always receives a non-null principal: anonymity is granted
     *  only by the per-fn literal, never by the default. */
    authorize?: ServerPolicy<P> | ServerPolicy<P>[];
    /** Round-trips a principal as a string — required only for cross-hop
     *  propagation (@sigx/actors, §7). decode → null means anonymous. */
    codec?: { encode(principal: P): string; decode(encoded: string): P | null };
}

export interface ServerFnMount extends Partial<EndpointPosture> {  // overrides win
    resolve(symbol: string): unknown | Promise<unknown>;
    base?: string;                          // claims its namespace (§3.3)
    renderBoundaries?: ServerFnRequestOptions['renderBoundaries'];
    /** Closes the §6.3 boundary-refresh gap: veto ONE re-render — whose props
     *  are client-supplied — under this request's principal. Deny drops the
     *  descriptor silently; the client converges through `$cache` one round
     *  trip later. Refresh stays best-effort (server/index.ts:975-983). */
    authorizeBoundary?(rq: ServerFnContext,
        boundary: { component: string; deps: readonly string[]; props?: Record<string, unknown> }
    ): boolean | Promise<boolean>;
}

export interface ServerApp<P = unknown> {
    serverFns(mount: ServerFnMount): (request: Request) => Promise<Response>;
    /** Release the seam (test teardown). */
    dispose(): void;
}

export function createServerApp<P = unknown>(options: ServerAppOptions<P>): ServerApp<P>;
```

Usage — the platform entry keeps rfc-deploy's exact composition:

```ts
// src/server-app.ts — user-owned; the ONE place policy lives
export const app = createServerApp<User>({
    middleware: [requestId, rateLimit, auditLog],
    authenticate: sessionFromCookie,          // (rq) => User | null
    onError: (e, info) => log.error({ fn: info.name, e }),
    timeoutMs: 10_000,
});

// src/entry.cloudflare.ts — routing stays HERE, visibly (rfc-deploy §1.2)
const fns = app.serverFns({ resolve: (s) => serverFns[s]?.() ?? null,
                            base: serverFnBase, renderBoundaries });
const doc = createFetchHandler({ template, app: (url) => createApp(url), document: { assets } });

export default {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
        if (matchesServerFn(request, serverFnBase)) return fns(request);
        return doc(request, { env, ctx });
    },
};
```

`ServerFnRequestOptions` splits along the same line: the posture keys
(`origin`, `maxBodyBytes`, `maxUrlBytes`, `maxResponseBytes`, `timeoutMs`,
`onError` — `server/index.ts:88-128`) are app-level, stated once, inherited
by every mount and by the dev endpoint; `resolve`/`base`/`renderBoundaries`/
`authorizeBoundary` are per-mount. The endpoint `guard` option
(`server/index.ts:72`) is **removed**: app middleware runs at its exact slot
(`:840`), pre-revive, and reaches every transport besides — the wire-only
backstop role is one `fn.transport !== 'wire'` early-return away. Two
mechanisms for one slot was the v3 §4 correction's subject; now there is one.
The pinned test *"does NOT run for an in-process call — the endpoint guard
is wire-only (§1.1/§4)"* (`packages/server/__tests__/handler.test.ts`) is
replaced by its inverse: **app middleware DOES run for an in-process call.**

`handleServerFnRequest` **survives as the exported primitive** — the mount
factory composes it; hand-wired non-Vite builds and tests keep calling it
directly, and it stays correct without an app because the pipeline rides
`invoke`, not the endpoint. `authorizeBoundary` lands on
`ServerFnRequestOptions` so the primitive has it too; the mount forwards.

### 3.2 The extension seam — what a future endpoint family gets

> **Promoted in #625.** `@sigx/actors` (§7) is the second feature, so the
> shape below shipped as `ServerFeatureContext` — exported from the `.`
> entry as the free `serverFeature()` accessor, and as `app.feature()` on
> `ServerApp`. Three deviations from the sketch, each forced by the first
> real consumer:
>
> - **`prelude(rq, fn, o?)` joins `enter(request, fn, o?)`.** `enter` is the
>   wire shape; actors' in-process entry points (`index.ts:174`/`:222`) hold
>   a `ServerFnContext` and never a `Request`, so the recorded member alone
>   could not serve them. Both funnel to `runServerPrelude` — one pipeline,
>   as promised. `enter` also gained `fn`, without which it cannot run
>   middleware at all.
> - **`codec` split in two.** The sketch's `codec` was the WIRE codec
>   (`__SIGX_SERVERFN_CODEC__`); §7's propagation needs the app's
>   **principal** codec, which is a different value with a different trust
>   story. Exposed as `principalCodec`; conflating the two would let a
>   request-supplied value decode into a principal.
> - **No app handle required.** Every member resolves
>   `__SIGX_SERVER_APP__` per call, so a feature holds one context at module
>   scope and still sees the live app. `claimBase` accordingly moved its
>   registry from `createServerApp`'s closure onto `ServerAppConfig`
>   (per-app scope preserved: a fresh stamp brings a fresh array).

Internal in v1 — `serverFns` is its first and only consumer; promoted to a
public export when the second feature ships, with the shape recorded now so
that feature does not get to invent it:

```ts
interface ServerFeatureContext<P = unknown> {
    /** middleware → authenticate for one wire request; returns the request
     *  context with the principal memo seeded. One pipeline, every feature. */
    enter(request: Request): Promise<ServerFnContext>;
    /** identity gate + a policy chain for one operation; throws 401/403. */
    authorize(rq: ServerFnContext, op: {
        fn: ServerFnInfo; policies?: ServerPolicy<P>[]; allowAnonymous?: boolean;
        input?: unknown; args?: readonly unknown[];
        resource?: ServerPolicyOp['resource'];
    }): Promise<void>;
    /** The app's merged posture. */
    posture: Readonly<EndpointPosture>;
    /** Namespace bookkeeping — NOT routing. "Everything after `base` is the
     *  symbol" (#543) means two families cannot share a base; claiming an
     *  overlapping prefix throws at mount time, at boot, naming both. */
    claimBase(base: string): void;
    /** encodeWire/reviveWire as configured (`__SIGX_SERVERFN_CODEC__`). */
    codec: { encode(v: unknown): unknown; revive(v: unknown): unknown };
}
```

A feature is a mount factory over this context that hands the *user* a
handler to compose in their entry — exactly `serverFns`' shape. The app
validates namespaces; it never dispatches. This is the "API endpoints later"
hook #607 asks the design to hold a place for: an endpoint family added in
0.16 gets the pipeline, the posture, a base claim and the codec from the
platform, and invents nothing.

### 3.3 The document path stays out

`createFetchHandler` does not participate in middleware/authentication and
takes no new seam. One line: **the pipeline guards operations, not URLs.**
(1) A render's *data* is already fully covered — every in-process serverFn
call runs the whole pipeline via `invoke`, and authentication memoizes on the
render's shared store, so a signed-in render decodes the session once, all
cells included. (2) `@sigx/server-renderer` cannot import `@sigx/server`
(the `__SIGX_SERVERFN_SCOPE__` posture, `serverfn-scope.ts`), and
rfc-deploy's phantom-dependency objection stands. (3) A whole-document auth
wall is a three-line wrapper around the fetch handler in the user's entry —
"it is just a function".

### 3.4 One app per process

`createServerApp` stamps at module evaluation; a second call **replaces the
stamp, last-wins, with a `__DEV__` note** when it replaces a live one.
Not a throw: dev HMR re-evaluates the server-app module, and a re-evaluation
is indistinguishable from a genuine second app. The process is the unit —
the same posture `__SIGX_SERVERFN_CODEC__` already takes, and the reason
`provideTypeHandlers` is deliberately *not* stamped server-side
(`seams.md:184-186`). `dispose()` clears the stamp for test teardown.

Vite wiring: `sigxServer({ serverApp: './src/server-app.ts' })`. Dev: the
plugin eagerly `ssrLoadModule`s the module at server start and re-evaluates
on `hotUpdate` — the exact model of today's `guard` specifier
(`server-fn.ts:760-764`), which it replaces. Prod build: one
`import '<spec>';` injected at the top of `virtual:sigx-server-fns`
(`server-fn.ts:465-521`), so any entry importing the registry evaluates the
config before serving. Hardening, not a dependency: the runtime never
requires the build — an un-imported config module denies (§2.1), it does not
open.

---

## §4 The rfc-deploy reconciliation

rfc-deploy refused `sigxStart({ statics, fns, document })` because it rolled
**routing** into one call: "the three-line composition *is* the routing
policy … the all-in-one is the first step onto the meta-framework slope"
(`rfc-deploy.md:633-639`). `createServerApp` rolls **policy** into one value
and hides nothing: every `Response` still originates from a handler the user
visibly mounted; `matchesServerFn` stays a predicate — rfc-deploy open
question 1 closes as *predicate, reaffirmed* (`app.serverFns` returns a
handler, never a `Response | null` combinator); no sigx code serves statics,
crawls routes, or decides which handler answers a URL.

The line, drawn for the record: **the meta-framework slope begins where the
framework decides which handler answers a URL; the server platform stops one
step before it — deciding what every operation must pass through, wherever
the user mounted it.** No rfc-deploy refusal is reversed; the refused thing
and the built thing are different axes.

---

## §5 The build gate: `requireGuards` → `requireAuthorization`

The runtime is now fail-closed, which inverts the gate's stakes. Today the
dangerous state is absence — an undeclared fn runs **open** on five
transports, so the gate is a security control and §1.5 needs a stamp
(`__sigxGuardChecked`), a build-wide marker (`__SIGX_GUARDS_CHECKED__`) and a
runtime warning (`warnUnchecked`, `index.ts:228-245`) to chase unanalyzed
modules. After this RFC an undeclared fn **denies** — the gate's job drops
from security to availability ("you forgot `allowAnonymous` on the sign-in
endpoint" is a build error instead of a production lockout). Consequences:

- `sigxServer({ requireAuthorization?: true | 'warn' | false })`, default
  **on**. A fn passes iff: it declares `authorize:` (presence-read, the
  `cache` discipline), OR the literal `allowAnonymous: true`, OR
  `sigxServer({ serverApp })` is configured — the app default decides
  undeclared fns, fail-closed. Without `serverApp`, a bare fn is a located
  build error naming all three remedies. Middleware satisfies nothing —
  there is no per-fn middleware key to declare. §1.5's "the check verifies
  declaration, not correctness" narrows to "`authorize: [() => true]`
  passes": still declaration-not-correctness, but the declaration is now in
  the authorization vocabulary, and a review greps two honest words.
- **§1.5's residual gap closes.** "A production build with an unanalyzed
  module stays silently unguarded. Dev catches it; prod does not. No
  candidate on the list closes this." An unanalyzed module now denies at
  runtime. The gap v3 could only record is closed by the runtime, so
  `__sigxGuardChecked`, `__SIGX_GUARDS_CHECKED__`, `warnUnchecked` and the
  stamp emission (`serverFnKeyStamps`' `guardChecked` half,
  `server-fn-extract.ts:481-503`) are **deleted, not migrated**, and the
  seams.md row retires.
- Static readers (`packages/vite`, both extractors): `readServerFnUseOption`
  → deleted; new `readServerFnAuthorizeOption` (presence via
  `hasServerFnOptionKey`); `readServerFnUnguardedOption` →
  `readServerFnAllowAnonymousOption` (literal-`true` discipline verbatim);
  `missingGuardError` → `missingAuthorizationError`;
  `optionsSpreadWarning`'s key list becomes
  `id, cache, invalidates, form, authorize, allowAnonymous`; pass 1b and
  `presetSource` delete with the preset.
- **Symbol note.** Rewriting `use:` → `authorize:` changes call-site text,
  and the hashed symbol seed includes it (`mintSymbols`,
  `server-fn-extract.ts:433-453`) — hashed symbols re-mint across the
  migration. Accepted pre-1.0. **Stable symbols (`<stableId>/<name>`) are
  untouched**, so native clients on `role: 'client'` builds (rfc-server
  rev 2) survive.

---

## §6 What this does to prior decisions

| Prior decision | Status |
|---|---|
| v3 §1.1 — "the mechanism has to be definition-level" | **Rule survives, reading corrected** (§2.2): the *requirement* is definition-level; identity and policy bodies resolve globally because their miss denies. The registry rejection applied to a decision-carrying registry, which this is not. |
| v3 §1.2 — `serverFnPreset` amended | **Superseded**: preset removed (§1.5). The direct-form and stream-reroute fixes it forced (#398) survive — they are pipeline properties now. |
| v3 §1.3 — `unguarded`, and "the pair should not use two vocabularies" | **Superseded**: the two vocabularies were correct; `allowAnonymous` is the word §1.3 wished it could use, now true (§1.2). The grep story survives with a more honest noun. |
| v3 §1.4 — `requireGuards`, default on | **Sharpened** into `requireAuthorization` (§5); default-on rationale unchanged. |
| v3 §1.5 — "verifies declaration, not correctness"; the unanalyzed-module gap | **Gap closed by the fail-closed runtime**; the stamp machinery deletes (§5). |
| v3 §2.8 — "`ServerFnGuard` stays, middleware implies around-ness" | **Superseded**: the vocabulary splits; before-only is pinned in the type and §9 instead of in a name. §2.8's throwing accessor lands as `requirePrincipal` (§2.4). |
| v3 §3 — "no process-level default `use` chain"; "no scope-carried chain" | The scope rejection **stands verbatim**. The process-level rejection is **rewritten**: no global *decision* — a global whose miss denies is now in-bounds (§2.2/§2.3). |
| v3 §3 / rfc-server §2.1 — before-only, no `next()`, no builders, no classes, no app-DI bridge | **Stand, restated** (§9). |
| v3 §3 — no endpoint `onFinish`, no `rateLimit` option ("a rate limiter is a guard") | **Stand, revocabularized**: a rate limiter **is middleware** — and correctly not per-function-disableable, which `unguarded` used to violate. The README pattern's discriminator line becomes `if (fn.transport !== 'wire') return`. |
| rfc-server §2.1 endpoint `guard` + v3 §4's wire-only correction | **Removed** (§3.1): app middleware occupies the same pre-revive slot and is transport-complete. The v3 §4 pinned test inverts. |
| `info.symbol === ''` as the transport contract (`types.ts:10-12`, README `:833-836`) | **Replaced by `info.transport`** (§1.1): `''` was overloaded (also "no build stamp"), unenforceable, and already broken by `@sigx/actors`, which needs `${type}#${method}` identity in-process (§7). Symbol returns to pure identity. |
| rfc-deploy — no unified start handler; `matchesServerFn` a predicate | **Not reversed — reconciled** (§4). Open question 1 closes: predicate, reaffirmed. |
| seams.md rule 3 — a miss is a no-op | **Carve-out**: the fail-closed control seam class (§2.3). |

---

## §7 `@sigx/actors` (design; implementation follows in that repo)

Actors reuses core's guard type verbatim (`packages/actors/src/guards.ts:12`)
and must follow the split. Its options move the same way:

```ts
// ActorOptions / WorkerOptions / JobOptions — replaces use / methodUse / unguarded
authorize?: ServerPolicy | readonly ServerPolicy[];
/** Per-method requirements, ANDed AFTER `authorize` — the own-keys-only
 *  static-map discipline methodUse has (guards.ts:31-34) carries over. */
methodAuthorize?: Record<string, ServerPolicy | readonly ServerPolicy[]>;
allowAnonymous?: true;
```

- **The resource, from day one.** The dominant real actor policy is
  per-instance — "may this user read cart `u_123`?" — and today the guard
  cannot see the key even though every call site has it in scope before
  `runGuards` (`actor-endpoint.ts:493` vs `:502`). Actors passes
  `op.resource = { kind: 'actor' | 'worker' | 'job', type: def.type, key,
  method }` into phase B. Plumbing, not a redesign — the signature was built
  for it (§1.1).
- **The `guardInfo` transport bug fixes itself.** Actors keeps
  `symbol = \`${def.type}#${method}\`` on **both** transports — honestly, now
  that symbol is pure identity — and passes `transport` per call site
  (wire at `actor-endpoint.ts:502`, in-process at `index.ts:174`/`:222`).
  An actor rate-limit middleware finally distinguishes a browser call from
  an SSR render without losing per-method identity. No third `'peer'` value:
  a forwarded host-to-host call re-enters the endpoint as wire, which is
  what a rate limiter should see.
- **Actor→actor hops stay trusted**, with the principled statement the old
  comment (`guards.ts:8-10`) lacked: authentication is per-request (resolved
  once at the system boundary), authorization is per **entry point** (wire
  endpoint, live endpoint, in-process call, job enqueue). A `ctx.actor` hop
  is not an entry point. Jobs authorize at enqueue; the executing job sees
  the principal snapshot recorded there and does not re-authorize.
- **The principal propagates in a first-class slot on the call envelope, not
  a bag key.** After the pipeline runs at an entry point, actors encodes the
  resolved principal with the app's `codec` (§3.1) and carries it beside
  `bag` through hops, `.with()`, and the host-to-host envelope — sanitized
  on decode like the bag, populated **only** from the endpoint's own
  authentication, never a request header (the `actor-endpoint.ts:513-516`
  posture, inherited verbatim). Callee side: `ctx.principal`, decoded
  lazily, memoized per turn, installed via core's `setPrincipal` so
  serverFns called inside the turn see the same identity; missing slot or
  failed decode ⇒ `null`. This kills the failure mode #607 names — a guard
  author forgetting `stampCallBag` and silently dropping identity across
  hops — structurally: identity is not writable through `.with({ bag })`,
  because it is not in the bag. `stampCallBag` survives for app data. A
  missing `codec` dev-warns once and propagates nothing: fail-closed at the
  reader.
- **Gate and backstop.** `sigxActors({ requireGuards })` →
  `requireAuthorization`, keeping actors' stricter posture (an empty
  `authorize: []` does not count, `extract.ts:149-151`). The registration
  warning (`host.ts:229-245`) flips polarity: "declares no authorization and
  no server app is configured — every call will be **denied**", still not
  `__DEV__`-gated; fail-closed made the runtime the safety net and the warn
  a UX aid.

Cross-repo sequencing in §8.3.

---

## §8 Migration

### 8.1 The table

| # | Old | New | Codemod |
|---|---|---|---|
| 1 | `unguarded: true` | `allowAnonymous: true` | mechanical — **but see the behavioral delta below** |
| 2 | `serverFn({ use: [g] })` / `serverStream({ use })` | `authorize:` (policies) / app `middleware` (work) | classify-and-TODO: each guard is one or the other |
| 3 | `serverFnPreset({ use })` / `preset.stream` | app default (`createServerApp({ authorize })`) or per-fn `authorize: shared` | mechanical for the single-auth-guard preset; manual otherwise |
| 4 | `ServerFnGuard` type refs | `ServerMiddleware` or `ServerPolicy`, per classification | classify, then rename |
| 5 | endpoint `guard` option / `sigxServer({ guard })` | app `middleware` (+ `fn.transport !== 'wire'` for wire-only) / `sigxServer({ serverApp })` | mechanical move |
| 6 | `sigxServer({ requireGuards })` | `requireAuthorization` | mechanical |
| 7 | `info.symbol === ''` / `!== ''` checks | `info.transport === 'in-process'` / `=== 'wire'` | mechanical |
| 8 | guard tests via `fn.with({ context })` | inject identity: `createTestServerFnContext(init, { principal })` / `stubServerApp` | manual |
| 9 | actors `use`/`methodUse`/`unguarded` (actors, workers, jobs) | `authorize`/`methodAuthorize`/`allowAnonymous` | classify-and-TODO / mechanical, as rows 1–2 |
| 10 | `stampCallBag(rq, { user })` as the identity channel; `ctx.bag.user` reads | automatic propagation; `ctx.principal` | manual (the recipe below) |

**Behavioral deltas the changelog's old→new table must name** (the AGENTS.md
"Changed, not Added" rule — the workaround written against the old value is
the first thing the new one breaks): an `allowAnonymous` fn now runs
middleware and authentication where `unguarded` ran nothing — a throwing
authenticator now 500s a formerly-unguarded endpoint, and a rate limiter now
applies to it (both are the point; both are observable). A bare undeclared fn
now **denies** where it ran open. `rq.locals` written by a guard is now more
often the memoized principal slot's neighbor — unchanged semantics, stated
for completeness.

### 8.2 The conflated guard — the worked recipe

The pattern no codemod can split: one guard doing all three jobs. The
canonical exhibit is `@sigx/actors`' `examples/chat/src/guards.ts:61-72` —
twelve lines that verify an HMAC cookie (authentication), throw 401
(authorization), and write `rq.locals.user` + `stampCallBag` (propagation).
Three cuts:

1. **The verify becomes the authenticator.**
   `createServerApp({ authenticate: currentUser, codec: { encode: u => u, decode: s => s || null } })`.
2. **The 401 becomes the default policy** — the built-in
   `requireAuthenticated`, i.e. nothing to write; `signIn`/`signOut`/`me`
   declare `allowAnonymous: true` (the sign-in target is #607's `submitPat`
   case).
3. **The propagation is deleted.** `rq.locals.user` reads →
   `await principal(rq)`; `ctx.bag.user` → `ctx.principal`; the
   `stampCallBag` line goes away, and the failure it guarded against —
   forgetting it — becomes impossible.

The codemod detects the pattern (a `use:` guard whose body both throws a
`ServerFnError` and writes `rq.locals` or calls `stampCallBag`) and emits a
TODO pointing here; it does not attempt the split.

### 8.3 Sequencing

1. **core 0.15.0** — this RFC's implementation (phases: pipeline + types;
   `createServerApp` + mounts; vite gate + `serverApp` wiring; examples,
   README, seams.md, changelog). The unreleased window already carries two
   BREAKING entries (#567, #543); this rides the same release.
2. **actors next minor**, after core per `docs/ecosystem-release.md`, pinned
   `@sigx/server@^0.15.0` — pre-1.0 minors are breaking and the pin prevents
   a 0.14-core/new-actors mismatch.
3. **One combined migration doc**, `docs/migrations/0.15-guard-split.md` in
   core, owning both repos' tables and the recipe; actors' changelog links
   to it. The split is one conceptual change; two half-docs would each be
   wrong about the other repo's timing.

In-repo docs updated with the implementation, not this RFC:
`packages/server/README.md` (Security defaults; "Rate limiting — a guard,
not an option" becomes "— middleware, not an option", discriminator line
updated), `docs/seams.md` (§2.3's carve-out + row changes),
`examples/resume/src/api.server.ts` (six `unguarded` → `allowAnonymous`,
header comment re-derived), the v3 §4 pinned test's inversion.

---

## §9 What this revision does not do

- **Around-middleware / `next()`.** Standing non-goal, restated: before-only,
  veto-by-throw. Post-handler concerns remain structural (`invalidates`,
  `Cache-Control`, `onError` + `timeoutMs`, `perRequest`'s `onDispose`).
  Streams and one-way calls are why; a reversal is its own RFC.
- **Per-fn or per-module middleware.** Middleware is the app's, ordered,
  never per-function-attachable or -disableable (§1.2). Discriminate inside
  the body.
- **An API-endpoints specification.** §3.2 is a seam contract; the first
  non-serverFn endpoint family is its own RFC, which must consume — not
  reinvent — the seam.
- **File-system routing, route crawling, static serving, a combinator.**
  rfc-deploy's refusals, untouched (§4).
- **A `'peer'` transport value.** Two values until a real middleware needs a
  third (§7).
- **An app-DI bridge, chainable builders, classes/controllers, a
  `createContext` hook.** Unchanged from the parent RFC.
- **Named-policy registries / requirement objects** (the ASP.NET
  requirement/handler model). Policies are functions; composition is
  `authorize: [a, b]` and userland combinators.

---

## §10 Open questions

1. **`codec` placement** — on `ServerAppOptions` directly (proposed) vs
   nested under an `authenticate: { resolve, codec }` object. Flat reads
   better until a second authenticator-adjacent option exists.
2. **`requirePrincipal` naming** — vs `assertPrincipal`. `require*` matches
   the built-in policy's name; `assert*` matches TS assertion conventions.
3. **Should `stubServerApp` live in `/testing` only, or should `dispose()`
   double for it?** Proposed: both exist; `stubServerApp` is the test-shaped
   face (stamp + restore in one value).
