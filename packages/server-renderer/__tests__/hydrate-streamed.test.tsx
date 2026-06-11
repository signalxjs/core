/**
 * Full streamed-SSR → hydration round trip for async (keyed useAsync)
 * components.
 *
 * Streaming mode wraps async components in a <div data-async-placeholder>
 * wrapper that is NOT part of the component's vnode tree. Hydration must
 * descend into the wrapper transparently — failing to do so makes the walk
 * mismatch at the wrapper and mount a duplicate copy of the content below
 * the server-rendered DOM (regression: duplicated <h1> in examples/spa-ssr).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, useAsync } from 'sigx';
import { createSSR, stateSerializationPlugin } from '../src/index';
import { hydrateComponent } from '../src/client/hydrate-component';
import { createSSRContainer, cleanupContainer, nextTick } from './test-utils';

async function collectStream(stream: ReadableStream<string>): Promise<string> {
    const reader = stream.getReader();
    let out = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += value;
    }
    return out;
}

/** Split streamed output into the shell (before the first script) and scripts. */
function splitShell(html: string): { shell: string; scripts: string } {
    const idx = html.indexOf('\n<script>');
    const i = idx >= 0 ? idx : html.indexOf('<script>');
    return { shell: html.slice(0, i), scripts: html.slice(i) };
}

/** Do what the browser would: install state blobs and apply $SIGX_REPLACE swaps. */
function executeStreamScripts(container: HTMLElement, scripts: string): void {
    for (const m of scripts.matchAll(/window\.__SIGX_ASYNC__=Object\.assign\(window\.__SIGX_ASYNC__\|\|\{\},(\{.*?\})\);/g)) {
        const blob = JSON.parse(m[1]);
        (globalThis as any).__SIGX_ASYNC__ = Object.assign((globalThis as any).__SIGX_ASYNC__ || {}, blob);
    }
    for (const m of scripts.matchAll(/\$SIGX_REPLACE\((\d+), ("(?:[^"\\]|\\.)*")\)/g)) {
        const placeholder = container.querySelector(`[data-async-placeholder="${m[1]}"]`);
        if (placeholder) placeholder.innerHTML = JSON.parse(m[2]);
    }
}

function makeHomeLike() {
    const clientLoad = vi.fn(async () => ({ stars: 0 }));
    const Page = (load: () => Promise<{ stars: number }>) => component(() => {
        const stats = useAsync('home-stats', load);
        return () => (
            <>
                <h1>Server-rendered</h1>
                <p class="intro">intro text</p>
                <div class="card">{stats.value ? `stars: ${(stats.value as any).stars}` : 'Loading stats…'}</div>
            </>
        );
    }, { name: 'HomeLike' });
    return { Page, clientLoad };
}

describe('hydrating streamed async components (placeholder wrappers)', () => {
    let container: HTMLDivElement;

    afterEach(() => {
        if (container) cleanupContainer(container);
        delete (globalThis as any).__SIGX_ASYNC__;
    });

    it('hydrates inside the placeholder without duplicating content', async () => {
        const { Page } = makeHomeLike();
        const Server = Page(() => new Promise<{ stars: number }>(r => setTimeout(() => r({ stars: 42 }), 5)));

        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await collectStream(ssr.renderStream((Server as any)({})));

        // Build the post-stream DOM exactly as a browser would see it
        const { shell, scripts } = splitShell(html);
        container = createSSRContainer(shell);
        executeStreamScripts(container, scripts);

        // Sanity: replaced content present, exactly once
        expect(container.querySelectorAll('h1').length).toBe(1);
        expect(container.textContent).toContain('stars: 42');

        // Hydrate — client component identical to the server one
        const { Page: ClientPage, clientLoad } = makeHomeLike();
        const Client = ClientPage(() => clientLoad());
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        hydrateComponent(
            { type: Client, props: {}, key: null, children: [], dom: null },
            container.firstChild, container
        );
        await nextTick();
        warn.mockRestore();

        // THE bug: a mismatch at the wrapper div used to mount a fresh copy
        // below the SSR content — duplicated <h1>.
        expect(container.querySelectorAll('h1').length).toBe(1);
        expect(container.querySelectorAll('.card').length).toBe(1);
        expect(container.textContent).toContain('stars: 42');
        expect(clientLoad).not.toHaveBeenCalled(); // state restored, no refetch
    });
});
