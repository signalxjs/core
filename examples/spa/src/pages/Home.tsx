import { component } from 'sigx';

export const Home = component((ctx) => {
    const detailsVisible = ctx.signal(true);

    return () => (
        <>
            <h1>Welcome</h1>
            <p>This is a tiny SignalX SPA. It uses hash routing — try the nav, or change the URL hash directly.</p>
            <div class="card">
                <button onClick={() => (detailsVisible.value = !detailsVisible.value)}>
                    {detailsVisible.value ? 'Hide' : 'Show'} the page list
                </button>
                {/* use:show toggles display — the element stays in the DOM
                    (state preserved), unlike conditional rendering. The
                    directive is built in: no registration, and typing
                    `use:` autocompletes it. */}
                <div use:show={detailsVisible.value}>
                <p>Pages:</p>
                <ul>
                    <li><a href="#/">Home</a> — this page</li>
                    <li><a href="#/counter">Counter</a> — both signal flavours side by side</li>
                    <li><a href="#/forms">Forms</a> — <code>model</code> bindings, <code>Define.Prop</code>, <code>Define.Event</code>, <code>Define.Model</code></li>
                    <li><a href="#/about">About</a> — what this example is</li>
                </ul>
                </div>
            </div>
        </>
    );
}, { name: 'Home' });
