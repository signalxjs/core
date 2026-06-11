/**
 * Vue adapter — same logical trees built with h()/defineComponent, rendered
 * through @vue/server-renderer. Children of components are passed as function
 * slots (Vue's equivalent of sigx's slots.default()).
 */
import { h, defineComponent, createSSRApp, type VNode, type VNodeChild } from 'vue';
import { renderToString, renderToNodeStream } from '@vue/server-renderer';
import type { FrameworkAdapter, ScenarioName } from './types.ts';
import { measureReadable } from './measure.ts';
import {
    SMALL_PAGE, ROWS_10K, ROWS_1K, DEEP_TREE, ATTR_ITEMS, ESCAPE,
    scoreColor, type TableRow
} from '../scenarios/data.ts';

// --- components -------------------------------------------------------------

const Card = defineComponent({
    props: { title: { type: String, required: true } },
    setup(props, { slots }) {
        return () => h('section', { class: 'card' }, [
            h('h2', props.title),
            h('div', { class: 'card-body' }, slots.default ? slots.default() : [])
        ]);
    }
});

const Row = defineComponent({
    props: { row: { type: Object, required: true } },
    setup(props) {
        const row = props.row as TableRow;
        return () => h('tr', { class: row.active ? 'row active' : 'row' }, [
            h('td', String(row.id)),
            h('td', row.name),
            h('td', row.email),
            h('td', row.role),
            h('td', [h('span', { style: { color: scoreColor(row.score) } }, row.score.toFixed(2))]),
            h('td', row.active ? 'yes' : 'no')
        ]);
    }
});

const Table = defineComponent({
    props: { rows: { type: Array, required: true } },
    setup(props) {
        const rows = props.rows as TableRow[];
        return () => h('table', { class: 'data' }, [
            h('tbody', rows.map((row) => h(Row, { row, key: row.id })))
        ]);
    }
});

// Explicit return annotations break the self-referential type inference cycle
// (Level appears in its own initializer via the recursive h() call).
const Level = defineComponent({
    name: 'Level',
    props: { depth: { type: Number, required: true }, branching: { type: Number, required: true } },
    setup(props) {
        const { depth, branching } = props;
        return (): VNode => h('div', { class: `lvl lvl-${depth}` },
            depth <= 1
                ? 'leaf'
                : Array.from({ length: branching }, (_, i): VNode =>
                    h(Level, { depth: depth - 1, branching, key: i })));
    }
});

// --- scenario trees ----------------------------------------------------------

function smallPage(): VNodeChild {
    return h('div', { id: 'app' }, [
        h('header', [
            h('h1', SMALL_PAGE.title),
            h('nav', SMALL_PAGE.navLinks.map((l) => h('a', { href: l.href, key: l.href }, l.label)))
        ]),
        h('main', SMALL_PAGE.cards.map((c, i) =>
            h(Card, { title: c.title, key: i },
                () => c.paragraphs.map((p, j) => h('p', { key: j }, p))))),
        h('footer', [h('p', SMALL_PAGE.footer)])
    ]);
}

function attrStyleHeavy(): VNodeChild {
    return h('div', { class: 'attr-grid' }, ATTR_ITEMS.map((item) => h('div', {
        id: item.id,
        class: item.className,
        'data-index': item.dataIndex,
        'data-group': item.dataGroup,
        title: item.title,
        tabindex: item.tabIndex,
        role: item.role,
        style: item.style,
        key: item.id
    }, item.label)));
}

function article(paragraphs: string[]): VNodeChild {
    return h('article', { class: 'prose' }, paragraphs.map((p, i) => h('p', { key: i }, p)));
}

function build(scenario: ScenarioName): VNodeChild {
    switch (scenario) {
        case 'small-page': return smallPage();
        case 'large-table': return h(Table, { rows: ROWS_10K });
        case 'large-table-1k': return h(Table, { rows: ROWS_1K });
        case 'deep-tree': return h(Level, { depth: DEEP_TREE.depth, branching: DEEP_TREE.branching });
        case 'attr-style-heavy': return attrStyleHeavy();
        case 'escape-heavy': return article(ESCAPE.dirty);
        case 'escape-clean': return article(ESCAPE.clean);
    }
}

function makeApp(scenario: ScenarioName) {
    return createSSRApp({ render: () => build(scenario) });
}

const adapter: FrameworkAdapter = {
    name: 'vue',
    renderToString: (scenario) => renderToString(makeApp(scenario)),
    renderStream: (scenario) => measureReadable(() => renderToNodeStream(makeApp(scenario)))
};

export default adapter;
