// Tests run against package sources, which use the `__DEV__` compile-time
// flag. A static `define` won't do here: Vite substitutes
// `process.env.NODE_ENV` inside define values at transform time, freezing the
// flag, while several suites flip NODE_ENV at runtime to exercise production
// branches. A global getter keeps the lookup dynamic per access.
Object.defineProperty(globalThis, '__DEV__', {
    configurable: true,
    get: () => process.env.NODE_ENV !== 'production'
});
