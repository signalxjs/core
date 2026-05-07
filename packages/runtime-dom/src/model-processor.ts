/**
 * Platform-specific model processor for DOM form elements.
 *
 * Registers smart two-way binding behavior for checkboxes (boolean and array modes),
 * radio buttons, text inputs, textareas, and select elements (single and multi-select).
 */

import { setPlatformModelProcessor } from '@sigx/runtime-core/internals';

setPlatformModelProcessor((type, props, [stateObj, key], originalProps) => {
    // Helper to set value - uses onUpdate handler if available (for props model forwarding)
    const setValue = (v: any) => {
        const updateHandler = stateObj[`onUpdate:${key}`];
        if (typeof updateHandler === 'function') {
            updateHandler(v);
        } else {
            stateObj[key] = v;
        }
    };

    // Smart mapping for checkbox
    if (type === 'input' && originalProps.type === 'checkbox') {
        const val = stateObj[key];

        if (Array.isArray(val)) {
            // Array Checkbox (Multi-select)
            props.checked = val.includes(originalProps.value);

            const existingHandler = props['onUpdate:modelValue'];
            props['onUpdate:modelValue'] = (checked: boolean) => {
                const currentVal = originalProps.value;
                const currentArr = stateObj[key] as any[];
                if (checked) {
                    if (!currentArr.includes(currentVal)) {
                        setValue([...currentArr, currentVal]);
                    }
                } else {
                    setValue(currentArr.filter((i: any) => i !== currentVal));
                }
                if (existingHandler) existingHandler(checked);
            };
        } else {
            // Boolean Checkbox
            props.checked = val;
            const existingHandler = props['onUpdate:modelValue'];
            props['onUpdate:modelValue'] = (v: any) => {
                setValue(v);
                if (existingHandler) existingHandler(v);
            };
        }
        return true; // Handled
    }

    // Radio Button
    if (type === 'input' && originalProps.type === 'radio') {
        props.checked = stateObj[key] === originalProps.value;
        const existingHandler = props['onUpdate:modelValue'];
        props['onUpdate:modelValue'] = (checked: boolean) => {
            if (checked) setValue(originalProps.value);
            if (existingHandler) existingHandler(checked);
        };
        return true; // Handled
    }

    // Text input (default input type)
    if (type === 'input') {
        props.value = stateObj[key] ?? '';
        const existingHandler = props['onUpdate:modelValue'];
        props['onUpdate:modelValue'] = (v: any) => {
            setValue(v);
            if (existingHandler) existingHandler(v);
        };
        return true; // Handled
    }

    // Textarea
    if (type === 'textarea') {
        props.value = stateObj[key] ?? '';
        const existingHandler = props['onUpdate:modelValue'];
        props['onUpdate:modelValue'] = (v: any) => {
            setValue(v);
            if (existingHandler) existingHandler(v);
        };
        return true; // Handled
    }

    // Select
    if (type === 'select') {
        if (originalProps.multiple && Array.isArray(stateObj[key])) {
            // Multi-select: pass array as value, patchProp will set option.selected
            props.value = stateObj[key];
        } else {
            props.value = stateObj[key] ?? '';
        }
        const existingHandler = props['onUpdate:modelValue'];
        props['onUpdate:modelValue'] = (v: any) => {
            setValue(v);
            if (existingHandler) existingHandler(v);
        };
        return true; // Handled
    }

    // Not handled - use generic fallback
    return false;
});
