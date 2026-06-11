/**
 * sigx adapter — builds the shared scenarios with sigx's jsx() runtime and
 * renders through @sigx/server-renderer (built dist via the workspace dep).
 */
import { jsx } from 'sigx/jsx-runtime';
import { component, type JSXElement } from 'sigx';
import { renderToString, renderToNodeStream } from '@sigx/server-renderer/server';
import type { FrameworkAdapter, ScenarioName } from './types.ts';
import { measureReadable } from './measure.ts';
import {
    SMALL_PAGE, ROWS_10K, ROWS_1K, DEEP_TREE, ATTR_ITEMS, ESCAPE,
    scoreColor, type TableRow
} from '../scenarios/data.ts';

// --- components -------------------------------------------------------------

const Card = component<{ title: string }>((ctx) => {
    const { title } = ctx.props;
    const { slots } = ctx;
    return () => jsx('section', {
        class: 'card',
        children: [
            jsx('h2', { children: title }),
            jsx('div', { class: 'card-body', children: slots.default() })
        ]
    });
});

const Row = component<{ row: TableRow }>((ctx) => {
    const row = ctx.props.row as TableRow;
    return () => jsx('tr', {
        class: row.active ? 'row active' : 'row',
        children: [
            jsx('td', { children: String(row.id) }),
            jsx('td', { children: row.name }),
            jsx('td', { children: row.email }),
            jsx('td', { children: row.role }),
            jsx('td', {
                children: jsx('span', { style: { color: scoreColor(row.score) }, children: row.score.toFixed(2) })
            }),
            jsx('td', { children: row.active ? 'yes' : 'no' })
        ]
    });
});

const Table = component<{ rows: TableRow[] }>((ctx) => {
    const rows = ctx.props.rows as TableRow[];
    return () => jsx('table', {
        class: 'data',
        children: jsx('tbody', {
            children: rows.map((row) => jsx(Row, { row }, String(row.id)))
        })
    });
});

const Level = component<{ depth: number; branching: number }>((ctx) => {
    const { depth, branching } = ctx.props;
    return () => jsx('div', {
        class: `lvl lvl-${depth}`,
        children: depth <= 1
            ? 'leaf'
            : Array.from({ length: branching }, (_, i) =>
                jsx(Level, { depth: depth - 1, branching }, String(i)))
    });
});

// --- scenario trees ----------------------------------------------------------

function smallPage(): JSXElement {
    return jsx('div', {
        id: 'app',
        children: [
            jsx('header', {
                children: [
                    jsx('h1', { children: SMALL_PAGE.title }),
                    jsx('nav', {
                        children: SMALL_PAGE.navLinks.map((l) =>
                            jsx('a', { href: l.href, children: l.label }, l.href))
                    })
                ]
            }),
            jsx('main', {
                children: SMALL_PAGE.cards.map((c, i) =>
                    jsx(Card, {
                        title: c.title,
                        children: c.paragraphs.map((p, j) => jsx('p', { children: p }, String(j)))
                    }, String(i)))
            }),
            jsx('footer', { children: jsx('p', { children: SMALL_PAGE.footer }) })
        ]
    });
}

function attrStyleHeavy(): JSXElement {
    return jsx('div', {
        class: 'attr-grid',
        children: ATTR_ITEMS.map((item) => jsx('div', {
            id: item.id,
            class: item.className,
            'data-index': item.dataIndex,
            'data-group': item.dataGroup,
            title: item.title,
            tabindex: item.tabIndex,
            role: item.role,
            style: item.style,
            children: item.label
        }, item.id))
    });
}

function article(paragraphs: string[]): JSXElement {
    return jsx('article', {
        class: 'prose',
        children: paragraphs.map((p, i) => jsx('p', { children: p }, String(i)))
    });
}

function build(scenario: ScenarioName): JSXElement {
    switch (scenario) {
        case 'small-page': return smallPage();
        case 'large-table': return jsx(Table, { rows: ROWS_10K });
        case 'large-table-1k': return jsx(Table, { rows: ROWS_1K });
        case 'deep-tree': return jsx(Level, { depth: DEEP_TREE.depth, branching: DEEP_TREE.branching });
        case 'attr-style-heavy': return attrStyleHeavy();
        case 'escape-heavy': return article(ESCAPE.dirty);
        case 'escape-clean': return article(ESCAPE.clean);
    }
}

const adapter: FrameworkAdapter = {
    name: 'sigx',
    renderToString: (scenario) => renderToString(build(scenario)),
    renderStream: (scenario) => measureReadable(() => renderToNodeStream(build(scenario)))
};

export default adapter;
