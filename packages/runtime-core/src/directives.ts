/**
 * Directive system for SignalX.
 *
 * Directives provide reusable element-level lifecycle hooks via the `use:name` prop syntax.
 * They can be registered globally via `app.directive()` or passed inline as imported values.
 *
 * @example
 * ```tsx
 * import { defineDirective } from 'sigx';
 *
 * const tooltip = defineDirective<string>({
 *     mounted(el, { value }) {
 *         el.title = value;
 *     },
 *     updated(el, { value }) {
 *         el.title = value;
 *     },
 *     unmounted(el) {
 *         el.title = '';
 *     }
 * });
 *
 * // Inline usage:
 * <div use:tooltip="Hello!">Hover me</div>
 *
 * // Or with explicit binding:
 * <div use:tooltip={[tooltip, "Hello!"]}>Hover me</div>
 * ```
 */

// ============================================================================
// Types
// ============================================================================

/**
 * The binding object passed to directive hooks.
 */
export interface DirectiveBinding<T = any> {
    /** The current value passed to the directive */
    value: T;
    /** The previous value (available in `updated` hook) */
    oldValue?: T;
}

/**
 * Extension interface for directive definitions.
 *
 * Other packages (e.g., `@sigx/server-renderer`) can augment this interface
 * to add hooks like `getSSRProps` via TypeScript module augmentation.
 *
 * @example
 * ```ts
 * // In @sigx/server-renderer
 * declare module '@sigx/runtime-core' {
 *     interface DirectiveDefinitionExtensions<T> {
 *         getSSRProps?(binding: DirectiveBinding<T>): Record<string, any> | void;
 *     }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unused-vars
export interface DirectiveDefinitionExtensions<T = any> {
    // Intentionally empty — filled via module augmentation by SSR and other packages
}

/**
 * A directive definition object with lifecycle hooks.
 *
 * All hooks are optional. Additional hooks (e.g., `getSSRProps`) may be
 * available when SSR packages augment `DirectiveDefinitionExtensions`.
 */
export interface DirectiveDefinition<T = any, El = any> extends DirectiveDefinitionExtensions<T> {
    /** Called after the element is created but before it is inserted into the DOM */
    created?(el: El, binding: DirectiveBinding<T>): void;
    /** Called after the element is inserted into the DOM */
    mounted?(el: El, binding: DirectiveBinding<T>): void;
    /** Called when the binding value changes */
    updated?(el: El, binding: DirectiveBinding<T>): void;
    /** Called before the element is removed from the DOM */
    unmounted?(el: El, binding: DirectiveBinding<T>): void;
}

/**
 * A resolved directive binding stored on a VNode.
 * Tuple of [definition, value].
 */
export type ResolvedDirective<T = any, El = any> = [DirectiveDefinition<T, El>, T];

/**
 * Marker symbol to identify directive definitions.
 * @internal
 */
export const __DIRECTIVE__ = Symbol.for('sigx.directive');

/**
 * Internal type for marked directive definitions.
 * @internal
 */
export interface MarkedDirectiveDefinition<T = any, El = any> extends DirectiveDefinition<T, El> {
    [__DIRECTIVE__]: true;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Define a directive. This is an identity function that marks the definition
 * for type inference and runtime identification.
 *
 * @example
 * ```ts
 * const highlight = defineDirective<string>({
 *     mounted(el, { value }) {
 *         el.style.backgroundColor = value;
 *     },
 *     updated(el, { value }) {
 *         el.style.backgroundColor = value;
 *     }
 * });
 * ```
 */
export function defineDirective<T = any, El = any>(definition: DirectiveDefinition<T, El>): DirectiveDefinition<T, El> {
    (definition as MarkedDirectiveDefinition<T, El>)[__DIRECTIVE__] = true;
    return definition;
}

/**
 * Check if a value is a directive definition.
 */
export function isDirective(value: any): value is DirectiveDefinition {
    return value != null && typeof value === 'object' && (value as any)[__DIRECTIVE__] === true;
}

// ============================================================================
// App-level Directive Registry
// ============================================================================
