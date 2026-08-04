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
 *     "addToCart_fn_9f3a01cc",                   // wire symbol (content-hashed)
 *     "addToCart",                               // export name, for error text
 *     "/_sigx/fn",                               // endpoint
 *     "@acme/api/src/cart.server.ts/addToCart",  // stable key → __sigxKey
 *     0,                                         // 1 = cache-marked GET read (§4.1)
 *     1                                          // 1 = declares invalidates (§6.2/§6.3)
 * );
 * export const auditLog = __serverOnly("auditLog", "@acme/api/src/cart.server.ts");
 * ```
 *
 * The two positional flags are omitted when unset (`stubFlags`), so an
 * unmarked function's stub is byte-identical to what shipped before either
 * feature existed; a `serverStream` gets `__serverStreamStub` with no key and
 * no flags. `__serverOnly`'s second argument is the module's STABLE ID, not a
 * raw relative path.
 *
 * Symbols are content-hashed (`<name>_fn_<hash8(stableId\0name\0implSource)>`,
 * the resume discipline) so version skew is a detectable 404 — a stale client
 * posts an old symbol and the stub surfaces a typed "stale build" error,
 * never a silent wrong-function call. The seed's path component is a
 * ROOT-INDEPENDENT stable id (rfc-server rev 2, §3/N.4) — package-qualified
 * (`@acme/api/src/cart.server.ts`), so every app build of one solution mints
 * the SAME symbol for a shared server module. Alongside it every function
 * gets a hash-free STABLE symbol (`<stableId>/<name>`, N.3) so backend
 * redeploys never break installed native clients; the options form's
 * `id: 'cart/add'` (string literal, read statically) replaces the file-derived
 * id for published APIs that must survive file moves.
 *
 * Type-only exports pass through untouched at runtime (they erase), so
 * "types + fns in one file" stays a supported layout. Re-exports cannot be
 * stubbed (the names are another module's) and are surfaced as warnings.
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
    /** Content-hashed transport symbol: `<name>_fn_<hash8>`. */
    symbol: string;
    /** Hash-free stable symbol: `<stableId>/<name>` (decoded form). */
    stableSymbol: string;
    /** True for `serverStream` (NDJSON transport, AsyncIterable stub). */
    stream: boolean;
    /**
     * True when the options form declares `cache` (rfc-server §4.1) — the
     * stub issues GET with the arguments in the query string. Presence-only
     * detection: the VALUES are runtime data the endpoint reads off the
     * wrapper; the stub needs just this one bit. No hash-seed change is
     * needed — the symbol already covers the call source, so toggling
     * `cache` re-mints it and a stale client can never GET a symbol whose
     * server half does not accept GET.
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
    /** Which symbol stubs carry: hashed (web, default) or stable (`role: 'client'`). */
    stubSymbols?: 'hashed' | 'stable';
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
 * Statically read the options-form `id` from a `serverFn({...})` call:
 * string literal only (`nonLiteral` reports a present-but-dynamic `id` so
 * callers can warn). Shared with the inline extractor.
 */
export function readServerFnIdOption(call: Node): { id?: string; nonLiteral: boolean } {
    const args = (call.arguments as Node[]) ?? [];
    if (args.length !== 1 || args[0]?.type !== 'ObjectExpression') return { nonLiteral: false };
    for (const prop of (args[0].properties as Node[]) ?? []) {
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
 * `invalidates` and `form` are read statically from the call site, so keys
 * arriving through a spread are invisible to every reader above — and the
 * failure is silent in all four directions. Warning-only: the function still
 * extracts, and the check deliberately fires even when the spread happens to
 * carry none of them, because which keys it carries is undecidable here.
 */
export function hasServerFnOptionsSpread(call: Node): boolean {
    const args = (call.arguments as Node[]) ?? [];
    if (args.length !== 1 || args[0]?.type !== 'ObjectExpression') return false;
    return ((args[0].properties as Node[]) ?? []).some((prop) => prop.type === 'SpreadElement');
}

/** The message for {@link hasServerFnOptionsSpread}, shared by both extractors. */
export function optionsSpreadWarning(name: string): string {
    return (
        `serverFn "${name}": a spread (\`...\`) in the options literal hides \`id\`, \`cache\`, ` +
        `\`invalidates\` and \`form\` from the build — all four are read STATICALLY from this ` +
        `call site, so anything inside the spread is invisible: the stub stays POST-only, no ` +
        `\`action\`/\`method\` is stamped, and a hidden \`invalidates\` silently disables ` +
        `single-flight boundary refresh (rfc-server §6.3). Write those four keys literally at ` +
        `the call site.`
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
    return readLiteralTrueOption(call, 'allowAnonymous');
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

/** The literal `true` on a non-computed key — the `form` discipline. */
function readLiteralTrueOption(call: Node, keyName: string): boolean {
    const args = (call.arguments as Node[]) ?? [];
    if (args.length !== 1 || args[0]?.type !== 'ObjectExpression') return false;
    for (const prop of (args[0].properties as Node[]) ?? []) {
        if (prop.type !== 'Property' || prop.computed === true) continue;
        const key = prop.key as Node;
        const name =
            key.type === 'Identifier' ? (key.name as string)
            : key.type === 'Literal' ? String(key.value)
            : '';
        if (name !== keyName) continue;
        const value = prop.value as Node;
        return value.type === 'Literal' && value.value === true;
    }
    return false;
}

/** Presence of a non-computed key on the single object-literal argument. */
function hasServerFnOptionKey(call: Node, keyName: string): boolean {
    const args = (call.arguments as Node[]) ?? [];
    if (args.length !== 1 || args[0]?.type !== 'ObjectExpression') return false;
    for (const prop of (args[0].properties as Node[]) ?? []) {
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
    const args = (call.arguments as Node[]) ?? [];
    if (args.length !== 1 || args[0]?.type !== 'ObjectExpression') return false;
    for (const prop of (args[0].properties as Node[]) ?? []) {
        if (prop.type !== 'Property' || prop.computed === true) continue;
        const key = prop.key as Node;
        const keyName =
            key.type === 'Identifier' ? (key.name as string)
            : key.type === 'Literal' ? String(key.value)
            : '';
        if (keyName !== 'form') continue;
        const value = prop.value as Node;
        return value.type === 'Literal' && value.value === true;
    }
    return false;
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
 * Mint both transport symbols for one function (rfc-server rev 2, §3/N.3):
 * hashed — `<name>_fn_<hash8(id\0name\0implSource)>` (`\0` is only ever a
 * hash-seed FIELD separator; never part of the id) — and stable —
 * `<id>/<name>`, stored DECODED (per-segment URL-encoding is the stub's
 * request-time job; the endpoint decodes the same way). An explicit
 * options-form `id` replaces the file-derived stable id in BOTH, so id'd
 * functions survive file moves with hashed and stable routes alike.
 *
 * The id is `routeSafeId`-normalized FIRST, so the hash seed and the stable
 * symbol agree on one spelling — an id that normalizes cannot mint a symbol
 * pair the endpoint would resolve differently.
 */
export function mintSymbols(
    name: string,
    implSource: string,
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
        symbol: `${name}_fn_${hash8(`${fnStableId}\0${name}\0${implSource}`)}`,
        stableSymbol: `${fnStableId}/${name}`,
        stream,
        get,
        invalidates,
        form
    };
}

/**
 * The positional flags a fn stub call carries after the stable-key argument
 * (5th: GET read §4.1; 6th: invalidates-declaring mutation §6.2/§6.3). Unflagged
 * output stays byte-identical to before either feature existed.
 */
export function stubFlags(fn: { stream: boolean; get: boolean; invalidates: boolean }): string {
    if (fn.stream) return '';
    if (fn.invalidates) return fn.get ? ', 1, 1' : ', 0, 1';
    return fn.get ? ', 1' : '';
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
        lines.push(`${fn.local}.__sigxKey = ${JSON.stringify(fn.stableSymbol)};`);
    }
    if (lines.length === 0) return '';
    return `\n${KEY_STAMP_MARKER}\n${lines.join('\n')}\n`;
}

/**
 * @param code    - module source
 * @param id      - absolute module path (parse lang from its extension)
 * @param options - stable id, baked endpoint, and stub symbol mode
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

    /** local name → wrapped call source + kind + explicit stable id + GET
     *  mark, for `export { x }` resolution. */
    const localFnSources = new Map<
        string,
        {
            source: string;
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
            const local = (declarator.id as Node).name as string;
            // Explicit `id` stays a serverFn-only option — serverStream's
            // options forms (#489/#572) don't carry it, so only serverFn
            // calls are probed.
            const idOption =
                call.kind === 'fn'
                    ? readServerFnIdOption(init)
                    : { id: undefined, nonLiteral: false as const };
            if (idOption.nonLiteral) {
                warnings.push(
                    `serverFn "${local}": \`id\` must be a ` +
                    `non-empty string literal (it is read statically) — falling back to the ` +
                    `file-derived stable id.`
                );
            }
            if (idOption.id !== undefined) warnIfIdRewritten(warnings, local, idOption.id);
            if (call.kind === 'fn' && hasServerFnOptionsSpread(init)) {
                warnings.push(optionsSpreadWarning(local));
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
            const callSource = code.slice(init.start, init.end);
            localFnSources.set(local, {
                source: callSource,
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
            fns.push({
                ...mintSymbols(
                    exportedName,
                    record.source,
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
            warnings.push(
                `"export * from ${JSON.stringify((stmt.source as Node).value)}" cannot be stubbed ` +
                `for the client — re-exported names are unknown here. Import and re-wrap what ` +
                `the client needs, or move the re-export out of the server module.`
            );
            continue;
        }
        if (stmt.type === 'ExportDefaultDeclaration') {
            if (isServerFnCall(stmt.declaration)) {
                warnings.push(
                    'default-exported serverFn is not extracted — the transport symbol needs a ' +
                    'stable export name. Use a named export.'
                );
            }
            serverOnly.push('default');
            continue;
        }
        if (stmt.type !== 'ExportNamedDeclaration') continue;
        if (stmt.exportKind === 'type') continue;
        if (isNode(stmt.source)) {
            warnings.push(
                `re-export from ${JSON.stringify((stmt.source as Node).value)} cannot be stubbed ` +
                `for the client — the bindings are another module's. Import and re-wrap instead.`
            );
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
                    warnings.push(
                        'default-exported serverFn is not extracted — the transport symbol needs a ' +
                        'stable export name. Use a named export.'
                    );
                }
                serverOnly.push('default');
                continue;
            }
            addExport(exported, local);
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
        const wireSymbol = options.stubSymbols === 'stable' ? fn.stableSymbol : fn.symbol;
        const factory = fn.stream ? '__serverStreamStub' : '__serverFnStub';
        // 4th positional: the stable data key (`useData(fn)` identity, fn
        // stubs only). Positional flags after it (§4.1 GET, §6.2 invalidates)
        // — absent flags keep unmarked output byte-identical to before.
        const keyArg = fn.stream ? '' : `, ${JSON.stringify(fn.stableSymbol)}`;
        lines.push(
            `export const ${fn.name} = ${factory}(${JSON.stringify(wireSymbol)}, ` +
            `${JSON.stringify(fn.name)}, ${JSON.stringify(options.endpoint)}${keyArg}${stubFlags(fn)});`
        );
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
