/**
 * Deterministic scenario data shared by every framework adapter.
 *
 * All randomness goes through a tiny seeded PRNG (mulberry32) so each run —
 * and each framework — benches the exact same input.
 */

/** mulberry32 — tiny 32-bit seeded PRNG, returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ---------------------------------------------------------------------------
// Table rows
// ---------------------------------------------------------------------------

export interface TableRow {
    id: number;
    name: string;
    email: string;
    role: string;
    active: boolean;
    score: number;
}

// Several names deliberately contain characters that need HTML escaping.
const FIRST_NAMES = ['Ada', 'Grace', 'Tim & Tam', 'Alan <The Great>', 'Edsger', '"Deno"', 'Barbara', 'Linus'];
const LAST_NAMES = ['Lovelace', 'Hopper & Co', 'O"Connor', 'Turing', 'Dijkstra', 'Liskov <jr>', 'Kernighan', 'Ritchie'];
const ROLES = ['admin', 'editor', 'viewer', 'owner'];

export function tableRows(n: number): TableRow[] {
    const rng = mulberry32(0xc0ffee);
    const rows: TableRow[] = [];
    for (let i = 0; i < n; i++) {
        const first = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)];
        const last = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)];
        rows.push({
            id: i + 1,
            name: `${first} ${last}`,
            // `&` and `+` in the local part: the email text needs escaping too
            email: `user+${i + 1}&tag@example.com`,
            role: ROLES[i % ROLES.length],
            active: rng() < 0.5,
            score: Math.round(rng() * 10000) / 100
        });
    }
    return rows;
}

/** Score → color, shared so the nested <span style> is identical everywhere. */
export function scoreColor(score: number): string {
    return score >= 50 ? '#0a7f2e' : '#b00020';
}

// ---------------------------------------------------------------------------
// Deep tree
// ---------------------------------------------------------------------------

export interface DeepTreeSpec {
    depth: number;
    branching: number;
}

export function deepTreeSpec(depth = 12, branching = 3): DeepTreeSpec {
    return { depth, branching };
}

// ---------------------------------------------------------------------------
// Attribute/style-heavy items
// ---------------------------------------------------------------------------

export interface AttrItem {
    id: string;
    className: string;
    dataIndex: string;
    dataGroup: string;
    title: string;
    tabIndex: number;
    role: string;
    /**
     * Style values are strings with explicit units on purpose: React and
     * Preact append `px` to bare numbers while sigx and Vue do not, so
     * numeric values would make the rendered styles diverge.
     */
    style: { color: string; marginTop: string; fontSize: string; paddingLeft: string };
    label: string;
}

export function attrItems(n = 2000): AttrItem[] {
    const rng = mulberry32(0x5eed);
    const items: AttrItem[] = [];
    for (let i = 0; i < n; i++) {
        const hue = Math.floor(rng() * 0xffffff);
        items.push({
            id: `item-${i}`,
            className: `cell c${i % 7}${i % 11 === 0 ? ' highlight' : ''}`,
            dataIndex: String(i),
            dataGroup: `g${i % 13}`,
            title: `Item ${i} of group g${i % 13}`,
            tabIndex: i % 5,
            role: 'listitem',
            style: {
                color: `#${hue.toString(16).padStart(6, '0')}`,
                marginTop: `${(i % 9) + 1}px`,
                fontSize: `${12 + (i % 6)}px`,
                paddingLeft: `${(i % 4) * 2}px`
            },
            label: `Item ${i}`
        });
    }
    return items;
}

// ---------------------------------------------------------------------------
// Escape-heavy / escape-clean text (~50KB each)
// ---------------------------------------------------------------------------

const CLEAN_WORDS = [
    'signal', 'render', 'stream', 'component', 'reactive', 'template',
    'hydrate', 'server', 'client', 'update', 'effect', 'computed'
];
// Dense in &, <, >, " and ' so the escaper is exercised on nearly every word.
const DIRTY_WORDS = [
    'a&b', '<tag>', '"quoted"', "it's", '5<6', '7>2', 'x&&y', '<&>',
    '"<mix>"', "don't&won't", 'a<b>c', '&amp-ish'
];

export function escapeText(paragraphs = 64): { dirty: string[]; clean: string[] } {
    const build = (words: string[], seed: number): string[] => {
        const rng = mulberry32(seed);
        const out: string[] = [];
        for (let p = 0; p < paragraphs; p++) {
            const parts: string[] = [];
            // ~110 words x ~7 chars ≈ 800 chars/paragraph → ~50KB total
            for (let w = 0; w < 110; w++) {
                parts.push(words[Math.floor(rng() * words.length)]);
            }
            out.push(parts.join(' '));
        }
        return out;
    };
    return { dirty: build(DIRTY_WORDS, 0xd1147), clean: build(CLEAN_WORDS, 0xc1ea4) };
}

// ---------------------------------------------------------------------------
// Small page
// ---------------------------------------------------------------------------

export interface SmallPageData {
    title: string;
    navLinks: Array<{ href: string; label: string }>;
    cards: Array<{ title: string; paragraphs: string[] }>;
    footer: string;
}

export const SMALL_PAGE: SmallPageData = {
    title: 'SSR Benchmark — Small Page',
    navLinks: [
        { href: '/', label: 'Home' },
        { href: '/docs', label: 'Docs & Guides' },
        { href: '/blog', label: 'Blog' },
        { href: '/about', label: 'About <us>' },
        { href: '/contact', label: 'Contact' }
    ],
    cards: [
        {
            title: 'Fast & lean',
            paragraphs: ['Renders straight to a string.', 'No client runtime needed for this page.']
        },
        {
            title: 'Streaming "TTFB"',
            paragraphs: ['First byte before the last row.', 'Backpressure-aware output.']
        },
        {
            title: 'Escaping <safely>',
            paragraphs: ['All text is HTML-escaped.', "Attributes too — it's table stakes."]
        }
    ],
    footer: '© 2026 bench & co — all comparisons rendered server-side'
};

// ---------------------------------------------------------------------------
// Hoisted, shared instances (built once per process, reused by every adapter)
// ---------------------------------------------------------------------------

export const ROWS_10K: TableRow[] = tableRows(10000);
export const ROWS_1K: TableRow[] = tableRows(1000);
export const DEEP_TREE: DeepTreeSpec = deepTreeSpec();
export const ATTR_ITEMS: AttrItem[] = attrItems();
export const ESCAPE: { dirty: string[]; clean: string[] } = escapeText();
