/**
 * The vnode brand: how the runtime tells its OWN vnodes from a user object
 * that merely has the same shape (#274, rfc-1.0 §4.7).
 *
 * Every vnode the runtime creates carries `[VNODE]: true` — in the literal
 * at each creation site in this package (`jsx()`, `normalizeSubTree`, the
 * component factory, `render()`), via `markVNode` for the few built by
 * `@sigx/server-renderer`, and `hydrateComponent` marks the root it is
 * handed so a pack that builds one by hand is covered too. The props
 * accessor then hands back RAW exactly the objects that carry the brand;
 * a plain `{ type, props, children, dom }` from user data stays reactive.
 *
 * Module-local `Symbol()`, never `Symbol.for`, and not exported from the
 * package root: a second copy of the runtime must not recognise this one's
 * vnodes (rfc-1.0 §3.4), and nothing downstream gets to spell the brand.
 * Deliberately dependency-free.
 */

export const VNODE: unique symbol = Symbol('sigx:vnode');

/** @internal Stamp an object built outside this package as a runtime vnode. */
export function markVNode<T extends object>(vnode: T): T {
    (vnode as any)[VNODE] = true;
    return vnode;
}

/** @internal Whether `v` (a raw object) is a vnode the runtime created. */
export function isVNode(v: object): boolean {
    return (v as any)[VNODE] === true;
}
