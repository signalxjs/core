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

export const getQuote = serverFn(async (rq, index: number) => {
    if (!Number.isInteger(index)) {
        throw new ServerFnError(400, 'index must be an integer');
    }
    // Proof this ran server-side: process.version does not exist in a browser.
    return `${QUOTES[Math.abs(index) % QUOTES.length]} (via node ${process.version})`;
});
