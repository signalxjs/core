import { component, useData, useHead } from 'sigx';

/**
 * The router shape: a page whose ENTIRE render is a streamed `useData`
 * region, reached through pass-through ancestors (#492).
 *
 * Every other page here renders its content as one of several siblings inside
 * `<main>`, so a page's content is never the `<div data-async-placeholder>`
 * wrapper itself. That is the one shape a real router app always has — the
 * page component sits under `RouterView`/`lazy()`, which render nothing of
 * their own — and it is the shape that broke: the ancestors' `<!--$c:N-->`
 * markers sit outside the wrapper, so an ancestor that descended into it
 * latched a DESCENDANT's marker as its anchor and re-mounted anything it
 * rendered after the streamed child.
 *
 * `Panel` is here on purpose: it puts a nested marker at the top level of the
 * streamed region, which is what makes the ancestors' scans find something
 * wrong to latch onto. `.rs-tail` is the sibling that used to be duplicated.
 */

async function fetchPayload(): Promise<{ rows: number }> {
    await new Promise(r => setTimeout(r, 120));
    return { rows: 3 };
}

const Panel = component(() => () => (
    <div class="card">
        <h3 style="margin-top: 0;">Panel</h3>
        <p>A child component INSIDE the streamed region — its trailing marker
            lands inside the placeholder wrapper.</p>
    </div>
));

/** The page: its whole render is the streamed region. */
const StreamPage = component(() => {
    const payload = useData('router-stream', fetchPayload);
    return () => (
        <>
            <Panel />
            <p class="rs-tail">
                {payload.match({
                    pending: () => 'Loading…',
                    ready: (p) => `Streamed ${p.rows} rows — this paragraph is a SIBLING of the streamed child.`
                })}
            </p>
        </>
    );
});

/** Stands in for `RouterView` / a `lazy()` route: renders only the page. */
const RouteHost = component(() => () => <StreamPage />);

export const RouterStream = component(() => {
    useHead({ title: 'Router stream' });
    // The layout renders the routed page AND content after it. That trailing
    // sibling is the visible half of #492: an ancestor that descends into the
    // placeholder hydrates everything it renders after the streamed child
    // against the WRAPPER's contents, and mounts a second copy of it inside.
    return () => (
        <>
            <RouteHost />
            <p class="rs-after">Layout content rendered AFTER the routed page.</p>
        </>
    );
});
