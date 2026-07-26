/**
 * Composing props from several sources.
 *
 * Forwarding a component's leftover props onto its root element is plain JS —
 * `const { color, ...rest } = ctx.props` then `<button {...rest} />`. What
 * plain JS cannot do is *combine* two sources: a JSX spread is lowered by the
 * compiler into a single object literal before the runtime sees anything, so
 * `<button {...rest} {...bag} />` lets later keys clobber earlier ones. If the
 * consumer and the component both set `class`, one is lost; same for
 * `onClick`; and `onClick` vs `onclick` land in the same DOM listener slot.
 *
 * No runtime change can recover what the compiler already discarded, which is
 * why this one function exists.
 */

import { parseStringStyle } from './utils/style.js';

/** A source of props: an object, a thunk returning one, or nothing. */
export type MergeSource = Record<string, any> | (() => Record<string, any>) | null | undefined;

/** Resolve a source, tolerating thunks and nullish entries. */
function resolve(source: MergeSource): Record<string, any> | null {
    if (!source) return null;
    const value = typeof source === 'function' ? source() : source;
    return value && typeof value === 'object' ? value : null;
}

/** `class` and `className` are one logical slot; normalize to `class`. */
function isClassKey(key: string): boolean {
    return key === 'class' || key === 'className';
}

/**
 * An `on*` key that is a DOM event handler rather than a channel of its own.
 * `onUpdate:modelValue` and friends carry stamped handler state and a
 * dedicated `patchProp` branch, so they are passed through untouched.
 */
function isChainableHandler(key: string, value: unknown): boolean {
    return typeof value === 'function'
        && key.length > 2
        && key.charCodeAt(0) === 111 /* o */
        && key.charCodeAt(1) === 110 /* n */
        && !key.includes(':');
}

/** The event a handler prop resolves to — the same normalization patchProp applies. */
function eventNameOf(key: string): string {
    return key.slice(2).toLowerCase();
}

function toStyleObject(value: unknown): Record<string, any> | null {
    if (!value) return null;
    if (typeof value === 'string') return parseStringStyle(value);
    return typeof value === 'object' ? value as Record<string, any> : null;
}

/** Apply a value to either ref form — `ref(value)` or `ref.current = value`. */
function applyRef(ref: any, value: any): void {
    if (typeof ref === 'function') ref(value);
    else if (ref && typeof ref === 'object') ref.current = value;
}

/**
 * Merge several prop sources into one.
 *
 * Ordinary keys follow **exact JS spread semantics**: the last source with the
 * key as an own key wins, including when its value is an explicit `undefined`.
 * This replaces a `{...a, ...b}` spread, so it must behave like one — it is
 * deliberately *not* a defaults helper (destructuring with defaults already
 * covers that).
 *
 * Four kinds of key are combined rather than overwritten:
 *
 * - **`class` / `className`** — concatenated in argument order, non-empty
 *   values only, emitted as `class`.
 * - **`style`** — merged left-to-right into an object; string sources are
 *   parsed first. An object beats a string downstream: `patchProp` diffs it
 *   per property and handles custom properties, and SSR stringifies it.
 * - **`on*` handlers** — chained in source order, and grouped by the event
 *   they resolve to, so `onClick` and `onclick` become **one** entry under the
 *   first spelling seen. Two keys can then never reach the same invoker slot.
 * - **`ref`** — chained into one ref that feeds every source's ref.
 *
 * Chaining cannot express *swallow*: a component that gates a consumer handler
 * (dropping `onClick` while disabled) must keep destructuring it out and
 * calling it itself.
 *
 * @example Hoist the call into setup — see the note on identity below.
 * ```tsx
 * const merged = mergeProps(
 *     () => { const { variant: _v, ...rest } = ctx.props; return rest; },
 *     () => ({ class: 'btn', onClick: onActivate })
 * );
 * return () => <button {...merged}>{slots.default?.()}</button>;
 * ```
 *
 * The returned object resolves on read, so thunk sources stay reactive: a
 * render that spreads it reads through to `ctx.props` and tracks as usual.
 * Calling `mergeProps` **once in setup** also keeps the derived `ref` and
 * chained handlers identity-stable across renders — rebuilding them per render
 * hands the renderer a fresh function every time, which makes it tear down and
 * re-apply refs for no reason.
 */
export function mergeProps(...sources: MergeSource[]): Record<string, any> {
    // Cache for derived values that must keep a stable identity while their
    // contributors do. Keyed by output key; invalidated by comparing the
    // contributing functions one by one.
    const derived = new Map<string, { parts: any[]; value: any }>();

    function cachedDerive(key: string, parts: any[], build: () => any): any {
        const hit = derived.get(key);
        if (hit && hit.parts.length === parts.length && hit.parts.every((p, i) => p === parts[i])) {
            return hit.value;
        }
        const value = build();
        derived.set(key, { parts, value });
        return value;
    }

    /**
     * Walk every source once, resolving what the merged object looks like
     * right now. Reads happen here, so a spread of the result tracks whatever
     * the thunks touch.
     */
    function collect(): {
        plain: Map<string, any>;
        classParts: string[];
        styleParts: unknown[];
        handlers: Map<string, { key: string; fns: any[] }>;
        refs: any[];
    } {
        const plain = new Map<string, any>();
        const classParts: string[] = [];
        const styleParts: unknown[] = [];
        const handlers = new Map<string, { key: string; fns: any[] }>();
        const refs: any[] = [];

        for (const source of sources) {
            const props = resolve(source);
            if (!props) continue;

            for (const key in props) {
                const value = props[key];

                if (isClassKey(key)) {
                    if (value) classParts.push(String(value));
                    continue;
                }
                if (key === 'style') {
                    if (value) styleParts.push(value);
                    continue;
                }
                if (key === 'ref') {
                    if (value) refs.push(value);
                    continue;
                }
                if (isChainableHandler(key, value)) {
                    const event = eventNameOf(key);
                    const group = handlers.get(event);
                    // First spelling seen owns the output key, so the merged
                    // object carries one handler prop per event no matter how
                    // many spellings arrived.
                    if (group) group.fns.push(value);
                    else handlers.set(event, { key, fns: [value] });
                    continue;
                }

                // Exact spread semantics: an own key wins even when its value
                // is undefined.
                plain.set(key, value);
            }
        }

        return { plain, classParts, styleParts, handlers, refs };
    }

    function keysOf(state: ReturnType<typeof collect>): string[] {
        const keys = [...state.plain.keys()];
        if (state.classParts.length) keys.push('class');
        if (state.styleParts.length) keys.push('style');
        if (state.refs.length) keys.push('ref');
        for (const group of state.handlers.values()) keys.push(group.key);
        return keys;
    }

    function read(key: string, state: ReturnType<typeof collect>): any {
        if (isClassKey(key)) {
            return state.classParts.length ? state.classParts.join(' ') : undefined;
        }
        if (key === 'style') {
            if (!state.styleParts.length) return undefined;
            const merged: Record<string, any> = {};
            for (const part of state.styleParts) Object.assign(merged, toStyleObject(part));
            return merged;
        }
        if (key === 'ref') {
            const refs = state.refs;
            if (!refs.length) return undefined;
            if (refs.length === 1) return refs[0];
            return cachedDerive('ref', refs, () =>
                (value: any) => { for (const ref of refs) applyRef(ref, value); });
        }

        for (const group of state.handlers.values()) {
            if (group.key !== key) continue;
            const fns = group.fns;
            if (fns.length === 1) return fns[0];
            return cachedDerive(key, fns, () =>
                (...args: any[]) => { for (const fn of fns) fn(...args); });
        }

        return state.plain.get(key);
    }

    return new Proxy({} as Record<string, any>, {
        get(_target, key) {
            if (typeof key === 'symbol') return undefined;
            return read(key, collect());
        },
        has(_target, key) {
            if (typeof key === 'symbol') return false;
            return keysOf(collect()).includes(key);
        },
        ownKeys() {
            return keysOf(collect());
        },
        getOwnPropertyDescriptor(_target, key) {
            if (typeof key === 'symbol') return undefined;
            const state = collect();
            if (!keysOf(state).includes(key)) return undefined;
            return {
                value: read(key, state),
                enumerable: true,
                configurable: true,
                writable: false
            };
        }
    });
}
