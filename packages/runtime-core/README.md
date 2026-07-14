# @sigx/runtime-core

Runtime core for SignalX. Provides the platform-agnostic component system, JSX runtime, reconciler, lifecycle hooks, dependency injection, and control flow primitives.

📚 **Full guides, API reference and live examples → <https://sigx.dev/core/packages/runtime-core/overview/>**

## Install

```bash
npm install @sigx/runtime-core
```

## Usage

```tsx
import { component, signal, onMounted, onUnmounted } from '@sigx/runtime-core';

const Timer = component(() => {
  const elapsed = signal(0);
  let interval: number;

  onMounted(() => {
    interval = setInterval(() => elapsed.value++, 1000);
  });

  onUnmounted(() => {
    clearInterval(interval);
  });

  return () => <span>Elapsed: {elapsed.value}s</span>;
});
```

### Dependency injection outside components

Use-functions from `defineInjectable`/`defineFactory` resolve to app-context instances inside components. Code that runs outside component setup — router navigation guards, socket handlers, entry-scope code — must opt in with `app.runWithContext(fn)`, or it silently gets a separate realm-level fallback instance:

```tsx
const useAuthStore = defineFactory(() => createAuthStore(), 'scoped');
const app = defineApp(<App />);

router.beforeEach((to) => {
  // Same instance the app's components see — not a realm copy.
  const auth = app.runWithContext(() => useAuthStore());
  if (!auth.isAuthenticated && to.meta.requiresAuth) return '/login';
});
```

The context applies only to the **synchronous** portion of the callback — after an `await`, re-enter with another `runWithContext` call (dev builds warn once per app when the callback returns a Promise):

```tsx
// ❌ Wrong — after the await, useSession() resolves a realm fallback, not the app's instance
await app.runWithContext(async () => {
  const user = await fetchUser();
  useSession().user = user; // context already restored here
});

// ✅ Right — re-enter for each synchronous section that resolves dependencies
const user = await fetchUser();
app.runWithContext(() => {
  useSession().user = user;
});
```

Nested calls restore the previous context. Plugins receive the app in `install()` and can capture it to wrap their own callbacks.

### Non-web renderers

This package references no web global unguarded — it runs anywhere. One thing renderer authors must know: `useData`/`useStream` only auto-run their sources on a **live client**, and without a declaration that is detected as "`window` exists" (which keeps server renders safe). A client runtime with no `window` (native, terminal) must say so once, from its platform-identity module:

```ts
import { declareLiveClient } from '@sigx/runtime-core/internals';

declareLiveClient(); // this runtime is a live client — keyed reads fetch on mount
```

Never call this from code a server render can evaluate (that would defeat the SSR guard) — it belongs in the module that defines your renderer's platform, the way `@sigx/runtime-dom/platform` defines the web's.

> **Note:** Most users should install [`sigx`](https://www.npmjs.com/package/sigx) instead, which bundles this package with a DOM renderer and the reactivity system.

## 📚 Documentation

The complete export list (component model, JSX runtime, lifecycle, lazy/Defer, DI, control flow, directives, error handling), guides and live examples → **<https://sigx.dev/core/packages/runtime-core/overview/>**

## License

[MIT](https://github.com/signalxjs/core/blob/main/LICENSE)
