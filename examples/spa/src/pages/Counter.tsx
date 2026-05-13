import { component } from 'sigx';

export const Counter = component(({ signal }) => {
    // Object signal: deeply reactive proxy, direct mutation, no `.value`.
    const state = signal({ count: 0 });

    // Primitive signal: single cell, accessed via `.value`.
    const ticks = signal(0);

    return () => (
        <>
            <h1>Counter</h1>
            <p>Two flavours of signal, one primitive: <code>signal()</code>.</p>

            <div class="card">
                <h3>Object signal</h3>
                <p>Count: <strong>{state.count}</strong></p>
                <button onClick={() => state.count++}>Increment</button>
                <p style="color: #888; font-size: 0.9em; margin-top: 0.75rem;">
                    <code>state.count++</code> — direct mutation on the proxy.
                </p>
            </div>

            <div class="card">
                <h3>Primitive signal</h3>
                <p>Ticks: <strong>{ticks.value}</strong></p>
                <button onClick={() => ticks.value++}>Tick</button>
                <p style="color: #888; font-size: 0.9em; margin-top: 0.75rem;">
                    <code>ticks.value++</code> — primitives use <code>.value</code>.
                </p>
            </div>
        </>
    );
}, { name: 'Counter' });
