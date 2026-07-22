/**
 * The global-singleton fallback warning must not fire on windowless LIVE
 * clients (#404). lynx's BG thread and the terminal runtime call
 * `declareLiveClient()` on import and have no `window`, so the old
 * `typeof window` gate told them every unprovided injectable was leaking
 * across SSR requests — in a process with no server in it.
 *
 * Lives in its own file: `declareLiveClient` writes module-level state with no
 * reset, and declaring inside `injectable.test.ts` would leak into its
 * "stays silent on the client" case. Relies on vitest's per-file module
 * isolation, exactly as `environment.test.ts` documents.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { defineInjectable } from '../src/di/injectable';
import { declareLiveClient } from '../src/async/environment';
import { setCurrentInstance, type ComponentSetupContext } from '../src/component';

const mockInstance = () =>
    ({ props: {}, provides: new Map(), parent: null }) as unknown as ComponentSetupContext;

afterEach(() => {
    vi.unstubAllGlobals();
    setCurrentInstance(null);
    vi.restoreAllMocks();
    delete (globalThis as { __SIGX_LIVE_CLIENT__?: unknown }).__SIGX_LIVE_CLIENT__;
});

describe('SSR global-fallback warning on windowless live clients (#404)', () => {
    it('stays silent when the runtime declared itself a live client, window or not', () => {
        vi.stubGlobal('window', undefined);
        declareLiveClient(); // what a lynx/terminal platform module does on import
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        setCurrentInstance(mockInstance());

        const useThing = defineInjectable(() => ({ n: 1 }));
        useThing();

        expect(warn).not.toHaveBeenCalled();
    });

    it('still warns once the runtime declares it is NOT a live client (a real server render)', () => {
        vi.stubGlobal('window', undefined);
        declareLiveClient(false);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        setCurrentInstance(mockInstance());

        const useThing = defineInjectable(() => ({ n: 1 }), { name: 'perRequestThing' });
        useThing();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('perRequestThing');
    });
});
