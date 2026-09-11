/**
 * @sigx/resume/client
 *
 * Browser half of the resume pack — lazy-loaded by the delegation loader on
 * first interaction, never part of the initial page payload. This module's
 * `invoke`/`wake` pair is the `ResumeRuntime` the loader drives.
 */

// Load the setup-context augmentation ($sigxB — the transform↔runtime contract)
import '../setup-context';

import { resolveQrl } from './qrl-registry';
import { getScope, getDetachedScope } from './scope';
import { installBoundaryRefreshSeam } from './refresh';

export { __registerResumeQrl, resolveQrl, resetResumeQrls } from './qrl-registry';
export type { QrlLoader } from './qrl-registry';
export { getScope, resetResumeScopes } from './scope';
export type { ResumeScope } from './scope';
export { wake } from './upgrade';
export { createRestoringSignal } from './restore-signal';
export { installBoundaryRefreshSeam, uninstallBoundaryRefreshSeam } from './refresh';

// Stamp the single-flight refresh seam (rfc-server §6.3) the moment the
// client runtime evaluates — an RPC can only be issued by a handler this
// module dispatches, so the fn stub always finds it on a resumable page.
installBoundaryRefreshSeam();

const BOUNDARY_ATTR = 'data-sigx-b';

/**
 * Run a QRL handler against its element's resumed scope. Called by the
 * delegation loader for every `data-sigx-on:*` carrier in the event chain.
 * After the boundary upgrades, its real listeners own the element — the
 * delegated QRL steps aside (double-fire guard).
 *
 * The handler is called as `(scope, event)` — the arity live dispatch gives
 * the original (`runtime-dom`'s invoker passes exactly the event), so a
 * second declared parameter is `undefined` before and after upgrade alike.
 * The element is not passed: it is `event.currentTarget`, re-pointed below.
 */
export async function invoke(symbol: string, event: Event, element: Element): Promise<void> {
    const handler = await resolveQrl(symbol);
    if (!handler) return;

    // Replay runs after native dispatch has ended, so `currentTarget` is
    // null — and `e.currentTarget.value` is the input idiom runtime-dom's own
    // README recommends. Re-point it at the delegated element for THIS
    // handler, exactly as native dispatch would have: an own property
    // shadows the prototype accessor, `configurable` so the next carrier in
    // the synthetic bubble redefines it. `eventPhase` and `composedPath()`
    // keep their post-dispatch values (documented in the README).
    Object.defineProperty(event, 'currentTarget', { value: element, configurable: true });

    const attr = element.getAttribute(BOUNDARY_ATTR);
    const id = attr === null ? NaN : parseInt(attr, 10);
    if (isNaN(id)) {
        if (__DEV__) {
            console.warn(
                `[sigx resume] QRL element for "${symbol}" carries no data-sigx-b boundary id — ` +
                `running against a detached scope.`
            );
        }
        await handler(getDetachedScope(), event);
        return;
    }

    const scope = getScope(id);
    if (scope._status === 'upgraded') return;
    await handler(scope, event);
}
