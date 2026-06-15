// JSX runtime for @sigx/runtime-core

import { detectAccess, detectAccessDev, isComputed } from '@sigx/reactivity';
import { createModel, isModel, type Model } from './model.js';
import { getModelProcessors } from './platform.js';
import { getModelModifier, wrapModelWriteBack } from './model-modifiers.js';
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
 * Dev-only warning when a value-transform modifier (`trim`/`number`/custom) is a
 * structural no-op for the bound value: on a checkbox/radio (boolean/array value),
 * or where the initial bound value is a non-string, non-numeric type. Conservative
 * to avoid false positives — an initially-empty (`''`/`null`/`undefined`) string
 * field never warns. Mirrors the {@link detectModelBinding} dev-warning style.
 */
function warnNoOpModifiers(
    type: string,
    originalProps: Record<string, any>,
    stateObj: object,
    stateKey: string,
    modifiers: Record<string, any>,
): void {
    let hasTransform = false;
    for (const name in modifiers) {
        const opt = modifiers[name];
        if (opt === false || opt == null) continue;
        if (getModelModifier(name)?.transform) { hasTransform = true; break; }
    }
    if (!hasTransform) return;

    // Class 1: value transform on a toggle — value is boolean/array, never a string.
    if (type === 'input' && (originalProps.type === 'checkbox' || originalProps.type === 'radio')) {
        console.warn(
            "[sigx] `modelModifiers` value transforms (e.g. `trim`/`number`) are no-ops on " +
            `<input type="${originalProps.type}">: the bound value is a boolean/array, not a ` +
            "string. Remove them, or bind the modifier to a text/number input."
        );
        return;
    }

    // Class 2: built-in trim/number where the initial value clearly isn't a string.
    // Skip null/undefined/'' (legitimate empty string targets) and numbers under `number`.
    if (modifiers.trim || modifiers.number) {
        const initial = (stateObj as Record<string, any>)[stateKey];
        if (
            initial != null && initial !== '' &&
            typeof initial !== 'string' &&
            !(modifiers.number && typeof initial === 'number')
        ) {
            console.warn(
                "[sigx] `modelModifiers` `trim`/`number` expect a string value, but the bound " +
                `value is of type \`${typeof initial}\`; the modifier is skipped at write-back.`
            );
        }
    }
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
        // Share EMPTY_PROPS for prop-less elements so the renderer's
        // `oldProps !== newProps` patch guard can skip the prop diff for
        // bare wrappers entirely. Nothing in the runtime mutates element
        // vnode props.
        let hasProps = false;
        for (const _k in rest) {
            hasProps = true;
            break;
        }
        return {
            type: type as string | typeof Fragment,
            props: hasProps ? rest : EMPTY_PROPS,
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

                    // Let registered processors handle intrinsic element models:
                    // extension processors first, then the platform processor
                    // (e.g., DOM checkbox/radio). First returning true wins.
                    if (typeof type === "string") {
                        for (const processor of getModelProcessors()) {
                            if (processor(type, processedProps, tuple, props)) {
                                handled = true;
                                break;
                            }
                        }
                        if (process.env.NODE_ENV !== 'production' && props.modelModifiers) {
                            warnNoOpModifiers(type, props, stateObj, stateKey, props.modelModifiers);
                        }
                    }

                    // For components: create Model<T> object
                    if (isComponentType) {
                        // Wrap once so the Model setter and the onUpdate handler apply
                        // value-transforms consistently (timing is inert for components).
                        const handler = props.modelModifiers
                            ? wrapModelWriteBack(updateHandler, props.modelModifiers)
                            : updateHandler;
                        models.model = createModel(tuple, handler);
                        // Keep onUpdate handler for backward compatibility
                        processedProps["onUpdate:modelValue"] = handler;
                    } else {
                        if (!handled) {
                            // Generic fallback for intrinsic elements
                            processedProps.modelValue = (stateObj as Record<string, any>)[stateKey];
                            processedProps["onUpdate:modelValue"] = updateHandler;
                        }
                        // Apply modifiers uniformly: wrap whatever write-back handler
                        // settled on onUpdate:modelValue — the processor's (handled),
                        // or the generic fallback's — so value-transforms run in core
                        // and timing hints reach the platform, on every path.
                        if (props.modelModifiers) {
                            const h = processedProps["onUpdate:modelValue"];
                            if (typeof h === "function") {
                                processedProps["onUpdate:modelValue"] = wrapModelWriteBack(h, props.modelModifiers);
                            }
                        }
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

                    if (process.env.NODE_ENV !== 'production' && typeof type === "string" && props.modelModifiers) {
                        warnNoOpModifiers(type, props, stateObj, stateKey, props.modelModifiers);
                    }

                    // Apply modifiers uniformly on the named path too (closes the
                    // model:name coverage gap): wrap the write-back handler so
                    // value-transforms run in core for components and intrinsics alike.
                    const handler = props.modelModifiers
                        ? wrapModelWriteBack(updateHandler, props.modelModifiers)
                        : updateHandler;

                    // For components: create Model<T> object with the prop name
                    if (isComponentType) {
                        models[name] = createModel(tuple, handler);
                        // Keep onUpdate handler for backward compatibility
                        processedProps[eventName] = handler;
                    } else {
                        // For intrinsic elements: put value directly on props
                        processedProps[name] = (stateObj as Record<string, any>)[stateKey];
                        processedProps[eventName] = handler;
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
