/**
 * The platform-neutral base of the global `JSX` namespace (rfc-1.0 §4.1).
 *
 * `@sigx/runtime-core` owns exactly what TypeScript needs to type a JSX
 * expression against ANY renderer: the element type, the attributes every
 * element and component accepts (`key`), and which prop carries children.
 * It deliberately declares no `IntrinsicElements`: runtime-core has no
 * elements of its own, and an index signature here would make `<anything>`
 * typecheck for every consumer and silently defeat the platform's table.
 *
 * A platform package adds the elements it can render by global merging —
 * `@sigx/runtime-dom`'s `src/jsx.tsx` for HTML/SVG, a terminal or native
 * renderer for its own:
 *
 *     declare global {
 *         namespace JSX {
 *             interface IntrinsicElements { box: BoxProps; text: TextProps }
 *         }
 *     }
 *
 * The same shape extends `ctx`: a `ComponentSetupContext` augmentation
 * (`declare module '@sigx/runtime-core' { interface ComponentSetupContext
 * { … } }`) delivered at runtime by `registerContextExtension`. Both seams
 * stay plain interfaces so any package can merge into them.
 *
 * This is a `.ts` module, not a `.d.ts`: tsc emits `dist/jsx-types.d.ts`
 * from it, and `index.ts`'s side-effect import keeps it reachable from the
 * package's `types` entry (#529 — the `.d.ts` this replaces never shipped).
 */

import type { JSXElement } from './jsx-runtime.js';

declare global {
    namespace JSX {
        type Element = JSXElement;

        interface IntrinsicAttributes {
            key?: string | number | null;
        }

        interface ElementChildrenAttribute {
            children: {};
        }
    }
}
