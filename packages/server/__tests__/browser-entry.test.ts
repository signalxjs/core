/**
 * @vitest-environment node
 *
 * The `browser` export condition — defense in depth: an unextracted
 * serverFn module evaluating in a browser bundle fails loudly.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    serverFn,
    serverStream,
    perRequest,
    principal,
    isServerFnError,
    ServerFnError
} from '../src/browser';
import { createDetachedContext } from '../src/context';

describe('@sigx/server browser entry', () => {
    it('serverFn throws with a pointer at the transform config', () => {
        expect(() => serverFn()).toThrow(/reached the browser unextracted/);
        expect(() => serverFn()).toThrow(/include pattern/);
    });

    it('serverStream throws the same way', () => {
        expect(() => serverStream()).toThrow(/serverStream\(\) reached the browser unextracted/);
    });

    it('principal throws the same way (rfc-server-v4)', () => {
        // A component reads the user through props/loader data, never by
        // importing the server package's identity accessors.
        expect(() => principal()).toThrow(/principal\(\) reached the browser unextracted/);
    });

    it('perRequest throws the same way (#494)', () => {
        // A `session.server.ts` exporting only per-request values has no
        // serverFn to shout, so this is the only loud signal it has.
        expect(() => perRequest()).toThrow(/perRequest\(\) reached the browser unextracted/);
    });

    it('the error channel is real in the browser build', () => {
        const error = new ServerFnError(401, 'nope');
        expect(isServerFnError(error)).toBe(true);
    });
});

describe('browser entry parity with the server entry (#565)', () => {
    it('exports exactly the same VALUE names', async () => {
        // The invariant that bites at runtime: a value the server entry
        // exports and the browser entry does not becomes
        // "undefined is not a function" inside a misconfigured client build —
        // the exact failure this entry exists to convert into a loud one.
        const [index, browser] = await Promise.all([import('../src/index'), import('../src/browser')]);
        expect(Object.keys(browser).sort()).toEqual(Object.keys(index).sort());
    });

    it('every browser export that is not an error utility throws', async () => {
        // Generalizes the four hand-written cases above, so a NEW export
        // mirrored into browser.ts without a throw is caught here rather than
        // shipping a silent no-op to the client.
        const browser = (await import('../src/browser')) as unknown as Record<string, unknown>;
        for (const [name, value] of Object.entries(browser)) {
            if (name === 'ServerFnError' || name === 'isServerFnError') continue;
            expect(typeof value, `${name} should be callable`).toBe('function');
            expect(() => (value as () => unknown)(), name).toThrow(/reached the browser unextracted/);
        }
    });

    it('publishes no type surface of its own, and cannot fall through to the server module', async () => {
        const { readFileSync } = await import('node:fs');
        const pkg = JSON.parse(
            readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
        ) as { exports: Record<string, Record<string, Record<string, string> | string>> };
        const root = pkg.exports['.'] as Record<string, Record<string, string> | string>;
        // `types` is routed unconditionally, ABOVE `browser`, and that is
        // correct: the throwing stand-ins' signatures contradict the real API,
        // so a consumer resolving them would fail to compile every
        // *.server.ts (#565).
        expect(root.types).toBe('./dist/index.d.ts');
        expect((root.browser as Record<string, string>).types).toBeUndefined();
        // Without a `default` inside the sub-object, a resolver that sets
        // `browser` but matches none of development/production/import falls
        // out of it and continues at the parent — where the next match is the
        // SERVER module.
        expect((root.browser as Record<string, string>).default).toBe('./dist/browser.js');
    });

    it('keeps the deleted type re-export list deleted', async () => {
        // Testing an absence on purpose: a comment did not stop it drifting
        // the first time, and nothing else can fail when it does — the list
        // is unreachable by construction.
        const { readFileSync } = await import('node:fs');
        const source = readFileSync(new URL('../src/browser.ts', import.meta.url), 'utf-8');
        expect(source).not.toMatch(/from '\.\/types'/);
        expect(source).not.toMatch(/from '\.\/index'/);
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
