import { component } from 'sigx';
import { submitFeedback } from '../api.server';

/**
 * Zero-JS form actions (rfc-server §6.4): the build sees this submit
 * handler capture the form-marked `submitFeedback` and stamps a real
 * `action="/_sigx/fn/<symbol>" method="post"` (plus `data-sigx-pd:submit`)
 * onto the <form>. Native HTML validation (`required`) is the no-JS first
 * line; the server-side validator is the real boundary.
 *
 * - JS loaded: the delegation cancels the native submit and this handler
 *   runs — plain RPC, rendered inline.
 * - JS off / not yet loaded: the browser POSTs the form natively; the
 *   endpoint validates, runs the same fn, and 303s back to this page.
 */
export const Feedback = component((ctx) => {
    const status = ctx.signal('');
    return () => (
        <form
            onSubmit={async (e) => {
                e.preventDefault();
                const form = e.target as HTMLFormElement;
                const input = Object.fromEntries(new FormData(form)) as { message: string };
                const result = await submitFeedback(input);
                status.value = `received: "${result.received}" (via RPC)`;
                form.reset();
            }}
        >
            <input name="message" placeholder="tell us something" required />
            <button type="submit">send</button> <em>{status.value}</em>
        </form>
    );
});
