// JSX runtime for @sigx/runtime-core

import { detectAccess, detectAccessDev, isComputed } from '@sigx/reactivity';
import { createModel, isModel, type Model } from './model.js';
import { runModelProcessors } from './platform.js';
import { isComponent } from './utils/is-component.js';

// Re-export platform types and functions
export { setPlatformModelProcessor, getPlatformModelProcessor, registerModelProcessor } from './platform.js';
export type { ModelProcessor } from './platform.js';
export { createModel, isModel, type Model } from './model.js';

export type VNode = {
    type: string | typeof Fragment | typeof Text | typeof Comment | Function;
    props: Record<string, any>;
    key: string | number | null;
    children: VNode[];
    dom: any | null;
    text?: string | number;
    parent?: VNode | null;
    cleanup?: () => void;
};

export type JSXChild = VNode | string | number | boolean | null | undefined | JSXChild[];
export type JSXChildren = JSXChild;
export type JSXElement = VNode | string | number | boolean | null;

interface JSXProps {
    children?: JSXChildren;
    [key: string]: any;
}

export const Fragment = Symbol.for('sigx.Fragment');
export const Text = Symbol.for('sigx.Text');
export const Comment = Symbol.for('sigx.Comment');

// Shared singletons to avoid per-call allocations.
// Not frozen — V8 optimizes regular objects/arrays better than frozen ones.
export const EMPTY_PROPS: Record<string, any> = {};
export const EMPTY_CHILDREN: VNode[] = [];

function createCommentVNode(): VNode {
    return { type: Comment, props: EMPTY_PROPS, key: null, children: EMPTY_CHILDREN, dom: null };
}

function createTextVNode(text: string | number): VNode {
    return { type: Text, props: EMPTY_PROPS, key: null, children: EMPTY_CHILDREN, dom: null, text };
}

function normalizeChildren(children: JSXChildren): VNode[] {
    if (children == null || children === false || children === true) {
        return [];
    }

    // Auto-unwrap computed signals
    if (isComputed(children)) {
        return normalizeChildren(children.value as JSXChild);
    }

    if (typeof children === 'string' || typeof children === 'number') {
        return [createTextVNode(children)];
    }

    if ((children as VNode).type) {
        return [children as VNode];
    }

    if (Array.isArray(children)) {
        // Use map (not flatMap) to preserve sibling positions.
        // Falsy items become Comment placeholders so positional diffing
        // doesn't shift sibling indices when conditionals toggle.
        return children.map(normalizeChild);
    }

    return [];
}

function normalizeChild(c: JSXChild): VNode {
    if (c == null || c === false || c === true) {
        return createCommentVNode();
    }
    if (typeof c === 'string' || typeof c === 'number') {
        return createTextVNode(c);
    }
    if (isComputed(c)) {
        return normalizeChildren(c.value as JSXChild)[0] ?? createCommentVNode();
    }
    if (Array.isArray(c)) {
        const nested = normalizeChildren(c);
        if (nested.length === 0) return createCommentVNode();
        if (nested.length === 1) return nested[0];
        return { type: Fragment, props: EMPTY_PROPS, key: null, children: nested, dom: null } as VNode;
    }
    if ((c as VNode).type) {
        return c as VNode;
    }
    return createCommentVNode();
}

// isComponent is imported from ./utils/is-component.js

/**
 * Detect the `[stateObj, key]` tuple a model getter reads. In development,
 * warns when the getter is a transformed expression (e.g. `() => state.x * 2`)
 * that would silently mis-bind, since two-way binding writes back to the last
 * property read. Production uses the lean {@link detectAccess} path.
 */
function detectModelBinding(selector: () => any): [any, string | symbol] | null {
    if (process.env.NODE_ENV !== 'production') {
        const { access, looksTransformed } = detectAccessDev(selector);
        if (access && looksTransformed) {
            console.warn(
                "[sigx] A `model` getter should read a signal property directly, " +
                "e.g. model={() => state.field}. The getter returned a value different " +
                "from the property it read (`" + String(access[1]) + "`), so writes will " +
                "go back to that property and won't match what the input shows. " +
                "Bind to a signal property or a writable computed instead."
            );
        }
        return access;
    }
    return detectAccess(selector);
}

/**
 * Create a JSX element - this is the core function called by TSX transpilation
 */
export function jsx(
    type: string | Function | typeof Fragment,
    props: JSXProps | null,
    key?: string
): JSXElement {
    const isComponentType = isComponent(type);

    // Fast path: skip props cloning when no model bindings need processing
    let needsModelProcessing = false;
    if (props) {
        for (const propKey in props) {
            if (propKey === 'model' || propKey.startsWith('model:')) {
                needsModelProcessing = true;
                break;
            }
        }
    }

    if (!needsModelProcessing) {
        // Fast path — no model bindings, avoid props clone entirely
        if (isComponentType) {
            const { children, ...rest } = (props || {});
            return {
                type: type as Function,
                props: { ...rest, children },
                key: key || rest.key || null,
                children: EMPTY_CHILDREN,
                dom: null
            };
        }

        if (typeof type === 'function' && (type as any) !== Fragment) {
            return (type as Function)(props);
        }

        const { children, ...rest } = (props || {});
        return {
            type: type as string | typeof Fragment,
            props: rest,
            key: key || rest.key || null,
            children: normalizeChildren(children),
            dom: null
        };
    }

    // Slow path: model bindings present, clone props for mutation
    const processedProps = { ...props };
    const models: Record<string, Model<any>> = {};

    // Handle model props (two-way binding)
    if (props) {
        for (const propKey in props) {
            if (propKey === "model") {
                let modelBinding = props[propKey];
                let tuple: [object, string] | null = null;
                let updateHandler: ((v: any) => void) | null = null;

                // Check if it's already a Model (forwarding)
                if (isModel(modelBinding)) {
                    const [obj, key, handler] = modelBinding.binding;
                    tuple = [obj, key];
                    updateHandler = handler;
                }
                // Convert getter function to tuple using detectAccess
                else if (typeof modelBinding === "function") {
                    const detected = detectModelBinding(modelBinding);
                    if (detected && typeof detected[1] === 'string') {
                        tuple = detected as [object, string];
                    }
                }
                // Direct tuple
                else if (Array.isArray(modelBinding) && modelBinding.length === 2 && typeof modelBinding[1] === 'string') {
                    tuple = modelBinding as [object, string];
                }

                if (tuple) {
                    const [stateObj, stateKey] = tuple;
                    let handled = false;

                    // Create update handler if not forwarding
                    if (!updateHandler) {
                        const existingHandler = processedProps["onUpdate:modelValue"];
                        updateHandler = (v: any) => {
                            const customHandler = (stateObj as any)[`onUpdate:${stateKey}`];
                            if (typeof customHandler === "function") {
                                customHandler(v);
                            } else {
                                (stateObj as any)[stateKey] = v;
                            }
                            if (existingHandler) existingHandler(v);
                        };
                    }

                    // Let user/platform processors handle intrinsic element model
                    // (e.g., custom elements, then DOM checkbox/radio/select)
                    if (typeof type === "string") {
                        handled = runModelProcessors(type, processedProps, tuple, props);
                        // Surface model modifiers (trim/lazy/number/debounce) to the
                        // platform by tagging the handler the processor produced.
                        if (handled && props.modelModifiers) {
                            const h = processedProps["onUpdate:modelValue"];
                            if (typeof h === "function") (h as any).__sigx_modelModifiers = props.modelModifiers;
                        }
                    }

                    // For components: create Model<T> object
                    if (isComponentType) {
                        models.model = createModel(tuple, updateHandler);
                        // Keep onUpdate handler for backward compatibility
                        processedProps["onUpdate:modelValue"] = updateHandler;
                    } else if (!handled) {
                        // Generic fallback for intrinsic elements
                        processedProps.modelValue = (stateObj as Record<string, any>)[stateKey];
                        processedProps["onUpdate:modelValue"] = updateHandler;
                    }
                    delete processedProps.model;
                }
            } else if (propKey.startsWith("model:")) {
                let modelBinding = props[propKey];
                const name = propKey.slice(6); // "model:title" → "title"
                let tuple: [object, string] | null = null;
                let updateHandler: ((v: any) => void) | null = null;

                // Check if it's already a Model (forwarding)
                if (isModel(modelBinding)) {
                    const [obj, key, handler] = modelBinding.binding;
                    tuple = [obj, key];
                    updateHandler = handler;
                }
                // Handle function form: model:propName={() => state.prop}
                else if (typeof modelBinding === "function") {
                    const detected = detectModelBinding(modelBinding);
                    if (detected && typeof detected[1] === 'string') {
                        tuple = detected as [object, string];
                    }
                }
                // Direct tuple
                else if (Array.isArray(modelBinding) && modelBinding.length === 2 && typeof modelBinding[1] === 'string') {
                    tuple = modelBinding as [object, string];
                }

                if (tuple) {
                    const [stateObj, stateKey] = tuple;
                    const eventName = `onUpdate:${name}`;

                    // Create update handler if not forwarding
                    if (!updateHandler) {
                        const existingHandler = processedProps[eventName];
                        updateHandler = (v: any) => {
                            const customHandler = (stateObj as any)[`onUpdate:${stateKey}`];
                            if (typeof customHandler === "function") {
                                customHandler(v);
                            } else {
                                (stateObj as any)[stateKey] = v;
                            }
                            if (existingHandler) existingHandler(v);
                        };
                    }

                    // For components: create Model<T> object with the prop name
                    if (isComponentType) {
                        models[name] = createModel(tuple, updateHandler);
                        // Keep onUpdate handler for backward compatibility
                        processedProps[eventName] = updateHandler;
                    } else {
                        // For intrinsic elements: let user/platform processors
                        // handle the binding (e.g. native checkbox/select) just
                        // like the default `model`; fall back to a direct prop write.
                        const handled =
                            typeof type === "string" &&
                            runModelProcessors(type, processedProps, tuple, props);
                        if (!handled) {
                            processedProps[name] = (stateObj as Record<string, any>)[stateKey];
                            processedProps[eventName] = updateHandler;
                        }
                    }
                    delete processedProps[propKey];
                }
            }
        }
    }

    // Attach models to props for component instantiation
    if (Object.keys(models).length > 0) {
        processedProps.$models = models;
    }

    // Handle sigx components - create a VNode with the component factory as type
    // The renderer will detect __setup and call mountComponent
    if (isComponent(type)) {
        const { children, ...rest } = processedProps;
        return {
            type: type as Function,
            props: { ...rest, children },
            key: key || rest.key || null,
            children: [], // Children are passed via props for components
            dom: null
        };
    }

    // Handle plain function components (not sigx component)
    if (typeof type === 'function' && (type as any) !== Fragment) {
        return (type as Function)(processedProps);
    }

    const { children, ...rest } = processedProps;

    const vnode: VNode = {
        type: type as string | typeof Fragment,
        props: rest,
        key: key || rest.key || null,
        children: normalizeChildren(children),
        dom: null
    };

    return vnode;
}

/**
 * JSX Factory for fragments
 */
export function jsxs(type: string | typeof Fragment | Function, props?: Record<string, unknown>, key?: string) {
    return jsx(type, props as Record<string, any>, key);
}

export const jsxDEV = jsx;
