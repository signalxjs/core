import { component } from 'sigx';

/**
 * The classic island. Server-renders its initial count; the button works
 * from the moment its hydration strategy fires — which is the whole demo:
 * the same component hydrates at three different times on this page,
 * decided per USE by the client:* directive, not by the component.
 */
export const Counter = component<{ label: string; initial?: number }>((ctx) => {
    // Island state transfers automatically: the vite transform keys this
    // signal by its declaration name ("count"), per island instance.
    const count = ctx.signal(ctx.props.initial ?? 0);
    return () => (
        <p>
            <button onClick={() => count.value++}>+1</button>{' '}
            {ctx.props.label}: <strong>{count.value}</strong>
        </p>
    );
}, { name: 'Counter' });
