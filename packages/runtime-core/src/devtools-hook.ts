/**
 * DevTools hook — runtime-core view.
 *
 * The hook itself lives in `@sigx/reactivity` (the lowest layer) so
 * every package can emit into the same global without circular deps.
 * This file just re-exports the hook accessors and adds the component
 * /app event variants that are specific to the renderer layer.
 *
 * Consumers (`@sigx/devtools`) see one `DevtoolsEvent` union that
 * spans every layer; they import each layer's contribution and union
 * them.
 */

import type { AppContext, ComponentInstance } from './app-types.js';
import type { DevtoolsEventBase } from '@sigx/reactivity/internals';

export {
    DEVTOOLS_HOOK_KEY,
    getDevtoolsHook,
    ensureDevtoolsHook,
} from '@sigx/reactivity/internals';
export type {
    DevtoolsHook,
    DevtoolsEventBase,
    DevtoolsListenerBase,
} from '@sigx/reactivity/internals';

/**
 * Component/app lifecycle events emitted by the renderer layer.
 * `DevtoolsEventBase` widening keeps these compatible with `hook.emit`.
 *
 * `instanceId` is the hook-minted id for the component's setup context.
 * It's the same id reactivity events carry in `ownerComponentId`, so
 * the panel can join "this component" ↔ "the signals it owns" without
 * an extra lookup. `instanceId` is null when no hook was installed at
 * setup time (defensive — shouldn't happen in practice since the hook
 * gates everything).
 *
 * `parentInstanceId` (on `component:created`) is the id of the
 * component whose render effect was running when this component was
 * set up. Lets the panel build the tree without a fragile mounting-
 * order heuristic — works for initial mount and for components that
 * appear later via reactive re-renders.
 */
export type DevtoolsEvent =
    | { type: 'app:init';            app: AppContext }
    | { type: 'app:unmount';         app: AppContext }
    | { type: 'component:created';   app: AppContext; instance: ComponentInstance; instanceId: number | null; parentInstanceId: number | null }
    | { type: 'component:mounted';   app: AppContext; instance: ComponentInstance; instanceId: number | null }
    | { type: 'component:updated';   app: AppContext; instance: ComponentInstance; instanceId: number | null }
    | { type: 'component:unmounted'; app: AppContext; instance: ComponentInstance; instanceId: number | null }
    | { type: 'component:error';     app: AppContext; instance: ComponentInstance | null; instanceId: number | null; error: Error; info: string };

export type DevtoolsListener = (event: DevtoolsEvent) => void;

// Compile-time check that DevtoolsEvent extends DevtoolsEventBase.
// If someone removes a `type` field by mistake, this fails. Pure
// type-level — no runtime emit.
type _AssertExtendsBase = DevtoolsEvent extends DevtoolsEventBase ? true : never;
export type _RuntimeCoreEventsCheck = _AssertExtendsBase;
