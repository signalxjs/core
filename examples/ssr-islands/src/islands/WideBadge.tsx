import { component } from 'sigx';

/**
 * client:media — hydrates only when the media query matches (immediately if
 * it already does, or the moment the viewport changes to match). Narrow
 * viewports never pay for this island's JavaScript.
 */
export const WideBadge = component((ctx) => {
    const state = ctx.signal({ clicks: 0 });
    return () => (
        <p>
            <button onClick={() => state.clicks++}>wide-screen clicks: {state.clicks}</button>{' '}
            <span class="hint">inert below 768px — resize to hydrate</span>
        </p>
    );
}, { name: 'WideBadge' });
