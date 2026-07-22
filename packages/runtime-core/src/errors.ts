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
 * - SIGX300–SIGX399: Hooks / async
 * - SIGX400–SIGX499: Messaging
 */
export const SigxErrorCode = {
    // App lifecycle
    NO_MOUNT_FUNCTION: 'SIGX001',
    // Rendering / mounting
    RENDER_TARGET_NOT_FOUND: 'SIGX100',
    MOUNT_TARGET_NOT_FOUND: 'SIGX101',
    ASYNC_SETUP_CLIENT: 'SIGX102',
    ERROR_SCOPE_OUTSIDE_SETUP: 'SIGX103',
    // Dependency injection
    PROVIDE_OUTSIDE_SETUP: 'SIGX200',
    PROVIDE_INVALID_INJECTABLE: 'SIGX201',
    REQUIRED_INJECTABLE_NOT_PROVIDED: 'SIGX202',
    FACTORY_INVALID_RETURN: 'SIGX203',
    // Hooks / async
    HOOK_OUTSIDE_SETUP: 'SIGX300',
    // Messaging
    TOPIC_DESTROYED: 'SIGX400',
    TOPIC_GROUP_DESTROYED: 'SIGX401',
} as const;

/**
 * In production builds the factories below throw the bare code, any runtime
 * detail, and a docs pointer — the full human-readable messages and
 * `suggestion` strings are dev-only (the `__DEV__` branches fold away, so
 * their literals never reach the prod dist). The docs base is the single URL
 * literal that ships in prod.
 *
 * `prodError` is exposed via `@sigx/runtime-core/internals` so first-party packs
 * that throw coded errors (e.g. `@sigx/server-renderer`) build the same coded
 * prod message without copying the `SIGX### … — see <url>` scaffolding.
 */
const ERRORS_URL = 'https://sigx.dev/errors/';

export function prodError(code: string, detail?: string): SigxError {
    return new SigxError(
        `${code}${detail ? ` ${detail}` : ''} — see ${ERRORS_URL}${code}/`,
        { code }
    );
}

// ============================================================================
// App Errors
// ============================================================================

export function noMountFunctionError(): SigxError {
    const code = SigxErrorCode.NO_MOUNT_FUNCTION;
    if (__DEV__) {
        return new SigxError(
            'No mount function provided and no default mount function set.',
            {
                code,
                suggestion:
                    'Either pass a mount function to app.mount(), or import a platform package ' +
                    '(e.g., @sigx/runtime-dom) that sets the default.',
            }
        );
    }
    return prodError(code);
}

// ============================================================================
// Render / Mount Errors
// ============================================================================

export function renderTargetNotFoundError(selector: string): SigxError {
    const code = SigxErrorCode.RENDER_TARGET_NOT_FOUND;
    if (__DEV__) {
        return new SigxError(
            `Render target "${selector}" not found.`,
            {
                code,
                suggestion: `Make sure the element exists in your HTML: <div id="${selector.replace(/^#/, '')}"></div>`,
            }
        );
    }
    return prodError(code, `"${selector}"`);
}

export function mountTargetNotFoundError(selector: string): SigxError {
    const code = SigxErrorCode.MOUNT_TARGET_NOT_FOUND;
    if (__DEV__) {
        return new SigxError(
            `Mount target "${selector}" not found.`,
            {
                code,
                suggestion: `Make sure the element exists in your HTML: <div id="${selector.replace(/^#/, '')}"></div>`,
            }
        );
    }
    return prodError(code, `"${selector}"`);
}

export function asyncSetupClientError(componentName: string): SigxError {
    const code = SigxErrorCode.ASYNC_SETUP_CLIENT;
    if (__DEV__) {
        return new SigxError(
            `Async setup in component "${componentName}" is only supported during SSR.`,
            {
                code,
                suggestion:
                    'On the client, use pre-loaded data from hydration or fetch in onMounted.',
            }
        );
    }
    return prodError(code, `"${componentName}"`);
}

export function errorScopeOutsideSetupError(): SigxError {
    const code = SigxErrorCode.ERROR_SCOPE_OUTSIDE_SETUP;
    if (__DEV__) {
        return new SigxError(
            'errorScope() must be called synchronously during component setup.',
            {
                code,
                suggestion:
                    'Move the errorScope() call into the component\'s setup function (before returning the render function).',
            }
        );
    }
    return prodError(code);
}

// ============================================================================
// Dependency Injection Errors
// ============================================================================

export function provideOutsideSetupError(): SigxError {
    const code = SigxErrorCode.PROVIDE_OUTSIDE_SETUP;
    if (__DEV__) {
        return new SigxError(
            'defineProvide must be called inside a component setup function.',
            {
                code,
                suggestion:
                    'Move the defineProvide() call inside your component\'s setup function, or use app.defineProvide() at the app level.',
            }
        );
    }
    return prodError(code);
}

/**
 * @param hint - Dev-only replacement for the generated suggestion. A pack whose
 * injectable is satisfied by rendering something (`<NavigationRoot>`) rather
 * than by `defineProvide` passes its own remedy here.
 */
export function requiredInjectableNotProvidedError(name: string, hint?: string): SigxError {
    const code = SigxErrorCode.REQUIRED_INJECTABLE_NOT_PROVIDED;
    if (__DEV__) {
        // Suggest the conventional use-function identifier only when the name
        // can form one; free-form names get a generic placeholder instead of
        // a misleading `use${name}`.
        const useFn = /^[A-Za-z][A-Za-z0-9_$]*$/.test(name)
            ? `use${name[0].toUpperCase()}${name.slice(1)}`
            : '<your use-function>';
        return new SigxError(
            `Injectable "${name}" was used without being provided.`,
            {
                code,
                suggestion: hint ??
                    `Provide it before use: app.defineProvide(${useFn}, () => ...) before ` +
                    `mount/hydrate, or defineProvide(${useFn}, () => ...) in an ancestor ` +
                    "component's setup.",
            }
        );
    }
    return prodError(code, `"${name}"`);
}

export function provideInvalidInjectableError(): SigxError {
    const code = SigxErrorCode.PROVIDE_INVALID_INJECTABLE;
    if (__DEV__) {
        return new SigxError(
            'defineProvide must be called with a function created by defineInjectable or defineFactory.',
            {
                code,
                suggestion:
                    'Create an injectable or factory first:\n' +
                    '  const useMyService = defineInjectable(() => new MyService());\n' +
                    "  // or: const useMyService = defineFactory(setup, 'scoped');\n" +
                    '  defineProvide(useMyService);',
            }
        );
    }
    return prodError(code);
}

export function factoryInvalidReturnError(got: string): SigxError {
    const code = SigxErrorCode.FACTORY_INVALID_RETURN;
    if (__DEV__) {
        return new SigxError(
            `[sigx] defineFactory setup must return an object or function, got ${got}.`,
            {
                code,
                suggestion:
                    'Return the service object (or callable) from the factory setup — ' +
                    'primitives cannot carry the dispose contract factories rely on.',
            }
        );
    }
    return prodError(code, got);
}

// ============================================================================
// Hook Errors
// ============================================================================

export function hookOutsideSetupError(hookName: string): SigxError {
    const code = SigxErrorCode.HOOK_OUTSIDE_SETUP;
    if (__DEV__) {
        return new SigxError(
            `${hookName}() must be called synchronously during component setup.`,
            {
                code,
                suggestion:
                    `Move the ${hookName}() call into the component's setup function (before returning the render function).`,
            }
        );
    }
    return prodError(code, `${hookName}()`);
}

// ============================================================================
// Messaging Errors
// ============================================================================

export function topicDestroyedError(name?: string): SigxError {
    const code = SigxErrorCode.TOPIC_DESTROYED;
    if (__DEV__) {
        return new SigxError(
            `[sigx] Cannot subscribe to destroyed topic${name ? ` "${name}"` : ''}.`,
            {
                code,
                suggestion:
                    'Subscriptions made after destroyTopic()/group.destroy() can never fire. ' +
                    'Subscribe before teardown, or create a new topic.',
            }
        );
    }
    return prodError(code, name ? `"${name}"` : undefined);
}

export function topicGroupDestroyedError(key: string): SigxError {
    const code = SigxErrorCode.TOPIC_GROUP_DESTROYED;
    if (__DEV__) {
        return new SigxError(
            `[sigx] Cannot create topic "${key}" on a destroyed topic group.`,
            {
                code,
                suggestion:
                    'The group was destroyed; create its topics before destroy(), or recreate the group.',
            }
        );
    }
    return prodError(code, `"${key}"`);
}
