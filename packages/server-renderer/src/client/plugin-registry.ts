/**
 * Client plugin registry + app-context tracking (eager half).
 *
 * This module is part of the eager scheduler surface
 * (`@sigx/server-renderer/client/scheduler`): it must not value-import
 * anything from the sigx family — the whole point of the scheduler entry is
 * that registering plugins and scheduling strategies costs zero runtime
 * bytes. The heavy hydration machinery consumes this registry when it loads.
 *
 * Plugins register in one of two forms:
 * - a plain `SSRPlugin` object — resolved immediately (the app-rooted
 *   `install(app)` flow, and packs whose client module is already loaded);
 * - a lazy source `{ name, load }` — the plugin module is dynamically
 *   imported the first time the hydration core loads, so a pack's client
 *   hooks can live in the same lazily-fetched chunk as the renderer.
 */

import type { SSRPlugin } from '../plugin';
import type { AppContext } from 'sigx';

/**
 * A lazily-loaded client plugin: `load()` is invoked (once, cached) by
 * {@link resolveClientPlugins} before the first component hydrates, so the
 * synchronous client hooks always see a resolved plugin.
 */
export interface LazyClientPlugin {
    /** Unique plugin name — the dedupe key across lazy and eager forms. */
    name: string;
    /** Import thunk returning the plugin (or a module with it as default). */
    load: () => Promise<SSRPlugin | { default: SSRPlugin }>;
}

/** Either a resolved plugin object or a lazy source for one. */
export type ClientPluginSource = SSRPlugin | LazyClientPlugin;

interface LazyEntry {
    source: LazyClientPlugin;
    /** In-flight/settled resolution; cleared on failure so a later trigger retries. */
    pending: Promise<void> | null;
}

// ============= Module State =============

// Track current app context during hydration for DI.
// Used for deferred hydration callbacks.
let _currentAppContext: AppContext | null = null;

// Resolved client-side SSR plugins, in registration order.
let _clientPlugins: SSRPlugin[] = [];
// Unresolved lazy sources, in registration order.
let _lazySources: LazyEntry[] = [];
// Names seen across both forms (dedupe, first-wins).
let _pluginNames = new Set<string>();

function isLazySource(source: ClientPluginSource): source is LazyClientPlugin {
    return typeof (source as LazyClientPlugin).load === 'function'
        && !(source as SSRPlugin).client
        && !(source as SSRPlugin).server;
}

// ============= Client Plugin Registry =============

/**
 * Register a client-side SSR plugin — a plugin object, or a lazy source
 * `{ name, load }` whose module is imported together with the hydration
 * core (see {@link resolveClientPlugins} for the resolution guarantee).
 *
 * Registrations dedupe by `name`, first-wins: registering the same name
 * again (in either form) is a no-op, so `hydrateIslands()`-style entries
 * that self-register a lazy source stay compatible with apps that already
 * registered the plugin object explicitly.
 */
export function registerClientPlugin(source: ClientPluginSource): void {
    if (_pluginNames.has(source.name)) {
        if (__DEV__) {
            console.warn(`[Hydrate] Client plugin "${source.name}" is already registered — ignoring the duplicate.`);
        }
        return;
    }
    _pluginNames.add(source.name);
    if (isLazySource(source)) {
        _lazySources.push({ source, pending: null });
    } else {
        _clientPlugins.push(source);
    }
}

/**
 * Get all RESOLVED client-side plugins. Lazy sources that have not been
 * resolved yet (via {@link resolveClientPlugins}) are not included — the
 * boundary-scheduled hydration paths resolve them before hydrating, so
 * hooks invoked from those paths always see the full list.
 */
export function getClientPlugins(): SSRPlugin[] {
    return _clientPlugins;
}

/** Are there registered lazy sources that have not resolved yet? */
export function hasPendingClientPlugins(): boolean {
    return _lazySources.length > 0;
}

/**
 * Resolve all registered lazy plugin sources, in registration order, and
 * return the full plugin list. Each source's `load()` runs once (concurrent
 * calls share the promise); a FAILED load is dropped from the cache so the
 * next trigger retries it, and the failure is reported instead of thrown —
 * one broken pack must not block the others from hydrating.
 *
 * The hydration core awaits this before the first `hydrateComponent`, which
 * is what lets the synchronous client hooks assume resolved plugins.
 */
export function resolveClientPlugins(): Promise<SSRPlugin[]> {
    if (_lazySources.length === 0) return Promise.resolve(_clientPlugins);

    const resolutions = _lazySources.map((entry) => {
        if (!entry.pending) {
            entry.pending = entry.source.load().then((mod) => {
                const plugin = (mod as { default?: SSRPlugin }).default ?? (mod as SSRPlugin);
                _clientPlugins.push(plugin);
                const index = _lazySources.indexOf(entry);
                if (index !== -1) _lazySources.splice(index, 1);
            }, (err) => {
                entry.pending = null; // retry on the next trigger
                if (__DEV__) {
                    console.error(`[Hydrate] Failed to load client plugin "${entry.source.name}":`, err);
                }
            });
        }
        return entry.pending;
    });
    return Promise.all(resolutions).then(() => _clientPlugins);
}

/**
 * Clear all registered client plugins, including unresolved lazy sources
 * (useful for testing).
 */
export function clearClientPlugins(): void {
    _clientPlugins = [];
    _lazySources = [];
    _pluginNames = new Set();
}

// ============= State Accessors =============

/** Get the current app context for deferred hydration */
export function getCurrentAppContext(): AppContext | null {
    return _currentAppContext;
}

/** Set the current app context during hydration */
export function setCurrentAppContext(ctx: AppContext | null): void {
    _currentAppContext = ctx;
}
