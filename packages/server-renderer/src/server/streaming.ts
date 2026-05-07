/**
 * Core streaming utilities for async SSR
 *
 * Provides the client-side `$SIGX_REPLACE` function and replacement script
 * generation used by core async streaming. These are strategy-agnostic —
 * any async component with `ssr.load()` gets streamed without needing a plugin.
 *
 * Plugins (e.g., islands) can augment replacements via `onAsyncComponentResolved`.
 */

/**
 * Escape a JSON string for safe embedding inside <script> tags.
 * Prevents XSS by replacing characters that could break out of the script context.
 */
export function escapeJsonForScript(json: string): string {
    return json
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/**
 * Generate the streaming bootstrap script (injected once before any replacements).
 * Defines `window.$SIGX_REPLACE` which swaps async placeholders with rendered HTML.
 */
export function generateStreamingScript(): string {
    return `
<script>
window.$SIGX_REPLACE = function(id, html) {
    var placeholder = document.querySelector('[data-async-placeholder="' + id + '"]');
    if (placeholder) {
        var template = document.createElement('template');
        template.innerHTML = html;
        placeholder.innerHTML = '';
        while (template.content.firstChild) {
            placeholder.appendChild(template.content.firstChild);
        }
        placeholder.dispatchEvent(new CustomEvent('sigx:async-ready', { bubbles: true, detail: { id: id } }));
    }
};
</script>`;
}

/**
 * Generate a replacement script for a resolved async component.
 */
export function generateReplacementScript(id: number, html: string, extraScript?: string): string {
    const escapedHtml = escapeJsonForScript(JSON.stringify(html));
    let script = `<script>$SIGX_REPLACE(${id}, ${escapedHtml});`;
    if (extraScript) {
        script += extraScript;
    }
    script += `</script>`;
    return script;
}
