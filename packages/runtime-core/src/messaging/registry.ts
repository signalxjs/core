// ============================================================================
// Topic registry — INSPECTION-ONLY surface (exposed via `@sigx/runtime-core/inspect`)
//
// DX contract: typed code holds Topic<T> references; this string-addressed
// registry exists for tooling (devtools, diagnostics) and is deliberately
// Topic<unknown>-typed. Only topics created WITH a namespace register here;
// destroy() unregisters. The registry is realm-global — owners must destroy
// their topics (stores do so on disposal).
// ============================================================================

import type { Topic, Subscription } from "../models/index.js";
import { onUnmounted } from "../component.js";

const topics = new Set<Topic<unknown>>();
const creationHandlers = new Set<(topic: Topic<unknown>) => void>();

/** Called by createTopic for namespaced topics. @internal */
export function registerTopic(topic: Topic<unknown>): void {
    topics.add(topic);
    for (const handler of creationHandlers) {
        try {
            handler(topic);
        } catch (err) {
            console.error('[sigx] Error in onTopicCreated handler:', err);
        }
    }
}

/** Called by Topic.destroy(). @internal */
export function unregisterTopic(topic: Topic<unknown>): void {
    topics.delete(topic);
}

function topicPath(topic: Topic<unknown>): string {
    return topic.name ? `${topic.namespace}.${topic.name}` : `${topic.namespace}`;
}

/** Compile a `*`-wildcard pattern (matched against `namespace.name`) to a RegExp. */
function toMatcher(pattern: string): RegExp {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, ch => (ch === '*' ? '.*' : `\\${ch}`));
    return new RegExp(`^${escaped}$`);
}

/** Look up a live registered topic by exact namespace and name. */
export function getTopic(namespace: string, name: string): Topic<unknown> | undefined {
    for (const topic of topics) {
        if (topic.namespace === namespace && topic.name === name) {
            return topic;
        }
    }
    return undefined;
}

/**
 * List live registered topics, optionally filtered by a `*`-wildcard pattern
 * over `${namespace}.${name}` (e.g. `'todos#1.*'`, `'*.actions.*'`).
 */
export function listTopics(pattern?: string): Topic<unknown>[] {
    if (pattern === undefined) {
        return Array.from(topics);
    }
    const matcher = toMatcher(pattern);
    return Array.from(topics).filter(topic => matcher.test(topicPath(topic)));
}

/**
 * Register a handler for every topic that registers from now on.
 * Returns a Subscription; auto-unsubscribes on component unmount when
 * called inside a component setup.
 */
export function onTopicCreated(handler: (topic: Topic<unknown>) => void): Subscription {
    creationHandlers.add(handler);
    const unsubscribe = () => {
        creationHandlers.delete(handler);
    };
    try {
        onUnmounted(unsubscribe);
    } catch {
        // Not in a context that supports auto-cleanup
    }
    return { unsubscribe };
}

/**
 * Subscribe to every registered topic matching a `*`-wildcard pattern —
 * both topics that already exist and topics created later. One Subscription
 * tears everything down.
 */
export function subscribeTopics(
    pattern: string,
    handler: (data: unknown, meta: { namespace: string; name: string }) => void
): Subscription {
    const matcher = toMatcher(pattern);
    const attached = new Map<Topic<unknown>, Subscription>();

    const attach = (topic: Topic<unknown>) => {
        if (attached.has(topic) || !matcher.test(topicPath(topic))) {
            return;
        }
        attached.set(topic, topic.subscribe(data =>
            handler(data, { namespace: topic.namespace ?? '', name: topic.name ?? '' })
        ));
    };

    topics.forEach(attach);
    const creationSub = onTopicCreated(attach);

    const unsubscribe = () => {
        creationSub.unsubscribe();
        attached.forEach(sub => sub.unsubscribe());
        attached.clear();
    };
    return { unsubscribe };
}
