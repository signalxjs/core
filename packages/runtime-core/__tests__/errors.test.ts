import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    SigxError,
    SigxErrorCode,
    noMountFunctionError,
    renderTargetNotFoundError,
    mountTargetNotFoundError,
    asyncSetupClientError,
    errorScopeOutsideSetupError,
    provideOutsideSetupError,
    provideInvalidInjectableError,
    requiredInjectableNotProvidedError,
    factoryInvalidReturnError,
    hookOutsideSetupError,
    topicDestroyedError,
    topicGroupDestroyedError,
} from '../src/errors';

describe('SigxError class', () => {
    it('is an instance of Error', () => {
        const err = new SigxError('test', { code: 'TEST001' });
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(SigxError);
    });

    it('has name "SigxError"', () => {
        const err = new SigxError('test', { code: 'TEST001' });
        expect(err.name).toBe('SigxError');
    });

    it('has correct message', () => {
        const err = new SigxError('Something went wrong', { code: 'TEST001' });
        expect(err.message).toBe('Something went wrong');
    });

    it('has correct code', () => {
        const err = new SigxError('test', { code: 'SIGX999' });
        expect(err.code).toBe('SIGX999');
    });

    it('has suggestion when provided', () => {
        const err = new SigxError('test', { code: 'TEST001', suggestion: 'Try this instead' });
        expect(err.suggestion).toBe('Try this instead');
    });

    it('has cause when provided', () => {
        const original = new Error('original');
        const err = new SigxError('wrapped', { code: 'TEST001', cause: original });
        expect(err.cause).toBe(original);
    });

    it('works without optional fields', () => {
        const err = new SigxError('minimal', { code: 'TEST001' });
        expect(err.suggestion).toBeUndefined();
        expect(err.cause).toBeUndefined();
    });
});

describe('SigxErrorCode', () => {
    it('contains all expected codes', () => {
        expect(SigxErrorCode.NO_MOUNT_FUNCTION).toBe('SIGX001');
        expect(SigxErrorCode.RENDER_TARGET_NOT_FOUND).toBe('SIGX100');
        expect(SigxErrorCode.MOUNT_TARGET_NOT_FOUND).toBe('SIGX101');
        expect(SigxErrorCode.ASYNC_SETUP_CLIENT).toBe('SIGX102');
        expect(SigxErrorCode.PROVIDE_OUTSIDE_SETUP).toBe('SIGX200');
        expect(SigxErrorCode.PROVIDE_INVALID_INJECTABLE).toBe('SIGX201');
        expect(SigxErrorCode.REQUIRED_INJECTABLE_NOT_PROVIDED).toBe('SIGX202');
        expect(SigxErrorCode.FACTORY_INVALID_RETURN).toBe('SIGX203');
        expect(SigxErrorCode.HOOK_OUTSIDE_SETUP).toBe('SIGX300');
        expect(SigxErrorCode.TOPIC_DESTROYED).toBe('SIGX400');
        expect(SigxErrorCode.TOPIC_GROUP_DESTROYED).toBe('SIGX401');
    });

    it('codes are unique', () => {
        const codes = Object.values(SigxErrorCode);
        expect(new Set(codes).size).toBe(codes.length);
    });

    it('app-level codes are in 001-099 range', () => {
        const num = parseInt(SigxErrorCode.NO_MOUNT_FUNCTION.replace('SIGX', ''), 10);
        expect(num).toBeGreaterThanOrEqual(1);
        expect(num).toBeLessThanOrEqual(99);
    });

    it('rendering codes are in 100-199 range', () => {
        const renderingCodes = [
            SigxErrorCode.RENDER_TARGET_NOT_FOUND,
            SigxErrorCode.MOUNT_TARGET_NOT_FOUND,
            SigxErrorCode.ASYNC_SETUP_CLIENT,
        ];
        for (const code of renderingCodes) {
            const num = parseInt(code.replace('SIGX', ''), 10);
            expect(num).toBeGreaterThanOrEqual(100);
            expect(num).toBeLessThanOrEqual(199);
        }
    });

    it('DI codes are in 200-299 range', () => {
        const diCodes = [
            SigxErrorCode.PROVIDE_OUTSIDE_SETUP,
            SigxErrorCode.PROVIDE_INVALID_INJECTABLE,
            SigxErrorCode.REQUIRED_INJECTABLE_NOT_PROVIDED,
            SigxErrorCode.FACTORY_INVALID_RETURN,
        ];
        for (const code of diCodes) {
            const num = parseInt(code.replace('SIGX', ''), 10);
            expect(num).toBeGreaterThanOrEqual(200);
            expect(num).toBeLessThanOrEqual(299);
        }
    });

    it('hook codes are in 300-399, messaging codes in 400-499', () => {
        const inRange = (code: string, lo: number, hi: number) => {
            const num = parseInt(code.replace('SIGX', ''), 10);
            expect(num).toBeGreaterThanOrEqual(lo);
            expect(num).toBeLessThanOrEqual(hi);
        };
        inRange(SigxErrorCode.HOOK_OUTSIDE_SETUP, 300, 399);
        inRange(SigxErrorCode.TOPIC_DESTROYED, 400, 499);
        inRange(SigxErrorCode.TOPIC_GROUP_DESTROYED, 400, 499);
    });
});

describe('Error factory functions', () => {
    describe('noMountFunctionError', () => {
        it('returns SigxError with code SIGX001', () => {
            const err = noMountFunctionError();
            expect(err).toBeInstanceOf(SigxError);
            expect(err.code).toBe('SIGX001');
        });

        it('has a suggestion', () => {
            const err = noMountFunctionError();
            expect(err.suggestion).toBeDefined();
            expect(err.suggestion!.length).toBeGreaterThan(0);
        });
    });

    describe('renderTargetNotFoundError', () => {
        it('includes selector in message and has code SIGX100', () => {
            const err = renderTargetNotFoundError('#app');
            expect(err).toBeInstanceOf(SigxError);
            expect(err.code).toBe('SIGX100');
            expect(err.message).toContain('#app');
        });

        it('has a suggestion', () => {
            const err = renderTargetNotFoundError('#app');
            expect(err.suggestion).toBeDefined();
            expect(err.suggestion!.length).toBeGreaterThan(0);
        });

        it('strips "#" prefix in suggestion', () => {
            const err = renderTargetNotFoundError('#app');
            expect(err.suggestion).toContain('id="app"');
            expect(err.suggestion).not.toContain('id="#app"');
        });
    });

    describe('mountTargetNotFoundError', () => {
        it('includes selector in message and has code SIGX101', () => {
            const err = mountTargetNotFoundError('#root');
            expect(err).toBeInstanceOf(SigxError);
            expect(err.code).toBe('SIGX101');
            expect(err.message).toContain('#root');
        });

        it('has a suggestion', () => {
            const err = mountTargetNotFoundError('#root');
            expect(err.suggestion).toBeDefined();
            expect(err.suggestion!.length).toBeGreaterThan(0);
        });

        it('strips "#" prefix in suggestion', () => {
            const err = mountTargetNotFoundError('#root');
            expect(err.suggestion).toContain('id="root"');
            expect(err.suggestion).not.toContain('id="#root"');
        });
    });

    describe('asyncSetupClientError', () => {
        it('includes component name in message and has code SIGX102', () => {
            const err = asyncSetupClientError('MyComponent');
            expect(err).toBeInstanceOf(SigxError);
            expect(err.code).toBe('SIGX102');
            expect(err.message).toContain('MyComponent');
        });

        it('has a suggestion', () => {
            const err = asyncSetupClientError('MyComponent');
            expect(err.suggestion).toBeDefined();
            expect(err.suggestion!.length).toBeGreaterThan(0);
        });
    });

    describe('provideOutsideSetupError', () => {
        it('returns SigxError with code SIGX200', () => {
            const err = provideOutsideSetupError();
            expect(err).toBeInstanceOf(SigxError);
            expect(err.code).toBe('SIGX200');
        });

        it('has a suggestion', () => {
            const err = provideOutsideSetupError();
            expect(err.suggestion).toBeDefined();
            expect(err.suggestion!.length).toBeGreaterThan(0);
        });
    });

    describe('provideInvalidInjectableError', () => {
        it('returns SigxError with code SIGX201', () => {
            const err = provideInvalidInjectableError();
            expect(err).toBeInstanceOf(SigxError);
            expect(err.code).toBe('SIGX201');
        });

        it('has a suggestion', () => {
            const err = provideInvalidInjectableError();
            expect(err.suggestion).toBeDefined();
            expect(err.suggestion!.length).toBeGreaterThan(0);
        });
    });

    describe('requiredInjectableNotProvidedError', () => {
        it('returns SigxError with code SIGX202 naming the injectable', () => {
            const err = requiredInjectableNotProvidedError('Router');
            expect(err).toBeInstanceOf(SigxError);
            expect(err.code).toBe('SIGX202');
            expect(err.message).toContain('"Router"');
        });

        it('has a suggestion naming the conventional use-function', () => {
            const err = requiredInjectableNotProvidedError('Router');
            expect(err.suggestion).toContain('app.defineProvide(useRouter');
        });

        it('capitalizes lowercase identifier names in the suggestion', () => {
            const err = requiredInjectableNotProvidedError('router');
            expect(err.suggestion).toContain('app.defineProvide(useRouter');
        });

        it('falls back to a generic placeholder for non-identifier names', () => {
            const err = requiredInjectableNotProvidedError('my router!');
            expect(err.suggestion).toContain('app.defineProvide(<your use-function>');
            expect(err.suggestion).not.toContain('usemy');
        });
    });

    describe('new factories (dev form)', () => {
        it('hookOutsideSetupError names the hook', () => {
            const err = hookOutsideSetupError('useData');
            expect(err.code).toBe(SigxErrorCode.HOOK_OUTSIDE_SETUP);
            expect(err.message).toBe('useData() must be called synchronously during component setup.');
            expect(err.suggestion).toContain('useData()');
        });

        it('factoryInvalidReturnError names the offending type', () => {
            const err = factoryInvalidReturnError('number');
            expect(err.code).toBe(SigxErrorCode.FACTORY_INVALID_RETURN);
            expect(err.message).toBe('[sigx] defineFactory setup must return an object or function, got number.');
            expect(err.suggestion!.length).toBeGreaterThan(0);
        });

        it('topicDestroyedError includes the topic path when known', () => {
            expect(topicDestroyedError('auth.login').message).toBe(
                '[sigx] Cannot subscribe to destroyed topic "auth.login".'
            );
            expect(topicDestroyedError().message).toBe('[sigx] Cannot subscribe to destroyed topic.');
            expect(topicDestroyedError().code).toBe(SigxErrorCode.TOPIC_DESTROYED);
        });

        it('topicGroupDestroyedError names the key', () => {
            const err = topicGroupDestroyedError('loggedIn');
            expect(err.code).toBe(SigxErrorCode.TOPIC_GROUP_DESTROYED);
            expect(err.message).toBe('[sigx] Cannot create topic "loggedIn" on a destroyed topic group.');
        });
    });
});

describe('production error form', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    // Factories with a representative call and the runtime detail the prod
    // message must keep (null = no detail expected).
    const cases: Array<[string, () => SigxError, string | null]> = [
        ['noMountFunctionError', () => noMountFunctionError(), null],
        ['renderTargetNotFoundError', () => renderTargetNotFoundError('#app'), '"#app"'],
        ['mountTargetNotFoundError', () => mountTargetNotFoundError('#app'), '"#app"'],
        ['asyncSetupClientError', () => asyncSetupClientError('MyWidget'), '"MyWidget"'],
        ['errorScopeOutsideSetupError', () => errorScopeOutsideSetupError(), null],
        ['provideOutsideSetupError', () => provideOutsideSetupError(), null],
        ['provideInvalidInjectableError', () => provideInvalidInjectableError(), null],
        ['requiredInjectableNotProvidedError', () => requiredInjectableNotProvidedError('Router'), '"Router"'],
        ['factoryInvalidReturnError', () => factoryInvalidReturnError('number'), 'number'],
        ['hookOutsideSetupError', () => hookOutsideSetupError('useData'), 'useData()'],
        ['topicDestroyedError', () => topicDestroyedError('auth.login'), '"auth.login"'],
        ['topicGroupDestroyedError', () => topicGroupDestroyedError('loggedIn'), '"loggedIn"'],
    ];

    it.each(cases)('%s throws code + docs URL, no suggestion', (_name, make, detail) => {
        vi.stubEnv('NODE_ENV', 'production');
        const err = make();
        expect(err).toBeInstanceOf(SigxError);
        // Message: "<CODE>[ <detail>] — see https://sigx.dev/errors/<CODE>/"
        expect(err.message.startsWith(`${err.code}`)).toBe(true);
        expect(err.message).toContain(`https://sigx.dev/errors/${err.code}/`);
        if (detail) expect(err.message).toContain(detail);
        expect(err.suggestion).toBeUndefined();
        // The code property is mode-independent.
        vi.unstubAllEnvs();
        expect(make().code).toBe(err.code);
    });

    it('dev and prod forms differ only in message verbosity, not code', () => {
        const dev = mountTargetNotFoundError('#app');
        vi.stubEnv('NODE_ENV', 'production');
        const prod = mountTargetNotFoundError('#app');
        expect(dev.code).toBe(prod.code);
        expect(dev.message).toContain('not found');
        expect(prod.message).not.toContain('not found');
    });
});
