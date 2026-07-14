/**
 * Server-side head rendering (rfc-ssr-platform §2.4 — head as part of the
 * document contract).
 *
 * `useHead()` itself lives in core (sigx) — browser-standalone composable.
 * During server rendering it collects configs onto the per-request
 * SSRContext (`ctx._headConfigs`); this module renders those configs to an
 * HTML string for injection into the document head (renderDocument does
 * this automatically), and exposes the collected `htmlAttrs`/`bodyAttrs`
 * for the document frame to merge into the template's `<html>`/`<body>`
 * tags.
 *
 * Escaping discipline: every attribute value is fully escaped (& " < >);
 * script/style/noscript content is emitted only through the explicit
 * `innerHTML` opt-in, with closing-tag sequences neutralized so the payload
 * cannot break out of its element.
 */

import type { HeadConfig } from 'sigx';
import { escapeHtml } from './server/render-core.js';

/**
 * Render collected head configs to an HTML string.
 * Configs render in ascending `priority` (default 0, ties in call order);
 * meta tags deduplicate by name/property/http-equiv/charset (last wins) and
 * the last title/base win.
 */
export function renderHeadToString(configs: HeadConfig[]): string {
    const parts: string[] = [];
    const seenMeta = new Map<string, string>();
    let finalTitle: string | undefined;
    let titleTemplate: string | undefined;
    let finalBase: { href?: string; target?: string } | undefined;

    // Process in ascending priority — later (and higher-priority) configs
    // override earlier ones.
    for (const config of sortByPriority(configs)) {
        if (config.titleTemplate) {
            titleTemplate = config.titleTemplate;
        }
        if (config.title) {
            finalTitle = config.title;
        }
        if (config.base) {
            finalBase = config.base;
        }

        if (config.meta) {
            for (const meta of config.meta) {
                // Deduplicate by name or property
                const key = meta.name ? `name:${meta.name}` :
                    meta.property ? `property:${meta.property}` :
                        meta['http-equiv'] ? `http-equiv:${meta['http-equiv']}` :
                            meta.charset ? 'charset' : null;

                const attrs = serializeAttrs(meta);
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
                parts.push(`<link ${serializeAttrs(link)}>`);
            }
        }

        if (config.script) {
            for (const script of config.script) {
                const { innerHTML, ...rest } = script;
                const attrs = serializeAttrs(rest);
                if (innerHTML) {
                    // innerHTML is the explicit raw opt-in — still neutralize
                    // closing-tag sequences so the payload cannot escape the
                    // element and inject markup.
                    parts.push(`<script ${attrs}>${guardRawContent(innerHTML, 'script')}</script>`);
                } else {
                    parts.push(`<script ${attrs}></script>`);
                }
            }
        }

        if (config.style) {
            for (const style of config.style) {
                const { innerHTML, ...rest } = style;
                const attrs = serializeAttrs(rest);
                const open = attrs ? `<style ${attrs}>` : '<style>';
                parts.push(`${open}${guardRawContent(innerHTML ?? '', 'style')}</style>`);
            }
        }

        if (config.noscript) {
            for (const noscript of config.noscript) {
                parts.push(`<noscript>${guardRawContent(noscript.innerHTML, 'noscript')}</noscript>`);
            }
        }
    }

    const result: string[] = [];

    // Base first (it affects how subsequent URLs resolve), then title
    if (finalBase) {
        result.push(`<base ${serializeAttrs(finalBase as Record<string, string | undefined>)}>`);
    }
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

/**
 * Collect the merged `htmlAttrs`/`bodyAttrs` across configs (ascending
 * priority, last write per attribute wins) — the document frame patches
 * them into the template's `<html>`/`<body>` tags.
 */
export function collectRootAttrs(configs: HeadConfig[]): {
    htmlAttrs: Record<string, string>;
    bodyAttrs: Record<string, string>;
} {
    const htmlAttrs: Record<string, string> = {};
    const bodyAttrs: Record<string, string> = {};
    for (const config of sortByPriority(configs)) {
        if (config.htmlAttrs) {
            for (const [k, v] of Object.entries(config.htmlAttrs)) {
                if (v !== undefined) htmlAttrs[k] = v;
            }
        }
        if (config.bodyAttrs) {
            for (const [k, v] of Object.entries(config.bodyAttrs)) {
                if (v !== undefined) bodyAttrs[k] = v;
            }
        }
    }
    return { htmlAttrs, bodyAttrs };
}

/**
 * Merge attributes into the first `<tag ...>` occurrence in an HTML string
 * (used for the template's `<html>` and `<body>` open tags). An attribute
 * already present on the tag is replaced; new ones are appended.
 */
export function mergeAttrsIntoTag(
    html: string,
    tag: 'html' | 'body',
    attrs: Record<string, string>
): string {
    const names = Object.keys(attrs);
    if (names.length === 0) return html;
    const tagRe = new RegExp(`<${tag}(\\s[^>]*)?>`, 'i');
    return html.replace(tagRe, (_match, existing: string | undefined) => {
        let updated = existing ?? '';
        for (const name of names) {
            const pair = ` ${escapeAttr(name)}="${escapeAttr(attrs[name])}"`;
            const attrRe = new RegExp(`\\s${escapeRegExp(name)}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]*)`, 'i');
            updated = attrRe.test(updated) ? updated.replace(attrRe, pair) : updated + pair;
        }
        return `<${tag}${updated}>`;
    });
}

// ============= Utilities =============

/** Stable ascending-priority sort (default 0). */
function sortByPriority(configs: HeadConfig[]): HeadConfig[] {
    // Array.prototype.sort is stable — call order breaks ties.
    return [...configs].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

function serializeAttrs(obj: Record<string, string | boolean | undefined>): string {
    return Object.entries(obj)
        .filter(([k, v]) => v !== undefined && v !== false && k !== 'priority')
        .map(([k, v]) => v === true ? escapeAttr(k) : `${escapeAttr(k)}="${escapeAttr(String(v))}"`)
        .join(' ');
}

/**
 * Neutralize closing-tag sequences in raw element content so an
 * `innerHTML` payload cannot terminate its element and inject markup:
 * `</tag` becomes `<\/tag` (the standard escape — identical semantics in
 * JS strings, an escaped character in CSS, inert as fallback markup).
 */
function guardRawContent(content: string, tag: 'script' | 'style' | 'noscript'): string {
    return content.replace(new RegExp(`</(?=${tag})`, 'gi'), '<\\/');
}

function escapeAttr(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
