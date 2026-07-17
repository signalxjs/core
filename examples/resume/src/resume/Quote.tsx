import { component } from 'sigx';
import { getQuote } from '../api.server';

/**
 * Resumability + server functions (rfc-server §1.3): the click handler is a
 * QRL, and the imported `getQuote` is a legal capture — in the browser it
 * resolves to a fetch stub, so the first click loads the tiny handler
 * chunk, POSTs to `/_sigx/fn/<symbol>`, and the write upgrades the
 * boundary. The server body (and anything it imports) never ships.
 */
export const Quote = component((ctx) => {
    const quote = ctx.signal('click for wisdom');
    const asked = ctx.signal(0);
    return () => (
        <p>
            <button
                onClick={async () => {
                    quote.value = await getQuote(asked.value);
                    asked.value++;
                }}
            >
                ask the server
            </button>
            {' '}
            <em>{quote.value}</em>
        </p>
    );
});
