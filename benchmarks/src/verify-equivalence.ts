/**
 * Verifies every framework renders an equivalent tree per scenario before
 * benching: same tag histogram, same text content. Exits 1 on mismatch.
 *
 * Normalization removes benign framework-specific output:
 * - HTML comments: sigx hydration markers (<!--$c:N-->, <!--t-->, <!---->),
 *   Vue fragment markers (<!--[-->, <!--]-->), React text separators (<!-- -->).
 * - data-async-placeholder attributes (sigx streaming wrappers, if any).
 * - Whitespace between tags.
 * Text comparison additionally decodes HTML entities, since frameworks escape
 * different character sets (e.g. Preact leaves " and ' raw in text nodes).
 */
import { loadAdapters } from './load-adapters.ts';
import type { ScenarioName } from './adapters/types.ts';

const SCENARIOS: ScenarioName[] = [
    'small-page', 'large-table-1k', 'large-table', 'deep-tree',
    'attr-style-heavy', 'escape-heavy', 'escape-clean'
];

export function normalizeHtml(html: string): string {
    return html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/ data-async-placeholder="[^"]*"( style="display:contents;")?/g, '')
        .replace(/>\s+</g, '><')
        .trim();
}

function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&amp;/g, '&'); // last, so &amp;lt; doesn't double-decode
}

export function tagHistogram(normalized: string): Map<string, number> {
    const histogram = new Map<string, number>();
    for (const match of normalized.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)/g)) {
        const tag = match[1].toLowerCase();
        histogram.set(tag, (histogram.get(tag) ?? 0) + 1);
    }
    return histogram;
}

export function textContent(normalized: string): string {
    return decodeEntities(normalized.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function histogramToString(h: Map<string, number>): string {
    return [...h.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([tag, n]) => `${tag}=${n}`).join(' ');
}

function diffHistograms(name: string, base: Map<string, number>, other: Map<string, number>): string[] {
    const lines: string[] = [];
    const tags = new Set([...base.keys(), ...other.keys()]);
    for (const tag of [...tags].sort()) {
        const a = base.get(tag) ?? 0;
        const b = other.get(tag) ?? 0;
        if (a !== b) lines.push(`    <${tag}>: baseline=${a} ${name}=${b}`);
    }
    return lines;
}

function firstTextDiff(a: string, b: string): string {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const ctx = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
    return `at char ${i}:\n    baseline: ${ctx(a)}\n    other:    ${ctx(b)}`;
}

async function main(): Promise<void> {
    const adapters = await loadAdapters();
    let failed = false;

    for (const scenario of SCENARIOS) {
        const rendered = [];
        for (const adapter of adapters) {
            const normalized = normalizeHtml(await adapter.renderToString(scenario));
            rendered.push({
                name: adapter.name,
                histogram: tagHistogram(normalized),
                text: textContent(normalized)
            });
        }

        const base = rendered[0]; // sigx is the baseline
        let scenarioOk = true;
        for (const other of rendered.slice(1)) {
            const histDiff = diffHistograms(other.name, base.histogram, other.histogram);
            if (histDiff.length > 0) {
                scenarioOk = false;
                console.error(`FAIL ${scenario}: tag histogram differs (${base.name} vs ${other.name})`);
                for (const line of histDiff) console.error(line);
                console.error(`  ${base.name}: ${histogramToString(base.histogram)}`);
                console.error(`  ${other.name}: ${histogramToString(other.histogram)}`);
            }
            if (other.text !== base.text) {
                scenarioOk = false;
                console.error(`FAIL ${scenario}: text content differs (${base.name} vs ${other.name})`);
                console.error(`  ${firstTextDiff(base.text, other.text)}`);
            }
        }

        if (scenarioOk) {
            const tagCount = [...base.histogram.values()].reduce((a, b) => a + b, 0);
            console.log(`ok ${scenario.padEnd(18)} tags=${tagCount} text=${base.text.length} chars (${rendered.length} frameworks match)`);
        } else {
            failed = true;
        }
    }

    if (failed) process.exit(1);
}

await main();
