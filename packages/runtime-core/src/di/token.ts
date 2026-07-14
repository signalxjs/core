/**
 * Typed DI tokens for internal seams.
 *
 * The internal seam pattern — a symbol token plus a structurally-typed
 * provide helper (`provideAsyncEngine`, `provideSSRSerializerHandlers`,
 * `provideHydrateDefaults`, `ERROR_SCOPE_TOKEN`) — used to declare plain
 * `unique symbol` tokens, forcing an `as X | undefined` cast at every read.
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
 * (`symbol.description`).
 * @internal
 */
export function createToken<T>(description: string): InjectionToken<T> {
    return Symbol(description) as InjectionToken<T>;
}

/**
 * Read a token's value from a provides Map, typed by the token. Accepts a
 * missing Map so callers can pass optional `provides` fields directly.
 * @internal
 */
export function getProvided<T>(
    provides: Map<symbol, unknown> | null | undefined,
    token: InjectionToken<T>
): T | undefined {
    return provides?.get(token) as T | undefined;
}

/**
 * Write a token's value into a provides Map, typed by the token.
 * @internal
 */
export function setProvided<T>(
    provides: Map<symbol, unknown>,
    token: InjectionToken<T>,
    value: T
): void {
    provides.set(token, value);
}
