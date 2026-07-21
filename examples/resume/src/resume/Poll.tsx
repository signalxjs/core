import { component, useData } from 'sigx';
import { getVotes, vote } from '../api.server';

/**
 * Single-flight boundary refresh (rfc-server §6.3): the handler calls a
 * mutation that declares `refreshes: ['Poll']` — the response carries this
 * boundary's freshly re-rendered HTML, and the client swaps it in. The
 * handler never writes a local signal, so the component chunk NEVER loads:
 * the server does the thinking, the client patches pixels.
 *
 * `useData` during SSR (and during the refresh re-render) is an in-process
 * call to the same server function the browser would hit over RPC.
 */
export const Poll = component((ctx) => {
    void ctx;
    const votes = useData('poll:votes', () => getVotes());
    return () => (
        <p>
            <button onClick={() => { void vote(); }}>
                Vote — total {String(votes.value ?? '…')}
            </button>
        </p>
    );
});
