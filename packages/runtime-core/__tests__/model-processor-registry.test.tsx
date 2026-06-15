/**
 * Model-processor registry: extension processors run before the platform
 * processor (FIFO among themselves), first returning true wins, and
 * registration is identity-idempotent.
 *
 * NOTE: the registry is module-global; vitest isolates modules per test
 * file, so registrations here cannot leak into other suites.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    registerModelProcessor,
    getModelProcessors,
    setPlatformModelProcessor,
    type ModelProcessor
} from '../src/platform';
import { jsx } from '../src/jsx-runtime';

describe('model-processor registry', () => {
    it('runs extension processors before the platform processor, first true wins', () => {
        const calls: string[] = [];
        const platform: ModelProcessor = vi.fn((_t, props) => {
            calls.push('platform');
            props.value = 'from-platform';
            return true;
        });
        const extA: ModelProcessor = vi.fn(() => {
            calls.push('extA');
            return false; // declines — next processor is tried
        });
        const extB: ModelProcessor = vi.fn((t, props) => {
            calls.push('extB');
            if (t !== 'input') return false; // scoped: only handles <input>
            props.value = 'from-extB';
            return true; // handled — platform must not run
        });

        setPlatformModelProcessor(platform);
        registerModelProcessor(extA);
        registerModelProcessor(extB);

        const state = { text: 'hi' };
        const vnode = jsx('input', { model: [state, 'text'] }) as any;

        expect(calls).toEqual(['extA', 'extB']);
        expect(platform).not.toHaveBeenCalled();
        expect(vnode.props.value).toBe('from-extB');
    });

    it('falls through to the platform processor when no extension handles', () => {
        // The registry is module-global and accumulates across tests in this
        // file — earlier extensions are scoped to <input>, so a <textarea>
        // binding falls through every extension to the platform tier.
        const platform: ModelProcessor = vi.fn((_t, props) => {
            props.value = 'from-platform';
            return true;
        });
        setPlatformModelProcessor(platform);
        registerModelProcessor(() => false);

        const state = { text: 'hi' };
        const vnode = jsx('textarea', { model: [state, 'text'] }) as any;

        expect(platform).toHaveBeenCalledTimes(1);
        expect(vnode.props.value).toBe('from-platform');
    });

    it('registering the same function twice is a no-op', () => {
        const ext: ModelProcessor = () => false;
        const before = getModelProcessors().length;
        registerModelProcessor(ext);
        registerModelProcessor(ext);
        expect(getModelProcessors().length).toBe(before + 1);
    });

    it('replacing the platform processor keeps extensions registered', () => {
        const ext: ModelProcessor = () => false;
        registerModelProcessor(ext);
        const platform: ModelProcessor = () => true;
        setPlatformModelProcessor(platform);

        const ordered = getModelProcessors();
        expect(ordered[ordered.length - 1]).toBe(platform);
        expect(ordered).toContain(ext);
    });
});
