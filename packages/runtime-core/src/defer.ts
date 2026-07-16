/**
 * <Defer fallback={…}> — the one tree-positional async wrapper.
 *
 * Client: the fallback covers lazy CHUNK loading only — a pending `useData`
 * read renders through its owning component's `match` (value-first), never
 * through a wrapper. Lazy wrappers register their load promise with the
 * nearest Defer at SETUP time via DI (deterministic — the parent chain is
 * linked before child setup runs; no render-order protocol, no thrown
 * promises).
 *
 * SSR streaming: the server renderer special-cases the `__defer` marker —
 * the fallback streams with the shell and ONE replacement arrives when
 * everything pending beneath it (chunks AND keyed data) resolves. Blocking
 * and string modes await inline, so Defer needs no special handling there.
 *
 * Render shape is CONSTANT: [fallback-or-comment, …children]. Children stay
 * mounted while a chunk loads (a pending lazy renders null), so sibling
 * state survives and the resolved component appears in place.
 */

import { component, type Define } from './component.js';
import { jsx, Fragment, type JSXElement } from './jsx-runtime.js';
import { getCurrentInstance } from './component-lifecycle.js';

const DEFER_TOKEN: unique symbol = Symbol('sigx:defer');

/** @internal */
export interface DeferCollector {
    add(p: Promise<unknown>): void;
}

/**
 * The nearest enclosing <Defer>'s collector, or undefined. Called by lazy
 * wrappers at SETUP time (setup-time DI registration is deterministic;
 * render-time registration is the removed protocol).
 *
 * @internal
 */
export function getDeferCollector(): DeferCollector | undefined {
    // Walk the instance parent chain (same traversal as DI's lookupProvided,
    // inlined to keep this on the internal ctx shape).
    let node = getCurrentInstance() as
        | { provides?: Map<symbol, unknown>; parent?: unknown }
        | null
        | undefined;
    while (node) {
        const found = node.provides?.get(DEFER_TOKEN);
        if (found) return found as DeferCollector;
        node = node.parent as typeof node;
    }
    return undefined;
}

export type DeferProps = Define.Prop<'fallback', JSXElement | (() => JSXElement)> &
    Define.Slot<'default'>;

export const Defer = component<DeferProps>((ctx) => {
    const state = ctx.signal({ pending: 0 });
    // Two instances of one lazy factory share one load promise — count it once.
    const tracked = new Set<Promise<unknown>>();

    const collector: DeferCollector = {
        add(p) {
            if (tracked.has(p)) return;
            tracked.add(p);
            // add() runs during a child's setup — INSIDE this component's
            // own render effect, whose re-entrant notifications the
            // reactivity system drops (render-loop guard). Step out of the
            // effect frame before writing; the microtask is queued ahead of
            // any settle reaction of `p`, so the decrement can't overtake.
            queueMicrotask(() => {
                state.pending++;
            });
            void p
                .finally(() => {
                    tracked.delete(p);
                    state.pending--;
                })
                .catch(() => {
                    // Rejections surface through the lazy wrapper's render
                    // throw — the collector only counts settlement.
                });
        },
    };

    const node = ctx as unknown as { provides?: Map<symbol, unknown> };
    (node.provides ??= new Map()).set(DEFER_TOKEN, collector);

    return () => {
        const fb =
            state.pending > 0
                ? (typeof ctx.props.fallback === 'function'
                    ? (ctx.props.fallback as () => JSXElement)()
                    : ctx.props.fallback) ?? null
                : null;
        // Constant shape: a null slot normalizes to a Comment vnode, so the
        // fallback toggles in place without shifting the children.
        return jsx(Fragment, { children: [fb, ctx.slots.default?.() ?? null] });
    };
}, { name: 'Defer' });

// Marker for renderers that special-case Defer boundaries (the server
// renderer streams the fallback and defers the children).
(Defer as any).__defer = true;
