import { component } from 'sigx';

export const About = component(() => {
    return () => (
        <>
            <h1>About</h1>
            <p>I built SignalX because I wanted Vue-grade reactivity and TSX-grade types in the same primitive.</p>
            <div class="card">
                <p>This SPA shows the smallest realistic shape:</p>
                <ul>
                    <li>A <code>signal</code> on the route — the nav reacts to it.</li>
                    <li>Three page components, each a <code>{'component(({ signal }) => () => jsx)'}</code>.</li>
                    <li>One <code>{'render(<App />, container)'}</code> call to mount.</li>
                </ul>
                <p>No router package, no store, no plugins — just <code>sigx</code>.</p>
            </div>
        </>
    );
});
