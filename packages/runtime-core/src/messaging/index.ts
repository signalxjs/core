import type { Subscription, Topic } from "../models/index.js";
import { onUnmounted } from "../component.js";
import { registerTopic, unregisterTopic } from "./registry.js";

export interface CreateTopicOptions {
    /** Tooling metadata; topics WITH a namespace register in the inspection registry. */
    namespace?: string;
    /** Tooling metadata. */
    name?: string;
    /** Called when subscriberCount transitions 0 → 1 (refCount pattern). */
    onActivate?(): void;
    /** Called when subscriberCount transitions back to 0 (last unsubscribe or destroy). */
    onDeactivate?(): void;
}

export function createTopic<T>(options?: CreateTopicOptions): Topic<T> {
    const namespace = options?.namespace;
    const name = options?.name;
    const onActivate = options?.onActivate;
    const onDeactivate = options?.onDeactivate;

    let subscribers: ((data: T) => void)[] = [];
    let disposed = false;
    let active = false;

    // Identify the topic in errors/logs by whatever metadata it has.
    const path = namespace && name ? `${namespace}.${name}` : (namespace ?? name);
    const label = path ? ` "${path}"` : '';

    // User-supplied lifecycle hooks are isolated so a misbehaving hook can
    // never corrupt subscription bookkeeping or block destroy/unregister.
    const activate = () => {
        active = true;
        try {
            onActivate?.();
        } catch (err) {
            if (process.env.NODE_ENV !== 'production') {
                console.error(`[sigx] Error in topic onActivate${label}:`, err);
            } else {
                console.error(err);
            }
        }
    };
    const deactivate = () => {
        active = false;
        try {
            onDeactivate?.();
        } catch (err) {
            if (process.env.NODE_ENV !== 'production') {
                console.error(`[sigx] Error in topic onDeactivate${label}:`, err);
            } else {
                console.error(err);
            }
        }
    };

    const topic: Topic<T> = {
        get namespace() {
            return namespace;
        },
        get name() {
            return name;
        },
        get subscriberCount() {
            return subscribers.length;
        },
        get hasSubscribers() {
            return subscribers.length > 0;
        },
        get disposed() {
            return disposed;
        },

        publish(data: T) {
            if (disposed) return;
            // Snapshot so a handler unsubscribing mid-publish cannot skip siblings.
            const handlers = subscribers.slice();
            for (const handler of handlers) {
                try {
                    handler(data);
                } catch (err) {
                    // Isolate subscriber errors: a bad observer must not break
                    // the publisher or the remaining subscribers.
                    if (process.env.NODE_ENV !== 'production') {
                        console.error(`[sigx] Error in topic subscriber${label}:`, err);
                    } else {
                        console.error(err);
                    }
                }
            }
        },

        subscribe(handler: (data: T) => void): Subscription {
            if (disposed) {
                throw new Error(`[sigx] Cannot subscribe to destroyed topic${label}.`);
            }
            subscribers.push(handler);
            if (subscribers.length === 1 && !active) {
                activate();
            }

            let removed = false;
            const unsubscribe = () => {
                if (removed) return;
                removed = true;
                const idx = subscribers.indexOf(handler);
                if (idx > -1) subscribers.splice(idx, 1);
                if (subscribers.length === 0 && active) {
                    deactivate();
                }
            };

            // Auto-unsubscribe if inside a component or effect scope that supports cleanup
            try {
                onUnmounted(unsubscribe);
            } catch {
                // Not in a context that supports auto-cleanup, ignore
            }

            return { unsubscribe };
        },

        destroy() {
            if (disposed) return;
            disposed = true;
            subscribers = [];
            if (active) {
                deactivate();
            }
            unregisterTopic(topic as Topic<unknown>);
        }
    };

    if (namespace) {
        registerTopic(topic as Topic<unknown>);
    }

    return topic;
}

export function toSubscriber<T>(topic: Topic<T>) {
    return {
        subscribe: (handler: (data: T) => void) => topic.subscribe(handler)
    };
}

/**
 * A typed group of topics keyed by an event map — mitt-level DX on the Topic
 * primitive. Topics are created lazily per key on first access (the event-map
 * generic is erased at runtime, so keys are only known when touched) and are
 * namespaced/registered like any other topic.
 *
 * @example
 * ```ts
 * const group = createTopicGroup<{ loggedIn: User; loggedOut: void }>({ namespace: 'auth#1.events' });
 * group.topics.loggedIn.publish(user);          // payload type-checked
 * group.topics.loggedIn.subscribe(u => ...);    // u: User
 * group.destroy();                              // destroys all created topics
 * ```
 */
export function createTopicGroup<EventMap extends Record<string, any>>(options?: { namespace?: string }): {
    topics: { [K in keyof EventMap]: Topic<EventMap[K]> };
    destroy(): void;
} {
    const created = new Map<string, Topic<any>>();
    let disposed = false;

    const topics = new Proxy({} as { [K in keyof EventMap]: Topic<EventMap[K]> }, {
        get(target, key) {
            // Never treat prototype/protocol keys as event names — logging,
            // stringification, JSON.stringify, or await would otherwise
            // silently create and register topics named toString/toJSON/then.
            if (typeof key !== 'string' || key in Object.prototype || key === 'toJSON' || key === 'then') {
                return Reflect.get(target, key);
            }
            let topic = created.get(key);
            if (!topic) {
                if (disposed) {
                    throw new Error(`[sigx] Cannot create topic "${key}" on a destroyed topic group.`);
                }
                topic = createTopic({ namespace: options?.namespace, name: key });
                created.set(key, topic);
            }
            return topic;
        }
    });

    return {
        topics,
        destroy() {
            if (disposed) return;
            disposed = true;
            created.forEach(topic => topic.destroy());
            created.clear();
        }
    };
}
