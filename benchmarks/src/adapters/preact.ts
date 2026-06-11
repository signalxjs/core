/**
 * Preact adapter — same logical trees built with h(), rendered through
 * preact-render-to-string. No node-stream API worth benching, so no
 * renderStream (preact-render-to-string's stream entry targets web streams
 * and Suspense, not a plain node Readable).
 */
import { h, type ComponentChildren, type VNode } from 'preact';
import { render } from 'preact-render-to-string';
import type { FrameworkAdapter, ScenarioName } from './types.ts';
import {
    SMALL_PAGE, ROWS_10K, ROWS_1K, DEEP_TREE, ATTR_ITEMS, ESCAPE,
    scoreColor, type TableRow, type AttrItem
} from '../scenarios/data.ts';

// --- components -------------------------------------------------------------

function Card({ title, children }: { title: string; children?: ComponentChildren }) {
    return h('section', { class: 'card' },
        h('h2', null, title),
        h('div', { class: 'card-body' }, children));
}

function Row({ row }: { row: TableRow }) {
    return h('tr', { class: row.active ? 'row active' : 'row' },
        h('td', null, String(row.id)),
        h('td', null, row.name),
        h('td', null, row.email),
        h('td', null, row.role),
        h('td', null, h('span', { style: { color: scoreColor(row.score) } }, row.score.toFixed(2))),
        h('td', null, row.active ? 'yes' : 'no'));
}

function Table({ rows }: { rows: TableRow[] }) {
    return h('table', { class: 'data' },
        h('tbody', null, rows.map((row) => h(Row, { row, key: row.id }))));
}

function Level({ depth, branching }: { depth: number; branching: number }): VNode<any> {
    return h('div', { class: `lvl lvl-${depth}` },
        depth <= 1
            ? 'leaf'
            : Array.from({ length: branching }, (_, i) =>
                h(Level, { depth: depth - 1, branching, key: i })));
}

// --- scenario trees ----------------------------------------------------------

function smallPage(): VNode<any> {
    return h('div', { id: 'app' },
        h('header', null,
            h('h1', null, SMALL_PAGE.title),
            h('nav', null, SMALL_PAGE.navLinks.map((l) => h('a', { href: l.href, key: l.href }, l.label)))),
        h('main', null, SMALL_PAGE.cards.map((c, i) =>
            h(Card, { title: c.title, key: i },
                c.paragraphs.map((p, j) => h('p', { key: j }, p))))),
        h('footer', null, h('p', null, SMALL_PAGE.footer)));
}

function attrDiv(item: AttrItem): VNode<any> {
    return h('div', {
        id: item.id,
        class: item.className,
        'data-index': item.dataIndex,
        'data-group': item.dataGroup,
        title: item.title,
        tabIndex: item.tabIndex,
        role: item.role,
        style: item.style,
        key: item.id
    }, item.label);
}

function article(paragraphs: string[]): VNode<any> {
    return h('article', { class: 'prose' }, paragraphs.map((p, i) => h('p', { key: i }, p)));
}

function build(scenario: ScenarioName): VNode<any> {
    switch (scenario) {
        case 'small-page': return smallPage();
        case 'large-table': return h(Table, { rows: ROWS_10K });
        case 'large-table-1k': return h(Table, { rows: ROWS_1K });
        case 'deep-tree': return h(Level, { depth: DEEP_TREE.depth, branching: DEEP_TREE.branching });
        case 'attr-style-heavy': return h('div', { class: 'attr-grid' }, ATTR_ITEMS.map(attrDiv));
        case 'escape-heavy': return article(ESCAPE.dirty);
        case 'escape-clean': return article(ESCAPE.clean);
    }
}

const adapter: FrameworkAdapter = {
    name: 'preact',
    renderToString: async (scenario) => render(build(scenario))
};

export default adapter;
