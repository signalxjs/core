import { component } from 'sigx';

/**
 * Fully resumable: the click handler captures only the named signal, so the
 * transform extracts it into a QRL chunk. Clicking loads that tiny chunk
 * (not this file!), the write triggers upgrade-on-write, and only then does
 * this component's chunk load and hydrate.
 */
export const Counter = component<{ label: string; initial?: number }>((ctx) => {
    const count = ctx.signal(ctx.props.initial ?? 0);
    return () => (
        <p>
            <button onClick={() => count.value++}>
                {ctx.props.label}: {count.value}
            </button>
        </p>
    );
});
