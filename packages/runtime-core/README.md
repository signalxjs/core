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

### Rest props — forwarding what you didn't consume

Forwarding a component's leftover props onto its root element is plain JS.
Destructure what the component consumes; the rest is what the consumer passed:

```tsx
const Button = component<ButtonProps>(ctx => () => {
  const { variant, ...rest } = ctx.props;
  return <button class={variant} {...rest} />;
});
```

The destructure **is** the declared-props list — there is no helper for it, and
the rest object is typed by TypeScript off the props type. Framework-internal
keys (`key`, `ref`, `children`, model bindings, `client:*` directives) never
appear in `ctx.props` or reach the DOM, so the spread is safe.

For the component's props type to accept host attributes in the first place,
declare `& Define.Attrs`:

```tsx
type ButtonProps = Define.Prop<'variant', 'primary' | 'ghost'> & Define.Attrs;
```

Declare it only if the component really does forward — a type that compiles and
then drops the attribute is the failure mode the opt-in exists to prevent.

#### `mergeProps` — when both sides set the same key

A JSX spread is flattened by the compiler into one object literal before the
runtime sees it, so `<button {...rest} {...bag} />` lets later keys clobber
earlier ones. If the consumer and the component both set `class`, one is lost;
same for `onClick`. `mergeProps` combines them instead:

```tsx
const Button = component<ButtonProps>(ctx => {
  const merged = mergeProps(
    () => { const { variant: _v, ...rest } = ctx.props; return rest; },
    () => ({ class: 'btn', onClick: onActivate })
  );
  return () => <button {...merged}>{ctx.slots.default?.()}</button>;
});
```

| Key | Rule |
|---|---|
| `class` / `className` | concatenated in argument order, emitted as `class` |
| `style` | merged into an object; string sources are parsed first |
| `on*` handlers | chained in source order, **grouped by the event they resolve to** — `onClick` and `onclick` become one entry, so two handlers can never collide in the same DOM listener slot |
| `ref` | chained; every source's ref is fed |
| everything else | exact spread semantics — the last source with the key wins, including an explicit `undefined` |

Two things to know. `mergeProps` is **not** a defaults helper: it replaces a
spread, so it behaves like one (destructuring with defaults already covers
defaults). And call it **once in setup**, as above — the derived `ref` and
chained handlers are identity-cached, and rebuilding them each render hands the
renderer fresh functions that make it tear down and re-apply refs for nothing.
Sources may be thunks, so the result stays reactive either way.

Chaining cannot express *swallow*. A component that gates a consumer handler —
dropping `onClick` while disabled — keeps destructuring it out and calling it
itself.

### Setup reactions are disposed on unmount

`effect()`, `watch()`, and non-detached `effectScope()` created **directly in a
component's setup** are tied to the component's lifetime — they're stopped
automatically when it unmounts (and re-created on HMR reload). You don't need to
hold their handles and call `.stop()` in `onUnmounted`:

```tsx
const Search = component(() => {
  const query = signal('');
  // Auto-disposed on unmount — no manual cleanup needed.
  watch(() => query.value, (q) => runSearch(q));
  return () => <input onInput={(e) => (query.value = e.target.value)} />;
});
```

Only setup itself is scoped: reactions created inside `onMounted`/`onCreated`
(or async callbacks) are not captured — dispose those via `onUnmounted`.
`computed()` is lazy and needs no disposal.

### Required injectables

`defineInjectable(factory)` gives an injectable a zero-config fallback: used without a provider, it lazily creates a module-global singleton. That is right for optional services, and wrong for per-app services like a router — on the server, a forgotten provide would silently share one instance across every request (dev builds warn when this happens during SSR).

Declare those services **required** by passing a name instead of a factory. There is no fallback; using it unprovided throws a structured error (`SIGX202`) naming the injectable. (In production builds, runtime errors carry the `SIGX###` code, any runtime detail, and a link to <https://sigx.dev/errors/> — the full message and fix suggestion appear in dev builds; `error.code` is the same in both.)

```tsx
export const useRouter = defineInjectable<Router>('Router');

// Per app (per request under SSR):
const app = defineApp(<App />);
app.defineProvide(useRouter, () => createRouter(url));

// In any component:
const router = useRouter();
```

App-level provides are read live: a `defineProvide` call made after `app.mount()` is visible to components mounted afterwards. Component-tree provides (`defineProvide` in setup) always take precedence.

That generated suggestion assumes `defineProvide` is the remedy. For a pack whose injectable is satisfied by *rendering* something, pass your own `hint` — it replaces the suggestion, keeping the `SIGX202` code and the name:

```tsx
export const useScreen = defineInjectable<Screen>('Screen', {
    hint: 'useIsFocused must be called from a component rendered as a route by <Stack>.',
});
```

The hint is only read in dev builds, but the string literal lives in *your* module, so it ships in your production bundle regardless — gate it yourself (`hint: __DEV__ ? '…' : undefined`) if the bytes matter.

The dev SSR warning on the factory form names the injectable after `factory.name`, which inline arrow factories don't have. Pass `{ name }` to name it — otherwise the warning falls back to the definition site (`defined at file:line`), captured dev-only:

```tsx
export const useSessionStore = defineInjectable(() => createSessionStore(), { name: 'sessionStore' });
```

The warning is skipped on live clients. That check is `isLiveClient()`, not `typeof window`, so windowless-but-live runtimes (lynx, terminal, Web Workers) stay quiet — see the `declareLiveClient()` note in the async docs.

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

The context applies only to the **synchronous** portion of the callback — after an `await`, re-enter with another `runWithContext` call (dev builds warn once per app when the callback returns a Promise or other thenable):

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

Libraries that run user-authored callbacks in app context (routers invoking navigation guards, schedulers running handlers) can tailor that warning with the `asyncAdvice` option, so the advice reaches the callback's author instead of pointing at a `runWithContext` call site they never see:

```tsx
// A string replaces the remediation sentence of the warning…
app.runWithContext(() => userGuard(to, from), {
  asyncAdvice: '(from my-router) Resolve injectables at the top of the guard, before the first await.'
});

// …false suppresses it for a deliberately sync-only call (the once-per-app
// warning slot is not consumed — later unmarked async callbacks still warn).
app.runWithContext(fn, { asyncAdvice: false });
```

Dev-only; ignored in production builds. The warning still fires at most once per app across all callers.

### Writing plugins

A plugin is a function or an object with `install(app, options?)`, registered with `app.use()`. Inside `install`, `app._context` is the supported surface for wiring app-wide services — pass it to seam provide-helpers (e.g. `provideAsyncEngine` from `sigx/internals`) or use `app.defineProvide` for injectables. The underscore marks it as an advanced surface, not a private one; no cast is needed:

```tsx
import { defineInjectable, type Plugin } from '@sigx/runtime-core';

class MyService {
  close() { /* release sockets, timers, … */ }
}

export const useMyService = defineInjectable(() => new MyService());

export const myPlugin: Plugin = {
  name: 'my-plugin',
  install(app) {
    const service = app.defineProvide(useMyService);
    app._context.disposables.add(() => service.close());
  }
};
```

### Non-web renderers

This package references no web global unguarded — it runs anywhere. One thing renderer authors must know: `useData`/`useStream` only auto-run their sources on a **live client**, and without a declaration that is detected as "`window` exists" (which keeps server renders safe). A client runtime with no `window` (native, terminal) must say so once, from its platform-identity module:

```ts
import { declareLiveClient } from '@sigx/runtime-core/internals';

declareLiveClient(); // this runtime is a live client — keyed reads fetch on mount
```

Never call this from code a server render can evaluate (that would defeat the SSR guard) — it belongs in the module that defines your renderer's platform, the way `@sigx/runtime-dom/platform` defines the web's.

A declaration also stamps `globalThis.__SIGX_LIVE_CLIENT__`, which `@sigx/server`'s live-client guard reads (rfc-server rev 2): a server function invoked in a declared live client throws instead of executing its body locally. The `window` fallback never stamps.

> **Note:** Most users should install [`sigx`](https://www.npmjs.com/package/sigx) instead, which bundles this package with a DOM renderer and the reactivity system.

## 📚 Documentation

The complete export list (component model, JSX runtime, lifecycle, lazy/Defer, DI, control flow, directives, error handling), guides and live examples → **<https://sigx.dev/core/packages/runtime-core/overview/>**

## License

[MIT](https://github.com/signalxjs/core/blob/main/LICENSE)
