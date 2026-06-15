// ============================================================================
// @sigx/runtime-core/inspect — inspection-only surface for tooling
//
// Typed application code holds Topic<T> references (e.g. a store's events);
// this string-addressed registry is for devtools and diagnostics, and is
// deliberately Topic<unknown>-typed. Do not use it as an app-level lookup
// mechanism — share typed topic references instead.
// ============================================================================

export { getTopic, listTopics, subscribeTopics, onTopicCreated } from './messaging/registry.js';
