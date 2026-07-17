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
 * Symbols are content-hashed (`<name>_fn_<hash8(relPath\0name\0implSource)>`,
 * the resume discipline) so version skew is a detectable 404 — a stale client
 * posts an old symbol and the stub surfaces a typed "stale build" error,
 * never a silent wrong-function call.
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
    /** Transport symbol: `<name>_fn_<hash8>`. */
    symbol: string;
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
 * @param code    - module source
 * @param id      - absolute module path (parse lang from its extension)
 * @param relPath - Vite-root-relative path with forward slashes (hash seed + messages)
 * @param base    - the endpoint prefix baked into stubs (default '/_sigx/fn')
 */
export function extractServerFns(
    code: string,
    id: string,
    relPath: string,
    base: string
): ServerFnExtraction {
    const clean = id.split('?')[0];
    const ext = clean.slice(clean.lastIndexOf('.'));
    const program = parseAst(code, { lang: LANG_BY_EXT[ext] ?? 'ts' }, clean) as unknown as Node;

    // -- pass 1: locals — `serverFn` aliases and module-level serverFn decls --
    const serverFnLocals = new Set<string>();
    for (const stmt of program.body as Node[]) {
        if (stmt.type !== 'ImportDeclaration') continue;
        if (((stmt.source as Node).value as string) !== '@sigx/server') continue;
        if (stmt.importKind === 'type') continue;
        for (const spec of (stmt.specifiers as Node[]) ?? []) {
            if (spec.type !== 'ImportSpecifier' || spec.importKind === 'type') continue;
            if (((spec.imported as Node).name as string) === 'serverFn') {
                serverFnLocals.add((spec.local as Node).name as string);
            }
        }
    }

    /** local name → serverFn(...) call source, for `export { x }` resolution. */
    const localFnSources = new Map<string, string>();
    const isServerFnCall = (init: unknown): init is Node =>
        isNode(init) &&
        init.type === 'CallExpression' &&
        isNode(init.callee) &&
        (init.callee as Node).type === 'Identifier' &&
        serverFnLocals.has(((init.callee as Node).name as string) ?? '');

    for (const stmt of program.body as Node[]) {
        const decl = stmt.type === 'ExportNamedDeclaration' && isNode(stmt.declaration)
            ? (stmt.declaration as Node)
            : stmt;
        if (decl.type !== 'VariableDeclaration') continue;
        for (const declarator of decl.declarations as Node[]) {
            if ((declarator.id as Node).type !== 'Identifier') continue;
            if (!isServerFnCall(declarator.init)) continue;
            const init = declarator.init as Node;
            localFnSources.set((declarator.id as Node).name as string, code.slice(init.start, init.end));
        }
    }

    // -- pass 2: exports --
    const fns: ExtractedServerFn[] = [];
    const serverOnly: string[] = [];
    const warnings: string[] = [];

    const mintSymbol = (exportedName: string, implSource: string): string =>
        `${exportedName}_fn_${hash8(`${relPath}\0${exportedName}\0${implSource}`)}`;

    const addExport = (exportedName: string, localName: string): void => {
        const implSource = localFnSources.get(localName);
        if (implSource !== undefined) {
            fns.push({ name: exportedName, symbol: mintSymbol(exportedName, implSource) });
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
        if (fns.length > 0) used.push('__serverFnStub');
        if (serverOnly.length > 0) used.push('__serverOnly');
        lines.push(`import { ${used.join(', ')} } from '@sigx/server/client';`);
    }
    for (const fn of fns) {
        lines.push(
            `export const ${fn.name} = __serverFnStub(${JSON.stringify(fn.symbol)}, ` +
            `${JSON.stringify(fn.name)}, ${JSON.stringify(base)});`
        );
    }
    for (const name of serverOnly) {
        lines.push(
            name === 'default'
                ? `export default __serverOnly("default", ${JSON.stringify(relPath)});`
                : `export const ${name} = __serverOnly(${JSON.stringify(name)}, ${JSON.stringify(relPath)});`
        );
    }
    if (lines.length === 0) lines.push('export {};');

    return { fns, serverOnly, warnings, stubModule: lines.join('\n') };
}
