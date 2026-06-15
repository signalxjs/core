import { describe, it, expect, vi } from 'vitest';
import { component, useAsync, Comment } from 'sigx';
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

    it('omits style entirely when the value is null/undefined (#98)', async () => {
        // Pass-through props like style={props.style} are undefined when unset —
        // they must omit the attribute, not stringify to style="undefined".
        expect(await renderToString(HostHelper({ style: undefined }) as any)).toBe('<div></div>');
        expect(await renderToString(HostHelper({ style: null }) as any)).toBe('<div></div>');
        expect(await renderToString(HostHelper({ style: false }) as any)).toBe('<div></div>');
    });

    it('omits className entirely when the value is null/undefined/false (#98)', async () => {
        expect(await renderToString(HostHelper({ className: undefined }) as any)).toBe('<div></div>');
        expect(await renderToString(HostHelper({ className: null }) as any)).toBe('<div></div>');
        expect(await renderToString(HostHelper({ className: false }) as any)).toBe('<div></div>');
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

describe('renderToString — falsy slot children', () => {
    it('renders numeric 0 and empty-adjacent children passed to a component slot', async () => {
        const Wrap = component((ctx) => {
            return () => <div class="wrap">{ctx.slots.default?.()}</div>;
        }, { name: 'Wrap' });

        const html = await renderToString(<Wrap>{0}</Wrap>);
        expect(html).toContain('>0<');
    });
});

describe('renderToString — slot presence parity', () => {
    it('falls back for absent slots and renders content when provided', async () => {
        const Card = component((ctx) => {
            return () => (
                <div class="card">
                    {(ctx.slots as any).header?.() ?? <h2 class="fb">fallback</h2>}
                    {ctx.slots.default?.() ?? <span class="dfb">no body</span>}
                </div>
            );
        }, { name: 'Card' });

        // Nothing provided → both fallbacks render (parity with the client,
        // where absent slots read as undefined).
        const empty = await renderToString(<Card />);
        expect(empty).toContain('class="fb"');
        expect(empty).toContain('class="dfb"');

        // header via the slots prop, default via children → content, no fallbacks.
        const CardWithSlots = Card as any;
        const filled = await renderToString(
            <CardWithSlots slots={{ header: () => <h1 class="h">H</h1> }}>
                <p class="body">B</p>
            </CardWithSlots>
        );
        expect(filled).toContain('class="h"');
        expect(filled).toContain('class="body"');
        expect(filled).not.toContain('class="fb"');
        expect(filled).not.toContain('class="dfb"');
    });

    it('groups a slot-prop child into its named slot and excludes it from default', async () => {
        const Card = component((ctx) => {
            return () => (
                <div class="card">
                    {(ctx.slots as any).footer?.() ?? <span class="ffb">no footer</span>}
                    {ctx.slots.default?.() ?? <span class="dfb">no body</span>}
                </div>
            );
        }, { name: 'Card' });

        // Only a footer slot-prop child → footer present, default absent.
        const html = await renderToString(
            <Card><div slot="footer" class="foot">F</div></Card>
        );
        expect(html).toContain('class="foot"');
        expect(html).toContain('class="dfb"');     // default fell back
        expect(html).not.toContain('class="ffb"');  // footer did not
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

    it('routes useAsync throwOnError rejections to the error fallback in block mode', async () => {
        // Block mode (string render) awaits keyed useAsync fetchers inline —
        // with throwOnError, a rejection must land in the component-level
        // catch (→ error fallback), not escape the render.
        const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
        const LoadFail = component(() => {
            useAsync('rc-throw-fail', async () => {
                throw new Error('load-fail');
            }, { throwOnError: true });
            return () => ({
                type: 'div',
                props: {},
                key: null,
                children: ['never shown'],
                dom: null
            } as any);
        }, { name: 'LoadFail' });

        const ssr = createSSR();
        const ctx = createSSRContext({
            onComponentError: (err: Error, name: string) => `<i data-failed="${name}">${err.message}</i>`
        });
        const html = await ssr.render((LoadFail as any)({}), ctx);
        expect(html).toContain('<i data-failed="LoadFail">load-fail</i>');
        expect(html).not.toContain('never shown');
        consoleErr.mockRestore();
    });

    it('renders the component error branch (not the fallback) when the fetcher rejects without throwOnError', async () => {
        // Soft failure: the rejection lands in `.error` and the component
        // renders its own error branch — the error fallback never fires.
        const SoftFail = component(() => {
            const data = useAsync('rc-soft-fail', async () => {
                throw new Error('soft-fail');
            });
            return () => ({
                type: 'div',
                props: { class: 'soft' },
                key: null,
                children: [data.error ? `error: ${data.error.message}` : 'no error'],
                dom: null
            } as any);
        }, { name: 'SoftFail' });

        const html = await renderToString((SoftFail as any)({}));
        expect(html).toContain('error: soft-fail');
        expect(html).not.toContain('ssr-error');
        expect(html).not.toContain('no error');
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

describe('renderToString — useAsync block mode', () => {
    it('awaits keyed useAsync fetchers before rendering and yields synchronously after', async () => {
        const Loaded = component(() => {
            const data = useAsync('rc-block-inline', async () => {
                await Promise.resolve();
                return 'ready';
            });
            return () => ({
                type: 'span',
                props: { class: 'loaded' },
                key: null,
                children: [data.value ?? 'pending'],
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

    it('renders an expression child adjacent to literal text — both texts, marker between (#97)', async () => {
        // <span>By {expr}</span> compiles to children ['By ', value]. Both must
        // render; the <!--t--> between them is the hydration text boundary, NOT
        // a dropped child (it keeps the browser from merging the two text nodes
        // so each Text vnode hydrates against its own DOM node).
        const Author = component<{ author: string }>((ctx) => {
            return () => <span>By {ctx.props.author}</span>;
        }, { name: 'Author' });
        const html = await renderToString((Author as any)({ author: 'SignalX' }));
        expect(html).toContain('<span>By <!--t-->SignalX</span>');
    });
});
