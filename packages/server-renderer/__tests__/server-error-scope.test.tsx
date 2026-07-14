/**
 * errorScope on the server (rfc-ssr-platform §2.2): a throw below a scope
 * renders the scope's fallback(e, retry) HTML in place of the subtree —
 * the same visual contract as the client — with the partial subtree output
 * rewound; the boundary is marked in the table so the client hydrator seeds
 * the scope errored and retry() performs a real remount after hydration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component, errorScope, signal } from 'sigx';
import { createSSR } from '../src/index';
import { hydrate } from '../src/client/hydrate-core';
import {
    cleanupPendingHydrations,
    invalidateMarkerIndex
} from '../src/client/boundary-hydrator';
import { clearClientPlugins } from '../src/client/hydrate-context';
import type { SSRBoundaryRecord } from '../src/boundary';
import { createSSRContainer, cleanupContainer, nextTick } from './test-utils';

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

function parseBoundaryTable(html: string): Record<string, SSRBoundaryRecord> {
    const match = html.match(
        /window\.__SIGX_BOUNDARIES__=Object\.assign\(Object\.create\(null\),window\.__SIGX_BOUNDARIES__,([\s\S]*?)\);<\/script>/
    );
    return match ? JSON.parse(match[1]) : {};
}

const Thrower = component(() => {
    throw new Error('deep boom');
}, { name: 'Thrower' });

describe('server errorScope — fallback in place', () => {
    it('a descendant throw renders the scope fallback, rewinding the partial subtree', async () => {
        const Middle = component(() => () => (
            <section class="middle">
                <p>partial content before the throw</p>
                {(Thrower as any)({})}
            </section>
        ), { name: 'Middle' });

        const Scoped = component(() => {
            errorScope({ fallback: (e, retry) => <div class="oops">{e.message}<button onClick={retry}>retry</button></div> });
            return () => <main>{(Middle as any)({})}</main>;
        }, { name: 'Scoped' });

        const html = await createSSR().render((Scoped as any)({}));

        // Fallback in place of the WHOLE scoped subtree
        expect(html).toContain('<div class="oops">deep boom<button>retry</button></div>');
        // The partial subtree output was rewound
        expect(html).not.toContain('partial content');
        expect(html).not.toContain('<main>');
        // The scope owner's trailing marker survives (hydration anchor)
        expect(html).toContain('<!--$c:1-->');
        // No default error artifacts
        expect(html).not.toContain('ssr-error');
    });

    it('the owner component\'s own render throw is caught by its own scope', async () => {
        const SelfScoped = component(() => {
            errorScope({ fallback: (e) => <i class="own">{e.message}</i> });
            return () => {
                throw new Error('own boom');
            };
        }, { name: 'SelfScoped' });

        const html = await createSSR().render((SelfScoped as any)({}));
        expect(html).toContain('<i class="own">own boom</i>');
        expect(html).not.toContain('ssr-error');
    });

    it('nested scopes: the inner scope wins; outer content stays', async () => {
        const Inner = component(() => {
            errorScope({ fallback: () => <em class="inner-fb">inner caught</em> });
            return () => <span>{(Thrower as any)({})}</span>;
        }, { name: 'Inner' });

        const Outer = component(() => {
            errorScope({ fallback: () => <em class="outer-fb">outer caught</em> });
            return () => <div class="outer-content">{(Inner as any)({})}</div>;
        }, { name: 'Outer' });

        const html = await createSSR().render((Outer as any)({}));
        expect(html).toContain('inner caught');
        expect(html).not.toContain('outer caught');
        expect(html).toContain('<div class="outer-content">');
    });

    it('siblings outside the scope render normally', async () => {
        const Scoped = component(() => {
            errorScope({ fallback: () => <b>caught</b> });
            return () => (Thrower as any)({});
        }, { name: 'Scoped' });
        const Page = component(() => () => (
            <div>
                <header>before</header>
                {(Scoped as any)({})}
                <footer>after</footer>
            </div>
        ), { name: 'Page' });

        const html = await createSSR().render((Page as any)({}));
        expect(html).toContain('<header>before</header>');
        expect(html).toContain('<b>caught</b>');
        expect(html).toContain('<footer>after</footer>');
    });

    it('the scope onError observer fires; the request-level onError does not', async () => {
        const observer = vi.fn();
        const requestOnError = vi.fn();
        const Scoped = component(() => {
            errorScope({ onError: observer, fallback: () => <b>caught</b> });
            return () => (Thrower as any)({});
        }, { name: 'Scoped' });

        await createSSR().render((Scoped as any)({}), { onError: requestOnError });
        expect(observer).toHaveBeenCalledOnce();
        expect((observer.mock.calls[0] as any)[0].message).toBe('deep boom');
        expect(requestOnError).not.toHaveBeenCalled();
    });

    it('a throwing fallback falls back to the default error path', async () => {
        const Scoped = component(() => {
            errorScope({ fallback: () => { throw new Error('fallback boom'); } });
            return () => (Thrower as any)({});
        }, { name: 'Scoped' });

        const html = await createSSR().render((Scoped as any)({}));
        expect(html).toContain('<!--ssr-error:1-->');
    });

    it('marks the boundary table with the caught error for hydration', async () => {
        const Scoped = component(() => {
            errorScope({ fallback: (e) => <b>{e.message}</b> });
            return () => (Thrower as any)({});
        }, { name: 'Scoped' });

        const html = await createSSR().render((Scoped as any)({}));
        const records = parseBoundaryTable(html);
        expect(records['1']).toMatchObject({
            hydrate: 'load',
            errorScope: { message: 'deep boom' }
        });
    });
});

describe('server errorScope — client retry after hydration', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        delete (window as any).__SIGX_BOUNDARIES__;
        clearClientPlugins();
        cleanupPendingHydrations();
        invalidateMarkerIndex();
    });

    afterEach(() => {
        if (container) cleanupContainer(container);
        delete (window as any).__SIGX_BOUNDARIES__;
        cleanupPendingHydrations();
        invalidateMarkerIndex();
    });

    it('seeds the client scope errored: the fallback hydrates and retry() remounts the subtree', async () => {
        // The scoped component whose subtree failed on the server but
        // succeeds on the client (e.g. a server-only failure).
        const Scoped = component(() => {
            errorScope({
                fallback: (e, retry) => <button class="retry" onClick={retry}>{e.message}</button>
            });
            const n = signal(0);
            return () => <output class="fine">{n.value}</output>;
        }, { name: 'Scoped' });

        // Server output: the scope fallback in place + marker; the table
        // carries the errorScope marking.
        container = createSSRContainer('<button class="retry">server boom</button><!--$c:1-->');
        (window as any).__SIGX_BOUNDARIES__ = Object.assign(Object.create(null), {
            '1': { hydrate: 'load', errorScope: { message: 'server boom' } }
        });

        hydrate((Scoped as any)({}), container, undefined);
        await nextTick();

        // The fallback hydrated in place (no duplicate content, no subtree)
        const button = container.querySelector('button.retry') as HTMLButtonElement;
        expect(button).toBeTruthy();
        expect(button.textContent).toBe('server boom');
        expect(container.querySelector('.fine')).toBeNull();

        // retry(): a real remount — the subtree renders fresh
        button.click();
        await nextTick();
        await nextTick();
        expect(container.querySelector('.fine')?.textContent).toBe('0');
    });
});
