/**
 * Shared types for server rendering APIs.
 * 
 * Kept separate to avoid circular imports between ssr.ts and render-api.ts.
 */

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
