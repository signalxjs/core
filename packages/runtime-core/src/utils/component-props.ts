/**
 * Shared component-setup helpers for props handling.
 * Used by both mountComponent (renderer) and hydrateComponent
 * (@sigx/server-renderer client) so the two setup paths cannot drift.
 */

import { isReactive } from '@sigx/reactivity';
import { isModel } from '../model.js';

/**
 * Split raw VNode props into the pieces component setup needs:
 * `children` and the `slots` prop are separated out to feed slot
 * creation, and `$models` entries that pass `isModel` are merged into
 * the remaining data props for unified access (`props.model.value`).
 *
 * `key` and `ref` are peeled off too, and deliberately do NOT reach
 * `ctx.props`. The renderer takes both off the vnode directly — `key` at
 * `jsx()` time, `ref` to deliver the `expose()` value — so a component has
 * no reason to read them, and leaving them visible is a live hazard once
 * props are forwarded by spread: `<button {...rest} />` would bind the
 * consumer's `ref` a second time (now to the element, after the renderer
 * already called it with the exposed value), and `<Child {...rest} />` would
 * put a key on a child the author never keyed — `jsx()` reads `props.key` as
 * the vnode key, and that decides sibling identity. `ref` comes back as
 * `forwardedRef` for the
 * one caller that must re-forward it deliberately — see `lazy`.
 */
export function splitComponentProps(initialProps: Record<string, any>): {
    children: any;
    slotsFromProps: Record<string, any> | undefined;
    propsWithModels: Record<string, any>;
    forwardedRef: any;
} {
    const {
        children,
        slots: slotsFromProps,
        $models: modelsData,
        key: _key,
        ref: forwardedRef,
        ...propsData
    } = initialProps;

    const propsWithModels: Record<string, any> = { ...propsData };
    if (modelsData) {
        for (const modelKey of Object.keys(modelsData)) {
            // Own keys only, and never prototype-mutating names — assigning
            // a "__proto__" key would rewire the props object's prototype.
            if (modelKey === '__proto__' || modelKey === 'constructor' || modelKey === 'prototype') continue;
            const modelValue = modelsData[modelKey];
            if (isModel(modelValue)) {
                propsWithModels[modelKey] = modelValue;
            }
        }
    }

    return { children, slotsFromProps, propsWithModels, forwardedRef };
}

/**
 * Create an emit function for a component context: `emit('click', e)`
 * invokes the `onClick` handler from the component's props. Accepts the
 * reactive props proxy used at runtime, or a plain `{ value: props }`
 * wrapper (legacy SSR call shape).
 */
export function createEmit(reactiveProps: { value?: Record<string, any> } | Record<string, any>): (event: string, ...args: any[]) => void {
    return (event: string, ...args: any[]) => {
        if (!event) return; // emit('') is a no-op, like a missing handler
        const eventName = `on${event[0].toUpperCase() + event.slice(1)}`;
        // A reactive props proxy IS the props object — a component's own
        // `value` prop must not trigger unwrapping. Only plain
        // `{ value: props }` wrappers unwrap.
        const props = !isReactive(reactiveProps) && 'value' in reactiveProps
            ? (reactiveProps as { value?: Record<string, any> }).value
            : (reactiveProps as Record<string, any>);
        const handler = props?.[eventName];
        if (handler && typeof handler === 'function') {
            handler(...args);
        }
    };
}
