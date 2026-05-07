/**
 * Head management composable for SSR and client-side.
 *
 * Provides `useHead()` for managing `<head>` elements (title, meta, link, script)
 * from within components. Works during SSR (collects into SSRContext._head) and
 * on the client (updates DOM directly).
 *
 * @example
 * ```tsx
 * import { useHead } from '@sigx/server-renderer/head';
 *
 * function MyPage(ctx) {
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
 * }
 * ```
 */

import { getCurrentInstance } from 'sigx';

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

// ============= SSR Head Collection =============

// Server-side: head configs are collected during rendering
let _ssrHeadConfigs: HeadConfig[] = [];
let _isSSR = false;

/**
 * Enable SSR mode for head management.
 * Called by the SSR renderer before rendering starts.
 */
export function enableSSRHead(): void {
    _isSSR = true;
    _ssrHeadConfigs = [];
}

/**
 * Disable SSR mode and return collected configs.
 */
export function collectSSRHead(): HeadConfig[] {
    _isSSR = false;
    const configs = _ssrHeadConfigs;
    _ssrHeadConfigs = [];
    return configs;
}

/**
 * Render collected head configs to an HTML string.
 * Deduplicates meta tags by name/property and uses the last title.
 */
export function renderHeadToString(configs: HeadConfig[]): string {
    const parts: string[] = [];
    const seenMeta = new Map<string, string>();
    let finalTitle: string | undefined;
    let titleTemplate: string | undefined;

    // Process in order — later configs override earlier ones
    for (const config of configs) {
        if (config.titleTemplate) {
            titleTemplate = config.titleTemplate;
        }
        if (config.title) {
            finalTitle = config.title;
        }

        if (config.meta) {
            for (const meta of config.meta) {
                // Deduplicate by name or property
                const key = meta.name ? `name:${meta.name}` :
                    meta.property ? `property:${meta.property}` :
                        meta['http-equiv'] ? `http-equiv:${meta['http-equiv']}` :
                            meta.charset ? 'charset' : null;

                const attrs = Object.entries(meta)
                    .filter(([, v]) => v !== undefined)
                    .map(([k, v]) => `${escapeAttr(k)}="${escapeAttr(String(v))}"`)
                    .join(' ');

                const tag = `<meta ${attrs}>`;

                if (key) {
                    seenMeta.set(key, tag);
                } else {
                    parts.push(tag);
                }
            }
        }

        if (config.link) {
            for (const link of config.link) {
                const attrs = Object.entries(link)
                    .filter(([, v]) => v !== undefined)
                    .map(([k, v]) => `${escapeAttr(k)}="${escapeAttr(String(v))}"`)
                    .join(' ');
                parts.push(`<link ${attrs}>`);
            }
        }

        if (config.script) {
            for (const script of config.script) {
                const { innerHTML, ...rest } = script;
                const attrs = Object.entries(rest)
                    .filter(([, v]) => v !== undefined && v !== false)
                    .map(([k, v]) => v === true ? escapeAttr(k) : `${escapeAttr(k)}="${escapeAttr(String(v))}"`)
                    .join(' ');
                if (innerHTML) {
                    parts.push(`<script ${attrs}>${innerHTML}</script>`);
                } else {
                    parts.push(`<script ${attrs}></script>`);
                }
            }
        }
    }

    const result: string[] = [];

    // Title first
    if (finalTitle) {
        const title = titleTemplate
            ? titleTemplate.replace('%s', finalTitle)
            : finalTitle;
        result.push(`<title>${escapeHtml(title)}</title>`);
    }

    // Deduplicated meta tags
    for (const tag of seenMeta.values()) {
        result.push(tag);
    }

    // Other parts
    result.push(...parts);

    return result.join('\n');
}

// ============= Client-side Head Management =============

/** Track elements managed by useHead for cleanup */
const _managedElements = new WeakMap<object, HTMLElement[]>();
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
                    meta['http-equiv'] ? `meta[http-equiv="${meta['http-equiv']}"]` : null;

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
 * During SSR, collects head configs for later rendering with `renderHeadToString()`.
 * On the client, updates the DOM directly. Cleans up on component unmount.
 *
 * @param config - Head configuration (title, meta, link, script, etc.)
 */
export function useHead(config: HeadConfig): void {
    if (_isSSR) {
        // Server-side: collect configs
        _ssrHeadConfigs.push(config);
        return;
    }

    // Client-side: apply to DOM and register cleanup
    const cleanup = applyHeadClient(config);

    // If we're inside a component setup, register cleanup on unmount
    const instance = getCurrentInstance();
    if (instance) {
        instance.onUnmounted(() => cleanup());
    }
}

// ============= Utilities =============

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
}
