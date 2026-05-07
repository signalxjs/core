/**
 * Async-safe context storage for SSR request isolation.
 *
 * On Node.js (server), uses AsyncLocalStorage to scope state per-request,
 * preventing cross-request contamination when concurrent requests share
 * the same process (e.g., async component setup with `await`).
 *
 * On browsers (client), falls back to simple module-level variables
 * since there's only ever one "request" in the browser.
 */

// ============= Types =============

interface SSRRequestContext {
    /** Current component context (replaces module-level singleton) */
    currentComponentContext: any | null;
    /** Current suspense boundary */
    currentSuspenseBoundary: any | null;
}

// ============= Implementation =============

/**
 * Try to load AsyncLocalStorage from Node.js.
 * Returns null in browser environments.
 */
let asyncLocalStorage: any = null;

try {
    // Use dynamic require-style check — bundlers will tree-shake this for browser builds
    if (typeof globalThis !== 'undefined' && typeof (globalThis as any).process !== 'undefined') {
        const nodeAsync = (globalThis as any).process?.versions?.node
            ? require('node:async_hooks')
            : null;
        if (nodeAsync?.AsyncLocalStorage) {
            asyncLocalStorage = new nodeAsync.AsyncLocalStorage();
        }
    }
} catch {
    // Not in Node.js or AsyncLocalStorage not available — use fallback
}

// ============= Fallback (browser / older Node.js) =============

let _fallbackContext: SSRRequestContext = {
    currentComponentContext: null,
    currentSuspenseBoundary: null
};

// ============= Public API =============

/**
 * Get the current request context.
 * Returns the AsyncLocalStorage store if available, otherwise the module-level fallback.
 */
function getRequestContext(): SSRRequestContext {
    if (asyncLocalStorage) {
        const store = asyncLocalStorage.getStore();
        if (store) return store;
    }
    return _fallbackContext;
}

/**
 * Get the current component context (request-safe).
 */
export function getCurrentInstanceSafe(): any | null {
    return getRequestContext().currentComponentContext;
}

/**
 * Set the current component context (request-safe).
 * Returns the previous value.
 */
export function setCurrentInstanceSafe(ctx: any | null): any | null {
    const reqCtx = getRequestContext();
    const prev = reqCtx.currentComponentContext;
    reqCtx.currentComponentContext = ctx;
    return prev;
}

/**
 * Get the current suspense boundary (request-safe).
 */
export function getCurrentSuspenseBoundarySafe(): any | null {
    return getRequestContext().currentSuspenseBoundary;
}

/**
 * Set the current suspense boundary (request-safe).
 * Returns the previous value.
 */
export function setCurrentSuspenseBoundarySafe(boundary: any | null): any | null {
    const reqCtx = getRequestContext();
    const prev = reqCtx.currentSuspenseBoundary;
    reqCtx.currentSuspenseBoundary = boundary;
    return prev;
}

/**
 * Run a function within a new isolated request context.
 * On Node.js, uses AsyncLocalStorage.run() to create a new scope.
 * On browsers, simply calls the function (no isolation needed).
 *
 * @example
 * ```ts
 * // In SSR request handler:
 * const html = await runInRequestScope(async () => {
 *     return await ssr.render(<App />);
 * });
 * ```
 */
export function runInRequestScope<T>(fn: () => T): T {
    if (asyncLocalStorage) {
        const freshContext: SSRRequestContext = {
            currentComponentContext: null,
            currentSuspenseBoundary: null
        };
        return asyncLocalStorage.run(freshContext, fn);
    }
    // Browser fallback — just call the function
    return fn();
}

/**
 * Check if AsyncLocalStorage-based request isolation is available.
 */
export function hasRequestIsolation(): boolean {
    return asyncLocalStorage !== null;
}
