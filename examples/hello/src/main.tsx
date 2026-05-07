import { component, render } from 'sigx';

const Counter = component(({ signal }) => {
    const state = signal({ count: 0 });

    return () => (
        <div class="card">
            <img src="/signalx-logo-150x119.png" alt="SignalX" width="150" height="119" />
            <h1>Hello SignalX</h1>
            <p>Count: {state.count}</p>
            <button onClick={() => state.count++}>Increment</button>
        </div>
    );
});

render(<Counter />, document.getElementById('app')!);
