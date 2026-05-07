import { component } from 'sigx';

export const Counter = component(({ signal }) => {
    const state = signal({ count: 0 });

    return () => (
        <>
            <h1>Counter</h1>
            <p>The server emits this markup with <code>count: 0</code>. After hydration, the button works — proving event handlers re-attached.</p>
            <div class="card">
                <p>Count: <strong>{state.count}</strong></p>
                <button onClick={() => state.count++}>Increment</button>
            </div>
        </>
    );
});
