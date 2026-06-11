/**
 * Head management composable — browser-standalone, SSR-enhanced.
 *
 * `useHead()` manages `<head>` elements (title, meta, link, script) from
 * within components. In the browser it applies changes to the document
 * directly and cleans them up on unmount. Under server rendering, the
 * server walk installs a per-request context on the component instance and
 * useHead collects into it (duck-typed — this package never imports server
 * code); `@sigx/server-renderer` injects the collected tags into the
 * document head.
 *
 * Layering rule: composables that run standalone in a browser live in core
 * (sigx); only server machinery lives in @sigx/server-renderer.
 *
 * @example
 * ```tsx
 * import { component, useHead } from 'sigx';
 *
 * const MyPage = component(() => {
 *     useHead({
 *         title: 'My Page',
 *         meta: [
 *             { name: 'description', content: 'A great page' },
 *             { property: 'og:title', content: 'My Page' }
 *         ],
 *         link: [
 *             { rel: 'canonical', href: 'https://example.com/my-page' }
 *         ]
 *     });
 *
 *     return () => <div>Page content</div>;
 * });
 * ```
 */

import { getCurrentInstance } from '@sigx/runtime-core';

// ============= Types =============

export interface HeadMeta {
    name?: string;
    property?: string;
    'http-equiv'?: string;
    charset?: string;
    content?: string;
    [key: string]: string | undefined;
}

export interface HeadLink {
    rel: string;
    href?: string;
    type?: string;
    crossorigin?: string;
    [key: string]: string | undefined;
}

export interface HeadScript {
    src?: string;
    type?: string;
    async?: boolean;
    defer?: boolean;
    innerHTML?: string;
    [key: string]: string | boolean | undefined;
}

export interface HeadConfig {
    /** Page title */
    title?: string;
    /** Title template — use %s as placeholder for the title */
    titleTemplate?: string;
    /** Meta tags */
    meta?: HeadMeta[];
    /** Link tags */
    link?: HeadLink[];
    /** Script tags */
    script?: HeadScript[];
    /** HTML language attribute */
    htmlAttrs?: { lang?: string; dir?: string; [key: string]: string | undefined };
    /** Body attributes */
    bodyAttrs?: { class?: string; [key: string]: string | undefined };
}

// ============= Client-side Head Management =============

let _headToken = 0;

function applyHeadClient(config: HeadConfig): (() => void) {
    const managed: HTMLElement[] = [];
    const token = ++_headToken;

    if (config.title) {
        const title = config.titleTemplate
            ? config.titleTemplate.replace('%s', config.title)
            : config.title;
        document.title = title;
    }

    if (config.meta) {
        for (const meta of config.meta) {
            // Remove existing matching meta
            const selector = meta.name ? `meta[name="${meta.name}"]` :
                meta.property ? `meta[property="${meta.property}"]` :
                    meta['http-equiv'] ? `meta[http-equiv="${meta['http-equiv']}"]` :
                        meta.charset ? 'meta[charset]' : null;

            if (selector) {
                const existing = document.querySelector(selector);
                if (existing) existing.remove();
            }

            const el = document.createElement('meta');
            for (const [k, v] of Object.entries(meta)) {
                if (v !== undefined) el.setAttribute(k, v);
            }
            el.setAttribute('data-sigx-head', String(token));
            document.head.appendChild(el);
            managed.push(el);
        }
    }

    if (config.link) {
        for (const link of config.link) {
            const el = document.createElement('link');
            for (const [k, v] of Object.entries(link)) {
                if (v !== undefined) el.setAttribute(k, v);
            }
            el.setAttribute('data-sigx-head', String(token));
            document.head.appendChild(el);
            managed.push(el);
        }
    }

    if (config.script) {
        for (const script of config.script) {
            const { innerHTML, ...rest } = script;
            const el = document.createElement('script');
            for (const [k, v] of Object.entries(rest)) {
                if (v === true) el.setAttribute(k, '');
                else if (v !== undefined && v !== false) el.setAttribute(k, String(v));
            }
            if (innerHTML) el.textContent = innerHTML;
            el.setAttribute('data-sigx-head', String(token));
            document.head.appendChild(el);
            managed.push(el);
        }
    }

    if (config.htmlAttrs) {
        for (const [k, v] of Object.entries(config.htmlAttrs)) {
            if (v !== undefined) document.documentElement.setAttribute(k, v);
        }
    }

    if (config.bodyAttrs) {
        for (const [k, v] of Object.entries(config.bodyAttrs)) {
            if (v !== undefined) document.body.setAttribute(k, v);
        }
    }

    // Return cleanup function
    return () => {
        for (const el of managed) {
            el.remove();
        }
    };
}

// ============= Public API =============

/**
 * Manage `<head>` elements from within a component.
 *
 * Browser: applies to the document `<head>` directly; cleans up on
 * component unmount. Server rendering: collects on the per-request render
 * context for injection by the server renderer.
 *
 * @param config - Head configuration (title, meta, link, script, etc.)
 */
export function useHead(config: HeadConfig): void {
    const instance = getCurrentInstance() as any;

    // Server rendering: the server walk installs `ssr._ctx` (the
    // per-request render context) on the component instance — collect
    // there. Safe under concurrent renders; no module-level state.
    const ssrCtx = instance?.ssr?.isServer ? instance.ssr._ctx : null;
    if (ssrCtx) {
        ssrCtx._headConfigs.push(config);
        return;
    }

    // No DOM (server-side, outside a component) — nothing to apply to
    if (typeof document === 'undefined') {
        if ((globalThis as any).process?.env?.NODE_ENV !== 'production') {
            console.warn(
                '[useHead] called on the server outside a component setup — ' +
                'the config was ignored. Call useHead synchronously during setup.'
            );
        }
        return;
    }

    // Client-side: apply to DOM and register cleanup on unmount
    const cleanup = applyHeadClient(config);
    if (instance) {
        instance.onUnmounted(() => cleanup());
    }
}
