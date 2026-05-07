import { getCurrentInstance } from "../component.js";
import type { AppContext } from "../app-types.js";
import { provideOutsideSetupError, provideInvalidInjectableError } from "../errors.js";

// ============================================================================
// Internal helpers
// ============================================================================

/** Internal type for traversing the component tree's provides */
interface ProviderNode {
    provides?: Map<symbol, unknown>;
    parent?: ProviderNode | null;
}

/**
 * Global singleton instances (fallback when no provider found)
 */
const globalInstances = new Map<symbol, unknown>();

/**
 * Token for the AppContext injectable.
 * Used to provide/lookup the AppContext in the component tree.
 */
const appContextToken = Symbol('sigx:appContext');

/**
 * Lookup a provided value by token, traversing component tree.
 * The AppContext is provided at the root component level, so it's found
 * just like any other provided value.
 * @internal
 */
function lookupProvided<T>(token: symbol): T | undefined {
    const ctx = getCurrentInstance();
    if (!ctx) {
        return undefined;
    }

    // Traverse up the component tree looking for provides
    let current = ctx as unknown as ProviderNode;
    while (current) {
        if (current.provides && current.provides.has(token)) {
            return current.provides.get(token) as T | undefined;
        }
        current = current.parent as ProviderNode;
    }

    return undefined;
}

/**
 * Provide a value at the current component level
 * @internal
 */
function provideAtComponent<T>(token: symbol, value: T): void {
    const ctx = getCurrentInstance();
    if (!ctx) {
        throw provideOutsideSetupError();
    }

    const node = ctx as unknown as ProviderNode;
    if (!node.provides) {
        node.provides = new Map();
    }
    node.provides.set(token, value);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Injectable function type with metadata
 */
export interface InjectableFunction<T> {
    (): T;
    _factory: () => T;
    _token: symbol;
}

/**
 * Define an injectable service/value that can be provided at app or component level.
 * 
 * The returned function can be called to get the current instance:
 * - If provided at component level via `defineProvide()`, returns that instance
 * - If provided at app level via `app.defineProvide()`, returns that instance  
 * - Otherwise falls back to a global singleton created by the factory
 * 
 * @example
 * ```typescript
 * // Define a service
 * const useApiConfig = defineInjectable(() => ({ 
 *     baseUrl: 'https://api.example.com' 
 * }));
 * 
 * // Use it in any component - gets nearest provided instance or global singleton
 * const config = useApiConfig();
 * console.log(config.baseUrl);
 * ```
 */
export function defineInjectable<T>(factory: () => T): InjectableFunction<T> {
    // Use a unique symbol as the token for this injectable
    const token = Symbol();

    const useFn = (() => {
        // Try to find a provided instance
        const provided = lookupProvided<T>(token);
        if (provided !== undefined) {
            return provided;
        }

        // Fallback to global singleton
        if (!globalInstances.has(token)) {
            globalInstances.set(token, factory());
        }
        return globalInstances.get(token);
    }) as InjectableFunction<T>;

    // Attach metadata for defineProvide
    useFn._factory = factory;
    useFn._token = token;

    return useFn;
}

/**
 * Provide a new instance of an injectable at the current component level.
 * Child components will receive this instance when calling the injectable function.
 * 
 * @param useFn - The injectable function created by defineInjectable
 * @param factory - Optional custom factory to create the instance (overrides default)
 * 
 * @example
 * ```typescript
 * const useApiConfig = defineInjectable(() => ({ baseUrl: 'https://api.example.com' }));
 * 
 * const MyComponent = component(() => {
 *     // Create and provide a new instance for this subtree
 *     const config = defineProvide(useApiConfig);
 *     config.baseUrl = 'https://custom.api.com';
 *     
 *     return () => <ChildComponent />;
 * });
 * 
 * // Or provide a pre-constructed instance:
 * const MyComponent2 = component(() => {
 *     const customService = createMyService({ custom: 'options' });
 *     defineProvide(useMyService, () => customService);
 *     
 *     return () => <ChildComponent />;
 * });
 * ```
 */
export function defineProvide<T>(useFn: InjectableFunction<T>, factory?: () => T): T {
    const actualFactory = factory ?? useFn._factory;
    const token = useFn._token;

    if (!actualFactory || !token) {
        throw provideInvalidInjectableError();
    }

    const instance = actualFactory();
    provideAtComponent(token, instance);
    return instance;
}

/**
 * Get the current AppContext from the component tree.
 * The AppContext is provided at the root component level during mount/hydrate/SSR.
 * 
 * @example
 * ```typescript
 * const appContext = useAppContext();
 * console.log(appContext?.app);
 * ```
 */
export function useAppContext(): AppContext | null {
    return lookupProvided<AppContext>(appContextToken) ?? null;
}

/**
 * Get the AppContext token.
 * Used by renderers to provide the AppContext at the root component level.
 * @internal
 */
export function getAppContextToken(): symbol {
    return appContextToken;
}

/**
 * Provide the AppContext on a component's provides Map.
 * Called by the renderer for the ROOT component only.
 * @internal
 */
export function provideAppContext(ctx: unknown, appContext: AppContext): void {
    const node = ctx as ProviderNode;
    if (!node.provides) {
        node.provides = new Map();
    }
    node.provides.set(appContextToken, appContext);
    
    // Also store app-level provides on the root component
    // This makes `lookupProvided` find them when traversing up to root
    if (appContext.provides) {
        for (const [token, value] of appContext.provides) {
            node.provides.set(token, value);
        }
    }
}
