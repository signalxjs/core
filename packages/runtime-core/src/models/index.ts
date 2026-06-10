import { guid as guidFn } from "../utils/index.js";

export type guid = string;
export const guid = guidFn;

export enum InstanceLifetimes {
    Transient = 0,
    Scoped = 1,
    Singleton = 2
}

export interface Subscription {
    unsubscribe(): void;
}

export interface Topic<T> {
    /** Deliver to all subscribers. Handler errors are isolated. No-op when disposed. */
    publish(data: T): void;
    /** Subscribe to messages. Throws if the topic is destroyed. */
    subscribe(handler: (data: T) => void): Subscription;
    /** Remove all subscribers and unregister; idempotent. */
    destroy(): void;
    /** Tooling metadata — never an app-level lookup path. */
    readonly namespace?: string;
    /** Tooling metadata — never an app-level lookup path. */
    readonly name?: string;
    readonly subscriberCount: number;
    readonly hasSubscribers: boolean;
    readonly disposed: boolean;
}
