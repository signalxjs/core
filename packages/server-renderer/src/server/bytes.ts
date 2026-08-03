/**
 * Encode an async chunk generator as a pull-based UTF-8 byte stream.
 * Backpressure is honored in `pull()` (one chunk per pull), and `cancel()`
 * (client disconnect) releases the generator so render work stops. The one
 * encoder under `renderDocumentToWebStream`, `createFetchHandler`, and
 * hand-written fetch servers.
 *
 * `onSettled` fires exactly ONCE, on whichever ending the body reaches —
 * normal close, error, or cancel. `createFetchHandler` resolves its
 * `keepAlive(until)` promise with it (rfc-server-v3 §2.6): "the response
 * has fully flushed" is observable nowhere but here.
 */
export function chunksToBytes(
    chunks: AsyncGenerator<string>,
    onSettled?: () => void
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let settled = false;
    const settle = (): void => {
        if (settled) return;
        settled = true;
        onSettled?.();
    };

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { value, done } = await chunks.next();
                if (done) {
                    settle();
                    controller.close();
                } else {
                    controller.enqueue(encoder.encode(value));
                }
            } catch (error) {
                settle();
                controller.error(error);
            }
        },
        cancel() {
            void chunks.return(undefined);
            settle();
        }
    });
}
