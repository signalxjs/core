/**
 * Encode an async chunk generator as a pull-based UTF-8 byte stream.
 * Backpressure is honored in `pull()` (one chunk per pull), and `cancel()`
 * (client disconnect) releases the generator so render work stops. The one
 * encoder under `renderDocumentToWebStream`, `createFetchHandler`, and
 * hand-written fetch servers.
 */
export function chunksToBytes(chunks: AsyncGenerator<string>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { value, done } = await chunks.next();
                if (done) {
                    controller.close();
                } else {
                    controller.enqueue(encoder.encode(value));
                }
            } catch (error) {
                controller.error(error);
            }
        },
        cancel() {
            void chunks.return(undefined);
        }
    });
}
