/**
 * Tests for client/island-context.ts — the island-data cache and server-state
 * lookup. Covers cache miss/hit, missing script, invalid JSON (→ console.error),
 * and getIslandServerState.
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
    it('returns an empty object when no __SIGX_ISLANDS__ script is present', () => {
        expect(getIslandData()).toEqual({});
    });

    it('parses and returns island data from the script', () => {
        createIslandDataScript({
            '1': { strategy: 'load', componentId: 'A', props: {} }
        });
        const data = getIslandData();
        expect(data['1']).toMatchObject({ componentId: 'A', strategy: 'load' });
    });

    it('caches the parsed result — a second read does not re-parse', () => {
        createIslandDataScript({ '1': { strategy: 'load', componentId: 'A' } });

        const first = getIslandData();
        // Mutate the script after first read; cache should win on second read.
        const script = document.getElementById('__SIGX_ISLANDS__')!;
        script.textContent = JSON.stringify({ '2': { strategy: 'idle', componentId: 'B' } });

        const second = getIslandData();
        expect(second).toBe(first); // same cached reference
        expect(second['1']).toBeDefined();
        expect(second['2']).toBeUndefined();
    });

    it('returns {} and logs when the script contains invalid JSON', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const script = document.createElement('script');
        script.id = '__SIGX_ISLANDS__';
        script.type = 'application/json';
        script.textContent = '{ not valid json';
        document.head.appendChild(script);

        expect(getIslandData()).toEqual({});
        expect(errorSpy).toHaveBeenCalled();
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
