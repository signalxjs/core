import type { Readable } from 'node:stream';

export interface StreamSample {
    ttfbNs: bigint;
    totalNs: bigint;
    bytes: number;
}

/**
 * Measure a node Readable: TTFB at the first 'data' event, total at 'end'.
 * The factory is invoked inside so stream creation is part of the timing.
 */
export function measureReadable(create: () => Readable): Promise<StreamSample> {
    return new Promise((resolve, reject) => {
        const start = process.hrtime.bigint();
        const stream = create();
        let ttfb = 0n;
        let bytes = 0;
        stream.on('data', (chunk: string | Buffer) => {
            if (ttfb === 0n) ttfb = process.hrtime.bigint() - start;
            bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        });
        stream.on('end', () => {
            resolve({ ttfbNs: ttfb, totalNs: process.hrtime.bigint() - start, bytes });
        });
        stream.on('error', reject);
    });
}
