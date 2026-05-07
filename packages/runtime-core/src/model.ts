/**
 * Model<T> - Unified two-way binding type for SignalX components.
 * 
 * Provides a single interface for reading, writing, and forwarding model bindings.
 * 
 * @example
 * ```tsx
 * const Input = component<InputProps>(({ props }) => {
 *     // Read
 *     console.log(props.model.value);
 *     
 *     // Write
 *     props.model.value = "new value";
 *     
 *     // Forward to child
 *     <Child model={props.model} />
 *     
 *     // Forward via context
 *     defineProvide(inputContext, () => props.model);
 * });
 * ```
 */

/** Symbol to identify Model objects */
const MODEL_SYMBOL = Symbol.for("sigx.model");

/** The binding tuple for Model<T>: [sourceObject, key, updateHandler] */
export type ModelBindingTuple<T> = readonly [object, string, (value: T) => void];

/**
 * Model<T> - A two-way binding that can be read, written, and forwarded.
 * 
 * - `.value` - Get or set the current value
 * - `.binding` - The underlying binding for forwarding
 */
export interface Model<T> {
    /** Get or set the current value */
    value: T;
    /** The underlying binding tuple for forwarding */
    readonly binding: ModelBindingTuple<T>;
    /** @internal Marker to identify Model objects */
    readonly [MODEL_SYMBOL]: true;
}

/**
 * Creates a Model<T> from a binding tuple and update handler.
 * 
 * @param tuple - The [sourceObject, key] tuple from reactivity detection
 * @param updateHandler - Function called when value is set (enables parent interception)
 * @returns A Model<T> with .value getter/setter and .binding for forwarding
 */
export function createModel<T>(
    tuple: [object, string],
    updateHandler: (value: T) => void
): Model<T> {
    const [obj, key] = tuple;
    
    return {
        get value(): T {
            return (obj as Record<string, T>)[key];
        },
        set value(v: T) {
            updateHandler(v);
        },
        get binding(): ModelBindingTuple<T> {
            return [obj, key, updateHandler] as const;
        },
        [MODEL_SYMBOL]: true as const
    };
}

/**
 * Creates a Model<T> from an existing binding (for forwarding scenarios).
 * 
 * @param binding - The full binding tuple [obj, key, handler]
 * @returns A new Model<T> wrapping the same binding
 */
export function createModelFromBinding<T>(binding: ModelBindingTuple<T>): Model<T> {
    const [obj, key, handler] = binding;
    return createModel([obj, key], handler);
}

/**
 * Type guard to check if a value is a Model<T>.
 * 
 * Used by JSX runtime to detect forwarded models and extract their bindings.
 */
export function isModel(value: unknown): value is Model<unknown> {
    return (
        value !== null &&
        typeof value === "object" &&
        MODEL_SYMBOL in value &&
        (value as Model<unknown>)[MODEL_SYMBOL] === true
    );
}

/**
 * Gets the Model symbol for external checks.
 * @internal
 */
export function getModelSymbol(): symbol {
    return MODEL_SYMBOL;
}
