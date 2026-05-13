/**
 * Devtools instrumentation smoke tests. Verifies that:
 *   - signal/computed/effect emit `*:created` when a hook is installed
 *     before creation
 *   - signal mutation emits `signal:updated` (only on actual change)
 *   - computed.value triggers `computed:recomputed` after a dep changes
 *   - effect run emits `effect:run` with a non-negative durationMs
 *   - effect runner.stop emits `effect:stopped`
 *   - hook.currentOwner flows into `ownerComponentId` on created events
 *   - no events at all when no hook is installed
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    DEVTOOLS_HOOK_KEY,
    ensureDevtoolsHook,
    type DevtoolsHook,
    type DevtoolsEventBase,
} from '../src/devtools-hook';
import { signal } from '../src/signal';
import { effect } from '../src/effect';
import { computed } from '../src/computed';

type AnyEvent = DevtoolsEventBase & Record<string, any>;

function withHook(): { hook: DevtoolsHook; events: AnyEvent[] } {
    const hook = ensureDevtoolsHook();
    const events: AnyEvent[] = [];
    hook.on(event => events.push(event as AnyEvent));
    return { hook, events };
}

describe('reactivity devtools events', () => {
    beforeEach(() => { delete (globalThis as any)[DEVTOOLS_HOOK_KEY]; });
    afterEach(() => { delete (globalThis as any)[DEVTOOLS_HOOK_KEY]; });

    it('emits signal:created and signal:updated on primitive signals', () => {
        const { events } = withHook();
        const count = signal(0);
        count.value = 1;
        count.value = 1; // no-op assign — same value, no event
        count.value = 2;

        const created = events.filter(e => e.type === 'signal:created');
        const updated = events.filter(e => e.type === 'signal:updated');
        // signal(0) wraps as signal({ value: 0 }) — that's the proxy
        // we observe, so exactly one creation event.
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ kind: 'object', ownerComponentId: null });
        expect(updated).toHaveLength(2);
        expect(updated[0]).toMatchObject({ key: 'value' });
    });

    it('emits signal:created with kind=collection for Maps/Sets', () => {
        const { events } = withHook();
        signal(new Map());
        signal(new Set());
        const created = events.filter(e => e.type === 'signal:created');
        expect(created.map(e => e.kind)).toEqual(['collection', 'collection']);
    });

    it('emits effect:created, effect:run, effect:stopped', () => {
        const { events } = withHook();
        const count = signal(0);
        const runner = effect(() => { void count.value; });

        // Initial run when effect is created
        expect(events.some(e => e.type === 'effect:created')).toBe(true);
        let runs = events.filter(e => e.type === 'effect:run');
        expect(runs.length).toBe(1);
        expect(runs[0].durationMs).toBeGreaterThanOrEqual(0);

        count.value = 1;
        runs = events.filter(e => e.type === 'effect:run');
        expect(runs.length).toBe(2);

        runner.stop();
        expect(events.some(e => e.type === 'effect:stopped')).toBe(true);
    });

    it('emits computed:created and computed:recomputed lazily', () => {
        const { events } = withHook();
        const count = signal(2);
        const doubled = computed(() => count.value * 2);

        // Creation emits eagerly; recompute doesn't happen until read
        expect(events.some(e => e.type === 'computed:created')).toBe(true);
        expect(events.filter(e => e.type === 'computed:recomputed')).toHaveLength(0);

        void doubled.value; // first read → recompute
        expect(events.filter(e => e.type === 'computed:recomputed')).toHaveLength(1);

        void doubled.value; // cached, no recompute
        expect(events.filter(e => e.type === 'computed:recomputed')).toHaveLength(1);

        count.value = 5; // invalidates
        void doubled.value; // recompute
        expect(events.filter(e => e.type === 'computed:recomputed')).toHaveLength(2);
    });

    it('attaches hook.currentOwner as ownerComponentId on created events', () => {
        const { hook, events } = withHook();
        hook.currentOwner = 42;
        signal(0);
        effect(() => {});
        computed(() => 1);
        hook.currentOwner = null;

        const created = events.filter(e => /:created$/.test(e.type));
        expect(created).toHaveLength(3);
        for (const e of created) {
            expect(e.ownerComponentId).toBe(42);
        }
    });

    it('emits zero reactivity events when no hook is installed', () => {
        // No installation — getDevtoolsHook() returns null in every
        // call path. Just exercise the APIs and assert no hook
        // appeared as a side effect.
        const count = signal(0);
        count.value = 1;
        const runner = effect(() => { void count.value; });
        const doubled = computed(() => count.value * 2);
        void doubled.value;
        runner.stop();
        expect((globalThis as any)[DEVTOOLS_HOOK_KEY]).toBeUndefined();
    });

    it('signals created before the hook installs are invisible to it', () => {
        // Pre-hook signal — no `signalId` minted, so set traps stay silent.
        const earlier = signal(0);

        const { events } = withHook();
        earlier.value = 1;
        const later = signal(0);
        later.value = 1;

        const updated = events.filter(e => e.type === 'signal:updated');
        // Only the post-hook signal's update surfaced.
        expect(updated).toHaveLength(1);
    });
});
