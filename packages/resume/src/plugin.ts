/**
 * Resume SSR Plugin (#241)
 *
 * The second first-party strategy pack on @sigx/server-renderer's public
 * plugin API — resumability:
 *
 * - Components stamped by the `sigxResume()` Vite transform (`__resumeId`)
 *   become boundaries with `hydrate: 'never'` — core schedules nothing for
 *   them; the pack's delegation loader wakes them from serialized state.
 * - Components the transform could not fully extract
 *   (`__resumeMode: 'hydrate'`) also record `hydrate: 'never'` but carry
 *   `data-sigx-wake:*` attributes instead of QRLs — the pack's delegation
 *   fully hydrates them on first interaction. Core never schedules resume
 *   boundaries: a resumable page ships no upfront runtime that could
 *   install core's interaction listeners.
 * - Named-signal state is captured during server setup (tracking signal) and
 *   shipped in the component's `__SIGX_BOUNDARIES__` record, where the
 *   client rebuilds the handler scope (`$scope.signals.<name>`) without
 *   running setup.
 * - `$sigxB` — the per-request boundary id — is exposed on the setup context
 *   so the transform-injected `data-sigx-b={ctx.$sigxB}` prop renders each
 *   interactive element's boundary resolution inline (lexical ownership; no
 *   DOM-ancestry search).
 *
 * The client half lives in `@sigx/resume/loader` (the delegation loader —
 * the page's only script) and `@sigx/resume/client` (scope resume,
 * upgrade-on-write); this module is WinterCG-clean server territory.
 *
 * @example
 * ```ts
 * import { createSSR } from '@sigx/server-renderer';
 * import { resumePlugin } from '@sigx/resume';
 *
 * const ssr = createSSR().use(resumePlugin({ manifest }));
 * const html = await ssr.render(<App />);
 * ```
 */

import type { SSRPlugin, ResolvedBoundary, SSRContext } from '@sigx/server-renderer';
import { serializeBoundaryProps, getTypeHandlers } from '@sigx/server-renderer/server';
import { provideHydrateDefaults } from '@sigx/server-renderer/client';
import type { VNode, ComponentSetupContext, App } from 'sigx';
import { signal } from 'sigx';
import type { ResumePluginOptions } from './types';
import { createTrackingSignal, serializeSignalState } from './server/track-signal';

interface ResumePluginData {
    /** Per-component signal maps, keyed by component ID. */
    signalMaps: Map<number, Map<string, any>>;
    /**
     * Boundary ids resume actually claimed in resolveBoundary. Later hooks
     * guard on THIS, not on `ctx.getBoundary(id)` — a record's existence
     * only proves that SOME plugin won the consult.
     */
    claimed: Set<number>;
    /**
     * Claimed ids whose usage-site props the snapshot could not fully carry
     * (children/slots/render props/…) — a server re-render from the record
     * would produce different HTML. Stamped `refreshable: false` onto the
     * record in afterRenderComponent (rfc-server §6.3 decline).
     */
    lossy: Set<number>;
}

const PLUGIN_NAME = 'resume';

/**
 * The transform's component stamp (private transform↔runtime contract).
 * `__resumeMode` also exists on stamped factories but is a TRANSFORM-side
 * concept: it decides which attributes a component's elements carry (QRLs
 * vs `data-sigx-wake:*`). The plugin records `hydrate: 'never'` either way —
 * the pack's delegation owns all waking — so it never reads the mode.
 */
interface ResumeStamps {
    __resumeId?: string;
}

/**
 * Create a resume plugin — dual-shaped like the islands sibling:
 *
 * - As an SSRPlugin (server: `createSSR().use(resumePlugin())`): claims
 *   components carrying the transform's `__resumeId` stamp — unless the
 *   usage site also carries a `client:*` islands directive, which islands
 *   owns (register `islandsPlugin()` first when combining the packs).
 * - As an app plugin (client, coexist mode: `app.use(resumePlugin())`):
 *   declares explicit-boundaries mode. The upgrade restore hook is NOT
 *   registered here — `client/upgrade.ts` registers it lazily on first
 *   upgrade, so app-less resumable pages (whose whole bootstrap is the
 *   generated loader entry) get it for free and this module stays free of
 *   client-runtime imports.
 */
export function resumePlugin(options?: ResumePluginOptions): SSRPlugin & { install(app: App): void } {
    return {
        name: PLUGIN_NAME,

        install(app: App) {
            provideHydrateDefaults(app._context, { boundaries: 'explicit' });
        },

        server: {
            setup(ctx: SSRContext) {
                ctx.setPluginData<ResumePluginData>(PLUGIN_NAME, {
                    signalMaps: new Map(),
                    claimed: new Set(),
                    lossy: new Set()
                });
            },

            resolveBoundary(vnode: VNode, ctx: SSRContext): ResolvedBoundary | undefined {
                const stamps = vnode.type as ResumeStamps;
                const resumeId = stamps.__resumeId;
                if (!resumeId) return undefined; // Not a resumable component — don't claim it

                const allProps = vnode.props || {};
                // A client:* directive at the usage site means islands owns
                // this boundary regardless of .use() order — decline.
                if (Object.keys(allProps).some((key) => key.startsWith('client:'))) {
                    if (__DEV__) {
                        console.warn(
                            `[sigx resume] <${resumeId}> is a resume component used with a client:* ` +
                            `directive — the islands plugin owns it here; resume steps aside. Drop the ` +
                            `directive to make it resumable at this usage site.`
                        );
                    }
                    return undefined;
                }

                let chunk: { url: string; export?: string } | undefined;
                const entry = options?.manifest?.components[resumeId];
                if (entry) {
                    chunk = { url: entry.chunkUrl, export: entry.exportName };
                }

                // Strip framework-internal props; serialize the rest — they
                // become $scope.props on the client and the upgrade's mount
                // snapshot. The key is passed even when undefined so core
                // never falls back to its own snapshot.
                const { children: _children, slots: _slots, $models: _models, ...propsData } = allProps;
                const props = serializeBoundaryProps(propsData, getTypeHandlers(ctx));

                // Remember the claim — the component id is already at the
                // stack top when resolveBoundary runs.
                const id = ctx._componentStack[ctx._componentStack.length - 1];
                const data = ctx.getPluginData<ResumePluginData>(PLUGIN_NAME);
                data?.claimed.add(id);

                // Would a server re-render from this snapshot reproduce the
                // HTML? children/slots/$models never serialize, and any
                // other dropped prop (render props, symbols, circulars)
                // shaped this render but cannot reach a refresh render.
                // Dropped on* handlers are fine — they never shape server
                // HTML — and so are undefined values (absent on re-render).
                let lossy =
                    _children !== undefined || _slots !== undefined || _models !== undefined;
                if (!lossy) {
                    for (const key in propsData) {
                        const value = propsData[key];
                        if (value === undefined || key === 'key' || key === 'ref') continue;
                        if (key.startsWith('on') && key.length > 2 && key[2] === key[2].toUpperCase()) {
                            continue;
                        }
                        if (!props || !(key in props)) {
                            lossy = true;
                            break;
                        }
                    }
                }
                if (lossy) data?.lossy.add(id);

                // ALL resume boundaries opt out of core scheduling — the
                // pack's delegation wakes them (QRL replay for 'resume'
                // components, full hydration for 'hydrate' ones via their
                // wake attributes). flush is never set — content SSRs per
                // core defaults, streaming included. `component` names the
                // record (#259) — core's __islandId || __name derivation
                // doesn't apply to resume stamps.
                return { hydrate: 'never', chunk, component: resumeId, props };
            },

            transformComponentContext(
                ctx: SSRContext,
                vnode: VNode,
                componentCtx: ComponentSetupContext
            ): ComponentSetupContext | void {
                if (!(vnode.type as ResumeStamps).__resumeId) return; // Not resumable — don't touch

                // Transform hooks run for EVERY plugin — only boundaries
                // resume itself claimed in resolveBoundary are touched
                // (declined client:* sites and other packs' wins are not).
                const id = ctx._componentStack[ctx._componentStack.length - 1];
                const data = ctx.getPluginData<ResumePluginData>(PLUGIN_NAME);
                if (!data?.claimed.has(id)) return;
                if (!ctx.getBoundary(id)) return;

                const signalMap = new Map<string, any>();
                data.signalMaps.set(id, signalMap);

                // Capture named-signal state for the resumed scope.
                componentCtx.signal = createTrackingSignal(signalMap) as typeof signal;
                // The transform-injected `data-sigx-b={ctx.$sigxB}` prop reads
                // this — every QRL-carrying element self-describes its
                // boundary. Props evaluate inside the owning component's
                // render, so ownership is lexical.
                (componentCtx as ComponentSetupContext & { $sigxB?: string }).$sigxB = String(id);

                return componentCtx;
            },

            afterRenderComponent(
                id: number,
                _vnode: VNode,
                _html: string,
                ctx: SSRContext
            ): string | void {
                // Capture signal state into the core boundary record — the
                // table ships it to the client, where it becomes the resumed
                // scope (and the upgrade's restore seed). Guard on resume's
                // own claim — this hook fires for every recorded boundary.
                const data = ctx.getPluginData<ResumePluginData>(PLUGIN_NAME);
                if (!data?.claimed.has(id)) return;
                const record = ctx.getBoundary(id);
                if (!record) return;

                // The lossy-snapshot verdict from resolveBoundary lands on
                // the record here (the record doesn't exist yet up there).
                if (data.lossy.has(id)) record.refreshable = false;

                const signalMap = data.signalMaps.get(id);
                if (signalMap && signalMap.size > 0) {
                    const state = serializeSignalState(signalMap, getTypeHandlers(ctx));
                    if (state) {
                        record.state = state;
                    }
                }
            },

            onAsyncComponentResolved(
                id: number,
                _html: string,
                ctx: SSRContext
            ): { html?: string; preScript?: string } | void {
                // Re-capture after async data resolved — core re-emits the
                // mutated record as the __SIGX_BOUNDARIES__ preScript patch,
                // so delegation over streamed content resumes current state.
                // Same claim guard: streamed boundaries of other packs pass
                // through here too.
                const data = ctx.getPluginData<ResumePluginData>(PLUGIN_NAME);
                if (!data?.claimed.has(id)) return;
                const record = ctx.getBoundary(id);
                if (!record) return;

                const signalMap = data.signalMaps.get(id);
                if (signalMap && signalMap.size > 0) {
                    const state = serializeSignalState(signalMap, getTypeHandlers(ctx));
                    if (state) {
                        record.state = state;
                    } else if (record.state) {
                        // The async phase made every key unserializable —
                        // stale pre-async state must not ship (the resumed
                        // scope would show values the DOM no longer matches).
                        delete record.state;
                    }
                }
            }
        }
    };
}
