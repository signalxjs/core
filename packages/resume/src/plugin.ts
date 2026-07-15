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
 *   (`__resumeMode: 'hydrate'`) degrade to island-style
 *   `hydrate: 'interaction'` — core's boundary hydrator handles them.
 * - Named-signal state is captured during server setup (tracking signal) and
 *   shipped in the component's `__SIGX_BOUNDARIES__` record, where the
 *   client rebuilds the handler scope (`$scope.signals.<name>`) without
 *   running setup.
 * - `$sigxB` — the per-request boundary id — is exposed on the setup context
 *   so the transform-injected `data-sigx-b={ctx.$sigxB}` prop renders each
 *   interactive element's boundary resolution inline (lexical ownership; no
 *   DOM-ancestry search).
 *
 * The client half (delegation loader, scope resume, upgrade-on-write) lands
 * with the later #241 PRs; this module is WinterCG-clean server territory.
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
import type { VNode, ComponentSetupContext } from 'sigx';
import type { signal } from 'sigx';
import type { ResumePluginOptions } from './types';
import { createTrackingSignal, serializeSignalState } from './server/track-signal';

interface ResumePluginData {
    /** Per-component signal maps, keyed by component ID. */
    signalMaps: Map<number, Map<string, any>>;
}

const PLUGIN_NAME = 'resume';

/** The transform's component stamps (private transform↔runtime contract). */
interface ResumeStamps {
    __resumeId?: string;
    __resumeMode?: 'resume' | 'hydrate';
}

/**
 * Create a resume plugin for `createSSR().use(...)`.
 *
 * Claims components carrying the transform's `__resumeId` stamp — unless the
 * usage site also carries a `client:*` islands directive, which islands owns
 * (register `islandsPlugin()` first when combining the packs).
 */
export function resumePlugin(options?: ResumePluginOptions): SSRPlugin {
    return {
        name: PLUGIN_NAME,

        server: {
            setup(ctx: SSRContext) {
                ctx.setPluginData<ResumePluginData>(PLUGIN_NAME, {
                    signalMaps: new Map()
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

                // Fully-extracted components opt out of core scheduling
                // entirely; partially-extracted ones ride core's interaction
                // strategy. flush is never set — content SSRs per core
                // defaults, streaming included.
                return stamps.__resumeMode === 'hydrate'
                    ? { hydrate: 'interaction', chunk, props }
                    : { hydrate: 'never', chunk, props };
            },

            transformComponentContext(
                ctx: SSRContext,
                vnode: VNode,
                componentCtx: ComponentSetupContext
            ): ComponentSetupContext | void {
                if (!(vnode.type as ResumeStamps).__resumeId) return; // Not resumable — don't touch

                // The boundary record exists before this hook runs. No record
                // means another plugin won the consult (or resume declined) —
                // leave the context alone.
                const id = ctx._componentStack[ctx._componentStack.length - 1];
                if (!ctx.getBoundary(id)) return;

                const data = ctx.getPluginData<ResumePluginData>(PLUGIN_NAME)!;
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
                // scope (and the upgrade's restore seed).
                const record = ctx.getBoundary(id);
                if (!record) return;

                const data = ctx.getPluginData<ResumePluginData>(PLUGIN_NAME);
                const signalMap = data?.signalMaps.get(id);
                if (signalMap && signalMap.size > 0) {
                    const state = serializeSignalState(signalMap);
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
                const record = ctx.getBoundary(id);
                if (!record) return;

                const data = ctx.getPluginData<ResumePluginData>(PLUGIN_NAME);
                const signalMap = data?.signalMaps.get(id);
                if (signalMap && signalMap.size > 0) {
                    const state = serializeSignalState(signalMap);
                    if (state) {
                        record.state = state;
                    }
                }
            }
        }
    };
}
