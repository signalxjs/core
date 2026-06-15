/**
 * Server-side rendering tests for islands architecture
 * Tests island rendering, signal state tracking, streaming with islands,
 * and signal state serialization — extracted from server-renderer/stream.test.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { component, Fragment, useAsync } from 'sigx';
import { renderToString, renderToStream, renderToStreamWithCallbacks, type StreamCallbacks } from '../../server-renderer/src/server/index';
import { createSSR } from '../../server-renderer/src/ssr';
import { islandsPlugin } from '../src/plugin';
// Import client-directives for ComponentAttributeExtensions augmentation (client:* types)
import '../src/client-directives';
import { parseIslandData } from './test-utils';
import type { SSRSignalFn } from './test-utils';

// ─── Test Components ───────────────────────────────────────────────

const SimpleDiv = component(() => {
    return () => <div class="simple">Hello</div>;
}, { name: 'SimpleDiv' });

const WithSignal = component((ctx) => {
    const state = ctx.signal({ count: 0 });
    return () => <div class="signal">{state.count}</div>;
}, { name: 'WithSignal' });

const IslandCounter = component<{ initial?: number }>((ctx) => {
    const count = ctx.signal(ctx.props.initial ?? 0);
    return () => <div class="island-counter">{count.value}</div>;
}, { name: 'IslandCounter' });

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

// ─── Tests ─────────────────────────────────────────────────────────

describe('island rendering (renderToString)', () => {
    describe('signal state tracking', () => {
        it('should track signal state for island components', async () => {
            const ssr = createSSR().use(islandsPlugin());
            const html = await ssr.render(
                <IslandCounter client:load initial={5} />
            );

            // The island data should be in the rendered HTML
            expect(html).toContain('__SIGX_ISLANDS__');
            const islandData = parseIslandData(html);
            const islands = Object.values(islandData);
            expect(islands.length).toBeGreaterThan(0);

            const island = islands[0] as any;
            expect(island.strategy).toBe('load');
            expect(island.componentId).toBe('IslandCounter');
        });

        it('should not track signals for non-island components', async () => {
            const ssr = createSSR().use(islandsPlugin());
            const html = await ssr.render(<WithSignal />);

            // No islands registered
            expect(html).not.toContain('__SIGX_ISLANDS__');
        });
    });

    describe('island rendering', () => {
        it('should render client:load island with content', async () => {
            const ssr = createSSR().use(islandsPlugin());
            const html = await ssr.render(<IslandCounter client:load initial={5} />);
            expect(html).toContain('<div class="island-counter">');
            expect(html).toContain('5');
        });

        it('should render client:only island with placeholder marker', async () => {
            const ssr = createSSR().use(islandsPlugin());
            const html = await ssr.render(<IslandCounter client:only />);
            expect(html).toContain('data-island=');
            // In plugin architecture, client:only still renders content server-side
            // but the island data marks it as strategy "only" for client-side fresh mount
            const islands = parseIslandData(html);
            const island = Object.values(islands)[0] as any;
            expect(island.strategy).toBe('only');
        });

        it('should include __SIGX_ISLANDS__ JSON for islands', async () => {
            const ssr = createSSR().use(islandsPlugin());
            const html = await ssr.render(<IslandCounter client:load />);
            expect(html).toContain('__SIGX_ISLANDS__');
            expect(html).toContain('application/json');
        });

        it('should not include __SIGX_ISLANDS__ when no islands', async () => {
            const ssr = createSSR().use(islandsPlugin());
            const html = await ssr.render(<SimpleDiv />);
            expect(html).not.toContain('__SIGX_ISLANDS__');
        });

        it('should serialize island props', async () => {
            const ssr = createSSR().use(islandsPlugin());
            const html = await ssr.render(<IslandCounter client:load initial={42} />);

            const islandData = parseIslandData(html);
            const island = Object.values(islandData)[0] as any;
            expect(island.props).toBeDefined();
            expect(island.props.initial).toBe(42);
        });

        it('should filter non-serializable props from islands', async () => {
            const ssr = createSSR().use(islandsPlugin());
            const html = await ssr.render(<IslandCounter client:idle initial={5} />);

            const islandData = parseIslandData(html);
            const island = Object.values(islandData)[0] as any;
            // Event handlers should be filtered out
            expect(island.props?.onClick).toBeUndefined();
        });
    });
});

describe('island streaming (renderToStream)', () => {
    it('should include __SIGX_ISLANDS__ for island content', async () => {
        const ssr = createSSR().use(islandsPlugin());
        const html = await collectStream(ssr.renderStream(<IslandCounter client:load />));
        expect(html).toContain('__SIGX_ISLANDS__');
    });

    describe('streaming async components', () => {
        it('should render async island placeholder first', async () => {
            const AsyncIsland = component(() => {
                const data = useAsync('async-island-data', async () => {
                    await new Promise(r => setTimeout(r, 10));
                    return 'async-loaded';
                });
                return () => (
                    <div class="async-island">
                        {data.value ?? 'Loading...'}
                    </div>
                );
            }, { name: 'AsyncIsland' });

            const ssr = createSSR().use(islandsPlugin());
            const html = await collectStream(ssr.renderStream(<AsyncIsland client:load />));
            // Should contain placeholder
            expect(html).toContain('data-async-placeholder=');
            // Should contain the replacement script
            expect(html).toContain('$SIGX_REPLACE');
            // The final data should be included
            expect(html).toContain('async-loaded');
        });

        it('should include streaming script before replacements', async () => {
            const AsyncIsland = component(() => {
                const data = useAsync('async-island-script', async () => {
                    await new Promise(r => setTimeout(r, 10));
                    return 'loaded';
                });
                return () => <div>{data.value ?? 'Loading'}</div>;
            }, { name: 'AsyncIsland' });

            const ssr = createSSR().use(islandsPlugin());
            const html = await collectStream(ssr.renderStream(<AsyncIsland client:load />));
            // The streaming script should be present
            expect(html).toContain('$SIGX_REPLACE');
        });

        it('should handle async component error in stream', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

            const FailingAsync = component(() => {
                useAsync('stream-fail-1', async () => {
                    throw new Error('Stream async fail');
                }, { throwOnError: true });
                return () => <div>Fallback</div>;
            }, { name: 'FailingAsync' });

            const ssr = createSSR().use(islandsPlugin());
            const html = await collectStream(ssr.renderStream(<FailingAsync client:load />));
            // Should have error fallback
            expect(html).toContain('Error loading component');

            consoleSpy.mockRestore();
        });
    });
});

describe('island streaming (renderToStreamWithCallbacks)', () => {
    describe('async component streaming via callbacks', () => {
        it('should send async chunks for async island components', async () => {
            const AsyncIsland = component(() => {
                const data = useAsync('cb-streamed-data', async () => {
                    await new Promise(r => setTimeout(r, 10));
                    return 'streamed-data';
                });
                return () => <div>{data.value ?? 'Loading'}</div>;
            }, { name: 'AsyncIsland' });

            const { callbacks } = createCallbackTracker();
            const ssr = createSSR().use(islandsPlugin());
            await ssr.renderStreamWithCallbacks(<AsyncIsland client:load />, callbacks);

            // Should have async chunks
            expect(callbacks.onAsyncChunk).toHaveBeenCalled();

            // Shell should have placeholder
            const shellHtml = (callbacks.onShellReady as any).mock.calls[0][0] as string;
            expect(shellHtml).toContain('data-async-placeholder=');
        });

        it('should include sync island data in shell', async () => {
            const { callbacks } = createCallbackTracker();
            const ssr = createSSR().use(islandsPlugin());
            await ssr.renderStreamWithCallbacks(<IslandCounter client:load initial={10} />, callbacks);

            const shellHtml = (callbacks.onShellReady as any).mock.calls[0][0] as string;
            // Sync islands should have their data in the shell
            expect(shellHtml).toContain('__SIGX_ISLANDS__');
        });

        it('should call onAsyncChunk with replacement scripts', async () => {
            const AsyncIsland = component(() => {
                const data = useAsync('cb-replacement-script', async () => {
                    await new Promise(r => setTimeout(r, 10));
                    return 'loaded';
                });
                return () => <div>{data.value ?? ''}</div>;
            }, { name: 'AsyncIsland' });

            const { calls, callbacks } = createCallbackTracker();
            const ssr = createSSR().use(islandsPlugin());
            await ssr.renderStreamWithCallbacks(<AsyncIsland client:load />, callbacks);

            const asyncChunks = calls.filter(c => c.type === 'async');
            expect(asyncChunks.length).toBeGreaterThan(0);
            // Should contain replacement script
            const allAsync = asyncChunks.map(c => c.data).join('');
            expect(allAsync).toContain('$SIGX_REPLACE');
        });

        it('should handle async error with onAsyncChunk error fallback', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { });

            const FailingAsync = component(() => {
                useAsync('cb-fail-1', async () => { throw new Error('fail'); }, { throwOnError: true });
                return () => <div>Content</div>;
            }, { name: 'FailingAsync' });

            const { calls, callbacks } = createCallbackTracker();
            const ssr = createSSR().use(islandsPlugin());
            await ssr.renderStreamWithCallbacks(<FailingAsync client:load />, callbacks);

            const asyncChunks = calls.filter(c => c.type === 'async');
            const allAsync = asyncChunks.map(c => c.data).join('');
            expect(allAsync).toContain('Error loading component');

            consoleSpy.mockRestore();
        });
    });

    describe('callback ordering with islands', () => {
        it('should call shell before async chunks before complete', async () => {
            const AsyncIsland = component(() => {
                const v = useAsync('cb-ordering', async () => {
                    await new Promise(r => setTimeout(r, 10));
                    return 'done';
                });
                return () => <div>{v.value ?? ''}</div>;
            }, { name: 'AsyncIsland' });

            const { calls, callbacks } = createCallbackTracker();
            const ssr = createSSR().use(islandsPlugin());
            await ssr.renderStreamWithCallbacks(<AsyncIsland client:load />, callbacks);

            const types = calls.map(c => c.type);
            const shellIdx = types.indexOf('shell');
            const firstAsyncIdx = types.indexOf('async');
            const completeIdx = types.indexOf('complete');

            expect(shellIdx).toBeLessThan(firstAsyncIdx);
            expect(firstAsyncIdx).toBeLessThan(completeIdx);
        });
    });
});

describe('signal state serialization', () => {
    it('should capture signal state for island with async load', async () => {
        const StatefulIsland = component((ctx) => {
            const ssrSignal = ctx.signal as SSRSignalFn;
            const count = ssrSignal(0, 'count');
            useAsync('stateful-count', async () => {
                count.value = 42;
                return count.value;
            });
            return () => <span>{count.value}</span>;
        }, { name: 'StatefulIsland' });

        const ssr = createSSR().use(islandsPlugin());
        const html = await ssr.render(<StatefulIsland client:load />);

        // Island should have state captured
        const islandData = parseIslandData(html);
        const island = Object.values(islandData)[0] as any;
        expect(island.state).toBeDefined();
        expect(island.state.count).toBe(42);
    });

    it('should capture multiple signals', async () => {
        const MultiSignal = component((ctx) => {
            const ssrSignal = ctx.signal as SSRSignalFn;
            const name = ssrSignal('', 'name');
            const age = ssrSignal(0, 'age');
            useAsync('multi-signal', async () => {
                name.value = 'Alice';
                age.value = 30;
                return null;
            });
            return () => <div>{name.value} is {age.value}</div>;
        }, { name: 'MultiSignal' });

        const ssr = createSSR().use(islandsPlugin());
        const html = await ssr.render(<MultiSignal client:load />);

        const islandData = parseIslandData(html);
        const island = Object.values(islandData)[0] as any;
        expect(island.state).toBeDefined();
        expect(island.state.name).toBe('Alice');
        expect(island.state.age).toBe(30);
    });

    it('should use auto-indexed keys when name not specified', async () => {
        const AutoIndex = component((ctx) => {
            const a = ctx.signal(1);
            const b = ctx.signal(2);
            useAsync('auto-index', async () => {
                a.value = 10;
                b.value = 20;
                return null;
            });
            return () => <div>{a.value},{b.value}</div>;
        }, { name: 'AutoIndex' });

        const ssr = createSSR().use(islandsPlugin());
        const html = await ssr.render(<AutoIndex client:load />);

        const islandData = parseIslandData(html);
        const island = Object.values(islandData)[0] as any;
        expect(island.state).toBeDefined();
        // Auto-indexed: $0, $1
        expect(island.state['$0']).toBe(10);
        expect(island.state['$1']).toBe(20);
    });

    it('should skip non-serializable signal values', async () => {
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

        const NonSerializable = component((ctx) => {
            const ssrSignal = ctx.signal as SSRSignalFn;
            const state = ssrSignal(null as any, 'state');
            useAsync('non-serializable', async () => {
                // Circular objects are not serializable
                const circular: any = {};
                circular.self = circular;
                state.value = circular;
                return null;
            });
            return () => <div>Test</div>;
        }, { name: 'NonSerializable' });

        const ssr = createSSR().use(islandsPlugin());
        await ssr.render(<NonSerializable client:load />);

        consoleSpy.mockRestore();
    });

    it('should not include state when signal map is empty', async () => {
        const NoState = component((ctx) => {
            return () => <div>No state</div>;
        }, { name: 'NoState' });

        const ssr = createSSR().use(islandsPlugin());
        const html = await ssr.render(<NoState client:load />);

        const islandData = parseIslandData(html);
        const island = Object.values(islandData)[0] as any;
        expect(island.state).toBeUndefined();
    });
});

describe('island edge cases', () => {
    it('should handle multiple islands on one page', async () => {
        const ssr = createSSR().use(islandsPlugin());
        const html = await ssr.render(
            <div>
                <IslandCounter client:load initial={1} />
                <IslandCounter client:idle initial={2} />
                <IslandCounter client:visible initial={3} />
            </div>
        );

        const islandData = parseIslandData(html);
        const islands = Object.values(islandData);
        expect(islands.length).toBe(3);
        const strategies = islands.map((i: any) => i.strategy);
        expect(strategies).toContain('load');
        expect(strategies).toContain('idle');
        expect(strategies).toContain('visible');
    });

    it('should handle island inside non-island component', async () => {
        const Wrapper = component(() => {
            return () => (
                <div class="page">
                    <IslandCounter client:load initial={5} />
                </div>
            );
        }, { name: 'Wrapper' });

        const ssr = createSSR().use(islandsPlugin());
        const html = await ssr.render(<Wrapper />);

        expect(html).toContain('<div class="page">');
        expect(html).toContain('island-counter');
        const islandData = parseIslandData(html);
        expect(Object.keys(islandData).length).toBe(1);
    });
});
