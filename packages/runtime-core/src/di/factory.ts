import { defineInjectable, type InjectableFunction } from "./injectable.js";
import { InstanceLifetimes, guid } from "../models/index.js";
import { onUnmounted } from "../component.js";

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

export function defineFactory<InferReturnSetup>(
    setup: (ctx: SetupFactoryContext, ...args: unknown[]) => InferReturnSetup,
    lifetime: InstanceLifetimes,
    typeIdentifier?: guid
): InjectableFunction<InferReturnSetup & { dispose?: () => void }>
export function defineFactory<InferReturnSetup, T1>(
    setup: (ctx: SetupFactoryContext, param1: T1) => InferReturnSetup,
    lifetime: InstanceLifetimes,
    typeIdentifier?: guid
): (param1: T1) => InferReturnSetup
export function defineFactory<InferReturnSetup, T1, T2>(
    setup: (ctx: SetupFactoryContext, param1: T1, param2: T2) => InferReturnSetup,
    lifetime: InstanceLifetimes,
    typeIdentifier?: string
): (param1: T1, param2: T2) => InferReturnSetup
export function defineFactory<InferReturnSetup, T1, T2, T3>(
    setup: (ctx: SetupFactoryContext, param1: T1, param2: T2, param3: T3) => InferReturnSetup,
    lifetime: InstanceLifetimes,
    typeIdentifier?: guid
): (param1: T1, param2: T2, param3: T3) => InferReturnSetup
export function defineFactory<InferReturnSetup, T1, T2, T3, T4>(
    setup: (ctx: SetupFactoryContext, param1: T1, param2: T2, param3: T3, param4: T4) => InferReturnSetup,
    lifetime: InstanceLifetimes,
    typeIdentifier?: guid
): (param1: T1, param2: T2, param3: T3, param4: T4) => InferReturnSetup
export function defineFactory<InferReturnSetup, T1, T2, T3, T4, T5>(
    setup: (ctx: SetupFactoryContext, param1: T1, param2: T2, param3: T3, param4: T4, param5: T5) => InferReturnSetup,
    lifetime: InstanceLifetimes,
    typeIdentifier?: guid
): (param1: T1, param2: T2, param3: T3, param4: T4, param5: T5) => InferReturnSetup
export function defineFactory<InferReturnSetup>(
    setup: (ctx: SetupFactoryContext, ...args: unknown[]) => InferReturnSetup,
    _lifetime: InstanceLifetimes,
    _typeIdentifier?: guid
) {
    // The actual factory that creates the instance
    const factoryCreator = (...args: unknown[]) => {
        const subscriptions = new SubscriptionHandler();
        const deactivations = new Set<() => void>();
        let customDispose: ((fn: () => void) => void) | null = null;

        const ctx: SetupFactoryContext = {
            onDeactivated: (fn) => deactivations.add(fn),
            subscriptions,
            overrideDispose: (fn) => customDispose = fn
        };

        const result = setup(ctx, ...args);

        const dispose = () => {
            deactivations.forEach(d => d());
            subscriptions.unsubscribe();
            if (result && typeof result === 'object' && 'dispose' in result && typeof (result as Record<string, unknown>).dispose === 'function') {
                ((result as Record<string, Function>).dispose)();
            }
        };

        if (customDispose) {
            (customDispose as (fn: () => void) => void)(dispose);
        } else {
            // Auto-dispose if in component context
            try {
                onUnmounted(() => dispose());
            } catch { }
        }

        return { ...result, dispose };
    };

    // If it's a parameterless factory, we can make it injectable
    if (setup.length <= 1) {
        return defineInjectable(() => factoryCreator());
    }

    return factoryCreator;
}
