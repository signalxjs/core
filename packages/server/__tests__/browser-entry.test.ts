/**
 * @vitest-environment node
 *
 * The `browser` export condition — defense in depth: an unextracted
 * serverFn module evaluating in a browser bundle fails loudly.
 */

import { describe, it, expect, vi } from 'vitest';
import { serverFn, isServerFnError, ServerFnError } from '../src/browser';
import { createDetachedContext } from '../src/context';

describe('@sigx/server browser entry', () => {
    it('serverFn throws with a pointer at the transform config', () => {
        expect(() => serverFn()).toThrow(/reached the browser unextracted/);
        expect(() => serverFn()).toThrow(/include pattern/);
    });

    it('the error channel is real in the browser build', () => {
        const error = new ServerFnError(401, 'nope');
        expect(isServerFnError(error)).toBe(true);
    });
});

describe('detached context inert members', () => {
    it('rq.url throws and rq.status warns without a request', () => {
        const ctx = createDetachedContext();
        expect(() => ctx.url).toThrow(/in-process server-function call/);
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            ctx.status(201);
            expect(spy).toHaveBeenCalledOnce();
            expect(String(spy.mock.calls[0][0])).toContain('inert');
        } finally {
            spy.mockRestore();
        }
    });
});
