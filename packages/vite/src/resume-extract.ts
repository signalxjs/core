/**
 * Handler extraction for sigxResume() — the analysis half of the resumability
 * transform (issue #241).
 *
 * Given a resume module's source, finds every DOM event handler on host
 * elements inside exported sigx components and, where the handler is
 * *eligible* (its captures can be expressed through the resumed scope),
 * produces:
 *
 * - the component module rewritten so each handled element also carries
 *   `data-sigx-on:<event>="<symbol>"` (plus `data-sigx-pd:<event>` when the
 *   body calls `preventDefault`, and one dynamic `data-sigx-b={<ctx>.$sigxB}`
 *   per element for boundary resolution). The original `on*` prop is KEPT —
 *   dev/SPA/post-upgrade behavior is untouched;
 * - a per-file handlers module exporting each handler as
 *   `($scope, <original params>) => body` with captured named signals
 *   rewritten to `$scope.signals.<name>` and `ctx.props` reads to
 *   `$scope.props`. The module imports nothing from this file (that would
 *   defeat the chunk split); only third-party/shared imports are replicated.
 *
 * Handlers whose captures cannot be rewritten (view-scope locals, same-file
 * module bindings, `ctx.emit`, unkeyed signals, …) are reported ineligible and
 * left alone; a component with any ineligible handler degrades to
 * `__resumeMode: 'hydrate'` (island-style interaction hydration).
 *
 * Unlike `injectSignalNames`, this is genuinely beyond a regex: finding the
 * end of an arbitrary handler expression and classifying its free variables
 * are parser problems. Vite 8 exports rolldown's oxc-backed `parseAst`
 * (ESTree-shaped, byte spans on every node), so no new dependency is needed.
 *
 * Emitted handler modules may contain TypeScript (param annotations are kept
 * verbatim) — the plugin must serve them under a `.ts`-suffixed virtual id.
 */

import { parseAst } from 'vite';

/** Symbols reserved by the runtime scope contract inside handler bodies. */
const RESERVED_NAMES = new Set(['$scope', '$el']);

/** One extracted (eligible) handler. */
export interface ExtractedHandler {
    /** `<ExportedName>_<event>_<hash8>` — hash of the rewritten export source. */
    symbol: string;
    /** DOM event name, lowercased (`click`, `input`, …). */
    event: string;
    /** Exported name of the owning component. */
    component: string;
    /** Whether the body syntactically calls `preventDefault` (→ `data-sigx-pd`). */
    preventDefault: boolean;
    /** The `export const <symbol> = …` statement for the handlers module. */
    exportSource: string;
}

/** One handler that could not be extracted, with a warnable reason. */
export interface IneligibleHandler {
    component: string;
    event: string;
    /** Byte offset of the handler expression in the original source. */
    offset: number;
    reason: string;
}

/** Per-component result. */
export interface ResumeComponent {
    /** Module-local binding (what injected statements can reference). */
    local: string;
    /** Export name — the `__resumeId` registry key. */
    exported: string;
    /** 'resume' iff every handler extracted and the component uses no slots. */
    mode: 'resume' | 'hydrate';
    /** Extracted handler count (0 + 0 named signals ⇒ not worth stamping). */
    handlerCount: number;
    /** Named-signal declaration count (what `injectSignalNames` will key). */
    signalCount: number;
}

export interface ResumeExtraction {
    /** Component code with QRL/pd/b attributes injected (no stamps/keying yet). */
    code: string;
    /** Handlers-module source (may contain TS), or null when nothing extracted. */
    handlersModule: string | null;
    handlers: ExtractedHandler[];
    ineligible: IneligibleHandler[];
    components: ResumeComponent[];
    /** Union of extracted event names — feeds the loader's delegation list. */
    events: string[];
}

/**
 * 1-based line/column for a source offset — for dev warnings. Offsets are
 * UTF-16 string indices, matching oxc's ESTree spans (verified: spans index
 * the JS string directly, not UTF-8 bytes).
 */
export function offsetToLoc(code: string, offset: number): { line: number; column: number } {
    let line = 1;
    let last = 0;
    for (let i = 0; i < offset && i < code.length; i++) {
        if (code.charCodeAt(i) === 10) {
            line++;
            last = i + 1;
        }
    }
    return { line, column: offset - last + 1 };
}

/* ------------------------------------------------------------------------ */
/* AST plumbing                                                             */
/* ------------------------------------------------------------------------ */

interface Node {
    type: string;
    start: number;
    end: number;
    [key: string]: unknown;
}

function isNode(value: unknown): value is Node {
    return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
}

/**
 * TS wrappers whose children include VALUE expressions (`x as T`, `x!`,
 * `x satisfies T`, `<T>x`, `f<T>`): the walk must descend through them,
 * unlike pure type-space nodes.
 */
const TS_VALUE_WRAPPERS = new Set([
    'TSAsExpression',
    'TSNonNullExpression',
    'TSSatisfiesExpression',
    'TSTypeAssertion',
    'TSInstantiationExpression'
]);

/** Child nodes in source order, skipping TS type-space subtrees. */
function childNodes(node: Node): Node[] {
    const out: Node[] = [];
    const keep = (value: Node): boolean => !value.type.startsWith('TS') || TS_VALUE_WRAPPERS.has(value.type);
    for (const key of Object.keys(node)) {
        if (key === 'type') continue;
        const value = node[key];
        if (isNode(value)) {
            if (keep(value)) out.push(value);
        } else if (Array.isArray(value)) {
            for (const item of value) {
                if (isNode(item) && keep(item)) out.push(item);
            }
        }
    }
    return out;
}

/** Collect binding names introduced by a declaration pattern. */
function patternNames(node: Node, out: string[] = []): string[] {
    switch (node.type) {
        case 'Identifier':
            out.push(node.name as string);
            break;
        case 'ObjectPattern':
            for (const prop of node.properties as Node[]) patternNames(prop, out);
            break;
        case 'Property':
            patternNames(node.value as Node, out);
            break;
        case 'ArrayPattern':
            for (const el of node.elements as (Node | null)[]) if (el) patternNames(el, out);
            break;
        case 'AssignmentPattern':
            patternNames(node.left as Node, out);
            break;
        case 'RestElement':
            patternNames(node.argument as Node, out);
            break;
    }
    return out;
}

const FUNCTION_TYPES = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration']);

/** Bindings a single statement introduces into its enclosing scope. */
function statementBindings(stmt: Node): string[] {
    if (stmt.type === 'VariableDeclaration') {
        const names: string[] = [];
        for (const decl of stmt.declarations as Node[]) patternNames(decl.id as Node, names);
        return names;
    }
    if ((stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') && isNode(stmt.id)) {
        return [(stmt.id as Node).name as string];
    }
    return [];
}

/** Bindings visible inside `node`'s own scope (params + direct body statements). */
function ownScopeBindings(node: Node): Set<string> {
    const names = new Set<string>();
    if (FUNCTION_TYPES.has(node.type)) {
        for (const param of node.params as Node[]) for (const n of patternNames(param)) names.add(n);
        const body = node.body as Node;
        if (body.type === 'BlockStatement') {
            for (const stmt of body.body as Node[]) for (const n of statementBindings(stmt)) names.add(n);
        }
    } else if (node.type === 'BlockStatement') {
        for (const stmt of node.body as Node[]) for (const n of statementBindings(stmt)) names.add(n);
    } else if (node.type === 'CatchClause' && isNode(node.param)) {
        for (const n of patternNames(node.param as Node)) names.add(n);
    } else if (node.type.startsWith('For') && isNode(node.left) && (node.left as Node).type === 'VariableDeclaration') {
        for (const n of statementBindings(node.left as Node)) names.add(n);
    } else if (node.type === 'ForStatement' && isNode(node.init) && (node.init as Node).type === 'VariableDeclaration') {
        for (const n of statementBindings(node.init as Node)) names.add(n);
    }
    return names;
}

/* ------------------------------------------------------------------------ */
/* Free-variable analysis of a handler function                             */
/* ------------------------------------------------------------------------ */

interface FreeRef {
    name: string;
    node: Node;
    /**
     * The identifier itself is (re)assigned: direct assignment target,
     * ++/--, or a binding position inside a destructuring-assignment pattern.
     */
    rootWrite: boolean;
    /** Nearest enclosing MemberExpression where this id is the object. */
    memberParent: Node | null;
}

interface HandlerScan {
    freeRefs: FreeRef[];
    callsPreventDefault: boolean;
    /** `this` in an arrow chain, bare `arguments`, or `import.meta` — always ineligible. */
    contextual: string | null;
    usesReservedName: boolean;
}

/** Positions where an Identifier is a reference to a value, not a name. */
function isValueReference(node: Node, parent: Node, key: string): boolean {
    switch (parent.type) {
        case 'MemberExpression':
            return key !== 'property' || parent.computed === true;
        case 'Property':
            // Shorthand `{ count }` visits the same span as both key and value.
            return key === 'value' || (key === 'key' && parent.computed === true);
        case 'PropertyDefinition':
        case 'MethodDefinition':
            return key !== 'key' || parent.computed === true;
        case 'LabeledStatement':
        case 'BreakStatement':
        case 'ContinueStatement':
            return key !== 'label';
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ClassDeclaration':
        case 'ClassExpression':
            return key !== 'id';
        case 'ImportSpecifier':
        case 'ImportDefaultSpecifier':
        case 'ImportNamespaceSpecifier':
        case 'ExportSpecifier':
            return false;
    }
    return true;
}

/** Scan a handler function for free references and disqualifying constructs. */
function scanHandler(fn: Node): HandlerScan {
    const result: HandlerScan = { freeRefs: [], callsPreventDefault: false, contextual: null, usesReservedName: false };
    // Scope stack rooted at the handler's own scope.
    const scopes: { bindings: Set<string>; isFunction: boolean }[] = [];
    // `data-sigx-pd` must fire only for preventDefault on the EVENT param —
    // `someController.preventDefault()` is not a browser-default concern.
    const firstParam = (fn.params as Node[])[0];
    const eventParam = firstParam?.type === 'Identifier' ? (firstParam.name as string) : null;

    function isBound(name: string): boolean {
        for (let i = scopes.length - 1; i >= 0; i--) {
            if (scopes[i].bindings.has(name)) return true;
        }
        return false;
    }

    function pushScope(bindings: Set<string>, isFunction: boolean): void {
        for (const name of RESERVED_NAMES) {
            if (bindings.has(name)) result.usesReservedName = true;
        }
        scopes.push({ bindings, isFunction });
    }

    function visit(node: Node, parent: Node, key: string, inAssignPattern: boolean): void {
        if (node.type === 'ThisExpression') {
            // The handler is re-emitted as an arrow, so it never owns `this` —
            // only NESTED non-arrow functions do (scopes[0] is excluded below).
            if (!scopes.some((s, i) => i > 0 && s.isFunction)) result.contextual = 'this';
            return;
        }
        if (node.type === 'MetaProperty') {
            result.contextual = 'import.meta / new.target';
            return;
        }
        if (node.type === 'Identifier') {
            const name = node.name as string;
            if (name === 'arguments' && !scopes.some((s, i) => i > 0 && s.isFunction)) {
                result.contextual = 'arguments';
                return;
            }
            if (!isValueReference(node, parent, key)) return;
            if (parent.type === 'Property' && parent.shorthand === true && key === 'key') return;
            // Reserved names only matter as value references (or bindings,
            // checked in pushScope) — `obj.$scope` / `{ $scope: 1 }` are fine.
            if (RESERVED_NAMES.has(name)) {
                result.usesReservedName = true;
                return;
            }
            if (isBound(name)) return;
            const isMemberObject = parent.type === 'MemberExpression' && key === 'object';
            result.freeRefs.push({
                name,
                node,
                rootWrite:
                    (parent.type === 'AssignmentExpression' && key === 'left') ||
                    (parent.type === 'UpdateExpression' && key === 'argument') ||
                    // `({ a: count } = obj)` / `[count] = arr` — a binding
                    // position in a destructuring-assignment target. Member
                    // chains inside the pattern (`[obj.a] = x`) stay member
                    // writes on the object, not root writes.
                    (inAssignPattern && !isMemberObject),
                memberParent: isMemberObject ? parent : null
            });
            return;
        }
        if (
            node.type === 'CallExpression' &&
            isNode(node.callee) &&
            (node.callee as Node).type === 'MemberExpression' &&
            isNode((node.callee as Node).property) &&
            (((node.callee as Node).property as Node).name as string) === 'preventDefault'
        ) {
            const receiver = (node.callee as Node).object as Node;
            if (eventParam !== null && receiver.type === 'Identifier' && (receiver.name as string) === eventParam) {
                result.callsPreventDefault = true;
            }
        }

        const scope = ownScopeBindings(node);
        // Non-arrow nested functions own `this`/`arguments`.
        const opensFunction = node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration';
        const pushes = scope.size > 0 || FUNCTION_TYPES.has(node.type) || opensFunction;
        if (pushes) pushScope(scope, opensFunction);
        for (const child of childNodes(node)) {
            const childKey = keyOf(node, child);
            visit(child, node, childKey, childInAssignPattern(node, child, childKey, inAssignPattern));
        }
        if (pushes) scopes.pop();
    }

    /** Whether `child` sits in a destructuring-ASSIGNMENT target position. */
    function childInAssignPattern(node: Node, child: Node, key: string, current: boolean): boolean {
        const isPattern = child.type === 'ObjectPattern' || child.type === 'ArrayPattern';
        if (node.type === 'AssignmentExpression' && key === 'left') return isPattern;
        if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') && key === 'left') return isPattern;
        if (!current) return false;
        // Inside a pattern: defaults and computed keys are reads, member
        // chains are member writes, everything else stays a binding position.
        if (node.type === 'AssignmentPattern') return key === 'left';
        if (node.type === 'Property') return key === 'value';
        if (node.type === 'MemberExpression') return false;
        return true;
    }

    // The handler's own params are its root scope. It is NEVER a `this` /
    // `arguments` owner (index 0 is excluded from the ownership checks): the
    // extracted export is an arrow even when the source was a function
    // expression, so handler-level `this`/`arguments` must disqualify.
    pushScope(ownScopeBindings(fn), fn.type !== 'ArrowFunctionExpression');
    const body = fn.body as Node;
    visit(body, fn, 'body', false);
    return result;
}

/** Which property of `parent` holds `child` (for reference-position checks). */
function keyOf(parent: Node, child: Node): string {
    for (const key of Object.keys(parent)) {
        const value = parent[key];
        if (value === child) return key;
        if (Array.isArray(value) && value.includes(child)) return key;
    }
    return '';
}

/* ------------------------------------------------------------------------ */
/* Module / component structure                                             */
/* ------------------------------------------------------------------------ */

interface ImportedBinding {
    local: string;
    /** Verbatim import clause piece: `track`, `track as t`, `* as ns`, or default. */
    kind: 'named' | 'default' | 'namespace';
    imported: string | null;
    source: string;
    typeOnly: boolean;
}

interface ModuleScan {
    imports: Map<string, ImportedBinding>;
    /** Local names of `component` imported from sigx. */
    componentFactories: Set<string>;
    /** Module-level bindings that are NOT imports (capture ⇒ ineligible). */
    moduleLocals: Set<string>;
    /** exported name → local binding, for component discovery. */
    exportsByLocal: Map<string, string>;
}

function scanModule(program: Node): ModuleScan {
    const scan: ModuleScan = {
        imports: new Map(),
        componentFactories: new Set(),
        moduleLocals: new Set(),
        exportsByLocal: new Map()
    };
    for (const stmt of program.body as Node[]) {
        if (stmt.type === 'ImportDeclaration') {
            const source = (stmt.source as Node).value as string;
            const stmtTypeOnly = stmt.importKind === 'type';
            for (const spec of (stmt.specifiers as Node[]) ?? []) {
                const local = ((spec.local as Node).name as string) ?? '';
                const typeOnly = stmtTypeOnly || spec.importKind === 'type';
                const binding: ImportedBinding = {
                    local,
                    kind:
                        spec.type === 'ImportDefaultSpecifier' ? 'default'
                        : spec.type === 'ImportNamespaceSpecifier' ? 'namespace'
                        : 'named',
                    imported: spec.type === 'ImportSpecifier' ? (((spec.imported as Node).name as string) ?? null) : null,
                    source,
                    typeOnly
                };
                scan.imports.set(local, binding);
                if (
                    !typeOnly &&
                    binding.kind === 'named' &&
                    binding.imported === 'component' &&
                    (source === 'sigx' || source.startsWith('@sigx/'))
                ) {
                    scan.componentFactories.add(local);
                }
            }
            continue;
        }
        let decl: Node | null = null;
        if (stmt.type === 'ExportNamedDeclaration') {
            if (isNode(stmt.declaration)) decl = stmt.declaration as Node;
            for (const spec of (stmt.specifiers as Node[]) ?? []) {
                const local = ((spec.local as Node)?.name as string) ?? '';
                const exported = ((spec.exported as Node)?.name as string) ?? '';
                if (local && exported) scan.exportsByLocal.set(local, exported);
            }
        } else {
            decl = stmt;
        }
        if (!decl) continue;
        for (const name of statementBindings(decl)) {
            scan.moduleLocals.add(name);
            if (stmt.type === 'ExportNamedDeclaration') scan.exportsByLocal.set(name, name);
        }
    }
    return scan;
}

interface ComponentInfo {
    local: string;
    exported: string;
    node: Node;
    /** Setup function's ctx param name, or null (no ctx ⇒ no signals/props). */
    ctxName: string | null;
    setupFn: Node;
    /** Declaration-name-keyed signals (what `injectSignalNames` will key). */
    namedSignals: Set<string>;
    /** All other setup-body top-level bindings (capture ⇒ ineligible). */
    setupLocals: Set<string>;
    usesSlots: boolean;
}

/** `const x = <ctx>.signal(…)` — mirrors `SIGNAL_DECL_RE`'s criteria. */
function isSignalDecl(decl: Node, ctxName: string): boolean {
    if ((decl.id as Node).type !== 'Identifier' || !isNode(decl.init)) return false;
    const init = decl.init as Node;
    if (init.type !== 'CallExpression') return false;
    const callee = init.callee as Node;
    return (
        callee.type === 'MemberExpression' &&
        callee.computed !== true &&
        (callee.object as Node).type === 'Identifier' &&
        ((callee.object as Node).name as string) === ctxName &&
        isNode(callee.property) &&
        ((callee.property as Node).name as string) === 'signal'
    );
}

function findComponents(program: Node, scan: ModuleScan): ComponentInfo[] {
    const components: ComponentInfo[] = [];
    for (const stmt of program.body as Node[]) {
        const decl = stmt.type === 'ExportNamedDeclaration' && isNode(stmt.declaration)
            ? (stmt.declaration as Node)
            : stmt;
        if (decl.type !== 'VariableDeclaration') continue;
        for (const declarator of decl.declarations as Node[]) {
            if ((declarator.id as Node).type !== 'Identifier' || !isNode(declarator.init)) continue;
            const init = declarator.init as Node;
            if (init.type !== 'CallExpression') continue;
            const callee = init.callee as Node;
            if (callee.type !== 'Identifier' || !scan.componentFactories.has(callee.name as string)) continue;
            const setupFn = (init.arguments as Node[])[0];
            if (!setupFn || !FUNCTION_TYPES.has(setupFn.type)) continue;
            const local = (declarator.id as Node).name as string;
            const exported = scan.exportsByLocal.get(local);
            if (!exported) continue; // only named exports are resumable components

            const firstParam = (setupFn.params as Node[])[0];
            const ctxName = firstParam && firstParam.type === 'Identifier' ? (firstParam.name as string) : null;
            const namedSignals = new Set<string>();
            const setupLocals = new Set<string>();
            const body = setupFn.body as Node;
            if (body.type === 'BlockStatement' && ctxName) {
                for (const s of body.body as Node[]) {
                    if (s.type !== 'VariableDeclaration') {
                        for (const n of statementBindings(s)) setupLocals.add(n);
                        continue;
                    }
                    for (const d of s.declarations as Node[]) {
                        if (isSignalDecl(d, ctxName)) namedSignals.add((d.id as Node).name as string);
                        else for (const n of patternNames(d.id as Node)) setupLocals.add(n);
                    }
                }
            }
            components.push({
                local,
                exported,
                node: init,
                ctxName,
                setupFn,
                namedSignals,
                setupLocals,
                usesSlots: ctxName !== null && usesCtxSlots(setupFn, ctxName)
            });
        }
    }
    return components;
}

/** Any `<ctx>.slots` access — data-driven upgrade can't rebuild slots. */
function usesCtxSlots(node: Node, ctxName: string): boolean {
    if (
        node.type === 'MemberExpression' &&
        (node.object as Node).type === 'Identifier' &&
        ((node.object as Node).name as string) === ctxName &&
        isNode(node.property) &&
        ((node.property as Node).name as string) === 'slots'
    ) {
        return true;
    }
    return childNodes(node).some((child) => usesCtxSlots(child, ctxName));
}

/* ------------------------------------------------------------------------ */
/* Handler discovery inside view JSX                                        */
/* ------------------------------------------------------------------------ */

interface HandlerSite {
    /** The `onClick`-style attribute node. */
    attr: Node;
    event: string;
    /** The handler expression (arrow/function/identifier/other). */
    expr: Node;
    /** The owning JSXOpeningElement. */
    element: Node;
    /** Function scopes between the setup body and the handler (view fn, callbacks). */
    intermediateScopes: Set<string>[];
}

/** Attribute name → DOM event, or null when not a plain `on[A-Z]…` attribute. */
function eventOf(attr: Node): string | null {
    const name = attr.name as Node;
    if (name.type !== 'JSXIdentifier') return null; // JSXNamespacedName: onUpdate:x etc.
    const text = name.name as string;
    if (!/^on[A-Z]/.test(text)) return null;
    return text.slice(2).toLowerCase();
}

function findHandlerSites(setupFn: Node): HandlerSite[] {
    const sites: HandlerSite[] = [];

    function visit(node: Node, scopes: Set<string>[]): void {
        let nextScopes = scopes;
        if (FUNCTION_TYPES.has(node.type) && node !== setupFn) {
            nextScopes = [...scopes, ownScopeBindings(node)];
        } else {
            const own = ownScopeBindings(node);
            if (own.size > 0 && node !== (setupFn.body as Node)) nextScopes = [...scopes, own];
        }
        if (node.type === 'JSXOpeningElement') {
            const tag = node.name as Node;
            const isHost = tag.type === 'JSXIdentifier' && /^[a-z]/.test(tag.name as string);
            if (isHost) {
                // Idempotency: events already carrying a QRL attribute (a
                // previous pass over this source) are not extracted again.
                const alreadyStamped = new Set<string>();
                for (const attr of node.attributes as Node[]) {
                    if (attr.type !== 'JSXAttribute') continue;
                    const name = attr.name as Node;
                    if (name.type === 'JSXNamespacedName') {
                        const ns = ((name.namespace as Node).name as string) ?? '';
                        if (ns === 'data-sigx-on') alreadyStamped.add(((name.name as Node).name as string) ?? '');
                    }
                }
                for (const attr of node.attributes as Node[]) {
                    if (attr.type !== 'JSXAttribute') continue;
                    const event = eventOf(attr);
                    if (!event || alreadyStamped.has(event) || !isNode(attr.value)) continue;
                    const container = attr.value as Node;
                    if (container.type !== 'JSXExpressionContainer') continue;
                    sites.push({
                        attr,
                        event,
                        expr: container.expression as Node,
                        element: node,
                        intermediateScopes: nextScopes
                    });
                }
            }
        }
        for (const child of childNodes(node)) visit(child, nextScopes);
    }

    visit(setupFn.body as Node, []);
    return sites;
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

/** FNV-1a, 8 hex chars — deterministic across environments and builds. */
function hash8(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

const LANG_BY_EXT: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = {
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.js': 'js',
    '.jsx': 'jsx',
    '.mjs': 'js',
    '.mts': 'ts'
};

export function extractResumeHandlers(code: string, id: string): ResumeExtraction {
    const clean = id.split('?')[0];
    const ext = clean.slice(clean.lastIndexOf('.'));
    const program = parseAst(code, { lang: LANG_BY_EXT[ext] ?? 'tsx' }, clean) as unknown as Node;

    const moduleScan = scanModule(program);
    const components = findComponents(program, moduleScan);

    const handlers: ExtractedHandler[] = [];
    const ineligible: IneligibleHandler[] = [];
    const componentResults: ResumeComponent[] = [];
    const componentSplices: Splice[] = [];
    const handlerExports = new Map<string, string>(); // symbol → export statement
    const replicatedImports = new Map<string, Set<string>>(); // source → clause pieces
    const events = new Set<string>();

    for (const comp of components) {
        let extracted = 0;
        let anyIneligible = false;
        /** Elements that already got their `data-sigx-b` this pass. */
        const stampedElements = new Set<Node>();

        const fail = (site: HandlerSite, reason: string): void => {
            anyIneligible = true;
            ineligible.push({ component: comp.exported, event: site.event, offset: site.expr.start, reason });
        };

        for (const site of findHandlerSites(comp.setupFn)) {
            // Resolve the handler expression to a function we can analyze.
            let fn = site.expr;
            if (fn.type === 'Identifier') {
                const name = fn.name as string;
                const imported = moduleScan.imports.get(name);
                if (imported && !imported.typeOnly) {
                    // Imported function: the handler module re-imports and wraps it.
                    emitWrapped(site, name, imported);
                    extracted++;
                    continue;
                }
                const local = resolveLocalFunction(comp, site, name);
                if (!local) {
                    fail(site, `handler "${name}" is not a statically analyzable const function`);
                    continue;
                }
                fn = local;
            }
            if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') {
                fail(site, 'handler is not a statically analyzable function expression');
                continue;
            }

            const scan = scanHandler(fn);
            if (scan.contextual) {
                fail(site, `handler uses ${scan.contextual}`);
                continue;
            }
            if (scan.usesReservedName) {
                fail(site, 'handler references a reserved name ($scope/$el)');
                continue;
            }

            const splices: Splice[] = [];
            let reason: string | null = null;
            const neededImports: ImportedBinding[] = [];

            for (const ref of scan.freeRefs) {
                // Nearest binding walking outward from the handler.
                const inIntermediate = site.intermediateScopes.some((s) => s.has(ref.name));
                if (inIntermediate) {
                    reason = `handler captures "${ref.name}" (view-scope local — closures cannot be serialized)`;
                    break;
                }
                if (comp.namedSignals.has(ref.name)) {
                    if (ref.rootWrite) {
                        reason = `handler reassigns signal binding "${ref.name}"`;
                        break;
                    }
                    splices.push({ start: ref.node.start, end: ref.node.end, text: `$scope.signals.${ref.name}` });
                    continue;
                }
                if (ref.name === comp.ctxName) {
                    const member = ref.memberParent;
                    const propName = member && isNode(member.property) ? ((member.property as Node).name as string) : null;
                    if (propName === 'props' && member) {
                        if (isPropsWrite(member, fn)) {
                            reason = 'handler writes to ctx.props (props are read-only in a resumed scope)';
                            break;
                        }
                        splices.push({ start: member.start, end: member.end, text: '$scope.props' });
                        continue;
                    }
                    reason = `handler uses ${comp.ctxName}.${propName ?? '…'} (only ${comp.ctxName}.props and named signals resume)`;
                    break;
                }
                if (comp.setupLocals.has(ref.name)) {
                    reason = `handler captures "${ref.name}" (setup-scope local that is not a named signal)`;
                    break;
                }
                const imported = moduleScan.imports.get(ref.name);
                if (imported && !imported.typeOnly) {
                    if (ref.rootWrite) {
                        reason = `handler writes to imported binding "${ref.name}"`;
                        break;
                    }
                    neededImports.push(imported);
                    continue;
                }
                if (moduleScan.moduleLocals.has(ref.name)) {
                    reason = `handler captures module-scope binding "${ref.name}" (would chain the handler chunk to this module)`;
                    break;
                }
                if (ref.rootWrite) {
                    reason = `handler writes to global "${ref.name}"`;
                    break;
                }
                // Unresolved ⇒ global (window, console, JSON, …) — fine as-is.
            }

            if (reason) {
                fail(site, reason);
                continue;
            }

            emitExtracted(site, fn, splices, neededImports, scan.callsPreventDefault);
            extracted++;
        }

        componentResults.push({
            local: comp.local,
            exported: comp.exported,
            mode: anyIneligible || comp.usesSlots ? 'hydrate' : 'resume',
            handlerCount: extracted,
            signalCount: comp.namedSignals.size
        });

        /** Emit attribute splices for one eligible handler. */
        function emitExtracted(
            site: HandlerSite,
            fn: Node,
            bodySplices: Splice[],
            imports: ImportedBinding[],
            preventDefault: boolean
        ): void {
            // Rebuild `($scope, <original params>) => <rewritten body>`.
            const params = fn.params as Node[];
            const paramsSrc = params.length > 0
                ? code.slice(params[0].start, params[params.length - 1].end)
                : '';
            const body = fn.body as Node;
            const relative = bodySplices.map((s) => ({ start: s.start - body.start, end: s.end - body.start, text: s.text }));
            const bodySrc = applySplices(code.slice(body.start, body.end), relative);
            const asyncPrefix = fn.async === true ? 'async ' : '';
            const exportSrc = (symbol: string): string =>
                `export const ${symbol} = ${asyncPrefix}($scope${paramsSrc ? ', ' + paramsSrc : ''}) => ${
                    body.type === 'BlockStatement' ? bodySrc : `(${bodySrc})`
                };`;
            const symbol = `${comp.exported}_${site.event}_${hash8(exportSrc('$'))}`;
            finishHandler(site, symbol, exportSrc(symbol), imports, preventDefault);
        }

        /** Imported-identifier handler: wrap it so the signature matches. */
        function emitWrapped(site: HandlerSite, name: string, imported: ImportedBinding): void {
            const exportSrc = (symbol: string): string =>
                `export const ${symbol} = ($scope, ...$args) => ${name}(...$args);`;
            const symbol = `${comp.exported}_${site.event}_${hash8(name + ':' + imported.source)}`;
            finishHandler(site, symbol, exportSrc(symbol), [imported], false);
        }

        function finishHandler(
            site: HandlerSite,
            symbol: string,
            exportSource: string,
            imports: ImportedBinding[],
            preventDefault: boolean
        ): void {
            if (!handlerExports.has(symbol)) {
                handlerExports.set(symbol, exportSource);
                handlers.push({ symbol, event: site.event, component: comp.exported, preventDefault, exportSource });
            }
            for (const imp of imports) {
                const clause =
                    imp.kind === 'default' ? `default:${imp.local}`
                    : imp.kind === 'namespace' ? `ns:${imp.local}`
                    : imp.imported === imp.local ? imp.local
                    : `${imp.imported} as ${imp.local}`;
                let set = replicatedImports.get(imp.source);
                if (!set) replicatedImports.set(imp.source, (set = new Set()));
                set.add(clause);
            }
            events.add(site.event);

            let attrs = ` data-sigx-on:${site.event}="${symbol}"`;
            if (preventDefault) attrs += ` data-sigx-pd:${site.event}=""`;
            if (!stampedElements.has(site.element) && comp.ctxName) {
                stampedElements.add(site.element);
                attrs += ` data-sigx-b={${comp.ctxName}.$sigxB}`;
            }
            componentSplices.push({ start: site.attr.end, end: site.attr.end, text: attrs });
        }
    }

    /** Resolve an identifier handler to a setup/view-level const fn declarator. */
    function resolveLocalFunction(comp: ComponentInfo, site: HandlerSite, name: string): Node | null {
        // Only setup-body top-level `const name = <fn>` is supported; view/loop
        // scopes would need per-instance closures the scope model can't
        // express — so any intermediate binding shadows the setup one and
        // makes the reference unresolvable.
        const body = comp.setupFn.body as Node;
        if (body.type !== 'BlockStatement') return null;
        if (site.intermediateScopes.some((s) => s.has(name))) return null;
        for (const stmt of body.body as Node[]) {
            if (stmt.type !== 'VariableDeclaration' || stmt.kind !== 'const') continue;
            for (const decl of stmt.declarations as Node[]) {
                if (
                    (decl.id as Node).type === 'Identifier' &&
                    ((decl.id as Node).name as string) === name &&
                    isNode(decl.init) &&
                    ((decl.init as Node).type === 'ArrowFunctionExpression' || (decl.init as Node).type === 'FunctionExpression')
                ) {
                    return decl.init as Node;
                }
            }
        }
        return null;
    }

    /** Assignment targeting anything rooted at this ctx.props member chain? */
    function isPropsWrite(member: Node, handlerFn: Node): boolean {
        // Walk the handler for AssignmentExpression/UpdateExpression whose
        // target's member-chain root span encloses this `ctx.props` node.
        let write = false;
        (function walk(node: Node): void {
            if (write) return;
            if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
                const target = (node.type === 'AssignmentExpression' ? node.left : node.argument) as Node;
                if (target.start <= member.start && target.end >= member.end) write = true;
            }
            for (const child of childNodes(node)) walk(child);
        })(handlerFn);
        return write;
    }

    let handlersModule: string | null = null;
    if (handlerExports.size > 0) {
        const importLines: string[] = [];
        for (const [source, clauses] of replicatedImports) {
            const named: string[] = [];
            for (const clause of clauses) {
                // Multiple default/namespace locals for one source each get
                // their own statement — merging would drop all but one.
                if (clause.startsWith('default:')) importLines.push(`import ${clause.slice(8)} from ${JSON.stringify(source)};`);
                else if (clause.startsWith('ns:')) importLines.push(`import * as ${clause.slice(3)} from ${JSON.stringify(source)};`);
                else named.push(clause);
            }
            if (named.length > 0) importLines.push(`import { ${named.join(', ')} } from ${JSON.stringify(source)};`);
        }
        handlersModule = [...importLines, ...handlerExports.values()].join('\n') + '\n';
    }

    return {
        code: componentSplices.length > 0 ? applySplices(code, componentSplices) : code,
        handlersModule,
        handlers,
        ineligible,
        components: componentResults,
        events: [...events].sort()
    };
}
