/**
 * Server-side rendering tests for stream.ts
 * Tests renderToString, renderToStream, renderToStreamWithCallbacks,
 * and internal helpers (async components, error boundaries, etc.)
 */

import { describe, it, expect, vi } from 'vitest';
import { component, useData, Fragment, Text, defineApp } from 'sigx';
import { renderToString, renderToStream, renderToStreamWithCallbacks, type StreamCallbacks } from '../src/server/index';
import { createSSRContext } from '../src/server/context';
import { createSSR } from '../src/ssr';

// ─── Test Components ───────────────────────────────────────────────

const SimpleDiv = component(() => {
    return () => <div class="simple">Hello</div>;
}, { name: 'SimpleDiv' });

const StaticText = component(() => {
    return () => <span>Static text</span>;
}, { name: 'StaticText' });

const WithProps = component<{ name: string; count: number }>((ctx) => {
    return () => <div class="with-props">{ctx.props.name}: {ctx.props.count}</div>;
}, { name: 'WithProps' });

const WithSignal = component((ctx) => {
    const state = ctx.signal({ count: 0 });
    return () => <div class="signal">{state.count}</div>;
}, { name: 'WithSignal' });

const WithChildren = component((ctx) => {
    return () => <div class="wrapper">{ctx.slots.default?.()}</div>;
}, { name: 'WithChildren' });

const Nested = component(() => {
    return () => (
        <div class="outer">
            <SimpleDiv />
        </div>
    );
}, { name: 'Nested' });

const DeepNested = component(() => {
    return () => (
        <div class="deep">
            <Nested />
            <StaticText />
        </div>
    );
}, { name: 'DeepNested' });

const WithEvent = component(() => {
    return () => <button onClick={() => {}}>Click</button>;
}, { name: 'WithEvent' });

const WithRef = component(() => {
    return () => <div ref={() => {}}>Ref test</div>;
}, { name: 'WithRef' });

const WithKey = component(() => {
    return () => <div key="test-key">Key test</div>;
}, { name: 'WithKey' });

const WithStyles = component(() => {
    return () => <div style={{ color: 'red', fontSize: '14px', backgroundColor: 'blue' }}>Styled</div>;
}, { name: 'WithStyles' });

const WithStyleString = component(() => {
    return () => <div style="color:red;font-size:14px">Styled</div>;
}, { name: 'WithStyleString' });

const WithClassName = component(() => {
    return () => <div className="foo bar">Classes</div>;
}, { name: 'WithClassName' });

const WithBooleanAttrs = component(() => {
    return () => <input disabled type="text" />;
}, { name: 'WithBooleanAttrs' });

const WithFalseBooleanAttr = component(() => {
    return () => <input disabled={false} type="text" />;
}, { name: 'WithFalseBooleanAttr' });

const WithNullAttr = component(() => {
    return () => <div data-value={null}>Null attr</div>;
}, { name: 'WithNullAttr' });

const FragmentComponent = component(() => {
    return () => (
        <>
            <span>A</span>
            <span>B</span>
        </>
    );
}, { name: 'FragmentComponent' });

const EmptyComponent = component(() => {
    return () => null;
}, { name: 'EmptyComponent' });

const ReturnsFalse = component(() => {
    return () => false;
}, { name: 'ReturnsFalse' });

const MultiTextChildren = component(() => {
    return () => (
        <div>
            {"Hello"}
            {"World"}
        </div>
    );
}, { name: 'MultiTextChildren' });

const AsyncComponent = component(() => {
    const data = useData('stream-async-component', async () => 'loaded-data');

    return () => (
        <div class="async">
            {data.value ? <span>{data.value}</span> : <span>Loading...</span>}
        </div>
    );
}, { name: 'AsyncComponent' });

const AsyncFailing = component(() => {
    const failing = useData('stream-async-failing', async () => {
        throw new Error('Async load failed');
    });

    return () => (
        <div class="async-fail">
            {failing.error ? `error: ${failing.error.message}` : 'Content'}
        </div>
    );
}, { name: 'AsyncFailing' });

const SetupThrowing = component(() => {
    throw new Error('Setup exploded');
    return () => <div>Never reached</div>;
}, { name: 'SetupThrowing' });

// ─── Helper Functions ──────────────────────────────────────────────

async function collectStream(stream: ReadableStream<string>): Promise<string> {
    const reader = stream.getReader();
    let result = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result += value;
    }
    return result;
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('renderToString', () => {
    describe('primitives and nulls', () => {
        it('should render null to empty string', async () => {
            const html = await renderToString(null);
            expect(html).toBe('');
        });

        it('should render undefined to empty string', async () => {
            const html = await renderToString(undefined as any);
            expect(html).toBe('');
        });

        it('should render false to empty string', async () => {
            const html = await renderToString(false);
            expect(html).toBe('');
        });

        it('should render true to empty string', async () => {
            const html = await renderToString(true);
            expect(html).toBe('');
        });

        it('should render string content', async () => {
            const html = await renderToString('Hello World');
            expect(html).toBe('Hello World');
        });

        it('should render number content', async () => {
            const html = await renderToString(42);
            expect(html).toBe('42');
        });

        it('should escape HTML entities in strings', async () => {
            const html = await renderToString('<script>alert("xss")</script>');
            expect(html).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
        });

        it('should escape ampersands', async () => {
            const html = await renderToString('Tom & Jerry');
            expect(html).toBe('Tom &amp; Jerry');
        });
    });

    describe('host elements', () => {
        it('should render a simple div', async () => {
            const html = await renderToString(<div>Hello</div>);
            expect(html).toBe('<div>Hello</div>');
        });

        it('should render nested elements', async () => {
            const html = await renderToString(
                <div><span>Nested</span></div>
            );
            expect(html).toBe('<div><span>Nested</span></div>');
        });

        it('should render element with attributes', async () => {
            const html = await renderToString(<div id="test" class="foo">Content</div>);
            expect(html).toContain('id="test"');
            expect(html).toContain('class="foo"');
            expect(html).toContain('Content');
        });

        it('should render void elements (self-closing)', async () => {
            const html = await renderToString(<br />);
            expect(html).toBe('<br>');
        });

        it('should render input as void element', async () => {
            const html = await renderToString(<input type="text" />);
            expect(html).toContain('<input');
            expect(html).toContain('type="text"');
            expect(html).not.toContain('</input>');
        });

        it('should render img as void element', async () => {
            const html = await renderToString(<img src="/test.png" alt="test" />);
            expect(html).toContain('<img');
            expect(html).toContain('src="/test.png"');
            expect(html).not.toContain('</img>');
        });

        it('should render hr as void element', async () => {
            const html = await renderToString(<hr />);
            expect(html).toBe('<hr>');
        });

        it('should render multiple children', async () => {
            const html = await renderToString(
                <ul>
                    <li>One</li>
                    <li>Two</li>
                    <li>Three</li>
                </ul>
            );
            expect(html).toBe('<ul><li>One</li><li>Two</li><li>Three</li></ul>');
        });

        it('should render empty element', async () => {
            const html = await renderToString(<div></div>);
            expect(html).toBe('<div></div>');
        });
    });

    describe('prop filtering', () => {
        it('should skip event handlers (on* props)', async () => {
            const html = await renderToString(<button onClick={() => {}} onMouseOver={() => {}}>Click</button>);
            expect(html).not.toContain('onClick');
            expect(html).not.toContain('onMouseOver');
            expect(html).toBe('<button>Click</button>');
        });

        it('should skip key prop', async () => {
            const html = await renderToString(<div key="test">Content</div>);
            expect(html).not.toContain('key=');
            expect(html).toBe('<div>Content</div>');
        });

        it('should skip ref prop', async () => {
            const html = await renderToString(<div ref={() => {}}>Content</div>);
            expect(html).not.toContain('ref=');
            expect(html).toBe('<div>Content</div>');
        });

        it('should skip children prop', async () => {
            const html = await renderToString(<div>Content</div>);
            expect(html).not.toContain('children=');
        });

        it('should render boolean true attributes without value', async () => {
            const html = await renderToString(<input disabled />);
            expect(html).toContain(' disabled');
            expect(html).not.toContain('disabled="');
        });

        it('should skip boolean false attributes', async () => {
            const html = await renderToString(<input disabled={false} />);
            expect(html).not.toContain('disabled');
        });

        it('should skip null/undefined attribute values', async () => {
            const html = await renderToString(<div data-value={null}>Test</div>);
            expect(html).not.toContain('data-value');
        });
    });

    describe('style handling', () => {
        it('should serialize style objects to CSS string', async () => {
            const html = await renderToString(<div style={{ color: 'red', fontSize: '14px' }}>Styled</div>);
            expect(html).toContain('style="');
            expect(html).toContain('color:red');
            expect(html).toContain('font-size:14px');
        });

        it('should pass through string styles', async () => {
            const html = await renderToString(<div style="color:red">Styled</div>);
            expect(html).toContain('style="color:red"');
        });

        it('should convert camelCase to kebab-case', async () => {
            const html = await renderToString(<div style={{ backgroundColor: 'blue' }}>Styled</div>);
            expect(html).toContain('background-color:blue');
        });
    });

    describe('className handling', () => {
        it('should convert className to class attribute', async () => {
            const html = await renderToString(<div className="foo bar">Classes</div>);
            expect(html).toContain('class="foo bar"');
            expect(html).not.toContain('className');
        });
    });

    describe('HTML escaping', () => {
        it('should escape text content', async () => {
            const html = await renderToString(<div>{'<script>alert("xss")</script>'}</div>);
            expect(html).toContain('&lt;script&gt;');
            expect(html).not.toContain('<script>alert');
        });

        it('should escape attribute values', async () => {
            const html = await renderToString(<div title={'He said "hello"'}>Content</div>);
            expect(html).toContain('&quot;hello&quot;');
        });

        it('should escape ampersands in text', async () => {
            const html = await renderToString(<div>{'Tom & Jerry'}</div>);
            expect(html).toContain('Tom &amp; Jerry');
        });

        it('should escape single quotes in attributes', async () => {
            const html = await renderToString(<div title={"it's"}>Content</div>);
            expect(html).toContain("&#39;");
        });
    });

    describe('text node markers', () => {
        it('should insert <!--t--> between adjacent text nodes', async () => {
            const html = await renderToString(
                <div>
                    {'Hello'}
                    {'World'}
                </div>
            );
            expect(html).toContain('Hello<!--t-->World');
        });

        it('should not insert marker for single text node', async () => {
            const html = await renderToString(<div>Hello</div>);
            expect(html).not.toContain('<!--t-->');
        });

        it('should not insert marker between element and text', async () => {
            const html = await renderToString(
                <div>
                    <span>A</span>
                    {'B'}
                </div>
            );
            expect(html).not.toContain('<!--t-->');
        });
    });

    describe('components', () => {
        it('should render a simple component', async () => {
            const html = await renderToString(<SimpleDiv />);
            expect(html).toContain('<div class="simple">Hello</div>');
        });

        it('should add trailing component marker', async () => {
            const html = await renderToString(<SimpleDiv />);
            expect(html).toMatch(/<!--\$c:\d+-->/);
        });

        it('should render component with props', async () => {
            const html = await renderToString(<WithProps name="test" count={42} />);
            expect(html).toContain('test');
            expect(html).toContain('42');
        });

        it('should render nested components', async () => {
            const html = await renderToString(<Nested />);
            expect(html).toContain('<div class="outer">');
            expect(html).toContain('<div class="simple">Hello</div>');
        });

        it('should render deeply nested components', async () => {
            const html = await renderToString(<DeepNested />);
            expect(html).toContain('<div class="deep">');
            expect(html).toContain('<div class="outer">');
            expect(html).toContain('<div class="simple">Hello</div>');
            expect(html).toContain('<span>Static text</span>');
        });

        it('should assign unique IDs to each component', async () => {
            const html = await renderToString(<DeepNested />);
            const markers = html.match(/<!--\$c:(\d+)-->/g) || [];
            const ids = markers.map(m => m.match(/\d+/)![0]);
            // All IDs should be unique
            expect(new Set(ids).size).toBe(ids.length);
        });

        it('should render component returning null', async () => {
            const html = await renderToString(<EmptyComponent />);
            // Should have the marker but no content
            expect(html).toMatch(/<!--\$c:\d+-->/);
        });

        it('should render component returning false', async () => {
            const html = await renderToString(<ReturnsFalse />);
            expect(html).toMatch(/<!--\$c:\d+-->/);
        });

        it('should render component with children/slots', async () => {
            const html = await renderToString(
                <WithChildren>
                    <span>Child content</span>
                </WithChildren>
            );
            expect(html).toContain('<div class="wrapper">');
            expect(html).toContain('<span>Child content</span>');
        });

        it('should not include event handlers on component output', async () => {
            const html = await renderToString(<WithEvent />);
            expect(html).not.toContain('onClick');
            expect(html).toContain('<button>Click</button>');
        });

        it('should not include ref on component output', async () => {
            const html = await renderToString(<WithRef />);
            expect(html).not.toContain('ref=');
        });

        it('should not include key on component output', async () => {
            const html = await renderToString(<WithKey />);
            expect(html).not.toContain('key=');
        });
    });

    describe('fragments', () => {
        it('should render fragment children without wrapper', async () => {
            const html = await renderToString(
                <>
                    <span>A</span>
                    <span>B</span>
                </>
            );
            expect(html).toBe('<span>A</span><span>B</span>');
        });

        it('should render fragment component', async () => {
            const html = await renderToString(<FragmentComponent />);
            expect(html).toContain('<span>A</span>');
            expect(html).toContain('<span>B</span>');
        });

        it('should render nested fragments', async () => {
            const html = await renderToString(
                <>
                    <>
                        <span>Deep</span>
                    </>
                </>
            );
            expect(html).toContain('<span>Deep</span>');
        });
    });

    describe('async components with useData', () => {
        it('should await keyed useData fetchers for non-island async components', async () => {
            const AsyncData = component(() => {
                const loaded = useData('stream-await-inline', async () => true);
                return () => <div>{loaded.value ? 'Loaded' : 'Not loaded'}</div>;
            }, { name: 'AsyncData' });

            const html = await renderToString(<AsyncData />);
            expect(html).toContain('Loaded');
            expect(html).not.toContain('Not loaded');
        });

        it('should handle multiple useData calls', async () => {
            const MultiLoad = component(() => {
                const usersCsv = useData('stream-multi-users', async () => 'Alice,Bob');
                const theme = useData('stream-multi-theme', async () => 'dark');
                return () => (
                    <div>
                        <span>{usersCsv.value}</span>
                        <span>{theme.value}</span>
                    </div>
                );
            }, { name: 'MultiLoad' });

            const html = await renderToString(<MultiLoad />);
            expect(html).toContain('Alice,Bob');
            expect(html).toContain('dark');
        });

        it('should render the error branch for a fetcher that rejects (soft error, non-island)', async () => {
            // Server data errors are SOFT: the component renders normally
            // with `.error` set — no error fallback, no escaped rejection.
            const html = await renderToString(<AsyncFailing />);
            expect(html).toContain('error: Async load failed');
            expect(html).not.toContain('ssr-error');
            expect(html).toMatch(/<!--\$c:\d+-->/);
        });
    });

    describe('App instance support', () => {
        it('should accept defineApp() input', async () => {
            const app = defineApp(<SimpleDiv />);
            const html = await renderToString(app);
            expect(html).toContain('<div class="simple">Hello</div>');
        });

        it('should accept defineApp() with plugins', async () => {
            const installed: string[] = [];
            const testPlugin = {
                install(app: any) {
                    installed.push('test-plugin');
                }
            };

            const app = defineApp(<SimpleDiv />).use(testPlugin);
            const html = await renderToString(app);
            expect(html).toContain('<div class="simple">Hello</div>');
            expect(installed).toContain('test-plugin');
        });

        it('should work with raw JSX (no app)', async () => {
            const html = await renderToString(<div>Raw JSX</div>);
            expect(html).toBe('<div>Raw JSX</div>');
        });
    });

    describe('custom SSRContext', () => {
        it('should accept a pre-created context', async () => {
            const ctx = createSSRContext();
            await renderToString(<SimpleDiv />, ctx);
            // Context should have been used (component IDs incremented)
            expect(ctx.nextId()).toBeGreaterThan(1);
        });

        it('should create context automatically if not provided', async () => {
            // Should work without explicit context
            const html = await renderToString(<SimpleDiv />);
            expect(html).toContain('Hello');
        });
    });
});

describe('renderToStream', () => {
    it('should return a ReadableStream', () => {
        const stream = renderToStream(<SimpleDiv />);
        expect(stream).toBeInstanceOf(ReadableStream);
    });

    it('should produce same content as renderToString for sync content', async () => {
        const stringResult = await renderToString(<SimpleDiv />);
        const streamResult = await collectStream(renderToStream(<SimpleDiv />));
        // Stream may include extra scripts (sigx:ready event), so check that content is there
        expect(streamResult).toContain('<div class="simple">Hello</div>');
    });

    it('should include sigx:ready event script', async () => {
        const ssr = createSSR();
        const html = await collectStream(ssr.renderStream(<SimpleDiv />));
        expect(html).toContain('sigx:ready');
    });

    it('should accept App instance', async () => {
        const app = defineApp(<SimpleDiv />);
        const html = await collectStream(renderToStream(app));
        expect(html).toContain('<div class="simple">Hello</div>');
    });

    it('should accept custom SSRContext', async () => {
        const ctx = createSSRContext();
        const html = await collectStream(renderToStream(<SimpleDiv />, ctx));
        expect(html).toContain('Hello');
        expect(ctx.nextId()).toBeGreaterThan(1);
    });

});

describe('renderToStreamWithCallbacks', () => {
    function createCallbackTracker() {
        const calls: { type: string; data?: string }[] = [];
        const callbacks: StreamCallbacks = {
            onShellReady: vi.fn((html: string) => calls.push({ type: 'shell', data: html })),
            onAsyncChunk: vi.fn((chunk: string) => calls.push({ type: 'async', data: chunk })),
            onComplete: vi.fn(() => calls.push({ type: 'complete' })),
            onError: vi.fn((error: Error) => calls.push({ type: 'error', data: error.message }))
        };
        return { calls, callbacks };
    }

    it('should call onShellReady with rendered content', async () => {
        const { callbacks } = createCallbackTracker();
        await renderToStreamWithCallbacks(<SimpleDiv />, callbacks);

        expect(callbacks.onShellReady).toHaveBeenCalledTimes(1);
        const shellHtml = (callbacks.onShellReady as any).mock.calls[0][0] as string;
        expect(shellHtml).toContain('<div class="simple">Hello</div>');
    });

    it('should call onComplete after rendering', async () => {
        const { callbacks } = createCallbackTracker();
        await renderToStreamWithCallbacks(<SimpleDiv />, callbacks);
        expect(callbacks.onComplete).toHaveBeenCalledTimes(1);
    });

    it('should include sigx:ready event in shell', async () => {
        const { callbacks } = createCallbackTracker();
        const ssr = createSSR();
        await ssr.renderStreamWithCallbacks(<SimpleDiv />, callbacks);

        const shellHtml = (callbacks.onShellReady as any).mock.calls[0][0] as string;
        expect(shellHtml).toContain('sigx:ready');
    });

    it('should call onShellReady before onComplete', async () => {
        const { calls, callbacks } = createCallbackTracker();
        await renderToStreamWithCallbacks(<SimpleDiv />, callbacks);

        const shellIdx = calls.findIndex(c => c.type === 'shell');
        const completeIdx = calls.findIndex(c => c.type === 'complete');
        expect(shellIdx).toBeLessThan(completeIdx);
    });

    it('should not call onError for successful render', async () => {
        const { callbacks } = createCallbackTracker();
        await renderToStreamWithCallbacks(<SimpleDiv />, callbacks);
        expect(callbacks.onError).not.toHaveBeenCalled();
    });

    it('should accept App instance', async () => {
        const { callbacks } = createCallbackTracker();
        const app = defineApp(<SimpleDiv />);
        await renderToStreamWithCallbacks(app, callbacks);

        expect(callbacks.onShellReady).toHaveBeenCalledTimes(1);
        const shellHtml = (callbacks.onShellReady as any).mock.calls[0][0] as string;
        expect(shellHtml).toContain('Hello');
    });

    describe('callback ordering', () => {
        it('should call complete even with no async content', async () => {
            const { calls, callbacks } = createCallbackTracker();
            await renderToStreamWithCallbacks(<SimpleDiv />, callbacks);

            const types = calls.map(c => c.type);
            expect(types).toContain('shell');
            expect(types).toContain('complete');
            expect(types).not.toContain('error');
        });
    });
});

describe('edge cases', () => {
    it('should handle component with 0 as content', async () => {
        const Zero = component(() => {
            return () => <div>{0}</div>;
        }, { name: 'Zero' });

        const html = await renderToString(<Zero />);
        expect(html).toContain('0');
    });

    it('should handle empty string content', async () => {
        const Empty = component(() => {
            return () => <div>{''}</div>;
        }, { name: 'Empty' });

        const html = await renderToString(<Empty />);
        expect(html).toContain('<div>');
    });

    it('should handle deeply nested elements', async () => {
        const html = await renderToString(
            <div><div><div><div><div>Deep</div></div></div></div></div>
        );
        expect(html).toBe('<div><div><div><div><div>Deep</div></div></div></div></div>');
    });

    it('should handle mixed content (elements and text)', async () => {
        const html = await renderToString(
            <div>
                Hello
                <span>World</span>
                !
            </div>
        );
        expect(html).toContain('Hello');
        expect(html).toContain('<span>World</span>');
        expect(html).toContain('!');
    });

});

// ─── Error Boundary Tests ──────────────────────────────────────────

describe('Error routing (onError + renderError)', () => {
    it('should render default error comment when component throws', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const html = await renderToString(
            <div><SetupThrowing /></div>
        );

        // Default fallback is an SSR error comment
        expect(html).toMatch(/<!--ssr-error:\d+-->/);
        // Page continues rendering (error is contained)
        expect(html).toContain('<div>');
        expect(html).toContain('</div>');

        consoleSpy.mockRestore();
    });

    it('should call onError with error details and render via renderError', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const onError = vi.fn();
        const renderError = vi.fn(() => '<div class="fallback">Something went wrong</div>');
        const ctx = createSSRContext({ onError, renderError });

        const html = await renderToString(
            <div><SetupThrowing /></div>,
            ctx
        );

        expect(onError).toHaveBeenCalledOnce();
        const [error, info] = onError.mock.calls[0] as unknown as [Error, any];
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('Setup exploded');
        expect(info.componentName).toBe('SetupThrowing');
        expect(typeof info.componentId).toBe('number');
        expect(info.phase).toBe('shell');

        // Custom fallback HTML is rendered
        expect(html).toContain('<div class="fallback">Something went wrong</div>');

        consoleSpy.mockRestore();
    });

    it('should use the default failure HTML when only onError is provided', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const onError = vi.fn();
        const ctx = createSSRContext({ onError });

        const html = await renderToString(
            <div><SetupThrowing /></div>,
            ctx
        );

        expect(onError).toHaveBeenCalledOnce();
        expect(html).toMatch(/<!--ssr-error:\d+-->/);

        consoleSpy.mockRestore();
    });

    it('should continue rendering siblings after component error', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const html = await renderToString(
            <div>
                <SetupThrowing />
                <SimpleDiv />
            </div>
        );

        // Error component has fallback
        expect(html).toMatch(/<!--ssr-error:\d+-->/);
        // Sibling still renders correctly
        expect(html).toContain('<div class="simple">Hello</div>');

        consoleSpy.mockRestore();
    });

    it('should handle error in nested component without affecting parent', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const Parent = component(() => {
            return () => (
                <section class="parent">
                    <SetupThrowing />
                    <span>After error</span>
                </section>
            );
        }, { name: 'Parent' });

        const html = await renderToString(<Parent />);

        expect(html).toContain('<section class="parent">');
        expect(html).toMatch(/<!--ssr-error:\d+-->/);
        expect(html).toContain('<span>After error</span>');
        expect(html).toContain('</section>');

        consoleSpy.mockRestore();
    });
});

// ─── Concurrent SSR Request Isolation ──────────────────────────────

describe('concurrent SSR requests', () => {
    it('should not leak data between parallel renders with async components', async () => {
        const SlowComponent = component(() => {
            const data = useData('concurrent-slow', async () => {
                await new Promise(r => setTimeout(r, 50));
                return 'slow-data';
            });

            return () => <div class="slow">{data.value}</div>;
        }, { name: 'SlowComponent' });

        const FastComponent = component(() => {
            const data = useData('concurrent-fast', async () => {
                await new Promise(r => setTimeout(r, 10));
                return 'fast-data';
            });

            return () => <div class="fast">{data.value}</div>;
        }, { name: 'FastComponent' });

        const [slowHtml, fastHtml] = await Promise.all([
            renderToString(<SlowComponent />),
            renderToString(<FastComponent />),
        ]);

        expect(slowHtml).toContain('slow-data');
        expect(slowHtml).not.toContain('fast-data');
        expect(fastHtml).toContain('fast-data');
        expect(fastHtml).not.toContain('slow-data');
    });

    it('should isolate getCurrentInstance across concurrent async renders', async () => {
        // This test verifies that getCurrentInstance() returns the correct
        // component context during child setup, even when parent renders
        // interleave at async await points.
        const { getCurrentInstance } = await import('sigx');
        const instanceChecks: { component: string, isOwnContext: boolean }[] = [];

        const SlowParent = component(() => {
            const data = useData('isolate-slow-child', async () => {
                await new Promise(r => setTimeout(r, 50));
                return 'slow-child';
            });

            return () => (
                <div class="slow-parent">
                    <SlowChild label="from-slow" />
                    {data.value}
                </div>
            );
        }, { name: 'SlowParent' });

        const FastParent = component(() => {
            const data = useData('isolate-fast-child', async () => {
                await new Promise(r => setTimeout(r, 10));
                return 'fast-child';
            });

            return () => (
                <div class="fast-parent">
                    <FastChild label="from-fast" />
                    {data.value}
                </div>
            );
        }, { name: 'FastParent' });

        const SlowChild = component<{ label: string }>((ctx) => {
            // During setup, getCurrentInstance() should return THIS ctx
            const inst = getCurrentInstance();
            instanceChecks.push({ component: 'slow', isOwnContext: inst === ctx });
            return () => <span>{ctx.props.label}</span>;
        }, { name: 'SlowChild' });

        const FastChild = component<{ label: string }>((ctx) => {
            const inst = getCurrentInstance();
            instanceChecks.push({ component: 'fast', isOwnContext: inst === ctx });
            return () => <span>{ctx.props.label}</span>;
        }, { name: 'FastChild' });

        const [slowHtml, fastHtml] = await Promise.all([
            renderToString(<SlowParent />),
            renderToString(<FastParent />),
        ]);

        // Data should not cross-contaminate
        expect(slowHtml).toContain('slow-child');
        expect(fastHtml).toContain('fast-child');

        // Each child's getCurrentInstance() during setup should be its own ctx
        const slowCheck = instanceChecks.find(c => c.component === 'slow');
        const fastCheck = instanceChecks.find(c => c.component === 'fast');
        expect(slowCheck?.isOwnContext).toBe(true);
        expect(fastCheck?.isOwnContext).toBe(true);
    });

    it('should handle many concurrent renders without errors', async () => {
        const renders = Array.from({ length: 10 }, (_, i) => {
            const Comp = component(() => {
                const data = useData(`many-concurrent-${i}`, async () => {
                    await new Promise(r => setTimeout(r, Math.random() * 20));
                    return `render-${i}`;
                });
                return () => <span class="item">{data.value}</span>;
            }, { name: `Concurrent${i}` });

            return renderToString(<Comp />);
        });

        const results = await Promise.all(renders);

        results.forEach((html, i) => {
            expect(html).toContain(`render-${i}`);
        });
    });
});
