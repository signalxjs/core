/**
 * Directive runtime for DOM (element-level use:* directives)
 *
 * Handles the built-in directive registry, directive lifecycle hooks
 * (created, mounted, updated, unmounted), and event handler cleanup.
 */

import { isDirective, type DirectiveDefinition } from '@sigx/runtime-core';
import type { AppContext } from '@sigx/runtime-core';

/**
 * A directive definition narrowed to DOM elements.
 * Use this type when defining directives for the DOM renderer.
 *
 * @example
 * ```ts
 * import { defineDirective, type DOMDirective } from 'sigx';
 *
 * const tooltip = defineDirective<string, HTMLElement>({
 *     mounted(el, { value }) {
 *         el.title = value; // el is HTMLElement, fully typed
 *     }
 * });
 * ```
 */
export type DOMDirective<T = any> = DirectiveDefinition<T, HTMLElement>;

/**
 * Registry of built-in directives by name.
 * When a `use:<name>` prop receives a plain value (not a DirectiveDefinition),
 * the runtime looks up the directive by name here.
 * @internal
 */
const builtInDirectives = new Map<string, DirectiveDefinition>();

/**
 * Register a built-in directive so it can be used with the shorthand syntax:
 * `<div use:show={value}>` instead of `<div use:show={[show, value]}>`.
 * @internal
 */
export function registerBuiltInDirective(name: string, def: DirectiveDefinition): void {
    builtInDirectives.set(name, def);
}

/**
 * Look up a registered built-in directive by name.
 * Used by SSR renderer to resolve `use:<name>={value}` shorthand.
 * @internal
 */
export function resolveBuiltInDirective(name: string): DirectiveDefinition | undefined {
    return builtInDirectives.get(name);
}

/**
 * Symbol key to store directive state on DOM elements.
 * @internal
 */
const DIRECTIVE_STATE = Symbol.for('sigx.directives');

/**
 * Per-directive state stored on a DOM element.
 * @internal
 */
interface DirectiveState {
    def: DirectiveDefinition;
    value: any;
    cleanup?: () => void;
}

/**
 * Get or create the directive state map on a DOM element.
 * @internal
 */
function getDirectiveMap(el: Element): Map<string, DirectiveState> {
    let map = (el as any)[DIRECTIVE_STATE] as Map<string, DirectiveState> | undefined;
    if (!map) {
        map = new Map();
        (el as any)[DIRECTIVE_STATE] = map;
    }
    return map;
}

/**
 * Process a `use:*` prop in patchProp.
 * Handles directive created and updated lifecycle hooks.
 * @internal
 */
export function patchDirective(el: Element, name: string, prevValue: any, nextValue: any, appContext: AppContext | null): void {
    const dirMap = getDirectiveMap(el);

    if (nextValue == null) {
        // Directive removed — unmounted will be called via onElementUnmounted
        dirMap.delete(name);
        return;
    }

    // Extract directive definition and binding value from the prop value:
    // - use:name={directiveDef}           → def=directiveDef, value=undefined
    // - use:name={[directiveDef, value]}  → def=directiveDef[0], value=directiveDef[1]
    let def: DirectiveDefinition;
    let value: any;

    if (isDirective(nextValue)) {
        def = nextValue;
        value = undefined;
    } else if (
        Array.isArray(nextValue) &&
        nextValue.length >= 1 &&
        isDirective(nextValue[0])
    ) {
        def = nextValue[0];
        value = nextValue[1];
    } else {
        // Not an explicit directive — try to resolve by name:
        // 1. Built-in directives (always available, e.g., 'show')
        // 2. App-registered custom directives (via app.directive())
        const builtIn = builtInDirectives.get(name);
        if (builtIn) {
            def = builtIn;
            value = nextValue;
        } else {
            const custom = appContext?.directives.get(name);
            if (custom) {
                def = custom;
                value = nextValue;
            } else {
                console.warn(
                    `[sigx] Directive "use:${name}" could not be resolved. ` +
                    `Make sure to register it via app.directive('${name}', definition) or pass a directive definition directly.`
                );
                return;
            }
        }
    }

    const existing = dirMap.get(name);

    if (!existing) {
        // First time — call created hook
        const state: DirectiveState = { def, value };
        dirMap.set(name, state);

        if (def.created) {
            def.created(el, { value });
        }
    } else {
        // Update — call updated hook
        const oldValue = existing.value;
        existing.def = def;
        existing.value = value;

        if (def.updated && value !== oldValue) {
            def.updated(el, { value, oldValue });
        }
    }
}

/**
 * Called after an element is inserted into the DOM.
 * Invokes `mounted` hooks for all directives on the element.
 * @internal
 */
export function onElementMounted(el: Element): void {
    const map = (el as any)[DIRECTIVE_STATE] as Map<string, DirectiveState> | undefined;
    if (!map) return;

    for (const [, state] of map) {
        if (state.def.mounted) {
            state.def.mounted(el, { value: state.value });
        }
    }
}

/**
 * Called before an element is removed from the DOM.
 * Invokes `unmounted` hooks for all directives on the element.
 * @internal
 */
export function onElementUnmounted(el: Element): void {
    // Clean up directive state
    const map = (el as any)[DIRECTIVE_STATE] as Map<string, DirectiveState> | undefined;
    if (map) {
        for (const [, state] of map) {
            if (state.def.unmounted) {
                state.def.unmounted(el, { value: state.value });
            }
            if (state.cleanup) {
                state.cleanup();
            }
        }
        map.clear();
        delete (el as any)[DIRECTIVE_STATE];
    }

    // Clean up event handlers to prevent memory leaks
    const handlersKey = '__sigx_event_handlers';
    const handlers = (el as any)[handlersKey] as Map<string, EventListener> | undefined;
    if (handlers) {
        for (const [eventName, handler] of handlers) {
            el.removeEventListener(eventName, handler);
        }
        handlers.clear();
        delete (el as any)[handlersKey];
    }
}
