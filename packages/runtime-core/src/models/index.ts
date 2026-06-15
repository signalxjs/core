import { guid as guidFn } from "../utils/index.js";

export type guid = string;
export const guid = guidFn;

/**
 * Instance lifetime for factories created with `defineFactory`.
 *
 * - `'singleton'` — one instance per `AppContext`, disposed on `app.unmount()`.
 *   Outside any app context, falls back to one instance per JS realm.
 * - `'scoped'` — the nearest instance provided via `defineProvide` in the
 *   component tree; falls back to the app-context (singleton) instance, and
 *   outside any app/component context to the per-realm instance (same
 *   fallback as `'singleton'`).
 * - `'transient'` — a new instance per call, disposed with the calling
 *   component (or manually via `dispose()`).
 */
export type Lifetime = 'singleton' | 'scoped' | 'transient';

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
