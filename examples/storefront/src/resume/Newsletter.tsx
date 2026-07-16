import { component } from 'sigx';

/**
 * Resumable form: the submit handler calls `preventDefault`, so the
 * transform stamps `data-sigx-pd:submit` and the loader prevents the
 * navigation SYNCHRONOUSLY — before any JavaScript has even loaded — then
 * replays the submit through the handler once it arrives.
 */
export const Newsletter = component((ctx) => {
    const subscribed = ctx.signal(false);
    return () => (
        <form
            class="newsletter"
            onSubmit={(e) => {
                e.preventDefault();
                const email = new FormData(e.target as HTMLFormElement).get('email');
                console.log('[storefront] subscribed:', email);
                subscribed.value = true;
            }}
        >
            {subscribed.value
                ? <p class="thanks">You're in. 🎉</p>
                : <>
                    <input name="email" type="email" required placeholder="you@example.com" />
                    <button type="submit">Subscribe</button>
                </>}
        </form>
    );
});
