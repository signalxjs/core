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
 */
export function splitComponentProps(initialProps: Record<string, any>): {
    children: any;
    slotsFromProps: Record<string, any> | undefined;
    propsWithModels: Record<string, any>;
} {
    const { children, slots: slotsFromProps, $models: modelsData, ...propsData } = initialProps;

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

    return { children, slotsFromProps, propsWithModels };
}

/**
 * Create an emit function for a component context: `emit('click', e)`
 * invokes the `onClick` handler from the component's props. Accepts the
 * reactive props proxy used at runtime, or a plain `{ value: props }`
 * wrapper (legacy SSR call shape).
 */
export function createEmit(reactiveProps: { value?: Record<string, any> } | Record<string, any>): (event: string, ...args: any[]) => void {
    return (event: string, ...args: any[]) => {
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
