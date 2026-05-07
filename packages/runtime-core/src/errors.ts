/**
 * Structured error system for SignalX runtime.
 *
 * Every runtime error has a unique code (SIGX001–SIGX999) so users can
 * programmatically handle errors and look them up in documentation.
 *
 * @example
 * ```ts
 * try {
 *     app.mount('#app');
 * } catch (e) {
 *     if (e instanceof SigxError && e.code === 'SIGX101') {
 *         // handle missing mount target
 *     }
 * }
 * ```
 */

/**
 * Base error class for all SignalX runtime errors.
 */
export class SigxError extends Error {
    readonly code: string;
    readonly suggestion?: string;
    declare readonly cause?: Error;

    constructor(
        message: string,
        options: {
            code: string;
            suggestion?: string;
            cause?: Error;
        }
    ) {
        super(message);
        this.name = 'SigxError';
        this.code = options.code;
        this.suggestion = options.suggestion;
        if (options.cause) {
            this.cause = options.cause;
        }
    }
}

/**
 * Error codes for the SignalX runtime.
 *
 * Ranges:
 * - SIGX001–SIGX099: App lifecycle
 * - SIGX100–SIGX199: Rendering / mounting
 * - SIGX200–SIGX299: Dependency injection
 */
export const SigxErrorCode = {
    // App lifecycle
    NO_MOUNT_FUNCTION: 'SIGX001',
    // Rendering / mounting
    RENDER_TARGET_NOT_FOUND: 'SIGX100',
    MOUNT_TARGET_NOT_FOUND: 'SIGX101',
    ASYNC_SETUP_CLIENT: 'SIGX102',
    // Dependency injection
    PROVIDE_OUTSIDE_SETUP: 'SIGX200',
    PROVIDE_INVALID_INJECTABLE: 'SIGX201',
} as const;

// ============================================================================
// App Errors
// ============================================================================

export function noMountFunctionError(): SigxError {
    return new SigxError(
        'No mount function provided and no default mount function set.',
        {
            code: SigxErrorCode.NO_MOUNT_FUNCTION,
            suggestion:
                'Either pass a mount function to app.mount(), or import a platform package ' +
                '(e.g., @sigx/runtime-dom) that sets the default.',
        }
    );
}

// ============================================================================
// Render / Mount Errors
// ============================================================================

export function renderTargetNotFoundError(selector: string): SigxError {
    return new SigxError(
        `Render target "${selector}" not found.`,
        {
            code: SigxErrorCode.RENDER_TARGET_NOT_FOUND,
            suggestion: `Make sure the element exists in your HTML: <div id="${selector.replace(/^#/, '')}"></div>`,
        }
    );
}

export function mountTargetNotFoundError(selector: string): SigxError {
    return new SigxError(
        `Mount target "${selector}" not found.`,
        {
            code: SigxErrorCode.MOUNT_TARGET_NOT_FOUND,
            suggestion: `Make sure the element exists in your HTML: <div id="${selector.replace(/^#/, '')}"></div>`,
        }
    );
}

export function asyncSetupClientError(componentName: string): SigxError {
    return new SigxError(
        `Async setup in component "${componentName}" is only supported during SSR.`,
        {
            code: SigxErrorCode.ASYNC_SETUP_CLIENT,
            suggestion:
                'On the client, use pre-loaded data from hydration or fetch in onMounted.',
        }
    );
}

// ============================================================================
// Dependency Injection Errors
// ============================================================================

export function provideOutsideSetupError(): SigxError {
    return new SigxError(
        'defineProvide must be called inside a component setup function.',
        {
            code: SigxErrorCode.PROVIDE_OUTSIDE_SETUP,
            suggestion:
                'Move the defineProvide() call inside your component\'s setup function, or use app.defineProvide() at the app level.',
        }
    );
}

export function provideInvalidInjectableError(): SigxError {
    return new SigxError(
        'defineProvide must be called with a function created by defineInjectable.',
        {
            code: SigxErrorCode.PROVIDE_INVALID_INJECTABLE,
            suggestion:
                'Create an injectable first:\n' +
                '  const useMyService = defineInjectable(() => new MyService());\n' +
                '  defineProvide(useMyService);',
        }
    );
}
