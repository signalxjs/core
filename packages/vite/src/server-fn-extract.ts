/**
 * Server-function extraction for sigxServer() — the analysis half of the
 * `@sigx/vite/server` transform (rfc-server §3, #305). The sibling of
 * `resume-extract.ts`, and deliberately simpler: `*.server.ts` modules are
 * server-only WHOLESALE, so there is no capture analysis — the client build
 * replaces the entire module with generated stubs.
 *
 * For a module like
 *
 * ```ts
 * import { serverFn } from '@sigx/server';
 * export const addToCart = serverFn(async (rq, id: string) => { … });
 * export const auditLog = (line: string) => { … };
 * ```
 *
 * the extraction yields the client replacement
 *
 * ```js
 * import { __serverFnStub, __serverOnly } from '@sigx/server/client';
 * export const addToCart = __serverFnStub(
 *     "@acme/api/src/cart.server.ts/addToCart",  // key: the route AND __sigxKey
 *     "addToCart",                               // export name, for error text
 *     "/_sigx/fn",                               // endpoint
 *     "9f3a01cc",                                // version: this build's tag
 *     2                                          // flags: 1 = GET read, 2 = invalidates
 * );
 * export const auditLog = __serverOnly("auditLog", "@acme/api/src/cart.server.ts");
 * ```
 *
 * The flags argument is omitted when zero (`stubCall`); a `serverStream` gets
 * `__serverStreamStub` with no flags. `__serverOnly`'s second argument is
 * the module's STABLE ID, not a raw relative path.
 *
 * One identity per function (rfc-server-v5 §1.3): the KEY `<stableId>/<name>`
 * is the only route, the registry key and the `useData(fn)` identity. Its
 * stable-id component is ROOT-INDEPENDENT (rfc-server rev 2, §3/N.4) —
 * package-qualified (`@acme/api/src/cart.server.ts`), so every app build of
 * one solution mints the SAME key for a shared server module — and the
 * options form's `id: 'cart/add'` (string literal, read statically) replaces
 * the file-derived id for published APIs that must survive file moves. The
 * VERSION (`hash8(id\0name\0normalizedCall)`, v5 §4.2) is the deploy-coupling
 * tag the stub sends with every call: the endpoint answers 409 version-skew
 * when a stale client's differs, never a silent wrong-function call. It is
 * seeded from the parsed AST, not the source text, so a reformat or a
 * comment edit keeps it while any semantic change bumps it.
 *
 * Type-only exports pass through untouched at runtime (they erase), so
 * "types + fns in one file" stays a supported layout. Everything the
 * extraction cannot represent client-side is a BUILD ERROR (rfc-server-v5
 * §1.7, the rfc-1.0 §4.5 posture): a re-export or `export *` (the names are
 * another module's — the client stub would silently lack them), a
 * default-exported server function (no stable export name), a server
 * function that is not an exported module-scope `const`, a spread in the
 * options literal (it hides the statically-read options), a non-literal
 * `id`, and a `form` / `allowAnonymous` that is not the literal `true`.
 */

import { parseAst } from 'vite';
import { hash8 } from './resume-extract.js';

interface Node {
    type: string;
    start: number;
    end: number;
    [key: string]: unknown;
}

function isNode(value: unknown): value is Node {
    return typeof value === 'object' && value !== null && 'type' in value;
}

/** One extracted server function. */
export interface ExtractedServerFn {
    /** Export name — what the stub re-exports and callers import. */
    name: string;
    /**
     * The module-local binding name behind the export (differs from `name`
     * under `export { local as exported }`) — the assignment target for the
     * SSR-side `__sigxKey` stamp. Absent for inline extractions, which
     * emit their own SSR module.
     */
    local?: string;
    /**
     * The stable key `<stableId>/<name>` (decoded form) — the route, the
     * registry key and the `__sigxKey` data identity (rfc-server-v5 §1.3).
     */
    key: string;
    /**
     * This build's version tag for the function — hash8 over the normalized
     * definition (rfc-server-v5 §4.2). Sent by the stub, checked by the
     * endpoint; never a route.
     */
    version: string;
    /** True for `serverStream` (NDJSON transport, AsyncIterable stub). */
    stream: boolean;
    /**
     * True when the options form declares `cache` (rfc-server §4.1) — the
     * stub issues GET with the arguments in the query string. Presence-only
     * detection: the VALUES are runtime data the endpoint reads off the
     * wrapper; the stub needs just this one bit. No extra version input is
     * needed — the version already covers the whole call, so toggling
     * `cache` bumps it and a stale client can never GET a function whose
     * server half does not accept GET (it 409s first).
     */
    get: boolean;
    /**
     * True when the options form declares `invalidates` (rfc-server
     * §6.2/§6.3) — the stub sends the page's boundary inventory (recorded
     * data deps included) up with the call and applies the envelope's
     * fresh entries. Presence-only detection, same rationale as `get`: the
     * PATTERNS are runtime data the endpoint reads off the wrapper.
     */
    invalidates: boolean;
    /**
     * True when the options form declares the LITERAL `form: true`
     * (rfc-server §6.4) — the fn is a declared form target, and the resume
     * transform may stamp `action`/`method` onto a `<form>` whose submit
     * handler calls it. Same no-hash-seed-change reasoning as `get`.
     */
    form: boolean;
}

/** Shared options for both extractors (file form and inline). */
export interface ServerFnExtractOptions {
    /**
     * Root-independent stable id for this module — the hash-seed path
     * component, the stable-symbol prefix, and the id in messages. Vite
     * builds derive it with `computeStableId` (`@sigx/vite/server-extract`);
     * non-Vite bundlers may pass their own.
     */
    stableId: string;
    /** Fetch target baked into stubs (the plugin's `endpoint`, default = `base`). */
    endpoint: string;
    /**
     * The access gate (rfc-server-v4 §5, #489/#611). Every extracted
     * `serverFn` and `serverStream` must have a DECIDED access policy:
     * declare `authorize: [...]`, declare the literal `allowAnonymous: true`,
     * or inherit the app default — {@link hasServerApp} says a `serverApp`
     * module is configured, so undeclared functions resolve fail-closed at
     * runtime. A bare one with no app is a build error naming the remedies.
     *
     * **Defaults to `true`.** The runtime is fail-closed, so the stakes here
     * are AVAILABILITY, not security — "forgot `allowAnonymous` on the
     * sign-in endpoint" should be a build error, not a production lockout —
     * and default-on is still right: the gate is most valuable to the app
     * that never reads an RFC. `'warn'` lists without failing; `false` opts
     * out deliberately.
     */
    requireAuthorization?: boolean | 'warn';
    /**
     * True when the build configured `sigxServer({ serverApp })` — the app
     * default decides undeclared functions, so the gate passes them
     * (rfc-server-v4 §5's third rung).
     */
    hasServerApp?: boolean;
}

/** A located build failure. Shared by both extractors. */
export interface ServerFnExtractionError {
    /** UTF-16 offset in the original source (for line/column reporting). */
    offset: number;
    message: string;
}

export interface ServerFnExtraction {
    fns: ExtractedServerFn[];
    /** Non-`serverFn` value exports — throwing `__serverOnly` stubs. */
    serverOnly: string[];
    /**
     * The subset of `serverOnly` whose declaration is PROVABLY not callable
     * (#565): a literal, a template, an object/array literal, or a class.
     *
     * `__serverOnly` hands the client a throwing FUNCTION, which is honest for
     * `export function helper()` and a lie for `export const MAX = 10` —
     * TypeScript keeps typing that `number`, so `MAX + 1` is a silent `NaN`
     * and only a CALL would throw. A class is the third shape: `new Db()` on
     * the stub fails with "is not a constructor" instead of the stub's message.
     *
     * Data, not a message, and deliberately conservative: an initializer that
     * is a call, an identifier, a member expression, or absent is left out —
     * `const helper = makeThing()` may well be callable, and a false alarm
     * costs more than a miss. The plugin emits these only in the CLIENT
     * transform, so a constant shared between server modules stays quiet.
     */
    serverOnlyValues: Array<{ name: string; kind: 'value' | 'class' }>;
    /**
     * HARD failures — the build must not proceed. Empty unless
     * `requireAuthorization` is on. The stub module is still produced: the
     * client must never receive the real module, whatever else is wrong.
     */
    errors: ServerFnExtractionError[];
    /** Constructs the extraction cannot represent client-side (re-exports…). */
    warnings: string[];
    /** The full client replacement module. */
    stubModule: string;
}

const LANG_BY_EXT: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = {
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.js': 'js',
    '.jsx': 'jsx',
    '.mjs': 'js',
    '.mts': 'ts'
};

/** Statement types that only exist at compile time — never stubbed. */
const TYPE_ONLY_DECLS = new Set(['TSTypeAliasDeclaration', 'TSInterfaceDeclaration']);

/** What a module-level `const x = …(…)` resolved to. */
interface CallKind {
    kind: 'fn' | 'stream';
}

/**
 * The options literal a `serverFn(...)` / `serverStream(...)` call passes,
 * seen through the TypeScript expression wrappers that erase at runtime —
 * `satisfies`, `as`, a non-null `!`, and parentheses — or `null` when the
 * single argument is not an object literal at all (rfc-server-v5 §1.1).
 * Every static option reader goes through this, so `serverFn({ … } satisfies
 * Opts)` reads exactly like `serverFn({ … })`.
 */
export function optionsLiteralOf(call: Node): Node | null {
    const args = (call.arguments as Node[]) ?? [];
    if (args.length !== 1) return null;
    let node: Node | undefined = args[0];
    while (
        node &&
        (node.type === 'TSSatisfiesExpression' ||
            node.type === 'TSAsExpression' ||
            node.type === 'TSNonNullExpression' ||
            node.type === 'ParenthesizedExpression')
    ) {
        node = isNode(node.expression) ? (node.expression as Node) : undefined;
    }
    return node && node.type === 'ObjectExpression' ? node : null;
}

/**
 * Statically read the options-form `id` from a `serverFn({...})` call:
 * string literal only (`nonLiteral` reports a present-but-dynamic `id` so
 * callers can warn). Shared with the inline extractor.
 */
export function readServerFnIdOption(call: Node): { id?: string; nonLiteral: boolean } {
    const literal = optionsLiteralOf(call);
    if (!literal) return { nonLiteral: false };
    for (const prop of (literal.properties as Node[]) ?? []) {
        if (prop.type !== 'Property' || prop.computed === true) continue;
        const key = prop.key as Node;
        const keyName =
            key.type === 'Identifier' ? (key.name as string)
            : key.type === 'Literal' ? String(key.value)
            : '';
        if (keyName !== 'id') continue;
        const value = prop.value as Node;
        if (value.type === 'Literal' && typeof value.value === 'string' && value.value !== '') {
            return { id: value.value, nonLiteral: false };
        }
        return { nonLiteral: true };
    }
    return { nonLiteral: false };
}

/**
 * Statically detect the options-form `cache` declaration (rfc-server §4.1)
 * on a `serverFn({...})` call — PRESENCE only, unlike `id`: the values
 * (`maxAge`, …) are runtime data the endpoint reads off the wrapper, so a
 * computed `cache: makePolicy()` still extracts. A call whose single
 * argument is not an object literal simply stays POST-only — safe
 * degradation. Shared with the inline extractor.
 */
export function readServerFnCacheOption(call: Node): boolean {
    return hasServerFnOptionKey(call, 'cache');
}

/**
 * Statically detect the options-form `invalidates` declaration (rfc-server
 * §6.2/§6.3) — presence only, like `cache`: the patterns are runtime data
 * the endpoint reads off the wrapper; the stub needs just the one bit that
 * makes it send the boundary inventory. Shared with the inline extractor.
 */
export function readServerFnInvalidatesOption(call: Node): boolean {
    return hasServerFnOptionKey(call, 'invalidates');
}

/**
 * A spread in a `serverFn({...})` options literal (#398). `id`, `cache`,
 * `invalidates`, `form`, `authorize` and `allowAnonymous` are read
 * statically from the call site, so keys arriving through a spread are
 * invisible to every reader above — and the failure would be silent in every
 * direction. A build error since rfc-server-v5 §1.7; the check deliberately
 * fires even when the spread happens to carry none of them, because which
 * keys it carries is undecidable here.
 */
export function hasServerFnOptionsSpread(call: Node): boolean {
    const literal = optionsLiteralOf(call);
    if (!literal) return false;
    return ((literal.properties as Node[]) ?? []).some((prop) => prop.type === 'SpreadElement');
}

/** The message for {@link hasServerFnOptionsSpread}, shared by both extractors. */
export function optionsSpreadError(name: string): string {
    return (
        `serverFn "${name}": a spread (\`...\`) in the options literal hides \`id\`, \`cache\`, ` +
        `\`invalidates\`, \`form\`, \`authorize\` and \`allowAnonymous\` from the build — they are ` +
        `read STATICALLY from this call site, so anything inside the spread is invisible: the ` +
        `stub would stay POST-only, no \`action\`/\`method\` would be stamped, a hidden ` +
        `\`invalidates\` would silently disable single-flight boundary refresh (rfc-server §6.3), ` +
        `and the access gate could not see a hidden policy. Write those keys literally at the ` +
        `call site (rfc-server-v5 §1.7).`
    );
}

/** The message for a non-literal `id`, shared by both extractors. */
export function nonLiteralIdError(name: string): string {
    return (
        `serverFn "${name}": \`id\` must be a non-empty string literal — it is read statically ` +
        `and becomes the function's route (rfc-server N.3, rfc-server-v5 §1.7).`
    );
}

/** The message for a `form` / `allowAnonymous` that is not the literal `true`. */
export function nonLiteralTrueError(name: string, key: string, stream = false): string {
    return (
        `${stream ? 'serverStream' : 'serverFn'} "${name}": \`${key}\` must be the LITERAL \`true\` — the build reads it ` +
        `statically, and a value that merely happens to be truthy at runtime would ` +
        `${key === 'form' ? 'stamp no form action' : 'not pass the access gate'} ` +
        `(rfc-server-v5 §1.7). Write \`${key}: true\`, or drop the key.`
    );
}

/**
 * Statically detect an `authorize:` declaration (rfc-server-v4 §1.2) —
 * presence only, like `cache`: the policies are runtime values the pipeline
 * reads off the definition, and the gate's question is "is this function's
 * access decided?".
 */
export function readServerFnAuthorizeOption(call: Node): boolean {
    return hasServerFnOptionKey(call, 'authorize');
}

/**
 * Statically detect `allowAnonymous: true` (rfc-server-v4 §1.2) — the
 * LITERAL only, the same discipline `form` and `unguarded` have: this bit
 * stands between a function and a build error, so a non-literal that
 * happened to be truthy at runtime must not silence it.
 */
export function readServerFnAllowAnonymousOption(call: Node): boolean {
    return readLiteralTrueOption(call, 'allowAnonymous') === 'true';
}

/**
 * A literal-`true` option (`form`, `allowAnonymous`) that is PRESENT but not
 * the literal — a build error (rfc-server-v5 §1.7): the bit stands between a
 * function and a build error or a stamped action, so a non-literal that
 * happened to be truthy at runtime must never silently pass.
 */
export function invalidLiteralTrueOption(call: Node, keyName: string): boolean {
    return readLiteralTrueOption(call, keyName) === 'invalid';
}

/**
 * The message the gate fails with. It names every remedy, because the check
 * verifies DECLARATION, not correctness — it converts "silently undecided"
 * into "a list a human wrote", which is the unit a review can act on.
 */
export function missingAuthorizationError(name: string, stream: boolean): string {
    const wrapper = stream ? 'serverStream' : 'serverFn';
    return (
        `${wrapper} "${name}" has no decided access policy. Every server function is a ` +
        `public endpoint reachable on every transport, so it must declare ` +
        `\`authorize: [...]\`, say \`allowAnonymous: true\` if it is deliberately open ` +
        `to anonymous callers (middleware and authentication still run for it), or ` +
        `inherit the app default by configuring sigxServer({ serverApp }) + ` +
        `createServerApp({ authenticate, … }) (rfc-server-v4 §1.2, §5). Turn this check ` +
        `off with sigxServer({ requireAuthorization: false }), or down with 'warn' ` +
        `while migrating.`
    );
}

/** The literal `true` on a non-computed key — the `form` discipline.
 *  `'invalid'` is present-but-not-the-literal. */
function readLiteralTrueOption(call: Node, keyName: string): 'absent' | 'true' | 'invalid' {
    const literal = optionsLiteralOf(call);
    if (!literal) return 'absent';
    for (const prop of (literal.properties as Node[]) ?? []) {
        if (prop.type !== 'Property' || prop.computed === true) continue;
        const key = prop.key as Node;
        const name =
            key.type === 'Identifier' ? (key.name as string)
            : key.type === 'Literal' ? String(key.value)
            : '';
        if (name !== keyName) continue;
        const value = prop.value as Node;
        return value.type === 'Literal' && value.value === true ? 'true' : 'invalid';
    }
    return 'absent';
}

/** Presence of a non-computed key on the single object-literal argument. */
function hasServerFnOptionKey(call: Node, keyName: string): boolean {
    const literal = optionsLiteralOf(call);
    if (!literal) return false;
    for (const prop of (literal.properties as Node[]) ?? []) {
        if (prop.type !== 'Property' || prop.computed === true) continue;
        const key = prop.key as Node;
        const name =
            key.type === 'Identifier' ? (key.name as string)
            : key.type === 'Literal' ? String(key.value)
            : '';
        if (name === keyName) return true;
    }
    return false;
}

/**
 * Statically detect the options-form `form: true` declaration (rfc-server
 * §6.4) — stricter than `cache`'s presence-only rule: the LITERAL `true`
 * is required, because this bit gates a build-stamped `action` attribute,
 * and a stamped action pointing at a fn whose runtime mark resolved false
 * would 415 with no JS on the page to recover. Shared with the inline
 * extractor.
 */
export function readServerFnFormOption(call: Node): boolean {
    return readLiteralTrueOption(call, 'form') === 'true';
}

/**
 * Every node under `node`, skipping TS type-only subtrees (annotations
 * erase; expression-carrying wrappers like as-casts still contain runtime
 * code). The file-form twin of the inline extractor's walker, used for the
 * misplaced-call check (rfc-server-v5 §1.7).
 */
export function forEachNode(node: Node, visit: (node: Node) => void): void {
    if (node.type.startsWith('TS')) {
        if (isNode(node.expression)) forEachNode(node.expression as Node, visit);
        return;
    }
    visit(node);
    for (const key of Object.keys(node)) {
        const value = node[key];
        if (Array.isArray(value)) {
            for (const item of value) if (isNode(item)) forEachNode(item, visit);
        } else if (isNode(value)) {
            forEachNode(value as Node, visit);
        }
    }
}

/**
 * True when the call takes exactly ONE object-literal argument — the only
 * shape `@sigx/server` accepts since rfc-server-v5 §1.1. The direct form
 * (`serverFn(async (rq, …) => …)`) is gone from the runtime, so accepting it
 * here would compile a module that throws on first call; a non-literal
 * options object (`serverFn(opts)`) hides EVERY statically-read option
 * (`id`, `cache`, `form`, `invalidates`, `authorize`, `allowAnonymous`),
 * the spread rule taken to its conclusion.
 */
export function hasOptionsLiteralArgument(call: Node): boolean {
    return optionsLiteralOf(call) !== null;
}

/** The message for {@link hasOptionsLiteralArgument} failing, shared by both extractors. */
export function optionsLiteralError(name: string, stream: boolean): string {
    const wrapper = stream ? 'serverStream' : 'serverFn';
    return (
        `${wrapper} "${name}": the only authoring form is ${wrapper}({ input?, handler, … }) ` +
        `with ONE object-literal argument (rfc-server-v5 §1.1). The direct form ` +
        `${wrapper}(async ${stream ? 'function* ' : ''}(rq, …) => …) was removed — it cannot ` +
        `declare validation or access and would throw on first call — and a non-literal ` +
        `options object hides the statically-read declarations (\`id\`, \`cache\`, \`form\`, ` +
        `\`invalidates\`, \`authorize\`, \`allowAnonymous\`) from the build. Write the ` +
        `options object literally at the call site.`
    );
}

/** The message for a `serverFn()` call that is not an exported module-scope `const`. */
export function misplacedServerFnError(): string {
    return (
        'serverFn() must be an exported module-scope `const name = serverFn(...)` in a ' +
        'server module — not created inside a function or expression (component state ' +
        'crosses the boundary as arguments, never as captures; rfc-server §1.2), not a ' +
        'let/var binding (the stub swap needs a fixed binding), and not left unexported ' +
        '(an unexported server function has no route and would be silently dropped; ' +
        'rfc-server-v5 §1.7).'
    );
}

/**
 * Make a stable id safe to spend as REAL URL path segments (#355).
 *
 * The stable symbol is no longer squeezed into one percent-encoded segment,
 * so the id's own slashes are now structural — which means two hazards it
 * never had to care about while everything was `%2F`:
 *
 * - **`.` / `..` segments.** `computeStableId`'s build-root-relative fallback
 *   emits `../` for out-of-root files, and `new URL()` RESOLVES those away
 *   before the endpoint ever sees the path — a route that silently points
 *   somewhere else. They become `_up` / `_here`.
 * - **Characters outside RFC 3986's `pchar`.** Percent-encoded per segment,
 *   a rare escape valve: `@` and `-._~!*'()` stay literal, so a normal
 *   package-qualified id (`@acme/api/src/cart.server.ts`) survives with no
 *   `%` at all — which is the whole point of the change.
 *
 * Empty segments are dropped: `a//b` carries one separator's worth of
 * meaning but two segments of URL, and the endpoint rejoins on `/`.
 */
export function routeSafeId(id: string): string {
    return id
        .split('/')
        .map((segment) =>
            segment === '..' ? '_up'
            : segment === '.' ? '_here'
            // encodeURIComponent already leaves `-._~!*'()` alone; `@` is
            // `pchar` too, and un-escaping it is what keeps scoped package
            // names readable.
            : encodeURIComponent(segment).replace(/%40/g, '@')
        )
        .filter((segment) => segment !== '')
        .join('/');
}

/**
 * An explicit `id` is a PUBLISHED route — the author wrote the URL they
 * meant. If `routeSafeId` had to rewrite it, say so rather than serving a
 * different route than the source reads (shared with the inline extractor).
 */
export function warnIfIdRewritten(warnings: string[], local: string, id: string): void {
    const safe = routeSafeId(id);
    if (safe === id) return;
    warnings.push(
        `serverFn "${local}": \`id: ${JSON.stringify(id)}\` is not URL-path-safe and ` +
        `routes as ${JSON.stringify(safe)} — write the id you want in the URL ` +
        `(rfc-server N.3, #355).`
    );
}

/**
 * The version seed (rfc-server-v5 §4.2): the parsed `serverFn(...)` /
 * `serverStream(...)` call, serialized WITHOUT positions (`start`/`end`/
 * `range`/`loc`) or literal spellings (`raw`), so a reformat, a comment
 * edit or `1.0` vs `1` keeps the version while any identifier, literal or
 * structural change — the handler body, the `input` schema expression, the
 * `authorize` list — bumps it. BigInt literal values are mapped to strings
 * (`JSON.stringify` throws on them). Comments are absent from the ESTree
 * body already. A parser upgrade that reorders node properties bumps every
 * version once — harmless, both ends ship from one build.
 */
export function normalizeServerFnCall(call: Node): string {
    return JSON.stringify(call, (key, value) =>
        key === 'start' || key === 'end' || key === 'range' || key === 'loc' || key === 'raw'
            ? undefined
            : typeof value === 'bigint'
              ? String(value)
              : value
    );
}

/**
 * Mint one function's identity (rfc-server-v5 §1.3/§4.1): the KEY
 * `<id>/<name>`, stored DECODED (per-segment URL-encoding is the stub's
 * request-time job; the endpoint decodes the same way), and the VERSION
 * `hash8(id\0name\0normalizedCall)` (`\0` is only ever a seed FIELD
 * separator; never part of the id). An explicit options-form `id` replaces
 * the file-derived stable id, so id'd functions survive file moves.
 *
 * The id is `routeSafeId`-normalized FIRST, so the version seed and the key
 * agree on one spelling.
 */
export function mintIdentity(
    name: string,
    call: Node,
    explicitId: string | undefined,
    stableId: string,
    stream = false,
    get = false,
    invalidates = false,
    form = false
): ExtractedServerFn {
    const fnStableId = routeSafeId(explicitId ?? stableId);
    return {
        name,
        key: `${fnStableId}/${name}`,
        version: hash8(`${fnStableId}\0${name}\0${normalizeServerFnCall(call)}`),
        stream,
        get,
        invalidates,
        form
    };
}

/** Bit 0 of a fn stub's `flags`: a cache-marked GET read (rfc-server §4.1). */
export const STUB_FLAG_GET = 1;
/** Bit 1: an `invalidates`-declaring mutation (§6.2/§6.3). */
export const STUB_FLAG_INVALIDATES = 2;

/** The bitmask a fn stub call carries (rfc-server-v5 §1.4); `0` for a stream. */
export function stubFlags(fn: { stream: boolean; get: boolean; invalidates: boolean }): number {
    if (fn.stream) return 0;
    return (fn.get ? STUB_FLAG_GET : 0) | (fn.invalidates ? STUB_FLAG_INVALIDATES : 0);
}

/**
 * The ONE stub call both emitters (file form and inline) write, so the two
 * cannot drift: `__serverFnStub(key, name, endpoint, version, flags?)` —
 * flags omitted when zero — or `__serverStreamStub(key, name, endpoint,
 * version)`.
 */
export function stubCall(fn: ExtractedServerFn, endpoint: string): string {
    const factory = fn.stream ? '__serverStreamStub' : '__serverFnStub';
    const flags = stubFlags(fn);
    return (
        `${factory}(${JSON.stringify(fn.key)}, ${JSON.stringify(fn.name)}, ` +
        `${JSON.stringify(endpoint)}, ${JSON.stringify(fn.version)}${flags ? `, ${flags}` : ''})`
    );
}

/**
 * Marker comment guarding the SSR-side key-stamp block against re-append
 * when a transform re-runs over already-stamped output.
 */
export const KEY_STAMP_MARKER = '/*! sigx:server-fn-keys */';

/**
 * The SSR-side `__sigxKey` stamp block for a file-form extraction — one
 * assignment per extracted fn onto its LOCAL binding, so the server
 * wrapper carries the same stable key the client stub does and
 * `useData(fn)` / fn-ref `invalidates` key identically on both sides.
 * Streams are skipped (not `useData` targets). One local exported under
 * two names mints two symbols — the FIRST export's key wins here, matching
 * the stub whose key a client actually calls through first.
 */
export function serverFnKeyStamps(fns: ExtractedServerFn[]): string {
    // rfc-server-v4 retired the `__sigxGuardChecked`/`__SIGX_GUARDS_CHECKED__`
    // halves this block used to emit: the fail-closed runtime closed the
    // unanalyzed-module gap they mitigated (an unanalyzed module now DENIES
    // instead of running open), so there is nothing left to mark.
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const fn of fns) {
        if (!fn.local || seen.has(fn.local) || fn.stream) continue;
        seen.add(fn.local);
        // Streams are not `useData` targets, so they get no key.
        lines.push(`${fn.local}.__sigxKey = ${JSON.stringify(fn.key)};`);
    }
    if (lines.length === 0) return '';
    return `\n${KEY_STAMP_MARKER}\n${lines.join('\n')}\n`;
}

/**
 * @param code    - module source
 * @param id      - absolute module path (parse lang from its extension)
 * @param options - stable id and baked endpoint
 */
export function extractServerFns(
    code: string,
    id: string,
    options: ServerFnExtractOptions
): ServerFnExtraction {
    const clean = id.split('?')[0];
    const ext = clean.slice(clean.lastIndexOf('.'));
    const program = parseAst(code, { lang: LANG_BY_EXT[ext] ?? 'ts' }, clean) as unknown as Node;

    // -- pass 1: locals — `serverFn`/`serverStream` aliases (named or
    // namespace imports) and their module-level declarations --
    const wrapperLocals = new Map<string, 'fn' | 'stream'>();
    const namespaceLocals = new Set<string>();
    for (const stmt of program.body as Node[]) {
        if (stmt.type !== 'ImportDeclaration') continue;
        if (((stmt.source as Node).value as string) !== '@sigx/server') continue;
        if (stmt.importKind === 'type') continue;
        for (const spec of (stmt.specifiers as Node[]) ?? []) {
            if (spec.importKind === 'type') continue;
            if (spec.type === 'ImportNamespaceSpecifier') {
                namespaceLocals.add((spec.local as Node).name as string);
                continue;
            }
            if (spec.type !== 'ImportSpecifier') continue;
            const imported = (spec.imported as Node).name as string;
            if (imported === 'serverFn') {
                wrapperLocals.set((spec.local as Node).name as string, 'fn');
            } else if (imported === 'serverStream') {
                wrapperLocals.set((spec.local as Node).name as string, 'stream');
            }
        }
    }

    const warnings: string[] = [];
    const errors: ServerFnExtractionError[] = [];
    // Default ON: forgetting is the failure mode worth catching, and declining
    // is a word you type once in the function it applies to (§5).
    const requireAuthorization = options.requireAuthorization ?? true;
    /** Call nodes accepted as module-scope `const` declarations. */
    const accepted = new Set<Node>();

    /** local name → wrapped call node + kind + explicit stable id + GET
     *  mark, for `export { x }` resolution. */
    const localFnSources = new Map<
        string,
        {
            node: Node;
            stream: boolean;
            explicitId?: string;
            get: boolean;
            invalidates: boolean;
            form: boolean;
        }
    >();
    const wrapperKind = (init: unknown): CallKind | undefined => {
        if (!isNode(init) || init.type !== 'CallExpression' || !isNode(init.callee)) {
            return undefined;
        }
        const callee = init.callee as Node;
        if (callee.type === 'Identifier') {
            const direct = wrapperLocals.get((callee.name as string) ?? '');
            return direct === undefined ? undefined : { kind: direct };
        }
        if (
            callee.type === 'MemberExpression' &&
            callee.computed !== true &&
            (callee.object as Node).type === 'Identifier' &&
            isNode(callee.property)
        ) {
            const object = ((callee.object as Node).name as string) ?? '';
            const prop = (callee.property as Node).name as string;
            // Namespace form: `srv.serverFn(...)` / `srv.serverStream(...)`.
            if (namespaceLocals.has(object)) {
                if (prop === 'serverFn') return { kind: 'fn' };
                if (prop === 'serverStream') return { kind: 'stream' };
            }
        }
        return undefined;
    };
    const isServerFnCall = (init: unknown): init is Node => wrapperKind(init) !== undefined;

    for (const stmt of program.body as Node[]) {
        const decl = stmt.type === 'ExportNamedDeclaration' && isNode(stmt.declaration)
            ? (stmt.declaration as Node)
            : stmt;
        if (decl.type !== 'VariableDeclaration') continue;
        for (const declarator of decl.declarations as Node[]) {
            if ((declarator.id as Node).type !== 'Identifier') continue;
            const call = wrapperKind(declarator.init);
            if (call === undefined) continue;
            const init = declarator.init as Node;
            // Claim the call site NOW — an invalid declaration raises ONE
            // precise error, not also the misplaced-call error below.
            accepted.add(init);
            if (decl.kind !== 'const') {
                errors.push({ offset: (declarator.id as Node).start, message: misplacedServerFnError() });
                continue;
            }
            const local = (declarator.id as Node).name as string;
            if (!hasOptionsLiteralArgument(init)) {
                // ONE precise error; the readers below all assume the literal.
                errors.push({ offset: init.start, message: optionsLiteralError(local, call.kind === 'stream') });
                continue;
            }
            // Explicit `id` stays a serverFn-only option — serverStream's
            // options forms (#489/#572) don't carry it, so only serverFn
            // calls are probed.
            const idOption =
                call.kind === 'fn'
                    ? readServerFnIdOption(init)
                    : { id: undefined, nonLiteral: false as const };
            if (idOption.nonLiteral) errors.push({ offset: init.start, message: nonLiteralIdError(local) });
            if (idOption.id !== undefined) warnIfIdRewritten(warnings, local, idOption.id);
            if (hasServerFnOptionsSpread(init)) {
                errors.push({ offset: init.start, message: optionsSpreadError(local) });
            }
            for (const key of call.kind === 'fn' ? ['form', 'allowAnonymous'] : ['allowAnonymous']) {
                if (invalidLiteralTrueOption(init, key)) {
                    errors.push({
                        offset: init.start,
                        message: nonLiteralTrueError(local, key, call.kind === 'stream')
                    });
                }
            }
            // The access gate (#489, rfc-server-v4 §5): a function passes
            // when its access is DECIDED — `authorize` declared, the literal
            // `allowAnonymous: true`, or a configured `serverApp` whose
            // default decides undeclared functions (fail-closed at runtime).
            // A stream is held to the same rule: it is a public endpoint too.
            if (
                requireAuthorization !== false &&
                !options.hasServerApp &&
                !readServerFnAuthorizeOption(init) &&
                !readServerFnAllowAnonymousOption(init)
            ) {
                const message = missingAuthorizationError(local, call.kind === 'stream');
                if (requireAuthorization === 'warn') warnings.push(message);
                else errors.push({ offset: init.start, message });
            }
            localFnSources.set(local, {
                node: init,
                stream: call.kind === 'stream',
                explicitId: idOption.id,
                get: call.kind === 'fn' && readServerFnCacheOption(init),
                invalidates: call.kind === 'fn' && readServerFnInvalidatesOption(init),
                form: call.kind === 'fn' && readServerFnFormOption(init)
            });
        }
    }

    // -- pass 2: exports --
    const fns: ExtractedServerFn[] = [];
    const serverOnly: string[] = [];
    /** Locals that reached an export — the rest are unexported server fns. */
    const exportedLocals = new Set<string>();
    const serverOnlyValues: Array<{ name: string; kind: 'value' | 'class' }> = [];

    /**
     * Local name → what its declaration provably is, for the #565 warning.
     * Only shapes that CANNOT be callable are recorded; everything else is
     * absent and therefore never warned about.
     */
    const localKinds = new Map<string, 'value' | 'class'>();
    const NOT_CALLABLE = new Set([
        'Literal',
        'TemplateLiteral',
        'ObjectExpression',
        'ArrayExpression'
    ]);
    for (const stmt of program.body as Node[]) {
        const decl = (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration'
            ? (isNode(stmt.declaration) ? (stmt.declaration as Node) : null)
            : stmt) as Node | null;
        if (!decl) continue;
        if (decl.type === 'ClassDeclaration' && isNode(decl.id)) {
            localKinds.set((decl.id as Node).name as string, 'class');
        } else if (decl.type === 'VariableDeclaration') {
            for (const d of decl.declarations as Node[]) {
                if ((d.id as Node)?.type !== 'Identifier') continue;
                const init = isNode(d.init) ? (d.init as Node) : null;
                if (init && NOT_CALLABLE.has(init.type as string)) {
                    localKinds.set((d.id as Node).name as string, 'value');
                } else if (init && init.type === 'ClassExpression') {
                    localKinds.set((d.id as Node).name as string, 'class');
                }
            }
        }
    }

    const addExport = (exportedName: string, localName: string): void => {
        const record = localFnSources.get(localName);
        if (record !== undefined) {
            exportedLocals.add(localName);
            fns.push({
                ...mintIdentity(
                    exportedName,
                    record.node,
                    record.explicitId,
                    options.stableId,
                    record.stream,
                    record.get,
                    record.invalidates,
                    record.form
                ),
                local: localName
            });
        } else {
            serverOnly.push(exportedName);
            const kind = localKinds.get(localName);
            if (kind) serverOnlyValues.push({ name: exportedName, kind });
        }
    };

    for (const stmt of program.body as Node[]) {
        if (stmt.type === 'ExportAllDeclaration') {
            // Type-only `export type * from` erases; a value `export *` is a
            // build error (v5 §1.7): the client stub would silently lack the
            // names, and the first browser import would fail instead.
            if (stmt.exportKind === 'type') continue;
            errors.push({
                offset: stmt.start,
                message:
                    `"export * from ${JSON.stringify((stmt.source as Node).value)}" cannot be stubbed ` +
                    `for the client — re-exported names are unknown here, so the stub would silently ` +
                    `lack them. Import and re-wrap what the client needs, or move the re-export out ` +
                    `of the server module (rfc-server-v5 §1.7).`
            });
            continue;
        }
        if (stmt.type === 'ExportDefaultDeclaration') {
            if (isServerFnCall(stmt.declaration)) {
                // Its route needs a stable export name; nothing to mint. ONE
                // precise error: claim the call so the misplaced-call walk
                // below does not report it a second time.
                accepted.add(stmt.declaration as Node);
                errors.push({
                    offset: stmt.start,
                    message:
                        'default-exported serverFn cannot be extracted — the route needs a stable ' +
                        'export name. Use a named export (rfc-server-v5 §1.7).'
                });
            }
            serverOnly.push('default');
            continue;
        }
        if (stmt.type !== 'ExportNamedDeclaration') continue;
        if (stmt.exportKind === 'type') continue;
        if (isNode(stmt.source)) {
            // `export { type A, type B } from './x'` erases like
            // `export type { … } from` — only a VALUE re-export is refused.
            const specs = (stmt.specifiers as Node[]) ?? [];
            if (specs.length > 0 && specs.every((spec) => spec.exportKind === 'type')) continue;
            errors.push({
                offset: stmt.start,
                message:
                    `re-export from ${JSON.stringify((stmt.source as Node).value)} cannot be stubbed ` +
                    `for the client — the bindings are another module's, so the stub would silently ` +
                    `lack them. Import and re-wrap instead (rfc-server-v5 §1.7).`
            });
            continue;
        }
        const decl = isNode(stmt.declaration) ? (stmt.declaration as Node) : null;
        if (decl) {
            if (TYPE_ONLY_DECLS.has(decl.type)) continue;
            if (decl.type === 'VariableDeclaration') {
                for (const declarator of decl.declarations as Node[]) {
                    if ((declarator.id as Node).type === 'Identifier') {
                        addExport((declarator.id as Node).name as string, (declarator.id as Node).name as string);
                    } else {
                        warnings.push(
                            'destructured export cannot be stubbed for the client — export bindings by name.'
                        );
                    }
                }
            } else if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') {
                const name = isNode(decl.id) ? ((decl.id as Node).name as string) : '';
                if (name) {
                    serverOnly.push(name);
                    // A class stub is a throwing FUNCTION, so `new X()` fails
                    // with "is not a constructor" rather than the stub's own
                    // message (#565). A function declaration is stubbed
                    // honestly and says nothing.
                    if (decl.type === 'ClassDeclaration') {
                        serverOnlyValues.push({ name, kind: 'class' });
                    }
                }
            }
            continue;
        }
        for (const spec of (stmt.specifiers as Node[]) ?? []) {
            if (spec.exportKind === 'type') continue;
            const local = ((spec.local as Node)?.name as string) ?? '';
            const exported = ((spec.exported as Node)?.name as string) ?? local;
            if (!local) continue;
            // `export { x as default }` — same posture as `export default`:
            // a transport symbol needs a stable NAMED export.
            if (exported === 'default') {
                if (localFnSources.has(local)) {
                    exportedLocals.add(local);
                    errors.push({
                        offset: (spec.exported as Node).start,
                        message:
                            'default-exported serverFn cannot be extracted — the route needs a stable ' +
                            'export name. Use a named export (rfc-server-v5 §1.7).'
                    });
                }
                serverOnly.push('default');
                continue;
            }
            addExport(exported, local);
        }
    }
    // Any serverFn call NOT accepted above is misplaced — inside a function
    // or expression, a destructured declarator — a hard error (v5 §1.7).
    // After pass 2, so a default-exported call is claimed by its own error.
    forEachNode(program, (node) => {
        if (node.type === 'CallExpression' && isServerFnCall(node) && !accepted.has(node)) {
            errors.push({ offset: node.start, message: misplacedServerFnError() });
        }
    });
    // A module-scope server function that never reached an export has no
    // route: it used to be silently omitted from the stub (v5 §1.7).
    for (const [local, record] of localFnSources) {
        if (!exportedLocals.has(local)) {
            errors.push({ offset: record.node.start, message: misplacedServerFnError() });
        }
    }

    // -- stub module --
    const lines: string[] = [];
    if (fns.length > 0 || serverOnly.length > 0) {
        const used: string[] = [];
        if (fns.some((fn) => !fn.stream)) used.push('__serverFnStub');
        if (fns.some((fn) => fn.stream)) used.push('__serverStreamStub');
        if (serverOnly.length > 0) used.push('__serverOnly');
        lines.push(`import { ${used.join(', ')} } from '@sigx/server/client';`);
    }
    for (const fn of fns) {
        lines.push(`export const ${fn.name} = ${stubCall(fn, options.endpoint)};`);
    }
    for (const name of serverOnly) {
        lines.push(
            name === 'default'
                ? `export default __serverOnly("default", ${JSON.stringify(options.stableId)});`
                : `export const ${name} = __serverOnly(${JSON.stringify(name)}, ${JSON.stringify(options.stableId)});`
        );
    }
    if (lines.length === 0) lines.push('export {};');

    return { fns, serverOnly, serverOnlyValues, errors, warnings, stubModule: lines.join('\n') };
}
