import { component, useData } from 'sigx';
import { getVotes, vote } from '../api.server';

/**
 * Single-flight boundary refresh (rfc-server §6.3): `useData(getVotes)`
 * records this boundary's dependency on the votes data during SSR; the
 * button calls a mutation whose `invalidates: () => [getVotes]` names the
 * same data — so the response carries this boundary's freshly re-rendered
 * HTML and the client swaps it in. No component names anywhere, and a
 * rename can't break the link. The handler never writes a local signal, so
 * the component chunk NEVER loads: the server does the thinking, the
 * client patches pixels.
 *
 * `useData(fn)` during SSR (and during the refresh re-render) is an
 * in-process call to the same server function the browser would hit over
 * RPC — the key (`'["<stableId>#getVotes"]'`) is identical on both sides.
 */
export const Poll = component((ctx) => {
    void ctx;
    const votes = useData(getVotes);
    return () => (
        <p>
            <button onClick={() => { void vote(); }}>
                Vote — total {String(votes.value ?? '…')}
            </button>
        </p>
    );
});
