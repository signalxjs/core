/**
 * Shared test utilities for ssr-islands tests
 * Re-exports common utilities from server-renderer's test-utils
 * and adds islands-specific helpers.
 */

import { component } from 'sigx';

export {
    cleanupScripts,
    createSSRContainer,
    cleanupContainer,
    ssrElement,
    ssrComponentMarkers,
    ssrIslandMarkers,
    ssrTextSeparator,
    escapeHtml,
    nextTick,
    waitForIdle,
    createVNode,
    createTextVNode,
    createFragmentVNode,
    TestCounter,
    TestCounterWithProps,
    TestText,
    TestWrapper,
    TestMountHook,
    TestButton,
} from '../../server-renderer/__tests__/test-utils';

// `SSRSignalFn` is island-specific (the tracked-signal contract). It used to
// live in server-renderer's test-utils; it now lives in this package's source.
export type { SSRSignalFn } from '../src/server/render-component';
import type { SSRSignalFn } from '../src/server/render-component';

/**
 * Create a mock __SIGX_ISLANDS__ script tag with given island data.
 * Island-specific helper — moved here from server-renderer's test-utils.
 */
export function createIslandDataScript(data: Record<string, any>): HTMLScriptElement {
    const script = document.createElement('script');
    script.id = '__SIGX_ISLANDS__';
    script.type = 'application/json';
    script.textContent = JSON.stringify(data);
    document.head.appendChild(script);
    return script;
}

/**
 * Create a mock __SIGX_STATE__ script tag with given state data.
 * Island-specific helper — moved here from server-renderer's test-utils.
 */
export function createStateScript(data: Record<string, any>): HTMLScriptElement {
    const script = document.createElement('script');
    script.id = '__SIGX_STATE__';
    script.type = 'application/json';
    script.textContent = JSON.stringify(data);
    document.head.appendChild(script);
    return script;
}

/**
 * Component with a named tracked signal for island state-restoration testing.
 * Moved here from server-renderer's test-utils. Uses the islands tracked-signal
 * mechanism (`ctx.signal as SSRSignalFn`), still wired by the islands plugin.
 */
export const TestAsyncCounter = component((ctx) => {
    const ssrSignal = ctx.signal as SSRSignalFn;
    const count = ssrSignal({ value: 0 }, 'count');

    return () => (
        <div class="async-counter">
            <span class="count">{count.value}</span>
        </div>
    );
}, { name: 'TestAsyncCounter' });

/**
 * Parse island data from rendered HTML (__SIGX_ISLANDS__ script)
 */
export function parseIslandData(html: string): Record<string, any> {
    const match = html.match(/<script[^>]*id="__SIGX_ISLANDS__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return {};
    return JSON.parse(match[1]);
}
