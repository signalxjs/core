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

/**
 * A cache-marked idempotent read (rfc-server §4.1): the client stub calls
 * it with GET and the endpoint answers with Cache-Control, so the browser
 * and any edge cache can absorb repeats without touching the origin. The
 * result carries rich types (#364) — the browser receives a live Date,
 * Set, and BigInt, not their JSON shadows.
 */
export const getCatalog = serverFn({
    cache: { maxAge: 60, staleWhileRevalidate: 300 },
    handler: async (_rq, section: string) => ({
        section,
        total: 3n,
        tags: new Set(['resumable', 'zero-js']),
        updatedAt: new Date()
    })
});

/**
 * Single-flight boundary refresh (rfc-server §6.3). The vote count lives
 * here — server truth, per-process for the demo. `vote` declares what DATA
 * it invalidates — a same-module fn reference, no component names anywhere
 * — and the endpoint re-renders whichever boundaries recorded a dependency
 * on that data during SSR (`useData(getVotes)` in Poll.tsx) through
 * `createBoundaryRefresh` (see server.mjs / src/dev-refresh.ts). The
 * response carries fresh HTML the client patches in without ever loading
 * the Poll component chunk; the same declaration drives `@sigx/cache`
 * invalidation for hydrated pages.
 */
let votes = 3;

export const getVotes = serverFn(async () => votes);

export const vote = serverFn({
    handler: async () => {
        votes += 1;
        return votes;
    },
    invalidates: () => [getVotes]
});

/** Minimal Standard Schema — the validator IS the boundary (§5.2b): form
 *  fields arrive as attacker-typable strings on the no-JS transport. */
const FeedbackInput = {
    '~standard': {
        version: 1 as const,
        vendor: 'sigx-example',
        validate: (value: unknown) => {
            const message = (value as { message?: unknown })?.message;
            return typeof message === 'string' && message.trim().length > 0
                ? { value: { message: message.trim() } }
                : { issues: [{ message: 'message must not be empty', path: ['message'] }] };
        }
    }
};

/**
 * A FORM TARGET (rfc-server §6.4): `form: true` makes the endpoint accept
 * native form POSTs for this fn (FormData → the validator → 303 back to
 * the page), and the build stamps `action`/`method` onto the <form> in
 * `Feedback.tsx` — so submitting works before the loader runs, with JS
 * disabled, or if it never arrives. With JS, the same fn is called as
 * plain RPC. One function, one validator, two transports.
 */
export const submitFeedback = serverFn({
    form: true,
    input: FeedbackInput,
    handler: async (_rq, input: { message: string }) => {
        console.log(`[resume-example] feedback: ${input.message}`);
        return { received: input.message };
    }
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
