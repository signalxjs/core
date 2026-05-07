/**
 * Component factory and runtime.
 *
 * This module contains the component() factory function, component registry,
 * and createPropsProxy utility. Type definitions live in component-types.ts,
 * lifecycle hooks live in component-lifecycle.ts.
 */

import { getComponentPlugins } from "./plugins.js";
import type {
    ComponentSetupContext,
    PlatformElement,
    ViewFn,
    SetupFn,
    ComponentFactory,
    ComponentOptions,
} from './component-types.js';

// Re-export everything from component-types.ts and component-lifecycle.ts
// so existing imports from './component.js' continue to work
export type {
    ComponentAttributeExtensions,
    Define,
    DefineProp,
    ModelBinding,
    DefineModel,
    EventDefinition,
    DefineEvent,
    DefineSlot,
    SlotsObject,
    EmitFn,
    PlatformTypes,
    PlatformElement,
    MountContext,
    SetupContext,
    PropsWithDefaults,
    PropsAccessor,
    ComponentSetupContext,
    ViewFn,
    SetupFn,
    DefineExpose,
    Ref,
    Exposed,
    ComponentRef,
    ComponentFactory,
    AnyComponentFactory,
    ComponentOptions,
} from './component-types.js';
export type { Model } from './component-types.js';
export {
    getCurrentInstance,
    setCurrentInstance,
    onMounted,
    onUnmounted,
    onCreated,
    onUpdated,
} from './component-lifecycle.js';

// Component registry for DevTools and debugging
const componentRegistry = new Map<Function, { name?: string; setup: SetupFn<any, any, any, any> }>();

/**
 * Get component metadata (for DevTools)
 */
export function getComponentMeta(factory: Function) {
    return componentRegistry.get(factory);
}

/**
 * Helper to create a proxy that tracks property access
 */
export function createPropsProxy<T extends Record<string, any>>(target: T, onAccess?: (key: string) => void): T {
    return new Proxy(target, {
        get(obj, prop) {
            if (typeof prop === 'string' && onAccess) {
                onAccess(prop);
            }
            return obj[prop as keyof T];
        }
    });
}

// Types needed only by the component() function below
type ExtractExposed<T> = "__exposed" extends keyof T
    ? (NonNullable<T["__exposed"]> extends { __type: infer E } ? E : void)
    : void;
type ExtractSlots<T> = T extends { __slots?: infer S } ? S : {};
type StripInternalMarkers<T> = {
    [K in keyof T as K extends "__exposed" | "__slots" | "__models" | "__modelBindings" ? never
        : K extends `model:${string}` ? never
        : K extends `update:${string}` ? never
        : K]: T[K];
};

/**
 * Define a component. Returns a JSX factory function.
 * 
 * @param setup - Setup function that receives context and returns a render function
 * @param options - Optional configuration (e.g., name for DevTools)
 * 
 * @example
 * ```tsx
 * type CardProps = DefineProp<"title", string> & DefineSlot<"header">;
 * 
 * export const Card = component<CardProps>((ctx) => {
 *     const { title } = ctx.props;
 *     const { slots } = ctx;
 *     
 *     return () => (
 *         <div class="card">
 *             {slots.header?.() ?? <h2>{title}</h2>}
 *             {slots.default()}
 *         </div>
 *     );
 * });
 * ```
 */
export function component<
    TCombined extends Record<string, any> = {},
    TRef = ExtractExposed<TCombined>,
    TSlots = ExtractSlots<TCombined>
>(
    setup: (ctx: ComponentSetupContext<PlatformElement, StripInternalMarkers<TCombined>, TCombined, TRef, TSlots>) => ViewFn | Promise<ViewFn>,
    options?: ComponentOptions
): ComponentFactory<TCombined, TRef, TSlots> {
    // Create the factory function - when called in JSX, it returns itself as a marker
    // The renderer will detect __setup and handle it as a component
    const factory = function (props: any) {
        // Return a VNode-like structure that the renderer can detect
        return {
            type: factory,
            props: props || {},
            key: props?.key || null,
            children: [],
            dom: null
        };
    } as unknown as ComponentFactory<TCombined, TRef, TSlots>;

    factory.__setup = setup as SetupFn<StripInternalMarkers<TCombined>, TCombined, TRef, TSlots>;
    factory.__name = options?.name;
    factory.__props = null as any;
    factory.__events = null as any;
    factory.__ref = null as any;
    factory.__slots = null as any;

    // Register in component registry for DevTools
    componentRegistry.set(factory, { name: options?.name, setup: setup as unknown as SetupFn<any, any, any, any> });

    // Notify plugins
    getComponentPlugins().forEach(p => p.onDefine?.(options?.name, factory, setup as unknown as SetupFn<any, any, any, any>));

    return factory;
}
