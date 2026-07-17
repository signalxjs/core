/**
 * Inline server-function extraction — the co-location half of
 * `@sigx/vite/server` (rfc-server §1.1(b)/§1.2, #305).
 *
 * A `serverFn` declared at MODULE SCOPE of any client-reachable file is
 * extracted in place:
 *
 * ```tsx
 * // Search.tsx
 * import { serverFn } from '@sigx/server';
 * import { searchIndex } from './search-index';   // server-only dep
 *
 * const search = serverFn(async (rq, q: string) => searchIndex.query(q));
 * ```
 *
 * - CLIENT build: the initializer becomes `__serverFnStub(...)`, and imports
 *   that were used ONLY inside extracted bodies are stripped (otherwise dev
 *   mode — no tree-shaking — would load server-only deps in the browser).
 *   Stripping removes the whole statement when no specifiers survive, so a
 *   server-only module's side effects never run client-side either.
 * - SSR build: the body stays IN PLACE (direct invocation, one module
 *   instance — no state split) and a mangled export
 *   (`__sigxSrvFn_<name>`) is appended so the endpoint/registry can import
 *   the wrapped function even when the declaration is not exported.
 *
 * The IMPORTS-ONLY capture rule (rfc-server §1.2) is enforced as a hard
 * error, never a degrade: a body may reference its own params/locals,
 * imports, and globals — module-scope locals, component scope, and JSX are
 * build errors. Data crosses the boundary only as typed arguments.
 *
 * NOT for resume files: a module-scope const is not a legal capture for
 * extracted QRL handlers — resume handlers import server functions from
 * `*.server.ts` modules instead (that path needs zero extractor changes).
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

export interface InlineServerFn {
    /** The declared const name (the registry name). */
    name: string;
    /** Transport symbol: `<name>_fn_<hash8>`. */
    symbol: string;
    /** The appended SSR export the endpoint resolves. */
    mangled: string;
}

export interface InlineExtractionError {
    /** UTF-16 offset in the original source (for line/column reporting). */
    offset: number;
    message: string;
}

export interface InlineServerFnExtraction {
    fns: InlineServerFn[];
    errors: InlineExtractionError[];
    /** Stub-swapped + import-stripped module, when fns exist and no errors. */
    clientModule: string | null;
    /** Original module + mangled exports, when fns exist and no errors. */
    ssrModule: string | null;
}

const LANG_BY_EXT: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = {
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.js': 'js',
    '.jsx': 'jsx',
    '.mjs': 'js',
    '.mts': 'ts'
};

const MANGLE_PREFIX = '__sigxSrvFn_';

/* ------------------------------------------------------------------------ */
/* AST plumbing                                                             */
/* ------------------------------------------------------------------------ */

/** Walk every node, skipping TS type-only subtrees (annotations erase). */
function walk(node: Node, visit: (node: Node, parent: Node | null) => boolean | void, parent: Node | null = null): void {
    if (node.type.startsWith('TS')) {
        // Type context erases at runtime — but expression-carrying wrappers
        // (as-casts, non-null, satisfies) still contain runtime code.
        if (isNode(node.expression)) walk(node.expression as Node, visit, node);
        return;
    }
    if (visit(node, parent) === false) return;
    for (const key of Object.keys(node)) {
        const value = node[key];
        if (Array.isArray(value)) {
            for (const item of value) {
                if (isNode(item)) walk(item, visit, node);
            }
        } else if (isNode(value)) {
            walk(value as Node, visit, node);
        }
    }
}

/** Names bound by a binding pattern (params, declarator ids). */
function patternNames(pattern: Node, out: Set<string>): void {
    switch (pattern.type) {
        case 'Identifier':
            out.add(pattern.name as string);
            return;
        case 'ObjectPattern':
            for (const prop of (pattern.properties as Node[]) ?? []) {
                if (prop.type === 'RestElement') patternNames(prop.argument as Node, out);
                else if (isNode(prop.value)) patternNames(prop.value as Node, out);
            }
            return;
        case 'ArrayPattern':
            for (const el of (pattern.elements as (Node | null)[]) ?? []) {
                if (isNode(el)) patternNames(el, out);
            }
            return;
        case 'AssignmentPattern':
            patternNames(pattern.left as Node, out);
            return;
        case 'RestElement':
            patternNames(pattern.argument as Node, out);
            return;
    }
}

const FUNCTION_TYPES = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration']);

/** Bindings declared directly in a function's own scope (function-level). */
function functionScopeBindings(fn: Node): Set<string> {
    const bindings = new Set<string>();
    for (const param of (fn.params as Node[]) ?? []) patternNames(param, bindings);
    const body = fn.body as Node;
    if (!isNode(body)) return bindings;
    walk(body, (node) => {
        if (FUNCTION_TYPES.has(node.type)) {
            if (node.id && isNode(node.id)) bindings.add((node.id as Node).name as string);
            return false; // nested scope owns its own bindings
        }
        if (node.type === 'VariableDeclaration') {
            for (const decl of node.declarations as Node[]) patternNames(decl.id as Node, bindings);
        }
        if (node.type === 'ClassDeclaration' && isNode(node.id)) {
            bindings.add((node.id as Node).name as string);
        }
        if (node.type === 'CatchClause' && isNode(node.param)) {
            patternNames(node.param as Node, bindings);
        }
    });
    return bindings;
}

/** Is this Identifier node a value REFERENCE in its parent? */
function isReference(node: Node, parent: Node | null): boolean {
    if (!parent) return true;
    if (parent.type === 'MemberExpression' && parent.property === node && parent.computed !== true) return false;
    if (parent.type === 'Property' && parent.key === node && parent.computed !== true && parent.shorthand !== true) return false;
    if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier') return false;
    if (parent.type === 'ExportSpecifier') return false;
    if ((parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') && parent.label === node) return false;
    // Binding positions (declarator ids, params, fn names) — handled by the
    // scope sets, but exclude the id of its own declaration outright.
    if (parent.type === 'VariableDeclarator' && parent.id === node) return false;
    if (FUNCTION_TYPES.has(parent.type) && parent.id === node) return false;
    if (parent.type === 'JSXAttribute' && parent.name === node) return false;
    return true;
}

interface FreeRef {
    name: string;
    offset: number;
}

/**
 * Free identifier references of an expression: names referenced but not
 * bound by any function scope inside it. Also reports whether the
 * expression contains JSX.
 */
function freeReferences(expr: Node): { refs: FreeRef[]; hasJsx: boolean } {
    const refs: FreeRef[] = [];
    const seen = new Set<string>();
    let hasJsx = false;

    const visitScoped = (node: Node, parent: Node | null, scopes: Set<string>[]): void => {
        if (node.type.startsWith('TS')) {
            if (isNode(node.expression)) visitScoped(node.expression as Node, node, scopes);
            return;
        }
        if (node.type === 'JSXElement' || node.type === 'JSXFragment') hasJsx = true;
        if (FUNCTION_TYPES.has(node.type)) {
            const inner = [...scopes, functionScopeBindings(node)];
            for (const key of Object.keys(node)) {
                const value = node[key];
                if (key === 'id') continue; // own name binds in the outer set
                if (Array.isArray(value)) {
                    for (const item of value) if (isNode(item)) visitScoped(item, node, inner);
                } else if (isNode(value)) {
                    visitScoped(value as Node, node, inner);
                }
            }
            return;
        }
        if (node.type === 'Identifier' || node.type === 'JSXIdentifier') {
            const name = node.name as string;
            if (
                isReference(node, parent) &&
                !scopes.some((scope) => scope.has(name)) &&
                !seen.has(name)
            ) {
                seen.add(name);
                refs.push({ name, offset: node.start });
            }
            return;
        }
        for (const key of Object.keys(node)) {
            const value = node[key];
            if (Array.isArray(value)) {
                for (const item of value) if (isNode(item)) visitScoped(item, node, scopes);
            } else if (isNode(value)) {
                visitScoped(value as Node, node, scopes);
            }
        }
    };

    visitScoped(expr, null, []);
    return { refs, hasJsx };
}

/* ------------------------------------------------------------------------ */
/* Extraction                                                               */
/* ------------------------------------------------------------------------ */

interface Splice {
    start: number;
    end: number;
    text: string;
}

function applySplices(code: string, splices: Splice[]): string {
    const sorted = [...splices].sort((a, b) => b.start - a.start || b.end - a.end);
    let out = code;
    for (const s of sorted) out = out.slice(0, s.start) + s.text + out.slice(s.end);
    return out;
}

/**
 * @param code    - module source (a component file, NOT a `*.server.ts`)
 * @param id      - absolute module path (parse lang from its extension)
 * @param relPath - Vite-root-relative path (hash seed + messages)
 * @param base    - the endpoint prefix baked into stubs
 */
export function extractInlineServerFns(
    code: string,
    id: string,
    relPath: string,
    base: string
): InlineServerFnExtraction {
    const clean = id.split('?')[0];
    const ext = clean.slice(clean.lastIndexOf('.'));
    const program = parseAst(code, { lang: LANG_BY_EXT[ext] ?? 'tsx' }, clean) as unknown as Node;

    // -- module scan: serverFn aliases, imports, module-scope locals --
    const serverFnLocals = new Set<string>();
    const namespaceLocals = new Set<string>();
    /** import local → typeOnly */
    const imports = new Map<string, boolean>();
    const moduleLocals = new Set<string>();

    for (const stmt of program.body as Node[]) {
        if (stmt.type === 'ImportDeclaration') {
            const source = (stmt.source as Node).value as string;
            const stmtTypeOnly = stmt.importKind === 'type';
            for (const spec of (stmt.specifiers as Node[]) ?? []) {
                const local = ((spec.local as Node).name as string) ?? '';
                const typeOnly = stmtTypeOnly || spec.importKind === 'type';
                imports.set(local, typeOnly);
                if (typeOnly || source !== '@sigx/server') continue;
                if (spec.type === 'ImportSpecifier' && ((spec.imported as Node).name as string) === 'serverFn') {
                    serverFnLocals.add(local);
                }
                if (spec.type === 'ImportNamespaceSpecifier') namespaceLocals.add(local);
            }
            continue;
        }
        const decl = stmt.type === 'ExportNamedDeclaration' && isNode(stmt.declaration)
            ? (stmt.declaration as Node)
            : stmt;
        if (decl.type === 'VariableDeclaration') {
            for (const declarator of decl.declarations as Node[]) patternNames(declarator.id as Node, moduleLocals);
        } else if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && isNode(decl.id)) {
            moduleLocals.add((decl.id as Node).name as string);
        }
    }

    const isServerFnCallee = (callee: Node): boolean => {
        if (callee.type === 'Identifier') return serverFnLocals.has(callee.name as string);
        return (
            callee.type === 'MemberExpression' &&
            callee.computed !== true &&
            (callee.object as Node).type === 'Identifier' &&
            namespaceLocals.has(((callee.object as Node).name as string) ?? '') &&
            isNode(callee.property) &&
            ((callee.property as Node).name as string) === 'serverFn'
        );
    };

    if (serverFnLocals.size === 0 && namespaceLocals.size === 0) {
        return { fns: [], errors: [], clientModule: null, ssrModule: null };
    }

    // -- find module-scope declarations and misplaced calls --
    const fns: InlineServerFn[] = [];
    const errors: InlineExtractionError[] = [];
    const clientSplices: Splice[] = [];
    /** Call nodes accepted as module-scope declarations. */
    const accepted = new Set<Node>();

    for (const stmt of program.body as Node[]) {
        const decl = stmt.type === 'ExportNamedDeclaration' && isNode(stmt.declaration)
            ? (stmt.declaration as Node)
            : stmt;
        if (decl.type !== 'VariableDeclaration') continue;
        for (const declarator of decl.declarations as Node[]) {
            const init = declarator.init;
            if (!isNode(init) || init.type !== 'CallExpression' || !isServerFnCallee(init.callee as Node)) continue;
            if ((declarator.id as Node).type !== 'Identifier') {
                errors.push({
                    offset: (declarator.id as Node).start,
                    message: 'serverFn() must be declared as a plain `const name = serverFn(...)`.'
                });
                continue;
            }
            const name = (declarator.id as Node).name as string;
            const call = init as Node;
            accepted.add(call);

            // Imports-only capture rule (§1.2), enforced on the whole call
            // (options-form guards/validators must satisfy it too).
            const { refs, hasJsx } = freeReferences(call);
            if (hasJsx) {
                errors.push({
                    offset: call.start,
                    message: `serverFn "${name}": JSX is not supported inside a server function body.`
                });
                continue;
            }
            let bad = false;
            for (const ref of refs) {
                if (serverFnLocals.has(ref.name)) continue; // the wrapper itself
                const typeOnly = imports.get(ref.name);
                if (typeOnly === false) continue;           // value import — legal
                if (typeOnly === true) {
                    errors.push({
                        offset: ref.offset,
                        message: `serverFn "${name}" captures "${ref.name}", a type-only import — import it as a value.`
                    });
                    bad = true;
                    break;
                }
                if (moduleLocals.has(ref.name) && ref.name !== name) {
                    errors.push({
                        offset: ref.offset,
                        message:
                            `serverFn "${name}" captures module-scope binding "${ref.name}" — an inline body ` +
                            `may only capture imports and globals (rfc-server §1.2). Pass it as an argument, ` +
                            `or move both into a *.server.ts module.`
                    });
                    bad = true;
                    break;
                }
                // Unresolved ⇒ global (fetch, console, JSON, …) — legal.
            }
            if (bad) continue;

            const callSource = code.slice(call.start, call.end);
            const symbol = `${name}_fn_${hash8(`${relPath}\0${name}\0${callSource}`)}`;
            const mangled = MANGLE_PREFIX + name;
            if (moduleLocals.has(mangled)) {
                errors.push({
                    offset: call.start,
                    message: `"${mangled}" collides with the reserved mangled export for serverFn "${name}".`
                });
                continue;
            }
            fns.push({ name, symbol, mangled });
            clientSplices.push({
                start: call.start,
                end: call.end,
                text: `__serverFnStub(${JSON.stringify(symbol)}, ${JSON.stringify(name)}, ${JSON.stringify(base)})`
            });
        }
    }

    // Any serverFn call NOT accepted above is misplaced (inside a component,
    // nested expression, …) — a hard error, per the module-scope-only rule.
    walk(program, (node) => {
        if (node.type === 'CallExpression' && isServerFnCallee(node.callee as Node) && !accepted.has(node)) {
            errors.push({
                offset: node.start,
                message:
                    'serverFn() must be a module-scope `const` declaration — it cannot be created ' +
                    'inside a component or expression (component state crosses the boundary as ' +
                    'arguments, never as captures; rfc-server §1.2).'
            });
        }
    });

    if (errors.length > 0 || fns.length === 0) {
        return { fns: errors.length > 0 ? [] : fns, errors, clientModule: null, ssrModule: null };
    }

    // -- client module: stub swap + strip imports orphaned by the swap --
    const swapped =
        `import { __serverFnStub } from '@sigx/server/client';\n` +
        applySplices(code, clientSplices);
    const clientModule = stripUnusedImports(swapped, clean);

    // -- ssr module: body in place + mangled exports --
    const ssrModule =
        code +
        '\n' +
        fns.map((fn) => `export const ${fn.mangled} = ${fn.name};`).join('\n') +
        '\n';

    return { fns, errors, clientModule, ssrModule };
}

/**
 * Remove import specifiers (and, when none survive, whole statements) whose
 * local binding is no longer referenced — the extracted bodies were their
 * only consumers. Side-effect-only imports (`import './x'`) are untouched;
 * a statement whose specifiers ALL vanish is removed entirely, side effects
 * included — that is the point: a server-only dep must not load client-side.
 */
function stripUnusedImports(code: string, id: string): string {
    const ext = id.slice(id.lastIndexOf('.'));
    const program = parseAst(code, { lang: LANG_BY_EXT[ext] ?? 'tsx' }, id) as unknown as Node;

    const referenced = new Set<string>();
    walk(program, (node, parent) => {
        if (node.type === 'ImportDeclaration') return false;
        if ((node.type === 'Identifier' || node.type === 'JSXIdentifier') && isReference(node, parent)) {
            referenced.add(node.name as string);
        }
    });

    const splices: Splice[] = [];
    for (const stmt of program.body as Node[]) {
        if (stmt.type !== 'ImportDeclaration') continue;
        const specs = (stmt.specifiers as Node[]) ?? [];
        if (specs.length === 0) continue; // side-effect import — keep
        const dead = specs.filter((spec) => !referenced.has(((spec.local as Node).name as string) ?? ''));
        if (dead.length === 0) continue;
        if (dead.length === specs.length) {
            splices.push({ start: stmt.start, end: stmt.end, text: '' });
            continue;
        }
        // Partial: rebuild the statement with the surviving specifiers.
        const alive = specs.filter((spec) => referenced.has(((spec.local as Node).name as string) ?? ''));
        const source = JSON.stringify((stmt.source as Node).value as string).replace(/"/g, "'");
        const named = alive
            .filter((spec) => spec.type === 'ImportSpecifier')
            .map((spec) => {
                const imported = ((spec.imported as Node).name as string) ?? '';
                const local = ((spec.local as Node).name as string) ?? '';
                return imported === local ? imported : `${imported} as ${local}`;
            });
        const defaultSpec = alive.find((spec) => spec.type === 'ImportDefaultSpecifier');
        const namespaceSpec = alive.find((spec) => spec.type === 'ImportNamespaceSpecifier');
        const clauses: string[] = [];
        if (defaultSpec) clauses.push(((defaultSpec.local as Node).name as string) ?? '');
        if (namespaceSpec) clauses.push(`* as ${((namespaceSpec.local as Node).name as string) ?? ''}`);
        if (named.length > 0) clauses.push(`{ ${named.join(', ')} }`);
        splices.push({ start: stmt.start, end: stmt.end, text: `import ${clauses.join(', ')} from ${source};` });
    }
    return applySplices(code, splices);
}
