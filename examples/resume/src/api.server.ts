import { serverFn, ServerFnError } from '@sigx/server';

/**
 * A server module (rfc-server §1.1): this whole file only ever runs on the
 * server — the client build swaps it for typed fetch stubs. Anything
 * imported here (database clients, secrets, node: builtins) never reaches
 * the browser.
 */

const QUOTES = [
    'The server thinks, the client patches pixels.',
    'Named = transferred.',
    'No closure serialization, ever.',
    'Every server function is a public endpoint — validate accordingly.'
];

/**
 * Called IN-PROCESS during SSR (see `entry-server.tsx`) — no HTTP hop, no
 * fetch stub. `rq.request`/`rq.url` are the DOCUMENT request: the handler
 * opened an ambient scope around the render (rfc-server §7 v1.1), which needs
 * no wiring beyond the `@sigx/server/server` import this app's entry already
 * has. Both of these used to throw here while the identical code worked over
 * RPC.
 */
export const requestSummary = serverFn(async (rq) => {
    return `SSR request: ${rq.request.method} ${rq.url.pathname}`;
});

export const getQuote = serverFn(async (rq, index: number) => {
    if (!Number.isInteger(index)) {
        throw new ServerFnError(400, 'index must be an integer');
    }
    // Proof this ran server-side, and WHERE: `navigator.userAgent` NAMES the
    // runtime on every tier — `Deno/…`, `Bun/…`, `Cloudflare-Workers`,
    // `Node.js/…` (Node ≥ 21; the fallback covers Node 20). It replaced a
    // `process.version` sniff, which stopped telling workerd apart from Node
    // the moment the worker enabled nodejs_compat.
    const runtime =
        globalThis.navigator?.userAgent ?? `Node.js/${globalThis.process?.versions?.node ?? '?'}`;
    return `${QUOTES[Math.abs(index) % QUOTES.length]} (via ${runtime})`;
});
