import { component } from 'sigx';

/**
 * client:interaction — this island stays inert HTML until the first
 * pointerdown/keydown/touchstart/focusin anywhere in it, then hydrates and
 * handles that interaction's follow-ups. (The triggering event itself is
 * not replayed — a documented trade-off of the strategy.)
 */
export const Echo = component((ctx) => {
    const state = ctx.signal({ text: '' });
    return () => (
        <p>
            <input
                placeholder="click, then type…"
                value={state.text}
                onInput={(e) => {
                    state.text = (e.target as HTMLInputElement).value;
                }}
            />{' '}
            {state.text ? <strong>{state.text.toUpperCase()}</strong> : <span class="hint">echoes UPPERCASE once hydrated</span>}
        </p>
    );
}, { name: 'Echo' });
