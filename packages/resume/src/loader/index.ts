/**
 * The resume delegation loader (#241) — the ONLY script a resumable page
 * ships. It must import nothing (size-limit enforces this: the entry is
 * checked with no `ignore` list) and do nothing until the user interacts.
 *
 * One capture-phase document listener per handled event type. On the first
 * interaction with a QRL-carrying element it lazy-imports the registry and
 * runtime (cached), then REPLAYS the triggering event through the resolved
 * handler — late invocation is well-defined for a pure
 * `(scope, event, element)` function, and dropping the first interaction is
 * precisely the failure resumability exists to fix. Two event effects cannot
 * be replayed and are handled explicitly:
 *
 * - `preventDefault` fires synchronously during native dispatch for elements
 *   carrying `data-sigx-pd:<event>` (the transform stamps it when the
 *   handler body calls preventDefault).
 * - `stopPropagation` is scoped to the synthetic bubble (`cancelBubble`
 *   checked between handlers); native propagation has already happened —
 *   capture-at-document saw the event first, so nothing user-visible
 *   depends on it.
 *
 * Delegation stays the permanent dispatch path — the pack never attaches
 * per-element listeners; repeat events resolve through settled promises.
 */

/** What `@sigx/resume/client` provides once loaded. */
export interface ResumeRuntime {
    /** Resolve a QRL symbol and run its handler for this event/element. */
    invoke(symbol: string, event: Event, element: Element): void | Promise<void>;
}

const ON_PREFIX = 'data-sigx-on:';
const PD_PREFIX = 'data-sigx-pd:';

interface LoaderState {
    listeners: Map<string, (ev: Event) => void>;
    loadRegistry: () => Promise<unknown>;
    loadRuntime: () => Promise<ResumeRuntime>;
    ready: Promise<ResumeRuntime> | null;
}

let state: LoaderState | null = null;

/**
 * Install delegation for `events` (the build-wide union emitted into
 * `virtual:sigx-resume/entry`). Idempotent: repeat calls add listeners only
 * for new event types and update the lazy registry/runtime references.
 */
export function initResume(
    events: string[],
    loadRegistry: () => Promise<unknown>,
    loadRuntime: () => Promise<ResumeRuntime>
): void {
    if (!state) {
        state = { listeners: new Map(), loadRegistry, loadRuntime, ready: null };
    } else {
        state.loadRegistry = loadRegistry;
        state.loadRuntime = loadRuntime;
        state.ready = null;
    }
    for (const type of events) {
        if (state.listeners.has(type)) continue;
        const listener = (ev: Event): void => dispatch(type, ev);
        state.listeners.set(type, listener);
        document.addEventListener(type, listener, { capture: true, passive: false });
    }
}

/**
 * Remove all delegation listeners and drop cached module references — for
 * SPA navigations that replace the boundary table, and for tests.
 */
export function resetResumeDelegation(): void {
    if (!state) return;
    for (const [type, listener] of state.listeners) {
        document.removeEventListener(type, listener, { capture: true });
    }
    state = null;
}

function dispatch(type: string, ev: Event): void {
    if (!state) return;
    // Collect QRL carriers target → root (the synthetic bubble order), and
    // apply preventDefault SYNCHRONOUSLY — it cannot wait for the import.
    const chain: Element[] = [];
    let node: Element | null = ev.target instanceof Element ? ev.target : null;
    while (node) {
        if (node.hasAttribute(ON_PREFIX + type)) {
            chain.push(node);
            if (node.hasAttribute(PD_PREFIX + type)) ev.preventDefault();
        }
        node = node.parentElement;
    }
    if (chain.length === 0) return;

    if (!state.ready) {
        // First interaction: load runtime + registry together, once.
        const { loadRegistry, loadRuntime } = state;
        state.ready = Promise.all([loadRuntime(), loadRegistry()]).then(([runtime]) => runtime);
    }
    void state.ready.then((runtime) => replay(runtime, type, ev, chain));
}

async function replay(runtime: ResumeRuntime, type: string, ev: Event, chain: Element[]): Promise<void> {
    for (const el of chain) {
        if (ev.cancelBubble) return; // handler called stopPropagation
        const symbol = el.getAttribute(ON_PREFIX + type);
        if (symbol) await runtime.invoke(symbol, ev, el);
    }
}
