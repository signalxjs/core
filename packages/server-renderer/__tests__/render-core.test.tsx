import { describe, it, expect, vi } from 'vitest';
import { component, signal, Comment } from 'sigx';
import { renderToString, createSSR } from '../src/index';
import { createSSRContext } from '../src/server/context';
import {
    escapeHtml,
    camelToKebab,
    parseStringStyle,
    stringifyStyle
} from '../src/server/render-core';

describe('escapeHtml', () => {
    it('escapes all five HTML-special characters', () => {
        expect(escapeHtml('&')).toBe('&amp;');
        expect(escapeHtml('<')).toBe('&lt;');
        expect(escapeHtml('>')).toBe('&gt;');
        expect(escapeHtml('"')).toBe('&quot;');
        expect(escapeHtml("'")).toBe('&#39;');
    });

    it('escapes mixed content in a single pass', () => {
        expect(escapeHtml(`a & "b" <c> 'd'`)).toBe('a &amp; &quot;b&quot; &lt;c&gt; &#39;d&#39;');
    });

    it('returns the same string when nothing needs escaping', () => {
        expect(escapeHtml('plain text 123')).toBe('plain text 123');
    });
});

describe('camelToKebab', () => {
    it('converts camelCase to kebab-case', () => {
        expect(camelToKebab('backgroundColor')).toBe('background-color');
        expect(camelToKebab('borderTopLeftRadius')).toBe('border-top-left-radius');
    });

    it('passes through already-kebab CSS custom properties', () => {
        expect(camelToKebab('--my-var')).toBe('--my-var');
        expect(camelToKebab('--Foo')).toBe('--Foo');
    });

    it('caches conversions (same input returns same output across calls)', () => {
        const first = camelToKebab('marginInlineStart');
        const second = camelToKebab('marginInlineStart');
        expect(first).toBe(second);
        expect(first).toBe('margin-inline-start');
    });
});

describe('parseStringStyle', () => {
    it('parses simple "prop:value" declarations', () => {
        expect(parseStringStyle('color: red; font-size: 14px')).toEqual({
            color: 'red',
            'font-size': '14px'
        });
    });

    it('ignores trailing semicolons and whitespace', () => {
        expect(parseStringStyle('color: red;;  ')).toEqual({ color: 'red' });
    });

    it('strips /* ... */ comments before parsing', () => {
        const out = parseStringStyle('/* important */ color: red; /* spacing */ margin: 1em');
        expect(out).toEqual({ color: 'red', margin: '1em' });
    });

    it('treats parens as atomic — does not split inside linear-gradient(...)', () => {
        const css = 'background: linear-gradient(45deg, red, blue); color: white';
        expect(parseStringStyle(css)).toEqual({
            background: 'linear-gradient(45deg, red, blue)',
            color: 'white'
        });
    });

    it('drops declarations without a colon', () => {
        expect(parseStringStyle('not-a-decl; color: red')).toEqual({ color: 'red' });
    });

    it('returns empty object for empty/whitespace input', () => {
        expect(parseStringStyle('')).toEqual({});
        expect(parseStringStyle('   ')).toEqual({});
    });
});

describe('stringifyStyle', () => {
    it('serializes an object with camelCase keys to kebab-case CSS', () => {
        expect(stringifyStyle({ backgroundColor: 'red', fontSize: '12px' }))
            .toBe('background-color:red;font-size:12px;');
    });

    it('skips null, undefined, and empty-string values', () => {
        expect(stringifyStyle({ color: 'red', margin: null, padding: undefined, border: '' }))
            .toBe('color:red;');
    });

    it('returns empty string for empty object', () => {
        expect(stringifyStyle({})).toBe('');
    });
});

// =====================================================================
// End-to-end coverage via renderToString
// =====================================================================

describe('renderToString — host element attribute serialization', () => {
    function HostHelper(props: Record<string, any>): any {
        return {
            type: 'div',
            props,
            key: null,
            children: [],
            dom: null
        };
    }

    it('emits void elements without a closing tag', async () => {
        const html = await renderToString({
            type: 'img', props: { src: '/x.png', alt: 'x' }, key: null, children: [], dom: null
        } as any);
        expect(html).toBe('<img src="/x.png" alt="x">');
    });

    it('renders boolean true attrs as bare names', async () => {
        const html = await renderToString(HostHelper({ disabled: true }) as any);
        expect(html).toContain('<div disabled>');
    });

    it('skips boolean false attrs entirely', async () => {
        const html = await renderToString(HostHelper({ disabled: false }) as any);
        expect(html).not.toContain('disabled');
        expect(html).toBe('<div></div>');
    });

    it('skips null/undefined attrs', async () => {
        const html = await renderToString(HostHelper({ title: null, lang: undefined }) as any);
        expect(html).toBe('<div></div>');
    });

    it('escapes attribute values', async () => {
        const html = await renderToString(HostHelper({ title: 'a & "b" <c>' }) as any);
        expect(html).toContain('title="a &amp; &quot;b&quot; &lt;c&gt;"');
    });

    it('serializes className → class', async () => {
        const html = await renderToString(HostHelper({ className: 'foo bar' }) as any);
        expect(html).toContain('class="foo bar"');
    });

    it('serializes style object via stringifyStyle (camelCase → kebab-case)', async () => {
        const html = await renderToString(HostHelper({ style: { backgroundColor: 'red', fontSize: '14px' } }) as any);
        expect(html).toContain('style="background-color:red;font-size:14px;"');
    });

    it('passes through string style values', async () => {
        const html = await renderToString(HostHelper({ style: 'color:red' }) as any);
        expect(html).toContain('style="color:red"');
    });

    it('drops on* event handlers', async () => {
        const html = await renderToString(HostHelper({ onClick: () => {} }) as any);
        expect(html).not.toContain('onClick');
        expect(html).not.toContain('onclick');
    });

    it('drops client:* directive props', async () => {
        const html = await renderToString(HostHelper({ 'client:load': true }) as any);
        expect(html).not.toContain('client:');
    });

    it('drops key and ref props', async () => {
        const html = await renderToString(HostHelper({ key: 'k1', ref: 'r' }) as any);
        expect(html).toBe('<div></div>');
    });
});

describe('renderToString — Comment vnodes', () => {
    it('renders an explicit Comment node as <!---->', async () => {
        const html = await renderToString({
            type: Comment as any,
            props: {},
            key: null,
            children: [],
            dom: null
        } as any);
        expect(html).toBe('<!---->');
    });
});

describe('renderToString — component error handling', () => {
    const Boom = component(() => {
        throw new Error('boom');
    }, { name: 'Boom' });

    it('emits a fallback comment when no handler is registered', async () => {
        // Suppress console.error noise for this test
        const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
        const html = await renderToString((Boom as any)({}));
        expect(html).toMatch(/<!--ssr-error:\d+-->/);
        consoleErr.mockRestore();
    });

    it('uses onComponentError fallback when provided in context options', async () => {
        const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
        const ssr = createSSR();
        const ctx = createSSRContext({
            onComponentError: (err: Error, name: string) => `<div data-error="${name}">${err.message}</div>`
        });
        const html = await ssr.render((Boom as any)({}), ctx);
        expect(html).toContain('<div data-error="Boom">boom</div>');
        consoleErr.mockRestore();
    });
});

describe('renderToString — async setup (Promise-returning)', () => {
    it('awaits a Promise<renderFn> from setup()', async () => {
        const AsyncSetup = component(() => {
            return Promise.resolve(() => ({
                type: 'span',
                props: { class: 'async-done' },
                key: null,
                children: [],
                dom: null
            } as any));
        }, { name: 'AsyncSetup' });

        const html = await renderToString((AsyncSetup as any)({}));
        expect(html).toContain('class="async-done"');
    });
});

describe('renderToString — ssr.load() block mode', () => {
    it('awaits ssr.load() promises before rendering and yields synchronously after', async () => {
        const Loaded = component((ctx: any) => {
            const data = signal({ value: 'pending' });
            ctx.ssr.load(async () => {
                await Promise.resolve();
                data.value = 'ready';
            });
            return () => ({
                type: 'span',
                props: { class: 'loaded' },
                key: null,
                children: [data.value],
                dom: null
            } as any);
        }, { name: 'Loaded' });

        const html = await renderToString((Loaded as any)({}));
        expect(html).toContain('class="loaded"');
        expect(html).toContain('ready');
    });
});

describe('renderToString — text-boundary marker between adjacent text children', () => {
    it('inserts <!--t--> between adjacent text vnodes in slow path', async () => {
        // Build a host element with two adjacent text nodes (force slow path with a host child)
        const html = await renderToString({
            type: 'div',
            props: {},
            key: null,
            children: [
                'hello',
                'world',
                { type: 'span', props: {}, key: null, children: ['inner'], dom: null }
            ],
            dom: null
        } as any);
        // The fast path doesn't apply because of the non-leaf <span>, so we use the slow path
        expect(html).toContain('hello<!--t-->world');
    });
});
