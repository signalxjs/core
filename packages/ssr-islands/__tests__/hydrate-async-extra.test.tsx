/**
 * Supplemental tests for client/hydrate-async.ts covering branches not hit by
 * async-streaming.test.tsx:
 * - early return when there are no unhydrated placeholders
 * - placeholder skipped when it has no matching island data
 * - missing-componentId error path during leftover hydration
 * - error reporting when hydration of a streamed island rejects
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hydrateLeftoverAsyncComponents } from '../src/client/hydrate-async';
import { invalidateIslandCache } from '../src/client/island-context';
import {
    createSSRContainer,
    cleanupContainer,
    createIslandDataScript,
    cleanupScripts,
    nextTick
} from './test-utils';

describe('hydrateLeftoverAsyncComponents — edge branches', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        cleanupScripts();
        invalidateIslandCache();
    });

    afterEach(() => {
        if (container) cleanupContainer(container);
        cleanupScripts();
        invalidateIslandCache();
        vi.restoreAllMocks();
    });

    it('returns early (does not read island data) when there are no unhydrated placeholders', () => {
        // All placeholders already hydrated → querySelectorAll matches nothing.
        container = createSSRContainer('<div data-async-placeholder="1" data-hydrated><span>done</span></div>');
        // No __SIGX_ISLANDS__ script at all; must not throw.
        expect(() => hydrateLeftoverAsyncComponents(container)).not.toThrow();
    });

    it('skips a placeholder that has no matching island data', async () => {
        container = createSSRContainer('<div data-async-placeholder="99"><span>orphan</span></div>');
        createIslandDataScript({ '1': { strategy: 'load', componentId: 'Other' } });

        hydrateLeftoverAsyncComponents(container);
        await nextTick();

        // Orphan placeholder is untouched — not marked hydrated.
        const ph = container.querySelector('[data-async-placeholder="99"]')!;
        expect(ph.hasAttribute('data-hydrated')).toBe(false);
    });

    it('logs an error and bails when an island lacks a componentId', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        container = createSSRContainer('<div data-async-placeholder="3"><span>x</span></div>');
        // Island info exists but has no componentId → hydrateAsyncComponent bails
        // before marking the placeholder hydrated.
        createIslandDataScript({ '3': { strategy: 'load' } as any });

        hydrateLeftoverAsyncComponents(container);
        await nextTick();
        await nextTick();

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('No component name');
        const ph = container.querySelector('[data-async-placeholder="3"]')!;
        expect(ph.hasAttribute('data-hydrated')).toBe(false);
    });

    it('logs an error when the referenced component cannot be resolved', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        container = createSSRContainer('<div data-async-placeholder="4"><span>x</span></div>');
        createIslandDataScript({ '4': { strategy: 'load', componentId: 'NeverRegistered_zzz' } });

        hydrateLeftoverAsyncComponents(container);
        await nextTick();
        await nextTick();

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('could not be resolved');
    });
});
