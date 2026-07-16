/**
 * Shared test utilities for server-renderer hydration tests
 */

import { component, signal, VNode, Fragment, Text } from 'sigx';
import { loadHydrationCore } from '../src/client/scheduler';

// Pre-warm the lazily-imported hydration executor for every suite that uses
// these utilities (ssr-islands' test-utils re-exports this module, so both
// packages are covered). In the browser it loads on the first strategy that
// fires; under vitest that first dynamic import runs a REAL async transform,
// which fake timers can't advance and `await nextTick()` flushes can't bound
// — scheduled-hydration tests would flake on module-cache timing. Warmed, a
// trigger's `loadHydrationCore()` resolves in microtasks and the existing
// flushes suffice. Laziness itself is covered by the examples'
// coverage-based browser smoke, not unit timing. Deliberately NOT in the
// global vitest setup: importing the executor registers the `ctx.ssr`
// context extension, which must not leak into runtime-core suites.
await loadHydrationCore();

/**
 * Remove any leftover script tags injected into document.head by tests
 */
export function cleanupScripts(): void {
    const islandScript = document.getElementById('__SIGX_ISLANDS__');
    islandScript?.remove();
}

/**
 * Create a container element with SSR-like HTML content
 */
export function createSSRContainer(html: string): HTMLDivElement {
    const container = document.createElement('div');
    container.id = 'app';
    container.innerHTML = html;
    document.body.appendChild(container);
    return container;
}

/**
 * Cleanup container from document
 */
export function cleanupContainer(container: HTMLElement): void {
    container.remove();
}

/**
 * Generate SSR-like HTML for a simple element
 */
export function ssrElement(tag: string, props: Record<string, any>, children: string = ''): string {
    const attrs = Object.entries(props)
        .filter(([key]) => !key.startsWith('on') && key !== 'children' && key !== 'key')
        .map(([key, value]) => {
            if (typeof value === 'boolean') {
                return value ? key : '';
            }
            return `${key}="${escapeHtml(String(value))}"`;
        })
        .filter(Boolean)
        .join(' ');
    
    const attrStr = attrs ? ` ${attrs}` : '';
    
    // Self-closing tags
    const selfClosing = ['input', 'br', 'hr', 'img', 'meta', 'link'];
    if (selfClosing.includes(tag)) {
        return `<${tag}${attrStr} />`;
    }
    
    return `<${tag}${attrStr}>${children}</${tag}>`;
}

/**
 * Generate SSR component markers (trailing marker pattern)
 * Structure: <content><!--$c:id-->
 */
export function ssrComponentMarkers(id: number, content: string): string {
    return `${content}<!--$c:${id}-->`;
}

/**
 * Generate SSR island markers
 * @deprecated Island markers are no longer emitted - island data is in __SIGX_ISLANDS__ JSON.
 * This function now just returns the content with the component marker.
 */
export function ssrIslandMarkers(id: number, content: string): string {
    return `${content}<!--$c:${id}-->`;
}

/**
 * Generate text node separator (used between adjacent text nodes)
 */
export function ssrTextSeparator(): string {
    return '<!--t-->';
}

/**
 * Escape HTML for attributes
 */
export function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Simple Counter component for testing
 */
export const TestCounter = component(() => {
    const count = signal(0);
    
    return () => (
        <div class="counter">
            <span class="count">{count.value}</span>
            <button onClick={() => count.value++}>+</button>
        </div>
    );
}, { name: 'TestCounter' });

/**
 * Counter with initial value prop
 */
export const TestCounterWithProps = component<{ initial?: number }>((ctx) => {
    const { initial = 0 } = ctx.props;
    const count = signal(initial);
    
    return () => (
        <div class="counter">
            <span class="count">{count.value}</span>
            <button onClick={() => count.value++}>+</button>
        </div>
    );
}, { name: 'TestCounterWithProps' });

/**
 * Simple text component for testing
 */
export const TestText = component<{ text: string }>((ctx) => {
    return () => <span class="text">{ctx.props.text}</span>;
}, { name: 'TestText' });

/**
 * Component with children/slots
 */
export const TestWrapper = component((ctx) => {
    return () => (
        <div class="wrapper">
            {ctx.slots.default?.()}
        </div>
    );
}, { name: 'TestWrapper' });

/**
 * Component with onMounted hook
 */
export const TestMountHook = component((ctx) => {
    let mounted = false;
    
    ctx.onMounted(() => {
        mounted = true;
    });
    
    return () => (
        <div class="mount-test" data-mounted={mounted ? 'true' : 'false'}>
            Mounted
        </div>
    );
}, { name: 'TestMountHook' });

/**
 * Component with event handler
 */
export const TestButton = component<{ label: string }>((ctx) => {
    const clicked = signal(false);
    
    return () => (
        <button 
            class="test-button" 
            data-clicked={clicked.value ? 'true' : 'false'}
            onClick={() => clicked.value = true}
        >
            {ctx.props.label}
        </button>
    );
}, { name: 'TestButton' });

/**
 * Wait for next tick (microtask)
 */
export function nextTick(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Wait for requestIdleCallback (or fallback)
 */
export function waitForIdle(): Promise<void> {
    return new Promise(resolve => {
        if ('requestIdleCallback' in window) {
            requestIdleCallback(() => resolve());
        } else {
            setTimeout(() => resolve(), 200);
        }
    });
}

/**
 * Create a VNode for testing
 */
export function createVNode(
    type: string | Function | typeof Fragment | typeof Text,
    props: Record<string, any> = {},
    children: VNode[] = [],
    text?: string | number
): VNode {
    return {
        type,
        props,
        key: props.key ?? null,
        children,
        dom: null,
        text
    };
}

/**
 * Create a text VNode
 */
export function createTextVNode(text: string | number): VNode {
    return {
        type: Text,
        props: {},
        key: null,
        children: [],
        dom: null,
        text
    };
}

/**
 * Create a fragment VNode
 */
export function createFragmentVNode(children: VNode[]): VNode {
    return {
        type: Fragment,
        props: {},
        key: null,
        children,
        dom: null
    };
}
