import type { Lifetime, guid } from "../models/index.js";
import { onUnmounted } from "../component.js";
import { lookupProvided, useAppContext, type InjectableFunction } from "./injectable.js";

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

export function defineFactory<InferReturnSetup>(
    setup: (ctx: SetupFactoryContext, ...args: unknown[]) => InferReturnSetup,
    lifetime: Lifetime,
    typeIdentifier?: guid
): InjectableFunction<InferReturnSetup & { dispose: () => void }>
export function defineFactory<InferReturnSetup, T1>(
    setup: (ctx: SetupFactoryContext, param1: T1) => InferReturnSetup,
    lifetime: Lifetime,
    typeIdentifier?: guid
): (param1: T1) => InferReturnSetup & { dispose: () => void }
export function defineFactory<InferReturnSetup, T1, T2>(
    setup: (ctx: SetupFactoryContext, param1: T1, param2: T2) => InferReturnSetup,
    lifetime: Lifetime,
    typeIdentifier?: string
): (param1: T1, param2: T2) => InferReturnSetup & { dispose: () => void }
export function defineFactory<InferReturnSetup, T1, T2, T3>(
    setup: (ctx: SetupFactoryContext, param1: T1, param2: T2, param3: T3) => InferReturnSetup,
    lifetime: Lifetime,
    typeIdentifier?: guid
): (param1: T1, param2: T2, param3: T3) => InferReturnSetup & { dispose: () => void }
export function defineFactory<InferReturnSetup, T1, T2, T3, T4>(
    setup: (ctx: SetupFactoryContext, param1: T1, param2: T2, param3: T3, param4: T4) => InferReturnSetup,
    lifetime: Lifetime,
    typeIdentifier?: guid
): (param1: T1, param2: T2, param3: T3, param4: T4) => InferReturnSetup & { dispose: () => void }
export function defineFactory<InferReturnSetup, T1, T2, T3, T4, T5>(
    setup: (ctx: SetupFactoryContext, param1: T1, param2: T2, param3: T3, param4: T4, param5: T5) => InferReturnSetup,
    lifetime: Lifetime,
    typeIdentifier?: guid
): (param1: T1, param2: T2, param3: T3, param4: T4, param5: T5) => InferReturnSetup & { dispose: () => void }
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

        // Capture a user-supplied dispose BEFORE attaching our own, so the
        // wrapper can delegate to it without recursing into itself.
        const userDispose =
            result && typeof result === 'object' && typeof (result as { dispose?: unknown }).dispose === 'function'
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

        // Attach (not spread): spreading would snapshot accessor getters and
        // drop prototypes, silently breaking reactive `get foo()` returns.
        if (result && typeof result === 'object') {
            Object.defineProperty(result, 'dispose', {
                value: dispose,
                enumerable: false,
                configurable: true,
                writable: true
            });
        }

        return { instance: result as Instance, dispose, customDispose };
    };

    // One-instance-per-realm fallback for singleton/scoped resolution outside
    // any app context (tests, scripts). App-owned instances are disposed by
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
            const provided = lookupProvided<Instance>(token);
            if (provided !== undefined) {
                return provided;
            }
        }

        const appContext = useAppContext();
        if (appContext) {
            if (!appContext.provides.has(token)) {
                // Args are honored at first creation only ("first creation
                // wins") — later calls return the shared instance.
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

        if (!realmInstance) {
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
    // scoped instances from this factory (args-less creation).
    useFn._factory = () => createInstance().instance;
    useFn._token = token;

    return useFn;
}
