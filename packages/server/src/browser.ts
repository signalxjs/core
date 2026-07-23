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
export type { ServerFnContext } from './context';
export type {
    ServerFnCallOptions,
    ServerFnCallable,
    ServerFnGuard,
    ServerFnInfo,
    ServerFnInvoke,
    ServerStreamCallOptions,
    ServerStreamCallable,
    StandardSchemaV1,
    WrappedServerFn
} from './types';
export type { ServerFnOptions, ServerFnReadCache } from './index';

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
