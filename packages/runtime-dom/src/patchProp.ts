/**
 * DOM property patching logic.
 *
 * Handles setting/updating all element properties including styles,
 * event handlers, className, SVG attributes, form element values,
 * and custom property bindings.
 */

/**
 * Stable per-event listener wrapper: re-renders swap `invoker.value`
 * instead of removing and re-adding the DOM listener for every fresh
 * inline handler closure.
 */
interface EventInvoker extends EventListener {
    value: Function;
}

export function patchProp(dom: Element, key: string, prevValue: any, nextValue: any, isSVG?: boolean) {
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
                    el.removeEventListener('input', wrapper);
                    el.removeEventListener('change', wrapper);
                }
            }

            if (newValue) {
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

                    (newValue as Function)(val);
                };
                (newValue as any).__sigx_model_handler = handler;

                const inputType = (dom as HTMLInputElement).type;
                if (tagName === 'select' || (tagName === 'input' && (inputType === 'checkbox' || inputType === 'radio'))) {
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
            } else {
                const invoker = function (e: Event) {
                    if (e instanceof CustomEvent) {
                        invoker.value(e.detail);
                    } else {
                        invoker.value(e);
                    }
                } as EventInvoker;
                invoker.value = newValue;
                handlers.set(eventName, invoker);
                dom.addEventListener(eventName, invoker);
            }
        } else if (existing) {
            dom.removeEventListener(eventName, existing);
            handlers.delete(eventName);
        }
    } else if (key === 'className') {
        // For SVG, use setAttribute to preserve case (class works on both)
        dom.setAttribute('class', String(newValue));
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
