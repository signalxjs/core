/**
 * Server-side head rendering.
 *
 * `useHead()` itself lives in core (sigx) — browser-standalone composable.
 * During server rendering it collects configs onto the per-request
 * SSRContext (`ctx._headConfigs`); this module renders those configs to an
 * HTML string for injection into the document head (renderDocument does
 * this automatically).
 */

import type { HeadConfig } from 'sigx';

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
