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
 * export const addToCart = __serverFnStub("addToCart_fn_9f3a01cc", "addToCart", "/_sigx/fn");
 * export const auditLog = __serverOnly("auditLog", "src/cart.server.ts");
 * ```
 *
 * Symbols are content-hashed (`<name>_fn_<hash8(stableId\0name\0implSource)>`,
 * the resume discipline) so version skew is a detectable 404 — a stale client
 * posts an old symbol and the stub surfaces a typed "stale build" error,
 * never a silent wrong-function call. The seed's path component is a
 * ROOT-INDEPENDENT stable id (rfc-server rev 2, §3/N.4) — package-qualified
 * (`@acme/api/src/cart.server.ts`), so every app build of one solution mints
 * the SAME symbol for a shared server module. Alongside it every function
 * gets a hash-free STABLE symbol (`<stableId>#<name>`, N.3) so backend
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
    /** Hash-free stable symbol: `<stableId>#<name>` (decoded form). */
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
}

export interface ServerFnExtraction {
    fns: ExtractedServerFn[];
    /** Non-`serverFn` value exports — throwing `__serverOnly` stubs. */
    serverOnly: string[];
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

/**
 * What a module-level `const x = …(…)` resolved to: a server function, a
 * stream, and — when it came through a `serverFnPreset` local — the preset
 * call's source text, which the derived function's hash seed mixes in (#398).
 */
interface CallKind {
    kind: 'fn' | 'stream';
    presetSource?: string;
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
 * Mint both transport symbols for one function (rfc-server rev 2, §3/N.3):
 * hashed — `<name>_fn_<hash8(id\0name\0implSource)>` (`\0` is only ever a
 * hash-seed FIELD separator; never part of the id) — and stable —
 * `<id>#<name>`, stored DECODED (URL-encoding is the stub's request-time
 * job; the endpoint decodes). An explicit options-form `id` replaces the
 * file-derived stable id in BOTH, so id'd functions survive file moves with
 * hashed and stable routes alike.
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
    const fnStableId = explicitId ?? stableId;
    return {
        name,
        symbol: `${name}_fn_${hash8(`${fnStableId}\0${name}\0${implSource}`)}`,
        stableSymbol: `${fnStableId}#${name}`,
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
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const fn of fns) {
        if (fn.stream || !fn.local || seen.has(fn.local)) continue;
        seen.add(fn.local);
        lines.push(`${fn.local}.__sigxKey = ${JSON.stringify(fn.stableSymbol)};`);
    }
    if (lines.length === 0) return '';
    return `\n${KEY_STAMP_MARKER}\n${lines.join('\n')}\n`;
}

/**
 * Exporting a `serverFnPreset` looks like the way to share one policy across
 * modules, and it silently is not: the extractors are per-file by contract
 * (rfc-server N.5), so the importing module cannot see that the local is a
 * preset and every function derived from it there extracts as nothing.
 */
function exportedPresetWarning(name: string): string {
    return (
        `serverFnPreset "${name}" is exported — a preset is a per-MODULE construct. The ` +
        `extractors analyze one file at a time, so a preset imported elsewhere is invisible ` +
        `there and the functions derived from it would not extract at all; this export becomes ` +
        `a server-only stub. Share the guard ARRAY instead and declare one ` +
        `serverFnPreset({ use }) per *.server.ts module (rfc-server-v3 §1.2).`
    );
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
    /** Locals bound to `serverFnPreset` itself (#398) — kept separate from
     *  `wrapperLocals` so a third kind never leaks into `wrapperKind`'s
     *  return type, which every classification site reads. */
    const presetFactoryLocals = new Set<string>();
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
            } else if (imported === 'serverFnPreset') {
                presetFactoryLocals.add((spec.local as Node).name as string);
            }
        }
    }

    /** Is this init a `serverFnPreset(...)` / `srv.serverFnPreset(...)` call? */
    const isPresetFactoryCall = (init: unknown): init is Node => {
        if (!isNode(init) || init.type !== 'CallExpression' || !isNode(init.callee)) return false;
        const callee = init.callee as Node;
        if (callee.type === 'Identifier') {
            return presetFactoryLocals.has((callee.name as string) ?? '');
        }
        return (
            callee.type === 'MemberExpression' &&
            callee.computed !== true &&
            (callee.object as Node).type === 'Identifier' &&
            namespaceLocals.has(((callee.object as Node).name as string) ?? '') &&
            isNode(callee.property) &&
            ((callee.property as Node).name as string) === 'serverFnPreset'
        );
    };

    // -- pass 1b: preset locals (#398). Its own pass, not folded into the
    // declaration loop below: `wrapperKind` is also consulted by pass 2's
    // `export default` probe, so preset knowledge has to be COMPLETE before
    // any classification runs. Source order happens to suffice today (using a
    // module-level const above its declaration is a TDZ error, so it cannot
    // legally occur), but that is an accident to not depend on.
    /** preset local → the preset call's source text, the hash-seed prefix. */
    const presetLocals = new Map<string, string>();
    for (const stmt of program.body as Node[]) {
        const decl =
            stmt.type === 'ExportNamedDeclaration' && isNode(stmt.declaration)
                ? (stmt.declaration as Node)
                : stmt;
        if (decl.type !== 'VariableDeclaration') continue;
        for (const declarator of decl.declarations as Node[]) {
            if ((declarator.id as Node).type !== 'Identifier') continue;
            if (!isPresetFactoryCall(declarator.init)) continue;
            const init = declarator.init as Node;
            presetLocals.set(
                (declarator.id as Node).name as string,
                code.slice(init.start, init.end)
            );
        }
    }

    const warnings: string[] = [];

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
            const name = (callee.name as string) ?? '';
            const direct = wrapperLocals.get(name);
            if (direct !== undefined) return { kind: direct };
            // `authed(...)` — a preset's derived serverFn.
            const presetSource = presetLocals.get(name);
            return presetSource === undefined ? undefined : { kind: 'fn', presetSource };
        }
        if (
            callee.type === 'MemberExpression' &&
            callee.computed !== true &&
            (callee.object as Node).type === 'Identifier' &&
            isNode(callee.property)
        ) {
            const object = ((callee.object as Node).name as string) ?? '';
            const prop = (callee.property as Node).name as string;
            // `authed.stream(...)` — a preset's derived serverStream. Anything
            // else on a preset is NOT a server function: falling through to
            // 'fn' would let the option readers probe a generator argument.
            const presetSource = presetLocals.get(object);
            if (presetSource !== undefined) {
                return prop === 'stream' ? { kind: 'stream', presetSource } : undefined;
            }
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
            // Explicit `id` is the OPTIONS form's field — serverStream is
            // direct-form only, so only serverFn calls are probed.
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
            if (call.kind === 'fn' && hasServerFnOptionsSpread(init)) {
                warnings.push(optionsSpreadWarning(local));
            }
            const callSource = code.slice(init.start, init.end);
            localFnSources.set(local, {
                // A derived function's seed mixes the PRESET's source text
                // ahead of the call's, so editing the shared guard chain
                // re-mints every symbol derived from it (#398). `\0` is
                // already this seed's field separator. A plain function takes
                // the call source unchanged — its symbol is byte-identical to
                // what it was before presets existed, which a pinned literal
                // hash in the tests proves.
                source:
                    call.presetSource === undefined
                        ? callSource
                        : `${call.presetSource}\0${callSource}`,
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
            if (presetLocals.has(localName)) warnings.push(exportedPresetWarning(localName));
            serverOnly.push(exportedName);
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
            if (isPresetFactoryCall(stmt.declaration)) {
                warnings.push(exportedPresetWarning('default'));
            }
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
                if (name) serverOnly.push(name);
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

    return { fns, serverOnly, warnings, stubModule: lines.join('\n') };
}
