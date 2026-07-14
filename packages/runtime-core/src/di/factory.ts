import type { Lifetime, guid } from "../models/index.js";
import { onUnmounted } from "../component.js";
import { lookupProvidedEntry, NOT_PROVIDED, useAppContext, type InjectableFunction } from "./injectable.js";

export class SubscriptionHandler {
    private unsubs: (() => void)[] = [];
    add(unsub: () => void) {
        this.unsubs.push(unsub);
    }
    unsubscribe() {
        this.unsubs.forEach(u => u());
        this.unsubs = [];
    }
}

export interface SetupFactoryContext {
    onDeactivated(fn: () => void): void;
    subscriptions: SubscriptionHandler;
    overrideDispose(onDispose: (fn: () => void) => void): void;
}

type CreatedInstance<T> = {
    instance: T & { dispose: () => void };
    dispose: () => void;
    /** Set when setup called overrideDispose — disposal registration is the setup's job. */
    customDispose: ((fn: () => void) => void) | null;
};

/**
 * A parameterized factory use-function: callable with the setup's params and
 * carrying the provide metadata so it works with defineProvide/app.defineProvide.
 */
export type FactoryFunction<TArgs extends unknown[], TInstance> = ((...args: TArgs) => TInstance) & {
    _factory: () => TInstance;
    _token: symbol;
};

/** True when the value is a factory instance whose generated dispose has run. */
function isDisposedInstance(value: unknown): boolean {
    const dispose = (value as { dispose?: unknown } | null)?.dispose;
    return typeof dispose === 'function'
        && (dispose as { __sigxDisposed?: boolean }).__sigxDisposed === true;
}

export function defineFactory<InferReturnSetup>(
    setup: (ctx: SetupFactoryContext, ...args: unknown[]) => InferReturnSetup,
    lifetime: Lifetime,
    typeIdentifier?: guid
): InjectableFunction<InferReturnSetup & { dispose: () => void }>
export function defineFactory<InferReturnSetup, T1>(
    setup: (ctx: SetupFactoryContext, param1: T1) => InferReturnSetup,
    lifetime: Lifetime,
    typeIdentifier?: guid
): FactoryFunction<[T1], InferReturnSetup & { dispose: () => void }>
export function defineFactory<InferReturnSetup, T1, T2>(
    setup: (ctx: SetupFactoryContext, param1: T1, param2: T2) => InferReturnSetup,
    lifetime: Lifetime,
    typeIdentifier?: guid
): FactoryFunction<[T1, T2], InferReturnSetup & { dispose: () => void }>
export function defineFactory<InferReturnSetup, T1, T2, T3>(
    setup: (ctx: SetupFactoryContext, param1: T1, param2: T2, param3: T3) => InferReturnSetup,
    lifetime: Lifetime,
    typeIdentifier?: guid
): FactoryFunction<[T1, T2, T3], InferReturnSetup & { dispose: () => void }>
export function defineFactory<InferReturnSetup, T1, T2, T3, T4>(
    setup: (ctx: SetupFactoryContext, param1: T1, param2: T2, param3: T3, param4: T4) => InferReturnSetup,
    lifetime: Lifetime,
    typeIdentifier?: guid
): FactoryFunction<[T1, T2, T3, T4], InferReturnSetup & { dispose: () => void }>
export function defineFactory<InferReturnSetup, T1, T2, T3, T4, T5>(
    setup: (ctx: SetupFactoryContext, param1: T1, param2: T2, param3: T3, param4: T4, param5: T5) => InferReturnSetup,
    lifetime: Lifetime,
    typeIdentifier?: guid
): FactoryFunction<[T1, T2, T3, T4, T5], InferReturnSetup & { dispose: () => void }>
export function defineFactory<InferReturnSetup>(
    setup: (ctx: SetupFactoryContext, ...args: unknown[]) => InferReturnSetup,
    lifetime: Lifetime,
    typeIdentifier?: guid
) {
    type Instance = InferReturnSetup & { dispose: () => void };
    const token = Symbol(typeIdentifier ?? 'sigx:factory');

    const createInstance = (...args: unknown[]): CreatedInstance<InferReturnSetup> => {
        const subscriptions = new SubscriptionHandler();
        const deactivations = new Set<() => void>();
        let customDispose: ((fn: () => void) => void) | null = null;

        const ctx: SetupFactoryContext = {
            onDeactivated: (fn) => deactivations.add(fn),
            subscriptions,
            overrideDispose: (fn) => customDispose = fn
        };

        const result = setup(ctx, ...args);
        // Functions are valid factory products too (e.g. callable stores) —
        // anything non-primitive can carry the dispose property. Primitives
        // cannot, which would silently break the dispose contract and the
        // disposed-instance detection the caches rely on — reject them loudly.
        const attachable = result !== null && (typeof result === 'object' || typeof result === 'function');
        if (!attachable) {
            throw new Error('[sigx] defineFactory setup must return an object or function, got ' +
                (result === null ? 'null' : typeof result) + '.');
        }

        // Capture a user-supplied dispose BEFORE attaching our own, so the
        // wrapper can delegate to it without recursing into itself.
        const userDispose =
            typeof (result as { dispose?: unknown }).dispose === 'function'
                ? ((result as unknown as { dispose: () => void }).dispose).bind(result)
                : null;

        let disposed = false;
        const dispose = () => {
            if (disposed) return;
            disposed = true;
            deactivations.forEach(d => d());
            subscriptions.unsubscribe();
            userDispose?.();
        };

        // Tag the generated dispose so caches can detect disposal (and
        // recreate instead of serving a corpse) and so provide paths can
        // tell factory-managed disposal from overrideDispose-managed.
        Object.defineProperties(dispose, {
            __sigxDisposed: { get: () => disposed },
            __sigxCustomManaged: { get: () => customDispose !== null }
        });

        // Attach (not spread): spreading would snapshot accessor getters and
        // drop prototypes, silently breaking reactive `get foo()` returns.
        Object.defineProperty(result as object, 'dispose', {
            value: dispose,
            enumerable: false,
            configurable: true,
            writable: true
        });

        return { instance: result as Instance, dispose, customDispose };
    };

    // One-instance-per-realm fallback for singleton/scoped resolution outside
    // any app context (tests, scripts). Non-component code that belongs to an
    // app — router guards, socket handlers, entry-scope code — should resolve
    // inside app.runWithContext(fn) instead, which yields the app's instance
    // (the one components see); resolving bare from such code silently splits
    // state into this realm instance. App-owned instances are disposed by
    // app.unmount(); the realm fallback has no owner and lives until manual
    // dispose().
    let realmInstance: { instance: Instance } | null = null;

    const resolveTransient = (...args: unknown[]): Instance => {
        const { instance, dispose, customDispose } = createInstance(...args);
        if (customDispose) {
            customDispose(dispose);
        } else {
            // Caller-owned: auto-dispose with the calling component when
            // resolved during setup; outside a component this is a no-op
            // and the caller disposes manually.
            try {
                onUnmounted(() => dispose());
            } catch { /* not in a disposal-capable context */ }
        }
        return instance;
    };

    const resolveShared = (...args: unknown[]): Instance => {
        if (lifetime === 'scoped') {
            const entry = lookupProvidedEntry(token);
            // A disposed instance falls through to the appContext branch below,
            // whose recovery logic recreates it instead of serving a corpse.
            if (entry !== NOT_PROVIDED && !isDisposedInstance(entry)) {
                return entry as Instance;
            }
        }

        const appContext = useAppContext();
        if (appContext) {
            const existing = appContext.provides.get(token);
            if (existing === undefined || isDisposedInstance(existing)) {
                // Drop the stale disposable so dispose/recreate cycles can't
                // grow the set unboundedly until app.unmount().
                if (existing !== undefined) {
                    const oldDispose = (existing as { dispose?: () => void }).dispose;
                    if (oldDispose) {
                        appContext.disposables.delete(oldDispose);
                    }
                }
                // Args are honored at first creation only ("first creation
                // wins") — later calls return the shared instance. A manually
                // disposed instance is replaced, never served as a corpse.
                const { instance, dispose, customDispose } = createInstance(...args);
                if (customDispose) {
                    customDispose(dispose);
                } else {
                    // App-owned: disposed on app.unmount(), never by the
                    // component that happened to resolve it first.
                    appContext.disposables.add(dispose);
                }
                appContext.provides.set(token, instance);
            }
            return appContext.provides.get(token) as Instance;
        }

        if (!realmInstance || isDisposedInstance(realmInstance.instance)) {
            const { instance, dispose, customDispose } = createInstance(...args);
            if (customDispose) {
                customDispose(dispose);
            }
            realmInstance = { instance };
        }
        return realmInstance.instance;
    };

    const useFn = ((...args: unknown[]) =>
        lifetime === 'transient' ? resolveTransient(...args) : resolveShared(...args)
    ) as InjectableFunction<Instance>;

    // Metadata so defineProvide / app.defineProvide can create and provide
    // scoped instances from this factory (args-less creation). overrideDispose
    // is honored here too — the custom registration receives the dispose fn,
    // and the __sigxCustomManaged tag tells provide paths to skip their own.
    useFn._factory = () => {
        const { instance, dispose, customDispose } = createInstance();
        if (customDispose) {
            customDispose(dispose);
        }
        return instance;
    };
    useFn._token = token;

    return useFn;
}
