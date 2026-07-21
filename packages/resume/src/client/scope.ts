/**
 * Resumed scopes (#241): the `$scope` object extracted handlers run against.
 *
 * Built from a boundary record WITHOUT running component setup:
 * `$scope.signals.<name>` are facade signals over the serialized state and
 * `$scope.props` is the record's props snapshot. Reads never cost anything;
 * the FIRST write buffers and triggers upgrade-on-write (`upgrade.ts`) —
 * read-only handlers (logging, navigation) never load the component chunk.
 *
 * After upgrade the facades re-point to the live signals the restoring
 * factory reported, so long-lived handler references keep working.
 */

import { getBoundaryRecord } from '@sigx/server-renderer/client';
import { reviveFromServer } from 'sigx/internals';
import type { SSRBoundaryRecord } from '@sigx/server-renderer';
import { scheduleUpgrade } from './upgrade';

/** What a handler sees. */
export interface ResumeScope {
    /** Named signals rebuilt from serialized state (facades until upgrade). */
    signals: Record<string, { value: unknown }>;
    /** Read-only props snapshot from the boundary record. */
    props: Record<string, unknown>;
}

/** Pack-internal view of a scope. */
export interface InternalScope extends ResumeScope {
    _id: number;
    _record: SSRBoundaryRecord | null;
    _status: 'resumed' | 'upgrading' | 'upgraded';
    /** The upgrade's restore hook fired for the boundary ROOT already. */
    _rootRestored: boolean;
    /** Facade backing store (record.state copy + buffered writes). */
    _values: Record<string, unknown>;
    /** Writes made before the live signals existed, in order. */
    _pendingWrites: Array<[string, unknown]>;
    /** Live signals reported by the restoring factory during upgrade. */
    _live: Record<string, { value: unknown }> | null;
}

const scopes = new Map<number, InternalScope>();

function makeFacade(scope: InternalScope, name: string): { value: unknown } {
    return {
        get value() {
            const live = scope._live?.[name];
            return live ? live.value : scope._values[name];
        },
        set value(next: unknown) {
            const live = scope._live?.[name];
            if (live) {
                live.value = next;
                return;
            }
            scope._values[name] = next;
            scope._pendingWrites.push([name, next]);
            // Detached scopes (no boundary id) buffer but can never upgrade —
            // don't schedule attempts that have nothing to hydrate.
            if (scope._status === 'resumed' && scope._id >= 0) {
                scope._status = 'upgrading';
                scheduleUpgrade(scope).catch((error) => {
                    console.error(`[sigx resume] upgrade of boundary ${scope._id} failed:`, error);
                });
            }
        }
    };
}

function makeScope(id: number, record: SSRBoundaryRecord | null): InternalScope {
    const facades = new Map<string, { value: unknown }>();
    const scope: InternalScope = {
        _id: id,
        _record: record,
        _status: 'resumed',
        _rootRestored: false,
        _values: { ...(reviveFromServer(record?.state) as Record<string, unknown>) },
        _pendingWrites: [],
        _live: null,
        props: (reviveFromServer(record?.props) as Record<string, unknown>) ?? {},
        // Unknown names still produce a facade (a named signal whose value
        // was unserializable resumes as undefined — dev-warned server-side).
        signals: new Proxy({} as Record<string, { value: unknown }>, {
            get(_target, name) {
                if (typeof name !== 'string') return undefined;
                let facade = facades.get(name);
                if (!facade) facades.set(name, (facade = makeFacade(scope, name)));
                return facade;
            }
        })
    };
    return scope;
}

/**
 * The scope for a boundary id — cached per id. A missing record (table/build
 * mismatch) yields a detached scope so global-only handlers still run; it
 * warns in dev and never upgrades.
 */
export function getScope(id: number): InternalScope {
    let scope = scopes.get(id);
    if (!scope) {
        const record = getBoundaryRecord(id) ?? null;
        if (!record && __DEV__) {
            console.warn(
                `[sigx resume] No boundary record for data-sigx-b="${id}" — the boundary table ` +
                `does not match the rendered HTML. The handler runs against a detached scope.`
            );
        }
        scopes.set(id, (scope = makeScope(id, record)));
    }
    return scope;
}

/**
 * A scope with no boundary at all (element carried no usable data-sigx-b):
 * global-only handlers still run; nothing resumes, nothing upgrades. The
 * missing-record warning is skipped — the caller has already warned about
 * the missing id.
 */
export function getDetachedScope(): InternalScope {
    let scope = scopes.get(-1);
    if (!scope) scopes.set(-1, (scope = makeScope(-1, null)));
    return scope;
}

/** The cached scope for an id, or undefined — NEVER fabricates one (unlike
 *  `getScope`); the refresh path peeks so a status check cannot create the
 *  very scope it is gating on. */
export function peekScope(id: number): InternalScope | undefined {
    return scopes.get(id);
}

/** Retire one cached scope — a refresh swapped its boundary out under a
 *  fresh id, and the old scope must not satisfy later lookups. */
export function dropScope(id: number): void {
    scopes.delete(id);
}

const resetHooks: Array<() => void> = [];

/** Run a hook on every `resetResumeScopes()` — pack-internal, so modules
 *  with per-page state (the refresh seq guard) reset in step without a
 *  circular import. */
export function onResumeReset(hook: () => void): void {
    resetHooks.push(hook);
}

/** Drop all cached scopes — SPA navigation (new boundary table) and tests. */
export function resetResumeScopes(): void {
    scopes.clear();
    for (const hook of resetHooks) hook();
}
