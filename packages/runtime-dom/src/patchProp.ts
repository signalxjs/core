/**
 * DOM property patching logic.
 *
 * Handles setting/updating all element properties including styles,
 * event handlers, className, SVG attributes, form element values,
 * and custom property bindings.
 */

import { resolveTiming, createDebounceScheduler, getHandlerModifiers, handleComponentError } from '@sigx/runtime-core/internals';
import type { AppContext } from '@sigx/runtime-core';

/**
 * Stable per-event listener wrapper: re-renders swap `invoker.value`
 * instead of removing and re-adding the DOM listener for every fresh
 * inline handler closure.
 */
interface EventInvoker extends EventListener {
    /** Current user handler; receives the Event, or `detail` for CustomEvents. */
    value: (eventOrDetail: unknown) => void;
    /** App context captured at patch time — routes handler throws to app onError. */
    appContext?: AppContext | null;
}

/**
 * Route a user event-handler throw through the app error path. Event
 * handlers have no owning component at the DOM layer (instance is null), so
 * only the app-level `onError` sees them — never an errorScope. Unhandled
 * ⇒ synchronous rethrow, preserving the browser's uncaught-error behavior.
 */
function routeEventError(e: unknown, appContext: AppContext | null | undefined): void {
    const err = e instanceof Error ? e : new Error(String(e));
    if (handleComponentError(appContext ?? null, err, null, 'event handler') !== true) {
        throw e;
    }
}

export function patchProp(dom: Element, key: string, prevValue: any, nextValue: any, isSVG?: boolean, appContext?: AppContext | null) {
    // Guard: skip if dom is null (shouldn't happen but protects against edge cases)
    if (!dom) return;

    // Detect SVG context: either passed explicitly or detect from element type
    // This ensures SVG attributes are handled correctly even if renderer doesn't pass isSVG
    const isSvgElement = isSVG ?? (dom instanceof SVGElement);

    // This is a simplified version of updateProps that handles a single prop
    // But the original updateProps handled all props at once.
    // The renderer calls patchProp for each key.

    // Logic adapted from original updateProps
    const oldValue = prevValue;
    const newValue = nextValue;

    if (key === 'children' || key === 'key' || key === 'ref') return;

    // `modelModifiers` configures the model directive (trim/lazy/number/debounce);
    // it is read off the model handler in the onUpdate:modelValue branch below and
    // is never rendered to the DOM.
    if (key === 'modelModifiers') return;

    if (key === 'style') {
        const el = dom as HTMLElement;
        if (typeof newValue === 'object' && newValue !== null) {
            const styleObj = newValue as Record<string, string | number | null | undefined>;
            // Remove old style properties not present in the new style object
            if (typeof oldValue === 'object' && oldValue !== null) {
                for (const oldKey in oldValue as Record<string, any>) {
                    if (!(oldKey in styleObj)) {
                        if (oldKey.startsWith('--')) {
                            el.style.removeProperty(oldKey);
                        } else {
                            (el.style as any)[oldKey] = '';
                        }
                    }
                }
            }
            for (const styleKey in styleObj) {
                const val = styleObj[styleKey];
                if (val == null || val === '') {
                    if (styleKey.startsWith('--')) {
                        el.style.removeProperty(styleKey);
                    } else {
                        (el.style as any)[styleKey] = '';
                    }
                } else {
                    if (styleKey.startsWith('--')) {
                        el.style.setProperty(styleKey, String(val));
                    } else {
                        (el.style as any)[styleKey] = val;
                    }
                }
            }
        } else if (newValue) {
            el.style.cssText = String(newValue);
        } else {
            el.style.cssText = '';
        }
    } else if (key.startsWith('on')) {
        const tagName = dom.tagName.toLowerCase();
        if (key === 'onUpdate:modelValue' && (tagName === 'input' || tagName === 'textarea' || tagName === 'select')) {
            const el = dom as HTMLElement;
            if (oldValue) {
                const wrapper = (oldValue as any).__sigx_model_handler;
                if (wrapper) {
                    // Cancel any pending debounced write so it can't fire after the
                    // handler is replaced (e.g. on re-render).
                    (wrapper as any).__sigx_cancel?.();
                    el.removeEventListener('input', wrapper);
                    el.removeEventListener('change', wrapper);
                }
            }

            if (newValue) {
                // Value-transforms (trim/number/custom) already run inside the
                // core write-back wrapper that `newValue` is. The platform only
                // maps the timing hints (lazy/debounce) the wrapper carries.
                const { lazy, debounceMs } = resolveTiming(getHandlerModifiers(newValue));

                // Trailing-edge debounce wraps the value push; created once per
                // handler instance so the timer persists across events. Scheduling
                // is shared with core; the platform owns the cancel wiring below.
                let invoke = (v: any) => (newValue as Function)(v);
                let cancel: (() => void) | undefined;
                if (debounceMs != null) {
                    const scheduler = createDebounceScheduler((v) => (newValue as Function)(v), debounceMs);
                    invoke = scheduler.invoke;
                    cancel = scheduler.cancel;
                }

                const handler = (e: Event) => {
                    const target = e.target as HTMLInputElement;
                    let val: any;

                    if (target.type === 'checkbox' || target.type === 'radio') {
                        val = target.checked;
                    } else if (target.type === 'number') {
                        val = target.valueAsNumber;
                    } else if (tagName === 'select' && (dom as HTMLSelectElement).multiple) {
                        val = Array.from((dom as HTMLSelectElement).selectedOptions).map(o => o.value);
                    } else {
                        val = target.value;
                    }

                    try {
                        invoke(val);
                    } catch (err) {
                        routeEventError(err, appContext);
                    }
                };
                (newValue as any).__sigx_model_handler = handler;
                // Expose the debounce canceller so handler replacement can clear it.
                if (cancel) (handler as any).__sigx_cancel = cancel;

                const inputType = (dom as HTMLInputElement).type;
                const isToggle = tagName === 'input' && (inputType === 'checkbox' || inputType === 'radio');
                // `.lazy` syncs text inputs on `change` (blur/enter) instead of `input`.
                if (tagName === 'select' || isToggle || lazy) {
                    el.addEventListener('change', handler);
                } else {
                    el.addEventListener('input', handler);
                }
            }
            return;
        }

        const eventName = key.slice(2).toLowerCase();
        // Store invokers on the DOM element, keyed by event name. Re-renders
        // hand fresh handler closures to patchProp constantly; swapping
        // `invoker.value` keeps the DOM listener stable instead of paying a
        // removeEventListener+addEventListener per prop per re-render.
        const handlersKey = '__sigx_event_handlers';
        let handlers = (dom as any)[handlersKey] as Map<string, EventInvoker> | undefined;
        if (!handlers) {
            handlers = new Map();
            (dom as any)[handlersKey] = handlers;
        }

        const existing = handlers.get(eventName);
        if (newValue) {
            if (existing) {
                existing.value = newValue;
                existing.appContext = appContext;
            } else {
                const invoker = function (e: Event) {
                    try {
                        if (e instanceof CustomEvent) {
                            invoker.value(e.detail);
                        } else {
                            invoker.value(e);
                        }
                    } catch (err) {
                        routeEventError(err, invoker.appContext);
                    }
                } as EventInvoker;
                invoker.value = newValue;
                invoker.appContext = appContext;
                handlers.set(eventName, invoker);
                dom.addEventListener(eventName, invoker);
            }
        } else if (existing) {
            dom.removeEventListener(eventName, existing);
            handlers.delete(eventName);
        }
    } else if (key === 'className') {
        // Nullish/false removes the attribute — keeps mount/hydration output
        // consistent with SSR, which omits the attribute for these values.
        if (newValue == null || newValue === false) {
            dom.removeAttribute('class');
        } else {
            // For SVG, use setAttribute to preserve case (class works on both)
            dom.setAttribute('class', String(newValue));
        }
    } else if (key.startsWith('.')) {
        const propName = key.slice(1);
        (dom as any)[propName] = newValue;
    } else if (key.startsWith('prop:')) {
        const propName = key.slice(5);
        (dom as any)[propName] = newValue;
    } else if (isSvgElement) {
        // SVG elements: use setAttribute to preserve case-sensitive attribute names
        // SVG attributes like viewBox, preserveAspectRatio, etc. are case-sensitive
        if (key === 'innerHTML' || key === 'textContent') {
            // These can be set as properties even on SVG
            (dom as any)[key] = newValue ?? '';
        } else if (key.startsWith('xlink:')) {
            // xlink: attributes need special namespace handling
            const xlinkNS = 'http://www.w3.org/1999/xlink';
            if (newValue == null) {
                dom.removeAttributeNS(xlinkNS, key.slice(6));
            } else {
                dom.setAttributeNS(xlinkNS, key, String(newValue));
            }
        } else {
            // Standard SVG attribute - use setAttribute to preserve case
            if (newValue === true) dom.setAttribute(key, '');
            else if (newValue === false || newValue == null) dom.removeAttribute(key);
            else dom.setAttribute(key, String(newValue));
        }
    } else {
        const tagName = dom.tagName.toLowerCase();
        if ((tagName === 'input' || tagName === 'textarea' || tagName === 'select') &&
            (key === 'value' || key === 'checked')) {
            if (tagName === 'select' && key === 'value') {
                // Defer setting select value until options are mounted
                queueMicrotask(() => {
                    if (Array.isArray(newValue)) {
                        // Multi-select: set selected on each matching option
                        const values = newValue as string[];
                        const options = (dom as HTMLSelectElement).options;
                        for (let i = 0; i < options.length; i++) {
                            options[i].selected = values.includes(options[i].value);
                        }
                    } else {
                        (dom as HTMLSelectElement).value = String(newValue ?? '');
                    }
                });
                return;
            }

            if (key === 'checked' && tagName === 'input') {
                (dom as HTMLInputElement).checked = Boolean(newValue);
            } else if (key === 'value') {
                (dom as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value = String(newValue ?? '');
            }
        } else if (key in dom) {
            // Skip undefined/null to avoid DOM coercing to 0 for numeric props like maxLength
            if (newValue == null) {
                // Remove attribute if it exists
                if (dom.hasAttribute?.(key)) {
                    dom.removeAttribute(key);
                }
            } else {
                try {
                    (dom as Record<string, any>)[key] = newValue;
                } catch {
                    dom.setAttribute(key, String(newValue));
                }
            }
        } else if (tagName.includes('-') && !key.includes('-')) {
            (dom as Record<string, any>)[key] = newValue;
        } else {
            if (newValue === true) dom.setAttribute(key, '');
            else if (newValue === false || newValue == null) dom.removeAttribute(key);
            else dom.setAttribute(key, String(newValue));
        }
    }
}
