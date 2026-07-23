/**
 * Typed DI tokens for internal seams.
 *
 * The internal seam pattern — a symbol token plus a structurally-typed
 * provide helper (`provideAsyncEngine`, `provideSSRSerializerHandlers`,
 * `provideHydrateDefaults`) — used to declare plain `unique symbol` tokens,
 * forcing an `as X | undefined` cast at every read. The same applied to bare
 * tokens set directly on a provides Map (`ERROR_SCOPE_TOKEN`).
 * An `InjectionToken<T>` is still a plain symbol at runtime, but carries its
 * value type at the type level so `getProvided`/`setProvided` (and the typed
 * `lookupProvided` overload) infer `T` at the call site.
 *
 * Tokens are created with `Symbol(description)`, deliberately NOT
 * `Symbol.for(...)`: DI identity must live in ONE module graph. A registry
 * symbol would keep resolving across duplicated copies of this package and
 * silently mask the dual-module-graph misconfiguration that
 * `@sigx/vite`'s `ssr.noExternal` handling exists to prevent — with added
 * cross-version collision risk. A duplicated graph should fail loudly
 * (provides not found), not blur versions together.
 *
 * Internal only — exported via `sigx/internals`, not the public API.
 */

/**
 * A DI token that carries its value type. Runtime value: a plain `symbol`
 * (assignable wherever a symbol is expected); the phantom property exists
 * only at the type level.
 * @internal
 */
export type InjectionToken<T> = symbol & { readonly __sigxTokenType?: T };

/**
 * Create a typed DI token. `description` names the token in diagnostics
 * (`symbol.description`). A typed alias of `Symbol` — zero runtime wrapper.
 * @internal
 */
export const createToken = Symbol as unknown as <T>(description: string) => InjectionToken<T>;

/**
 * Read a token's value from a provides Map, typed by the token. Accepts a
 * missing Map so callers can pass optional `provides` fields directly.
 * @internal
 */
export const getProvided = <T>(
    provides: Map<symbol, unknown> | null | undefined,
    token: InjectionToken<T>
): T | undefined => provides?.get(token) as T | undefined;

/**
 * Write a token's value into a provides Map, typed by the token.
 * @internal
 */
export const setProvided = <T>(
    provides: Map<symbol, unknown>,
    token: InjectionToken<T>,
    value: T
): void => void provides.set(token, value);

/**
 * Was this token provided by a DIFFERENT copy of the module that defines it?
 *
 * The "fail loudly" half of the one-module-graph rule above. A miss on a
 * provides Map is ambiguous — nothing provided it, or something provided it
 * through a second copy of this package — and every seam reads the ambiguity
 * as the former, so a duplicated graph degrades to defaults in silence. That
 * is how #425 shipped a plugin-less SSR render: `getSSRPlugins()` returned
 * `[]` and the renderer simply believed the app had installed no packs.
 *
 * A key carrying this token's description that is NOT this token can only
 * exist if two copies of the defining module are live, so this identifies a
 * duplicated graph outright rather than guessing at one. Call it on the MISS
 * path only, from `__DEV__` blocks — never from `getProvided`, which is the
 * hot injection path and where a miss is ordinarily legitimate.
 *
 * @internal
 */
export const hasForeignToken = (
    provides: Map<symbol, unknown> | null | undefined,
    token: InjectionToken<unknown>
): boolean => {
    if (!provides || provides.has(token)) return false;
    for (const key of provides.keys()) {
        if (key.description === token.description) return true;
    }
    return false;
};
