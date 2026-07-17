/**
 * ServerFnError — the deliberate error channel across the server-function
 * boundary (rfc-server §4/§5). A thrown ServerFnError passes through the
 * wire verbatim (`{ status, message, data }`); every other throw is masked
 * to a generic 500 in production so internals never leak.
 *
 * Identified by BRAND, never `instanceof`: in dev the Vite module runner and
 * Node can hold two copies of this module (the module-graph split documented
 * in `packages/vite/src/ssr.ts`), and the client stub re-creates errors from
 * the wire without this class.
 */
export class ServerFnError extends Error {
    readonly __sigxServerFnError = true;
    readonly status: number;
    readonly data?: unknown;

    constructor(status: number, message: string, data?: unknown) {
        super(message);
        this.name = 'ServerFnError';
        this.status = status;
        this.data = data;
    }
}

/** The shape a branded server-function error is guaranteed to carry. */
export interface ServerFnErrorShape extends Error {
    status: number;
    data?: unknown;
}

/**
 * Brand check for server-function errors — matches both `ServerFnError`
 * instances and the errors the client stub re-creates from the wire.
 */
export function isServerFnError(error: unknown): error is ServerFnErrorShape {
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as { __sigxServerFnError?: unknown }).__sigxServerFnError === true
    );
}
