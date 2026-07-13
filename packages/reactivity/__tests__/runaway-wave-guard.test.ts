/**
 * Dev-mode runaway-wave guard (issue #111).
 *
 * An effect cascade that keeps writing reactive state effects depend on
 * re-triggers itself synchronously and used to wedge the main thread with
 * zero feedback. In dev builds flushPendingEffects now counts effect runs
 * per OUTERMOST wave (nested depth-first flushes accumulate into the same
 * count) and throws an actionable error past the limit.
 *
 * The production limit is deliberately far above anything a test should
 * construct, so these tests lower it via the internal test hook.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { signal, effect } from '../src/index';
import { setMaxWaveEffectRuns } from '../src/effect';
import type { EffectRunner } from '../src/types';

describe('dev-mode runaway wave guard (issue #111)', () => {
    const runners: EffectRunner[] = [];

    afterEach(() => {
        runners.forEach(r => r.stop());
        runners.length = 0;
        setMaxWaveEffectRuns(null);
    });

    /**
     * Build a cascade: effect i reads sigs[i] and writes sigs[i+1], so one
     * write at the head ripples through every link in ONE wave (each write
     * flushes nested, depth-first — the counter must accumulate across the
     * nesting, not reset per nested flush).
     */
    function buildCascade(links: number) {
        const sigs = Array.from({ length: links + 1 }, () => signal(0));
        for (let i = 0; i < links; i++) {
            const src = sigs[i];
            const dst = sigs[i + 1];
            runners.push(effect(() => {
                const v = src.value;
                if (v > 0) dst.value = v + 1;
            }));
        }
        return sigs;
    }

    it('throws when a single wave exceeds the effect-run limit', () => {
        setMaxWaveEffectRuns(50);
        const sigs = buildCascade(60);
        expect(() => { sigs[0].value = 1; }).toThrow(/Runaway notification wave/);
    });

    it('the run counter resets between waves', () => {
        setMaxWaveEffectRuns(50);
        const sigs = buildCascade(40);
        // Two consecutive 40-run waves: each is under the limit, but a
        // counter that failed to reset would trip on the second one.
        expect(() => { sigs[0].value = 1; }).not.toThrow();
        expect(() => { sigs[0].value = 100; }).not.toThrow();
    });

    it('recovers after a guard trip: the next wave runs normally', () => {
        setMaxWaveEffectRuns(50);
        const sigs = buildCascade(60);
        expect(() => { sigs[0].value = 1; }).toThrow(/Runaway notification wave/);

        let observed = -1;
        const probe = signal(0);
        runners.push(effect(() => { observed = probe.value; }));
        probe.value = 7;
        expect(observed).toBe(7);
    });
});
