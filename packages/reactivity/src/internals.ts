/**
 * @sigx/reactivity internal APIs
 * 
 * ⚠️ These are low-level primitives for building custom renderers and plugins.
 * They are NOT part of the public API and may change without notice.
 * 
 * @internal
 */
export { track, trigger, cleanup } from './effect';
