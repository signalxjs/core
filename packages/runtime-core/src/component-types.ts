/**
 * Component type definitions.
 *
 * Pure type definitions for the component system including the Define namespace,
 * prop/event/slot/model types, ComponentSetupContext, and ComponentFactory.
 */

import type { JSXElement } from './jsx-runtime.js';
import type { Model as ModelType } from './model.js';
import { signal } from '@sigx/reactivity';

/**
 * Extension point for additional component attributes.
 * Use module augmentation to add attributes to all components:
 * 
 * @example
 * ```ts
 * // In @sigx/server-renderer
 * declare module '@sigx/runtime-core' {
 *     interface ComponentAttributeExtensions {
 *         'client:load'?: boolean;
 *         'client:visible'?: boolean;
 *         'client:idle'?: boolean;
 *     }
 * }
 * ```
 */
export interface ComponentAttributeExtensions {
    // Attributes are added here via module augmentation
}

/**
 * Namespace for component definition types.
 * Provides a discoverable API for defining props, events, models, slots, and exposed APIs.
 *
 * @example
 * ```tsx
 * import { component, type Define } from 'sigx';
 *
 * type ButtonProps =
 *     & Define.Prop<'variant', 'primary' | 'secondary'>
 *     & Define.Prop<'disabled', boolean>
 *     & Define.Event<'click', MouseEvent>
 *     & Define.Slot<'default'>;
 *
 * export const Button = component<ButtonProps>(({ props, slots, emit }) => {
 *     return () => <button>{slots.default?.()}</button>;
 * });
 * ```
 */
export namespace Define {
    /**
     * Define a single prop with type, required/optional status
     */
    export type Prop<TName extends string, TType, Required extends boolean = false> = Required extends false
        ? { [K in TName]?: TType }
        : { [K in TName]: TType };

    /**
     * Define a single custom event with its detail type
     */
    export type Event<TName extends string, TDetail = void> = {
        [K in TName]?: EventDefinition<TDetail>;
    };

    /**
     * Define a 2-way bound model.
     *
     * Default form: Model<T> → props.model: Model<T>
     * Named form: Model<"name", T> → props.name: Model<T>
     *
     * @example
     * ```tsx
     * type InputProps = Define.Model<string> & Define.Prop<'placeholder', string>;
     * ```
     */
    export type Model<TNameOrType, TType = void> = TType extends void
        ? {
            model?: ModelType<TNameOrType>;
            /** @internal Marker for JSX to accept binding tuples */
            __modelBindings?: { model: TNameOrType };
          }
          & Define.Event<"update:modelValue", TNameOrType>
        : TNameOrType extends string
        ? {
            [K in TNameOrType]?: ModelType<TType>;
          }
          & {
            /** @internal Marker for JSX to accept binding tuples */
            __modelBindings?: { [K in TNameOrType]: TType };
          }
          & Define.Event<`update:${TNameOrType}`, TType>
        : never;

    /**
     * Define a slot with optional scoped props.
     *
     * @example
     * ```tsx
     * type Props = Define.Slot<'header'> & Define.Slot<'item', { item: T; index: number }>;
     * ```
     */
    export type Slot<TName extends string, TProps = void> = {
        __slots?: {
            [K in TName]: TProps extends void
            ? () => JSXElement | JSXElement[] | null
            : (props: TProps) => JSXElement | JSXElement[] | null
        }
    };

    /**
     * Define the public API exposed by a component via `expose()`.
     *
     * @example
     * ```tsx
     * type Props = Define.Expose<{ reset: () => void; getValue: () => string }>;
     * ```
     */
    export type Expose<T> = {
        __exposed?: { __type: T };
    };
}

/**
 * Define a single prop with type, required/optional status
 * @deprecated Use `Define.Prop` instead
 */
export type DefineProp<TName extends string, TType, Required extends boolean = false> = Define.Prop<TName, TType, Required>;

/**
 * Model binding tuple type - [stateObject, key] for forwarding
 * The state object can be a Signal or any object with the given key
 */
export type ModelBinding<_T> = [object, string];

/**
 * Re-export Model type for convenience
 */
export type { ModelType as Model };

/**
 * Define a 2-way bound model.
 * 
 * The component receives a Model<T> object with:
 *   - `.value` - Get or set the current value
 *   - `.binding` - The underlying binding for forwarding
 * 
 * Default form: DefineModel<T>
 *   - props.model: Model<T> (read/write/forward)
 *   - props.model.value to read/write
 *   - <Child model={props.model} /> to forward
 * 
 * Named form: DefineModel<"name", T>
 *   - props.name: Model<T> (read/write/forward)
 *   - props.name.value to read/write
 *   - <Child model={props.name} /> to forward
 * 
 * Callers use: model={() => state.prop} or model:name={() => state.prop}
 * 
 * @example
 * ```tsx
 * interface InputProps extends DefineModel<string> {
 *     placeholder?: string;
 * }
 * 
 * const Input = component<InputProps>(({ props }) => {
 *     // Read
 *     console.log(props.model.value);
 *     
 *     // Write
 *     props.model.value = "new value";
 *     
 *     // Forward
 *     <Child model={props.model} />
 * });
 * ```
 * @deprecated Use `Define.Model` instead
 */
export type DefineModel<TNameOrType, TType = void> = Define.Model<TNameOrType, TType>;

/**
 * Extract model binding definitions from a component props type.
 * Used at JSX level to allow binding tuples for model props.
 */
type ExtractModelBindings<T> = T extends { __modelBindings?: infer M } ? NonNullable<M> : {};

/**
 * Map model keys to their JSX prop names.
 * - "model" stays as "model" (default model)
 * - Other names become "model:name" (named models)
 */
type ModelPropName<K extends string> = K extends "model" ? "model" : `model:${K}`;

/**
 * Transform Model<T> props to also accept binding syntax at JSX level.
 * This allows: model={[state, "value"]} or model={props.model}
 * For named models: model:title={[state, "title"]} or model:title={() => state.title}
 */
type ExternalModelProps<T> = {
    [K in keyof ExtractModelBindings<T> as K extends string ? ModelPropName<K> : never]?: 
        | ModelType<ExtractModelBindings<T>[K]>  // Forward Model<T>
        | ModelBinding<ExtractModelBindings<T>[K]>  // Binding tuple
        | (() => ExtractModelBindings<T>[K]);  // Getter function
};

export type EventDefinition<T> = { __eventDetail: T };

/**
 * Define a single custom event with its detail type
 * @deprecated Use `Define.Event` instead
 */
export type DefineEvent<TName extends string, TDetail = void> = Define.Event<TName, TDetail>;

/**
 * Define a slot with optional scoped props.
 * - DefineSlot<"header"> - a simple slot named "header"
 * - DefineSlot<"item", { item: T; index: number }> - a scoped slot with props
 * @deprecated Use `Define.Slot` instead
 */
export type DefineSlot<TName extends string, TProps = void> = Define.Slot<TName, TProps>;

/**
 * Extract slot definitions from a combined type
 */
type ExtractSlots<T> = T extends { __slots?: infer S } ? S : {};

/**
 * Default slot function type
 */
type DefaultSlot = () => JSXElement[];

/**
 * Slots object passed to components - always has default, plus any declared slots
 */
export type SlotsObject<TSlots = {}> = {
    default: DefaultSlot;
} & TSlots;

/**
 * Extract event names from an event definition
 */
type EventNames<TEvents> = {
    [K in keyof TEvents]: TEvents[K] extends EventDefinition<any> | undefined ? K : never
}[keyof TEvents] & string;

/**
 * Extract event detail type for a specific event name
 */
type EventDetail<TEvents, TName extends EventNames<TEvents>> = TEvents extends { [K in TName]?: EventDefinition<infer TDetail> }
    ? TDetail
    : never;

/**
 * Typed emit function for dispatching custom events
 */
export type EmitFn<TEvents extends Record<string, any>> = <TName extends EventNames<TEvents>>(
    eventName: TName,
    ...args: EventDetail<TEvents, TName> extends void ? [] : [detail: EventDetail<TEvents, TName>]
) => void;

/**
 * Capitalize the first letter of a string
 */
type Capitalize<S extends string> = S extends `${infer First}${infer Rest}`
    ? `${Uppercase<First>}${Rest}`
    : S;

/**
 * Convert events to event handler props (on{EventName})
 */
type EventHandlers<TEvents extends Record<string, any>> = {
    [K in keyof TEvents as TEvents[K] extends EventDefinition<any> | undefined
    ? `on${Capitalize<string & K>}`
    : never
    ]?: (detail: TEvents[K] extends EventDefinition<infer D> | undefined ? D : never) => void;
};

/**
 * Platform registry - platforms add their element type here via declaration merging
 */
export interface PlatformTypes {
    // Platforms add: element: HTMLElement (or other element type)
}

/** Resolves to the platform's element type, or 'any' if not defined */
export type PlatformElement = PlatformTypes extends { element: infer E } ? E : any;

/**
 * Base mount context - platforms can extend this via declaration merging
 */
export interface MountContext<TElement = PlatformElement> {
    el: TElement;
}

/**
 * Base setup context - platforms can extend this via declaration merging
 */
export interface SetupContext {
    // Platforms add properties here via module augmentation
}

/**
 * Extract keys from T where undefined is assignable to the value (optional props)
 */
type _OptionalKeys<T> = { [K in keyof T]: undefined extends T[K] ? K : never }[keyof T];

/**
 * Type for defaults object - REQUIRES all optional keys to be provided.
 * Required props (where undefined is not assignable) get type 'never' to prevent setting them.
 * This ensures you don't forget to add a default when adding a new optional prop.
 */
type _DefaultsFor<TProps> = {
    [K in keyof TProps as undefined extends TProps[K] ? K : never]-?: NonNullable<TProps[K]>;
};

/**
 * Props type after defaults are applied - all props become required (non-undefined)
 */
export type PropsWithDefaults<TProps, D> = {
    readonly [K in keyof TProps]-?: K extends keyof D ? NonNullable<TProps[K]> : TProps[K];
};

/**
 * Props accessor - a reactive proxy for component props.
 * Use destructuring with defaults for optional props.
 * 
 * @example
 * ```tsx
 * // Destructure with defaults
 * const { variant = 'primary', size = 'md' } = ctx.props;
 * return () => <button class={variant}>...</button>
 * 
 * // Or spread to forward all props
 * return () => <ChildComponent {...ctx.props} />
 * ```
 */
export type PropsAccessor<TProps> = {
    readonly [K in keyof TProps]: TProps[K];
};

export interface ComponentSetupContext<
    TElement = PlatformElement,
    TProps extends Record<string, any> = {},
    TEvents extends Record<string, any> = {},
    TRef = any,
    TSlots = {}
> extends SetupContext {
    el: TElement;
    signal: typeof signal;
    /**
     * Component props - includes regular props and Model<T> objects.
     * 
     * Models are accessed via props: props.model.value, props.title.value
     * 
     * @example
     * ```tsx
     * // Read model
     * const value = props.model.value;
     * 
     * // Write model
     * props.model.value = "new value";
     * 
     * // Forward to child
     * <Child model={props.model} />
     * 
     * // Forward via context
     * defineProvide(ctx, () => props.model);
     * ```
     */
    props: PropsAccessor<TProps>;
    slots: SlotsObject<TSlots>;
    emit: EmitFn<TEvents>;
    parent: ComponentSetupContext | null;
    onMounted(fn: (ctx: MountContext<TElement>) => void): void;
    onUnmounted(fn: (ctx: MountContext<TElement>) => void): void;
    onCreated(fn: () => void): void;
    onUpdated(fn: () => void): void;
    expose(exposed: TRef): void;
    /**
     * The current render function. Can be replaced directly for HMR.
     * @internal Used by HMR - set this, then call update()
     */
    renderFn: ViewFn | null;
    /**
     * Force the component to re-render using the current renderFn.
     * For HMR: first set ctx.renderFn to the new render function, then call update().
     */
    update(): void;
}

export type ViewFn = () => JSXElement | JSXElement[] | undefined;

/**
 * Type for component setup functions.
 * Includes Props, Events, Ref, and Slots generics to preserve type information.
 * Can be sync or async - async setup is awaited on server, runs sync on client hydration.
 */
export type SetupFn<
    TProps extends Record<string, any> = {},
    TEvents extends Record<string, any> = {},
    TRef = any,
    TSlots = {}
> = (ctx: ComponentSetupContext<PlatformElement, TProps, TEvents, TRef, TSlots>) => ViewFn | Promise<ViewFn>;

/**
 * @deprecated Use `Define.Expose` instead
 */
export type DefineExpose<T> = Define.Expose<T>;

type ExtractExposed<T> = "__exposed" extends keyof T
    ? (NonNullable<T["__exposed"]> extends { __type: infer E } ? E : void)
    : void;

export type Ref<T> = { current: T | null } | ((instance: T | null) => void);

/**
 * Extract the exposed API type from a component.
 * Use this to type variables that will hold a component's exposed interface.
 * 
 * @example
 * ```tsx
 * let api: Exposed<typeof MyComponent>;
 * <MyComponent ref={r => api = r!} />
 * api.exposedMethod();
 * ```
 */
export type Exposed<T extends { __ref: any }> = T["__ref"];

/**
 * Extract the ref (exposed) type from a component (includes function ref option).
 * 
 * @example
 * ```tsx
 * const myRef = { current: null } as ComponentRef<typeof MyComponent>;
 * ```
 */
export type ComponentRef<T extends { __ref: any }> = Ref<T["__ref"]>;


/**
 * Strip internal type markers from component props for setup context (internal use).
 * Preserves model keys so components can access props.model, props.title, etc.
 *
 * Strips:
 * - Internal markers: __exposed, __slots, __models, __modelBindings
 * - JSX model:name syntax markers
 * - Event markers (update:*)
 */
type StripInternalMarkers<T> = {
    [K in keyof T as K extends "__exposed" | "__slots" | "__models" | "__modelBindings" ? never
        : K extends `model:${string}` ? never  // Strip JSX model:name syntax marker
        : K extends `update:${string}` ? never
        : K]: T[K];
};

/**
 * Strip props for JSX external signature.
 * Same as StripInternalMarkers but also strips model keys so ExternalModelProps
 * is the sole source (avoiding intersection conflicts between Model<T> and widened union).
 */
type StripForJSX<T> = {
    [K in keyof T as K extends "__exposed" | "__slots" | "__models" | "__modelBindings" ? never
        : K extends `model:${string}` ? never
        : K extends `update:${string}` ? never
        : K extends keyof ExtractModelBindings<T> ? never  // Strip model keys - ExternalModelProps provides them
        : K]: T[K];
};

/**
 * Component options (optional second param)
 */
export interface ComponentOptions {
    /** Component name for DevTools debugging */
    name?: string;
}

/**
 * Slot props type - converts slot definitions to a slots prop object
 */
type SlotProps<TSlots> = TSlots extends Record<string, any>
    ? { slots?: Partial<TSlots> }
    : {};

/**
 * Sync binding type - used at JSX level to enable two-way binding
 * The JSX runtime transforms sync into value + onUpdate:value
 */
type SyncBinding<T> = [object, string] | (() => T);

/**
 * Sync props - if the component has a 'value' prop, allow 'sync' binding
 */
type SyncProps<TCombined> = 'value' extends keyof TCombined
    ? { sync?: SyncBinding<TCombined['value']> }
    : {};

// Return type for component - the function IS the component
export type ComponentFactory<TCombined extends Record<string, any>, TRef, TSlots> = ((props: StripForJSX<Omit<TCombined, EventNames<TCombined>>> & EventHandlers<TCombined> & SlotProps<TSlots> & SyncProps<TCombined> & ExternalModelProps<TCombined> & JSX.IntrinsicAttributes & ComponentAttributeExtensions & {
    ref?: Ref<TRef>;
    children?: any;
}) => JSXElement) & {
    /** @internal Setup function for the renderer */
    __setup: SetupFn<StripInternalMarkers<TCombined>, TCombined, TRef, TSlots>;
    /** @internal Component name for debugging */
    __name?: string;
    /** @internal Stable island identity based on file path (injected by sigxIslandsPlugin) */
    __islandId?: string;
    /** @internal Type brand for props */
    __props: StripInternalMarkers<TCombined>;
    /** @internal Type brand for events */
    __events: TCombined;
    /** @internal Type brand for ref */
    __ref: TRef;
    /** @internal Type brand for slots */
    __slots: TSlots;
};

/**
 * Structural constraint type for generic functions that accept any ComponentFactory.
 *
 * Uses only the covariant brand properties (not the function signature) to avoid
 * contravariance issues with `strictFunctionTypes`. Any `ComponentFactory<T, R, S>`
 * satisfies this constraint regardless of its props type.
 *
 * @see ComponentFactory
 */
export type AnyComponentFactory = {
    (...args: any[]): any;
    __setup: SetupFn<any, any, any, any>;
    __props: any;
    __events: any;
    __ref: any;
    __slots: any;
};
