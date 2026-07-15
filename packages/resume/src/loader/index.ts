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
 *   depends on it. `cancelBubble` set by NATIVE listeners during dispatch
 *   also suppresses the replay — deliberate behavior parity: a hydrated
 *   component's real listener would not have fired either.
 *
 * Delegation stays the permanent dispatch path — the pack never attaches
 * per-element listeners; repeat events resolve through settled promises.
 */

/** What `@sigx/resume/client` provides once loaded. */
export interface ResumeRuntime {
    /** Resolve a QRL symbol and run its handler for this event/element. */
    invoke(symbol: string, event: Event, element: Element): void | Promise<void>;
    /**
     * Fully hydrate a boundary (`__resumeMode: 'hydrate'` components carry
     * `data-sigx-wake:*` instead of QRLs). The triggering event is NOT
     * replayed — its listener only exists after hydration.
     */
    wake(boundaryId: number): void | Promise<void>;
}

const ON_PREFIX = 'data-sigx-on:';
const WAKE_PREFIX = 'data-sigx-wake:';
const PD_PREFIX = 'data-sigx-pd:';
const BOUNDARY_ATTR = 'data-sigx-b';

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
        // Update the lazy references for FUTURE loads but keep an already
        // loaded (or loading) runtime — re-init must not force a reload.
        state.loadRegistry = loadRegistry;
        state.loadRuntime = loadRuntime;
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
    // Collect QRL and wake carriers target → root (the synthetic bubble
    // order), applying preventDefault SYNCHRONOUSLY — it cannot wait for the
    // import.
    const chain: Element[] = [];
    const wakeIds: number[] = [];
    // event.target can be a Text node (clicking text inside a button).
    const target = ev.target;
    let node: Element | null =
        target instanceof Element ? target
        : target instanceof Node ? target.parentElement
        : null;
    while (node) {
        if (node.hasAttribute(ON_PREFIX + type)) {
            chain.push(node);
            if (node.hasAttribute(PD_PREFIX + type)) ev.preventDefault();
        } else if (node.hasAttribute(WAKE_PREFIX + type)) {
            const id = parseInt(node.getAttribute(BOUNDARY_ATTR) || '', 10);
            if (!isNaN(id) && wakeIds.indexOf(id) < 0) wakeIds.push(id);
            if (node.hasAttribute(PD_PREFIX + type)) ev.preventDefault();
        }
        node = node.parentElement;
    }
    if (chain.length === 0 && wakeIds.length === 0) return;

    let ready = state.ready;
    if (!ready) {
        // First interaction: load runtime + registry together, once. A
        // failed load clears the cache so the NEXT interaction retries
        // instead of failing forever on a rejected promise.
        const current = state;
        ready = Promise.all([current.loadRuntime(), current.loadRegistry()]).then(
            ([runtime]) => runtime,
            (error) => {
                if (current.ready === ready) current.ready = null;
                throw error;
            }
        );
        current.ready = ready;
    }
    // MACROTASK hop (#266): UA-dispatched events run microtask checkpoints
    // between listener invocations, so with warm caches a promise-chained
    // replay would run — and the resulting upgrade would attach the real
    // listener — while the SAME event is still propagating, double-firing
    // the handler. setTimeout guarantees the synthetic bubble starts only
    // after native dispatch completes. (Synthetic dispatchEvent() calls are
    // fully synchronous and never interleave, so unit tests cannot
    // reproduce this — the browser smokes are the regression coverage.)
    ready.then((runtime) => new Promise<void>((resolve) => {
        setTimeout(async () => {
            // Errors inside a timer callback escape every promise chain —
            // contain them here and ALWAYS resolve, or a failed dispatch
            // becomes an unhandled rejection.
            try {
                for (const id of wakeIds) {
                    // wake failures must not kill the QRL replay below (or
                    // vice versa) — surface them individually.
                    try {
                        await runtime.wake(id);
                    } catch (error) {
                        console.error(`[sigx resume] wake of boundary ${id} failed:`, error);
                    }
                }
                await replay(runtime, type, ev, chain);
            } catch (error) {
                console.error('[sigx resume] resume dispatch failed:', error);
            } finally {
                resolve();
            }
        }, 0);
    })).catch((error) => {
        console.error('[sigx resume] failed to load the resume runtime:', error);
    });
}

async function replay(runtime: ResumeRuntime, type: string, ev: Event, chain: Element[]): Promise<void> {
    for (const el of chain) {
        if (ev.cancelBubble) return; // handler called stopPropagation
        const symbol = el.getAttribute(ON_PREFIX + type);
        if (!symbol) continue;
        // A throwing handler must not swallow the rest of the synthetic
        // bubble — native dispatch keeps running other listeners too.
        try {
            await runtime.invoke(symbol, ev, el);
        } catch (error) {
            console.error(`[sigx resume] handler "${symbol}" failed:`, error);
        }
    }
}
