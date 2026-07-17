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
    /** Content-hashed transport symbol: `<name>_fn_<hash8>`. */
    symbol: string;
    /** Hash-free stable symbol: `<stableId>#<name>` (decoded form). */
    stableSymbol: string;
    /** True for `serverStream` (NDJSON transport, AsyncIterable stub). */
    stream: boolean;
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
    stream = false
): ExtractedServerFn {
    const fnStableId = explicitId ?? stableId;
    return {
        name,
        symbol: `${name}_fn_${hash8(`${fnStableId}\0${name}\0${implSource}`)}`,
        stableSymbol: `${fnStableId}#${name}`,
        stream
    };
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

    // -- pass 1: locals — `serverFn`/`serverStream` aliases and their
    // module-level declarations --
    const wrapperLocals = new Map<string, 'fn' | 'stream'>();
    for (const stmt of program.body as Node[]) {
        if (stmt.type !== 'ImportDeclaration') continue;
        if (((stmt.source as Node).value as string) !== '@sigx/server') continue;
        if (stmt.importKind === 'type') continue;
        for (const spec of (stmt.specifiers as Node[]) ?? []) {
            if (spec.type !== 'ImportSpecifier' || spec.importKind === 'type') continue;
            const imported = (spec.imported as Node).name as string;
            if (imported === 'serverFn') {
                wrapperLocals.set((spec.local as Node).name as string, 'fn');
            } else if (imported === 'serverStream') {
                wrapperLocals.set((spec.local as Node).name as string, 'stream');
            }
        }
    }

    const warnings: string[] = [];

    /** local name → wrapped call source + kind + explicit stable id, for
     *  `export { x }` resolution. */
    const localFnSources = new Map<
        string,
        { source: string; stream: boolean; explicitId?: string }
    >();
    const wrapperKind = (init: unknown): 'fn' | 'stream' | undefined =>
        isNode(init) &&
        init.type === 'CallExpression' &&
        isNode(init.callee) &&
        (init.callee as Node).type === 'Identifier'
            ? wrapperLocals.get(((init.callee as Node).name as string) ?? '')
            : undefined;
    const isServerFnCall = (init: unknown): init is Node => wrapperKind(init) !== undefined;

    for (const stmt of program.body as Node[]) {
        const decl = stmt.type === 'ExportNamedDeclaration' && isNode(stmt.declaration)
            ? (stmt.declaration as Node)
            : stmt;
        if (decl.type !== 'VariableDeclaration') continue;
        for (const declarator of decl.declarations as Node[]) {
            if ((declarator.id as Node).type !== 'Identifier') continue;
            const kind = wrapperKind(declarator.init);
            if (kind === undefined) continue;
            const init = declarator.init as Node;
            // Explicit `id` is the OPTIONS form's field — serverStream is
            // direct-form only, so only serverFn calls are probed.
            const idOption =
                kind === 'fn'
                    ? readServerFnIdOption(init)
                    : { id: undefined, nonLiteral: false as const };
            if (idOption.nonLiteral) {
                warnings.push(
                    `serverFn "${(declarator.id as Node).name as string}": \`id\` must be a ` +
                    `non-empty string literal (it is read statically) — falling back to the ` +
                    `file-derived stable id.`
                );
            }
            localFnSources.set((declarator.id as Node).name as string, {
                source: code.slice(init.start, init.end),
                stream: kind === 'stream',
                explicitId: idOption.id
            });
        }
    }

    // -- pass 2: exports --
    const fns: ExtractedServerFn[] = [];
    const serverOnly: string[] = [];

    const addExport = (exportedName: string, localName: string): void => {
        const record = localFnSources.get(localName);
        if (record !== undefined) {
            fns.push(
                mintSymbols(
                    exportedName,
                    record.source,
                    record.explicitId,
                    options.stableId,
                    record.stream
                )
            );
        } else {
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
        lines.push(
            `export const ${fn.name} = ${factory}(${JSON.stringify(wireSymbol)}, ` +
            `${JSON.stringify(fn.name)}, ${JSON.stringify(options.endpoint)});`
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
