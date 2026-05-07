/**
 * Shared types for server rendering APIs.
 * 
 * Kept separate to avoid circular imports between ssr.ts and render-api.ts.
 */

import type { Signal, PrimitiveSignal, Primitive } from 'sigx';

/**
 * SSR-enhanced signal function type.
 * Extends the base signal() with an optional `name` parameter used as the
 * serialization key for hydration state transfer.
 *
 * Both `createTrackingSignal` (server/islands) and `createRestoringSignal` (client/hydration)
 * use this type and share the same key-generation contract via `generateSignalKey`.
 */
export type SSRSignalFn = {
    <T extends Primitive>(initial: T, name?: string): PrimitiveSignal<T>;
    <T extends object>(initial: T, name?: string): Signal<T>;
};

/**
 * Generate a stable key for a signal during SSR state tracking/restoration.
 *
 * Named signals use the provided name; unnamed signals use a positional key (`$0`, `$1`, ...).
 * Both server-side tracking (`createTrackingSignal`) and client-side restoration
 * (`createRestoringSignal`) MUST use this function to guarantee key parity.
 */
export function generateSignalKey(name: string | undefined, index: number): string {
    return name ?? `$${index}`;
}

/**
 * Streaming callbacks interface
 */
export interface StreamCallbacks {
    /** Called when the initial shell (synchronous content) is ready */
    onShellReady: (html: string) => void;
    /** Called for each async chunk (replacement scripts, hydration data) */
    onAsyncChunk: (chunk: string) => void;
    /** Called when all streaming is complete */
    onComplete: () => void;
    /** Called on error */
    onError: (error: Error) => void;
}
