/**
 * Shared component-setup helpers for props handling.
 * Used by both mountComponent (renderer) and hydrateComponent
 * (@sigx/server-renderer client) so the two setup paths cannot drift.
 */

import { isModel } from '../model.js';

/**
 * Split raw VNode props into the pieces component setup needs:
 * `children` and the `slots` prop feed slot creation, and `$models`
 * entries are merged into the remaining props for unified access
 * (`props.model.value`). VNode-valued keys are excluded from the merge
 * to avoid deep recursion on reactive wrapping.
 */
export function splitComponentProps(initialProps: Record<string, any>): {
    children: any;
    slotsFromProps: Record<string, any> | undefined;
    propsWithModels: Record<string, any>;
} {
    const { children, slots: slotsFromProps, $models: modelsData, ...propsData } = initialProps;

    const propsWithModels: Record<string, any> = { ...propsData };
    if (modelsData) {
        for (const modelKey in modelsData) {
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
 * invokes the `onClick` handler from the component's (possibly
 * signal-wrapped) props.
 */
export function createEmit(reactiveProps: { value?: Record<string, any> } | Record<string, any>): (event: string, ...args: any[]) => void {
    return (event: string, ...args: any[]) => {
        const eventName = `on${event[0].toUpperCase() + event.slice(1)}`;
        // Handle both signal-wrapped props and plain props
        const props = 'value' in reactiveProps ? reactiveProps.value : reactiveProps;
        const handler = props?.[eventName];
        if (handler && typeof handler === 'function') {
            handler(...args);
        }
    };
}
