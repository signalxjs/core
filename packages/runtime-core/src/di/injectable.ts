import { getCurrentInstance, onUnmounted } from "../component.js";
import type { AppContext } from "../app-types.js";
import {
    provideOutsideSetupError,
    provideInvalidInjectableError,
    requiredInjectableNotProvidedError,
} from "../errors.js";
import type { InjectionToken } from "./token.js";

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
 * The app context made current by `app.runWithContext(fn)` for code running
 * outside any component — router navigation guards, socket handlers,
 * entry-scope code. Consulted only when there is no current component
 * instance; component-tree provides always take precedence.
 */
let activeAppContext: AppContext | null = null;

/**
 * Swap the active app context, returning the previous one so the caller can
 * restore it (nested runWithContext calls). Used by `app.runWithContext()`.
 * @internal
 */
export function setActiveAppContext(context: AppContext | null): AppContext | null {
    const prev = activeAppContext;
    activeAppContext = context;
    return prev;
}

/**
 * Sentinel distinguishing "not provided" from an explicitly provided
 * `undefined` — `lookupProvidedEntry` returns it on a lookup miss.
 * @internal
 */
export const NOT_PROVIDED: unique symbol = Symbol('sigx:notProvided');

/**
 * Lookup a provided entry by token, traversing the component tree.
 * The AppContext is provided at the root component level, so it's found
 * just like any other provided value.
 * On a tree miss, falls back to the app-level provides of the AppContext
 * found at the root — a live read, so `app.defineProvide` calls made after
 * mount are visible too. Outside any component, falls back to the app
 * context made current by `app.runWithContext(fn)`.
 * Returns `NOT_PROVIDED` when the token is not provided anywhere, so callers
 * can tell a lookup miss from an explicitly provided `undefined`.
 * @internal
 */
export function lookupProvidedEntry(token: symbol): unknown {
    const ctx = getCurrentInstance();
    if (!ctx) {
        if (activeAppContext?.provides.has(token)) {
            return activeAppContext.provides.get(token);
        }
        return NOT_PROVIDED;
    }

    // Traverse up the component tree looking for provides
    let current = ctx as unknown as ProviderNode;
    let root: ProviderNode | null = null;
    while (current) {
        if (current.provides && current.provides.has(token)) {
            return current.provides.get(token);
        }
        root = current;
        current = current.parent as ProviderNode;
    }

    // Tree miss: consult the app-level provides via the AppContext at the
    // root (component-tree provides always take precedence over these).
    const appContext = root?.provides?.get(appContextToken) as AppContext | undefined;
    if (appContext?.provides.has(token)) {
        return appContext.provides.get(token);
    }

    return NOT_PROVIDED;
}

/**
 * Like `lookupProvidedEntry`, but conflates "not provided" with a provided
 * `undefined`. Exported for the factory system's scoped-lifetime resolution
 * and internal seam reads that never provide `undefined`.
 * The `InjectionToken` overload infers the value type from the token.
 * @internal
 */
export function lookupProvided<T>(token: InjectionToken<T>): T | undefined;
export function lookupProvided<T>(token: symbol): T | undefined;
export function lookupProvided<T>(token: symbol): T | undefined {
    const entry = lookupProvidedEntry(token);
    return entry === NOT_PROVIDED ? undefined : entry as T;
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
 * The metadata defineProvide actually needs — satisfied by both
 * InjectableFunction and parameterized FactoryFunction use-functions.
 */
export interface Providable<T> {
    _factory: () => T;
    _token: symbol;
}

/**
 * Dev-only: tokens whose global-singleton fallback already warned on the
 * server, so each injectable warns at most once per process.
 */
const ssrFallbackWarned = new Set<symbol>();

/**
 * Dev-only, server-only: warn when the global-singleton fallback fires while
 * an app exists (a component is rendering, or code runs inside
 * `app.runWithContext`). That singleton is shared across every SSR request in
 * the process — almost always a forgotten provide, not the zero-config usage
 * the fallback is meant for. Bare Node scripts and tests (no app anywhere)
 * stay silent, as does the client.
 */
function warnSSRGlobalFallback(token: symbol): void {
    if (typeof window !== 'undefined') return;
    if (!getCurrentInstance() && !activeAppContext) return;
    if (ssrFallbackWarned.has(token)) return;
    ssrFallbackWarned.add(token);
    console.warn(
        `[sigx] Injectable "${token.description || 'anonymous'}" resolved to a ` +
        'module-global singleton on the server because no provider was found. ' +
        'That instance is shared across ALL SSR requests in this process. ' +
        'Provide it per app — app.defineProvide(useX, () => ...) — or declare it ' +
        "required: defineInjectable<T>('Name')."
    );
}

/**
 * Define an injectable service/value that can be provided at app or component level.
 *
 * The returned function can be called to get the current instance:
 * - If provided at component level via `defineProvide()`, returns that instance
 * - If provided at app level via `app.defineProvide()`, returns that instance
 * - Otherwise falls back to a global singleton created by the factory
 *
 * Pass a **name string** instead of a factory to declare a *required*
 * injectable: there is no fallback, and using it without a provider throws a
 * structured error (SIGX202) naming the injectable. Use this for services
 * that must be provided per app — e.g. per-request services under SSR.
 *
 * @example
 * ```typescript
 * // Define a service with a zero-config fallback
 * const useApiConfig = defineInjectable(() => ({
 *     baseUrl: 'https://api.example.com'
 * }));
 *
 * // Use it in any component - gets nearest provided instance or global singleton
 * const config = useApiConfig();
 * console.log(config.baseUrl);
 *
 * // A required service: no fallback, must be provided
 * const useRouter = defineInjectable<Router>('Router');
 * app.defineProvide(useRouter, () => createRouter(url));
 * ```
 */
export function defineInjectable<T>(factory: () => T): InjectableFunction<T>;
export function defineInjectable<T>(name: string): InjectableFunction<T>;
export function defineInjectable<T>(factoryOrName: (() => T) | string): InjectableFunction<T> {
    if (typeof factoryOrName === 'string') {
        const name = factoryOrName;
        const token = Symbol(name);

        const useFn = (() => {
            const entry = lookupProvidedEntry(token);
            if (entry !== NOT_PROVIDED) {
                return entry as T;
            }
            throw requiredInjectableNotProvidedError(name);
        }) as InjectableFunction<T>;

        // No default factory either: defineProvide(useFn) without an explicit
        // factory fails with the same clear, named error.
        useFn._factory = () => {
            throw requiredInjectableNotProvidedError(name);
        };
        useFn._token = token;

        return useFn;
    }

    const factory = factoryOrName;
    // Use a unique symbol as the token for this injectable; the description
    // only feeds diagnostics (dev warnings, devtools).
    const token = Symbol(factory.name || 'sigx:injectable');

    const useFn = (() => {
        // Try to find a provided instance
        const entry = lookupProvidedEntry(token);
        if (entry !== NOT_PROVIDED) {
            return entry as T;
        }

        // Fallback to global singleton
        if (__DEV__) {
            warnSSRGlobalFallback(token);
        }
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
 * @param useFn - A use-function created by defineInjectable or defineFactory
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
export function defineProvide<T>(useFn: Providable<T>, factory?: () => T): T {
    const actualFactory = factory ?? useFn._factory;
    const token = useFn._token;

    if (!actualFactory || !token) {
        throw provideInvalidInjectableError();
    }

    const instance = actualFactory();
    provideAtComponent(token, instance);
    // The provider component owns the instance: dispose it on unmount —
    // unless the factory setup took over disposal via overrideDispose.
    // provideAtComponent above guarantees we are inside a component setup.
    const dispose = (instance as { dispose?: unknown } | null)?.dispose;
    if (typeof dispose === 'function'
        && (dispose as { __sigxCustomManaged?: boolean }).__sigxCustomManaged !== true) {
        onUnmounted(() => (dispose as () => void).call(instance));
    }
    return instance;
}

/**
 * Get the current AppContext from the component tree.
 * The AppContext is provided at the root component level during mount/hydrate/SSR.
 * Outside any component, returns the context made current by
 * `app.runWithContext(fn)`, or null.
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
    // App-level provides are NOT copied here: `lookupProvidedEntry` reads
    // `appContext.provides` live through this token on a tree miss, so
    // `app.defineProvide` calls made after mount stay visible.
}
