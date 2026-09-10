/**
 * Duplicate-copy guard (rfc-1.0 §3.4, #633 phase 1).
 *
 * `@sigx/reactivity` and `@sigx/runtime-core` each carry per-process state
 * that must exist exactly once (the tracking context and batch queue here;
 * the current instance, app contexts and DI tokens there). Two copies of
 * either — two installed versions, a bundler that inlined one — split that
 * state in half: signals created by one copy never trigger effects tracked by
 * the other, and nothing says so. This guard makes it say so.
 *
 * Each package stamps one hidden control seam at module init (`assertSingleCopy`,
 * called at the top level of the module that owns the state). A later
 * evaluation from a DIFFERENT file finds the stamp and, in dev, throws naming
 * both versions and both module URLs; in prod it warns once and continues —
 * a page that half-works beats a blank one, and the dev throw is what catches
 * it before deploy.
 *
 * The identity is the module FILE. The same file evaluating again is not a
 * second copy but a re-evaluation — an in-process Vite `server.restart()`,
 * a browser HMR re-import (`…?t=<ts>`), `vi.resetModules()` — and restamps
 * silently. Registered in `docs/seams.md`, which also states what this cannot
 * see: one file loaded twice into one realm (#425's SSR-runner-plus-Node
 * split) is invisible here and stays `hasForeignToken`'s job.
 */

/** The seam's value — what a second copy reads and what the accessor returns. */
export interface CopyStamp {
    /** The stamping copy's version (`__SIGX_VERSION__`; `'unknown'` when unbundled). */
    readonly version: string;
    /** The stamping module's `import.meta.url`, `''` where unavailable (an IIFE bundle). */
    readonly url: string;
    /** Prod once-latch, carried forward across restamps so a third copy stays quiet. */
    warned?: boolean;
}

export type CopyStampKey = '__SIGX_REACTIVITY__' | '__SIGX_RUNTIME_CORE__';

/**
 * The seams' shape at their single accessor — the canonical contract lives
 * in `docs/seams.md`. A local structural type, never a `declare global`.
 */
type CopyStampHost = { [K in CopyStampKey]?: CopyStamp };

/**
 * Vite appends `?t=<ts>` to an HMR re-import and `?v=<hash>` to a prebundled
 * dep; the file is the identity (the normalisation `@sigx/vite`'s dev pin
 * applies to its own ids).
 */
function moduleFile(url: string): string {
    return url.replace(/[?#].*$/, '');
}

/** The one accessor for both copy stamps. `undefined` before the package evaluated. */
export function readCopyStamp(key: CopyStampKey): CopyStamp | undefined {
    return (globalThis as CopyStampHost)[key];
}

/**
 * Stamp `key` for the copy of `pkg` evaluating now, or fail loudly if a copy
 * from another file already did. Called once per package, at module init.
 *
 * The seam name is passed in rather than derived here, so the literal occurs
 * only at the two call sites: `verify-pack` greps a consumer's production
 * bundle for it to prove the top-level call survived tree-shaking, and this
 * function is exported from `/internals` — alive whether or not the call is.
 */
export function assertSingleCopy(key: CopyStampKey, pkg: string, version: string, url: string): void {
    const host = globalThis as CopyStampHost;
    const prev = host[key];
    let warned = prev?.warned;
    if (prev && moduleFile(prev.url) !== moduleFile(url)) {
        const detail =
            `${prev.version} at ${prev.url || '<unknown url>'} and ` +
            `${version} at ${url || '<unknown url>'}`;
        if (__DEV__) {
            // Name the symptom the split actually produces for THIS package.
            const symptom = pkg === '@sigx/reactivity'
                ? 'Signals created by one copy are invisible to effects tracked by the other.'
                : 'Components, app contexts and DI tokens of one copy are invisible to the other.';
            throw new Error(
                `[sigx] Two copies of ${pkg} are loaded: ${detail}. ${symptom} ` +
                'Install `sigx` once in the app and keep every `@sigx/*` package a peer of it ' +
                '(docs/rfc-1.0.md §3, docs/seams.md).'
            );
        }
        if (!warned) {
            warned = true;
            console.warn(`[sigx] Two copies of ${pkg} are loaded: ${detail}.`);
        }
    }
    // Every write is a full descriptor: a partial one would preserve the
    // `enumerable: true` of a property an older copy created by assignment,
    // and `enumerable: false` is spelled even though it is the default for a
    // new property (docs/seams.md, "Adding a seam").
    Object.defineProperty(host, key, {
        value: { version, url, warned } satisfies CopyStamp,
        writable: true,
        configurable: true,
        enumerable: false
    });
}
