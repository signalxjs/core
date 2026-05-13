import { describe, it, expect } from 'vitest';
import {
    escapeJsonForScript,
    generateStreamingScript,
    generateReplacementScript
} from '../src/server/streaming';

describe('escapeJsonForScript', () => {
    it('escapes < to prevent </script> breakout', () => {
        expect(escapeJsonForScript('</script>')).toBe('\\u003c/script\\u003e');
    });

    it('escapes both angle brackets', () => {
        expect(escapeJsonForScript('a < b > c')).toBe('a \\u003c b \\u003e c');
    });

    it('escapes U+2028 line separator', () => {
        expect(escapeJsonForScript('a b')).toBe('a\\u2028b');
    });

    it('escapes U+2029 paragraph separator', () => {
        expect(escapeJsonForScript('a b')).toBe('a\\u2029b');
    });

    it('leaves plain text unchanged', () => {
        expect(escapeJsonForScript('hello world')).toBe('hello world');
    });

    it('returns empty string for empty input', () => {
        expect(escapeJsonForScript('')).toBe('');
    });

    it('is idempotent on already-escaped output', () => {
        const once = escapeJsonForScript('</x>');
        expect(escapeJsonForScript(once)).toBe(once);
    });
});

describe('generateStreamingScript', () => {
    const script = generateStreamingScript();

    it('returns a single <script> block', () => {
        expect(script).toMatch(/^\s*<script>/);
        expect(script.trim()).toMatch(/<\/script>$/);
    });

    it('defines window.$SIGX_REPLACE', () => {
        expect(script).toContain('window.$SIGX_REPLACE');
    });

    it('looks up the placeholder by data-async-placeholder', () => {
        expect(script).toContain("data-async-placeholder");
    });

    it('dispatches a sigx:async-ready CustomEvent', () => {
        expect(script).toContain("'sigx:async-ready'");
        expect(script).toContain('CustomEvent');
    });
});

describe('generateReplacementScript', () => {
    it('emits a script tag invoking $SIGX_REPLACE with id and escaped html', () => {
        const out = generateReplacementScript(42, '<div>ok</div>');
        expect(out.startsWith('<script>$SIGX_REPLACE(42, ')).toBe(true);
        expect(out.endsWith('</script>')).toBe(true);
        // JSON-encoded then script-escaped (so '<' becomes '<')
        expect(out).toContain('\\u003cdiv\\u003eok\\u003c/div\\u003e');
    });

    it('appends extraScript inside the same <script> tag', () => {
        const out = generateReplacementScript(7, 'hi', 'console.log("done");');
        expect(out).toContain('$SIGX_REPLACE(7,');
        expect(out).toContain('console.log("done");');
        expect(out).toMatch(/<\/script>$/);
        // The extra script lives BEFORE the closing tag, AFTER the $SIGX_REPLACE call
        const replaceIdx = out.indexOf('$SIGX_REPLACE');
        const extraIdx = out.indexOf('console.log');
        expect(replaceIdx).toBeLessThan(extraIdx);
    });

    it('omits extra script when not provided', () => {
        const out = generateReplacementScript(1, 'x');
        expect(out).not.toContain('console.log');
    });

    it('escapes embedded </script> in html payload', () => {
        const out = generateReplacementScript(0, '</script><x>');
        // The literal characters '<' and '>' must NOT appear unescaped inside the JSON literal
        const argMatch = out.match(/\$SIGX_REPLACE\(0, ("(?:[^"\\]|\\.)*")\)/);
        expect(argMatch).not.toBeNull();
        const arg = argMatch![1];
        expect(arg).not.toMatch(/<\/script>/);
        expect(arg).toContain('\\u003c/script\\u003e');
    });
});
