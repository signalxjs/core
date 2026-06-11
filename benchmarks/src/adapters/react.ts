/**
 * React adapter — same logical trees built with createElement, string render
 * via react-dom/server renderToString, streaming via renderToPipeableStream
 * piped into a byte-counting Writable (TTFB at first write).
 */
import { Writable } from 'node:stream';
import { createElement as ce, type ReactNode } from 'react';
import { renderToString, renderToPipeableStream } from 'react-dom/server';
import type { FrameworkAdapter, ScenarioName } from './types.ts';
import type { StreamSample } from './measure.ts';
import {
    SMALL_PAGE, ROWS_10K, ROWS_1K, DEEP_TREE, ATTR_ITEMS, ESCAPE,
    scoreColor, type TableRow, type AttrItem
} from '../scenarios/data.ts';

// --- components -------------------------------------------------------------

function Card({ title, children }: { title: string; children?: ReactNode }) {
    return ce('section', { className: 'card' },
        ce('h2', null, title),
        ce('div', { className: 'card-body' }, children));
}

function Row({ row }: { row: TableRow }) {
    return ce('tr', { className: row.active ? 'row active' : 'row' },
        ce('td', null, String(row.id)),
        ce('td', null, row.name),
        ce('td', null, row.email),
        ce('td', null, row.role),
        ce('td', null, ce('span', { style: { color: scoreColor(row.score) } }, row.score.toFixed(2))),
        ce('td', null, row.active ? 'yes' : 'no'));
}

function Table({ rows }: { rows: TableRow[] }) {
    return ce('table', { className: 'data' },
        ce('tbody', null, rows.map((row) => ce(Row, { row, key: row.id }))));
}

function Level({ depth, branching }: { depth: number; branching: number }) {
    return ce('div', { className: `lvl lvl-${depth}` },
        depth <= 1
            ? 'leaf'
            : Array.from({ length: branching }, (_, i) =>
                ce(Level, { depth: depth - 1, branching, key: i })));
}

// --- scenario trees ----------------------------------------------------------

function smallPage(): ReactNode {
    return ce('div', { id: 'app' },
        ce('header', null,
            ce('h1', null, SMALL_PAGE.title),
            ce('nav', null, SMALL_PAGE.navLinks.map((l) => ce('a', { href: l.href, key: l.href }, l.label)))),
        ce('main', null, SMALL_PAGE.cards.map((c, i) =>
            ce(Card, { title: c.title, key: i },
                c.paragraphs.map((p, j) => ce('p', { key: j }, p))))),
        ce('footer', null, ce('p', null, SMALL_PAGE.footer)));
}

function attrDiv(item: AttrItem): ReactNode {
    return ce('div', {
        id: item.id,
        className: item.className,
        'data-index': item.dataIndex,
        'data-group': item.dataGroup,
        title: item.title,
        tabIndex: item.tabIndex,
        role: item.role,
        style: item.style,
        key: item.id
    }, item.label);
}

function article(paragraphs: string[]): ReactNode {
    return ce('article', { className: 'prose' }, paragraphs.map((p, i) => ce('p', { key: i }, p)));
}

function build(scenario: ScenarioName): ReactNode {
    switch (scenario) {
        case 'small-page': return smallPage();
        case 'large-table': return ce(Table, { rows: ROWS_10K });
        case 'large-table-1k': return ce(Table, { rows: ROWS_1K });
        case 'deep-tree': return ce(Level, { depth: DEEP_TREE.depth, branching: DEEP_TREE.branching });
        case 'attr-style-heavy': return ce('div', { className: 'attr-grid' }, ATTR_ITEMS.map(attrDiv));
        case 'escape-heavy': return article(ESCAPE.dirty);
        case 'escape-clean': return article(ESCAPE.clean);
    }
}

function measurePipeable(element: ReactNode): Promise<StreamSample> {
    return new Promise((resolve, reject) => {
        let ttfb = 0n;
        let bytes = 0;
        const start = process.hrtime.bigint();
        const sink = new Writable({
            write(chunk: Buffer, _enc, cb) {
                if (ttfb === 0n) ttfb = process.hrtime.bigint() - start;
                bytes += chunk.length;
                cb();
            }
        });
        sink.on('finish', () => {
            resolve({ ttfbNs: ttfb, totalNs: process.hrtime.bigint() - start, bytes });
        });
        sink.on('error', reject);
        const { pipe } = renderToPipeableStream(element, {
            // Pipe as soon as the shell is ready so the first chunk timestamps
            // TTFB; remaining content streams until the sink finishes.
            onShellReady() { pipe(sink); },
            onShellError(err) { reject(err); },
            onError(err) { reject(err as Error); }
        });
    });
}

const adapter: FrameworkAdapter = {
    name: 'react',
    renderToString: async (scenario) => renderToString(build(scenario)),
    renderStream: (scenario) => measurePipeable(build(scenario))
};

export default adapter;
