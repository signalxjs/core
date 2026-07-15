import { component } from 'sigx';

/**
 * client:only — setup NEVER runs on the server (so touching `navigator`
 * here is safe). The server emits the skip-boundary wrapper with the
 * fallback markup; the client mounts this component fresh on load.
 */
export const BrowserInfo = component((ctx) => {
    const state = ctx.signal({ shown: false });
    const cores = navigator.hardwareConcurrency ?? '?';
    const lang = navigator.language;
    return () => (
        <p>
            your browser reports <strong>{String(cores)}</strong> cores, language <strong>{lang}</strong>{' '}
            <button onClick={() => { state.shown = !state.shown; }}>
                {state.shown ? 'hide' : 'show'} user agent
            </button>
            {state.shown && <span class="hint"> {navigator.userAgent}</span>}
        </p>
    );
}, { name: 'BrowserInfo' });
