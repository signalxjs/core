import { Subscription, Topic } from "../models/index.js";
import { onUnmounted } from "../component.js";

export function createTopic<T>(_options?: { namespace?: string; name?: string }): Topic<T> {
    let subscribers: ((data: T) => void)[] = [];

    const publish = (data: T) => {
        subscribers.forEach(s => s(data));
    };

    const subscribe = (handler: (data: T) => void): Subscription => {
        subscribers.push(handler);
        const unsubscribe = () => {
            const idx = subscribers.indexOf(handler);
            if (idx > -1) subscribers.splice(idx, 1);
        };

        // Auto-unsubscribe if inside a component or effect scope that supports cleanup
        try {
            onUnmounted(unsubscribe);
        } catch {
            // Not in a context that supports auto-cleanup, ignore
        }

        return { unsubscribe };
    };

    const destroy = () => {
        subscribers = [];
    };

    return {
        publish,
        subscribe,
        destroy
    };
}

export function toSubscriber<T>(topic: Topic<T>) {
    return {
        subscribe: (handler: (data: T) => void) => topic.subscribe(handler)
    };
}
