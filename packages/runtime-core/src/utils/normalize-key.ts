/**
 * Normalize a vnode key at creation time. `??` (not `||`) at call sites so
 * falsy keys (`key={0}`, `key=""`) actually key the element; numbers coerce
 * to strings once here so the keyed diff compares with pure `===`.
 */
export function normalizeKey(k: unknown): string | null {
    return k == null ? null : typeof k === 'string' ? k : String(k);
}
