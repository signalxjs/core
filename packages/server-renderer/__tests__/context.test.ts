/**
 * SSR Context tests
 * Tests the SSRContext factory and its state tracking
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createSSRContext, type SSRContext, type CorePendingAsync } from '../src/server/context';

describe('createSSRContext', () => {
    let ctx: SSRContext;

    beforeEach(() => {
        ctx = createSSRContext();
    });

    describe('nextId()', () => {
        it('should return sequential IDs starting from 1', () => {
            expect(ctx.nextId()).toBe(1);
            expect(ctx.nextId()).toBe(2);
            expect(ctx.nextId()).toBe(3);
        });

        it('should never repeat IDs', () => {
            const ids = new Set<number>();
            for (let i = 0; i < 100; i++) {
                ids.add(ctx.nextId());
            }
            expect(ids.size).toBe(100);
        });
    });

    describe('component stack', () => {
        it('should push and pop component IDs', () => {
            ctx.pushComponent(1);
            ctx.pushComponent(2);
            ctx.pushComponent(3);

            expect(ctx.popComponent()).toBe(3);
            expect(ctx.popComponent()).toBe(2);
            expect(ctx.popComponent()).toBe(1);
        });

        it('should return undefined when popping empty stack', () => {
            expect(ctx.popComponent()).toBeUndefined();
        });

        it('should track nesting correctly', () => {
            ctx.pushComponent(1);
            ctx.pushComponent(2);
            expect(ctx.popComponent()).toBe(2);
            ctx.pushComponent(3);
            expect(ctx.popComponent()).toBe(3);
            expect(ctx.popComponent()).toBe(1);
        });
    });

    describe('getPluginData / setPluginData', () => {
        it('should store and retrieve plugin data by name', () => {
            const data = { strategy: 'load', componentId: 'Counter' };
            ctx.setPluginData('islands', data);

            const retrieved = ctx.getPluginData<typeof data>('islands');
            expect(retrieved).toBe(data);
        });

        it('should return undefined for unset plugin data', () => {
            expect(ctx.getPluginData('nonexistent')).toBeUndefined();
        });

        it('should store data for multiple plugins', () => {
            ctx.setPluginData('islands', { count: 1 });
            ctx.setPluginData('suspense', { boundaries: 2 });
            ctx.setPluginData('resumable', { active: true });

            expect(ctx.getPluginData<{ count: number }>('islands')!.count).toBe(1);
            expect(ctx.getPluginData<{ boundaries: number }>('suspense')!.boundaries).toBe(2);
            expect(ctx.getPluginData<{ active: boolean }>('resumable')!.active).toBe(true);
        });

        it('should handle complex plugin data structures', () => {
            const islandData = {
                islands: new Map<number, { strategy: string; componentId: string }>(),
                signalMaps: new Map<number, Map<string, any>>()
            };
            islandData.islands.set(1, { strategy: 'load', componentId: 'Counter' });
            ctx.setPluginData('islands', islandData);

            const retrieved = ctx.getPluginData<typeof islandData>('islands')!;
            expect(retrieved.islands.size).toBe(1);
            expect(retrieved.islands.get(1)!.strategy).toBe('load');
        });

        it('should overwrite plugin data with same name', () => {
            ctx.setPluginData('islands', { version: 1 });
            ctx.setPluginData('islands', { version: 2 });

            expect(ctx.getPluginData<{ version: number }>('islands')!.version).toBe(2);
        });

        it('should store null and false values correctly', () => {
            ctx.setPluginData('test-null', null);
            ctx.setPluginData('test-false', false);

            expect(ctx.getPluginData('test-null')).toBeNull();
            expect(ctx.getPluginData('test-false')).toBe(false);
        });

        it('should not share data between context instances', () => {
            const ctx2 = createSSRContext();
            ctx.setPluginData('islands', { a: 1 });

            expect(ctx2.getPluginData('islands')).toBeUndefined();
        });
    });

    describe('head management', () => {
        it('should collect head elements', () => {
            ctx.addHead('<link rel="stylesheet" href="/style.css">');
            ctx.addHead('<script src="/app.js"></script>');

            const head = ctx.getHead();
            expect(head).toContain('<link rel="stylesheet" href="/style.css">');
            expect(head).toContain('<script src="/app.js"></script>');
        });

        it('should return empty string when no head elements', () => {
            expect(ctx.getHead()).toBe('');
        });

        it('should join head elements with newlines', () => {
            ctx.addHead('<meta charset="utf-8">');
            ctx.addHead('<title>Test</title>');

            const head = ctx.getHead();
            expect(head).toBe('<meta charset="utf-8">\n<title>Test</title>');
        });
    });

    describe('pending async (_pendingAsync)', () => {
        it('should collect pending async components', () => {
            const pending: CorePendingAsync = {
                id: 1,
                promise: Promise.resolve('html')
            };
            ctx._pendingAsync.push(pending);

            expect(ctx._pendingAsync).toHaveLength(1);
            expect(ctx._pendingAsync[0]).toBe(pending);
        });

        it('should return empty array when no pending', () => {
            expect(ctx._pendingAsync).toHaveLength(0);
        });

        it('should collect multiple pending async components', () => {
            ctx._pendingAsync.push({
                id: 1,
                promise: Promise.resolve('a')
            });
            ctx._pendingAsync.push({
                id: 2,
                promise: Promise.resolve('b')
            });

            expect(ctx._pendingAsync).toHaveLength(2);
        });
    });

    describe('context options', () => {
        it('should create context with default options', () => {
            const ctx = createSSRContext();
            expect(ctx).toBeDefined();
            expect(ctx.nextId()).toBe(1);
        });

        it('should accept streaming option', () => {
            const ctx = createSSRContext({ streaming: true });
            expect(ctx).toBeDefined();
        });

        it('should accept streaming=false', () => {
            const ctx = createSSRContext({ streaming: false });
            expect(ctx).toBeDefined();
        });
    });

    describe('integration: ID sequencing with plugin data', () => {
        it('should use nextId for plugin data registration', () => {
            const islands = new Map<number, { strategy: string; componentId: string }>();
            ctx.setPluginData('islands', { islands });

            const id1 = ctx.nextId();
            islands.set(id1, { strategy: 'load', componentId: 'A' });

            const id2 = ctx.nextId();
            islands.set(id2, { strategy: 'idle', componentId: 'B' });

            expect(id1).toBe(1);
            expect(id2).toBe(2);
            expect(ctx.getPluginData<{ islands: Map<number, any> }>('islands')!.islands.size).toBe(2);
        });

        it('should maintain separate counters across context instances', () => {
            const ctx1 = createSSRContext();
            const ctx2 = createSSRContext();

            expect(ctx1.nextId()).toBe(1);
            expect(ctx1.nextId()).toBe(2);
            expect(ctx2.nextId()).toBe(1); // independent counter
        });
    });
});
