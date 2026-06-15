import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESULTS_DIR: string = fileURLToPath(new URL('../results/', import.meta.url));

export interface ResultsMeta {
    date: string;
    node: string;
    cpu: string;
}

export function resultsMeta(): ResultsMeta {
    return {
        date: new Date().toISOString(),
        node: process.version,
        cpu: os.cpus()[0]?.model ?? 'unknown'
    };
}

export function writeResults(fileName: string, payload: unknown): string {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const file = path.join(RESULTS_DIR, fileName);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
    return file;
}

/**
 * Merge one section ('string', 'stream' or 'quick') into results/baseline.json
 * so the individual --baseline runs build a single combined baseline file.
 */
export function mergeBaseline(key: 'string' | 'stream' | 'quick', data: unknown, meta: ResultsMeta): string {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const file = path.join(RESULTS_DIR, 'baseline.json');
    let baseline: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
        try {
            baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            baseline = {};
        }
    }
    baseline[key] = data;
    baseline.meta = meta;
    fs.writeFileSync(file, JSON.stringify(baseline, null, 2) + '\n');
    return file;
}
