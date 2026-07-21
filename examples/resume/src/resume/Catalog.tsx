import { component } from 'sigx';
import { getCatalog } from '../api.server';

/**
 * A cache-marked read from a resumed handler (rfc-server §4.1 + #364): the
 * click issues GET /_sigx/fn/<symbol>?args=… — cacheable by the browser
 * and any edge — and the values arrive as LIVE instances. The instanceof/
 * typeof checks below run in the browser on the revived result; "live
 * instances OK" rendering is the end-to-end proof the wire preserved them.
 */
export const Catalog = component((ctx) => {
    const status = ctx.signal('click to fetch the catalog over GET');
    return () => (
        <p>
            <button
                onClick={async () => {
                    const cat = await getCatalog('quotes');
                    const ok =
                        cat.updatedAt instanceof Date &&
                        cat.tags instanceof Set &&
                        typeof cat.total === 'bigint';
                    status.value = ok
                        ? `live instances OK — ${cat.tags.size} tags, total ${cat.total}n, ` +
                          `updated ${cat.updatedAt.toISOString()}`
                        : 'instances lost their types!';
                }}
            >
                fetch catalog (GET)
            </button>{' '}
            <em>{status.value}</em>
        </p>
    );
});
