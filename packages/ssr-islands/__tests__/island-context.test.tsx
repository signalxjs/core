/**
 * Tests for client/island-context.ts — the island-shaped view over the
 * window.__SIGX_BOUNDARIES__ table and the server-state lookup. Covers cache
 * miss/hit, missing table, record→IslandInfo mapping, and getIslandServerState.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    invalidateIslandCache,
    getIslandData,
    getIslandServerState
} from '../src/client/island-context';
import { createIslandDataScript, cleanupScripts } from './test-utils';

beforeEach(() => {
    cleanupScripts();
    invalidateIslandCache();
});

afterEach(() => {
    cleanupScripts();
    invalidateIslandCache();
    vi.restoreAllMocks();
});

describe('getIslandData', () => {
    it('returns an empty object when no __SIGX_BOUNDARIES__ table is present', () => {
        expect(getIslandData()).toEqual({});
    });

    it('maps boundary records onto the island-shaped view', () => {
        createIslandDataScript({
            '1': { strategy: 'load', componentId: 'A', props: {} }
        });
        const data = getIslandData();
        expect(data['1']).toMatchObject({ componentId: 'A', strategy: 'load' });
    });

    it('maps flush:"skip" records to the "only" strategy and chunk to chunkUrl/exportName', () => {
        (window as any).__SIGX_BOUNDARIES__ = {
            '3': { flush: 'skip', hydrate: 'load', component: 'CO', chunk: { url: '/co.js', export: 'CO' } },
            '4': { component: 'NoStrategy' }
        };
        invalidateIslandCache();
        const data = getIslandData();
        expect(data['3']).toMatchObject({
            strategy: 'only',
            componentId: 'CO',
            chunkUrl: '/co.js',
            exportName: 'CO'
        });
        // Records without a hydrate strategy inherit 'load'
        expect(data['4']).toMatchObject({ strategy: 'load', componentId: 'NoStrategy' });
    });

    it('caches the mapped view — a second read ignores global mutation until invalidated', () => {
        createIslandDataScript({ '1': { strategy: 'load', componentId: 'A' } });

        const first = getIslandData();
        // Replace the global after first read; cache should win on second read.
        (window as any).__SIGX_BOUNDARIES__ = { '2': { hydrate: 'idle', component: 'B' } };

        const second = getIslandData();
        expect(second).toBe(first); // same cached reference
        expect(second['1']).toBeDefined();
        expect(second['2']).toBeUndefined();
    });

    it('re-reads after invalidateIslandCache()', () => {
        createIslandDataScript({ '1': { strategy: 'load', componentId: 'A' } });
        getIslandData();

        cleanupScripts();
        createIslandDataScript({ '9': { strategy: 'idle', componentId: 'Z' } });
        invalidateIslandCache();

        const data = getIslandData();
        expect(data['9']).toBeDefined();
        expect(data['1']).toBeUndefined();
    });
});

describe('getIslandServerState', () => {
    it('returns the stored state for a known component id', () => {
        createIslandDataScript({
            '5': { strategy: 'load', componentId: 'Stateful', state: { count: 3 } }
        });
        expect(getIslandServerState(5)).toEqual({ count: 3 });
    });

    it('returns undefined for an unknown component id', () => {
        createIslandDataScript({
            '5': { strategy: 'load', componentId: 'Stateful', state: { count: 3 } }
        });
        expect(getIslandServerState(404)).toBeUndefined();
    });

    it('returns undefined when the island has no state', () => {
        createIslandDataScript({
            '5': { strategy: 'load', componentId: 'NoState' }
        });
        expect(getIslandServerState(5)).toBeUndefined();
    });
});
