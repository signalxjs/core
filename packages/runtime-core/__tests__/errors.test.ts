import { describe, it, expect } from 'vitest';
import {
    SigxError,
    SigxErrorCode,
    noMountFunctionError,
    renderTargetNotFoundError,
    mountTargetNotFoundError,
    asyncSetupClientError,
    provideOutsideSetupError,
    provideInvalidInjectableError,
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
        ];
        for (const code of diCodes) {
            const num = parseInt(code.replace('SIGX', ''), 10);
            expect(num).toBeGreaterThanOrEqual(200);
            expect(num).toBeLessThanOrEqual(299);
        }
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
});
