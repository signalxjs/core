/**
 * Style-string parsing, shared by `mergeProps` and the SSR serializer.
 *
 * It lived in `@sigx/server-renderer`'s render-core until `mergeProps` needed
 * the same edge cases (a `style` source can be a string on either side of a
 * merge). One implementation rather than two that drift — the parens and
 * comment handling below is exactly the kind of detail that would.
 */

const styleCommentRE = /\/\*[^]*?\*\//g;

/**
 * Parse a CSS string into a style object.
 *
 * Handles edge cases: parens in values (e.g., `linear-gradient(...)`),
 * CSS comments, and colons in values.
 */
export function parseStringStyle(cssText: string): Record<string, string> {
    const ret: Record<string, string> = {};
    const stripped = cssText.replace(styleCommentRE, '');
    let start = 0;
    let depth = 0;

    for (let i = 0; i <= stripped.length; i++) {
        const ch = stripped.charCodeAt(i);
        if (ch === 40 /* ( */) { depth++; continue; }
        if (ch === 41 /* ) */) { depth--; continue; }
        // Split on ';' only outside parentheses, or at end of string
        if ((ch === 59 /* ; */ && depth === 0) || i === stripped.length) {
            const decl = stripped.slice(start, i);
            start = i + 1;
            const colon = decl.indexOf(':');
            if (colon > 0) {
                const prop = decl.slice(0, colon).trim();
                const value = decl.slice(colon + 1).trim();
                if (prop) ret[prop] = value;
            }
        }
    }
    return ret;
}
