import { component } from 'sigx';

/**
 * A read-only handler: it reads scope state and logs, but never writes a
 * signal — so this component's chunk NEVER loads. Watch the network panel:
 * clicking loads only the shared handlers chunk.
 */
export const Tracker = component<{ campaign: string }>((ctx) => {
    const views = ctx.signal(1);
    return () => (
        <p>
            <button onClick={() => console.log('[tracker]', ctx.props.campaign, 'views:', views.value)}>
                Log campaign "{ctx.props.campaign}" (check the console — no component chunk loads)
            </button>
        </p>
    );
});
