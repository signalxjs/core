/**
 * JSX type definitions for SignalX
 */

import type { JSXElement, VNode } from './jsx-runtime.js';

declare global {
    namespace JSX {
        type Element = JSXElement;
        
        interface IntrinsicAttributes {
            key?: string | number | null;
        }
        
        interface ElementChildrenAttribute {
            children: {};
        }
        
        interface IntrinsicElements {
            // HTML elements
            [elemName: string]: any;
        }
    }
}

export {};
