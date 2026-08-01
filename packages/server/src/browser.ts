/**
 * The `browser` export condition of `@sigx/server` — defense in depth
 * (rfc-server §2). The `@sigx/vite/server` transform should have replaced
 * every `serverFn` module with client stubs before a browser bundle exists;
 * if one slipped through (file outside the include pattern, plugin not
 * installed), evaluating it here fails loudly instead of shipping the server
 * body to the client.
 *
 * The error channel is real in every environment — browser code may catch
 * and inspect wire errors with `isServerFnError`.
 */

export { ServerFnError, isServerFnError, type ServerFnErrorShape } from './errors';

/**
 * NO type re-exports here, deliberately (#565).
 *
 * `package.json` routes `"types"` to `./dist/index.d.ts` unconditionally, ABOVE
 * the `browser` condition, so this entry's types are never what a consumer
 * sees — and must not be: the values below are throwing stand-ins whose
 * signatures contradict the real API (`serverFn(): never` takes no arguments
 * and is not generic), so a resolver that did pick them up would fail to
 * compile every `*.server.ts`. One type surface, two value surfaces, exactly
 * as the header says — "the build transform swaps values, never types".
 *
 * What used to sit here was a hand-maintained mirror of 14 type names that no
 * resolver could reach, and it had drifted three behind `index.ts`
 * (`InvalidatePattern`, `ServerFnKeyRef`, `ServerStreamOptions`). Unreachable
 * and unenforced is how it drifted; deleting it is the fix, and
 * `browser-entry.test.ts` now pins the VALUE parity that does matter.
 */

export function serverFn(): never {
    throw new Error(
        '[sigx server] serverFn() reached the browser unextracted — is the @sigx/vite/server ' +
        'plugin configured, and does this file match its include pattern ' +
        '(default **/*.server.{ts,tsx})?'
    );
}

export function serverStream(): never {
    throw new Error(
        '[sigx server] serverStream() reached the browser unextracted — is the @sigx/vite/server ' +
        'plugin configured, and does this file match its include pattern ' +
        '(default **/*.server.{ts,tsx})?'
    );
}

/**
 * Worth more than it looks: a `session.server.ts` exporting only per-request
 * values has no `serverFn` to shout, so without this the setup bodies (cookie
 * secrets, decode logic) could ship on a misconfigured `include`.
 */
export function perRequest(): never {
    throw new Error(
        '[sigx server] perRequest() reached the browser unextracted — is the @sigx/vite/server ' +
        'plugin configured, and does this file match its include pattern ' +
        '(default **/*.server.{ts,tsx})?'
    );
}

export function serverFnPreset(): never {
    throw new Error(
        '[sigx server] serverFnPreset() reached the browser unextracted — is the @sigx/vite/server ' +
        'plugin configured, and does this file match its include pattern ' +
        '(default **/*.server.{ts,tsx})?'
    );
}
