/**
 * Shared perf-proof harness for counting tests and benchmarks.
 *
 * `createCountingNodeOps()` is the established mock-DOM pattern from
 * `reconciler.test.ts` / `renderer-mount.test.ts`, extended with a
 * `counts()` accessor that buckets the operation log so tests can assert
 * exact DOM-op counts (the deterministic proof for renderer optimizations).
 */

export interface MockNode {
    id: number;
    type: string;
    children: MockNode[];
    textContent: string;
    parentNode: MockNode | null;
    [key: string]: any;
}

export interface OpCounts {
    createElement: number;
    createText: number;
    createComment: number;
    insert: number;
    remove: number;
    setText: number;
    setElementText: number;
    patchProp: number;
}

export function createCountingNodeOps() {
    const operations: string[] = [];
    let nodeIdCounter = 0;

    const createNode = (type: string): MockNode => {
        const id = ++nodeIdCounter;
        return { id, type, children: [], textContent: '', parentNode: null };
    };

    return {
        operations,
        createElement: (type: string) => {
            const node = createNode(type);
            operations.push(`createElement:${type}#${node.id}`);
            return node;
        },
        createText: (text: string) => {
            const node = createNode('TEXT');
            node.textContent = text;
            operations.push(`createText:"${text}"#${node.id}`);
            return node;
        },
        createComment: (text: string) => {
            const node = createNode('COMMENT');
            operations.push(`createComment:${text}#${node.id}`);
            return node;
        },
        insert: (child: MockNode, parent: MockNode, anchor?: MockNode | null) => {
            if (child.parentNode) {
                const idx = child.parentNode.children.indexOf(child);
                if (idx > -1) child.parentNode.children.splice(idx, 1);
            }
            if (anchor) {
                const idx = parent.children.indexOf(anchor);
                parent.children.splice(idx, 0, child);
                operations.push(`insert:#${child.id}->parent#${parent.id}@anchor#${anchor.id}`);
            } else {
                parent.children.push(child);
                operations.push(`insert:#${child.id}->parent#${parent.id}`);
            }
            child.parentNode = parent;
        },
        remove: (child: MockNode) => {
            if (child.parentNode) {
                const idx = child.parentNode.children.indexOf(child);
                if (idx > -1) child.parentNode.children.splice(idx, 1);
            }
            operations.push(`remove:#${child.id}`);
        },
        patchProp: (el: MockNode, key: string, _prev: any, next: any) => {
            el[key] = next;
            operations.push(`patchProp:#${el.id}.${key}=${next}`);
        },
        setText: (node: MockNode, text: string) => {
            node.textContent = text;
            operations.push(`setText:#${node.id}="${text}"`);
        },
        setElementText: (el: MockNode, text: string) => {
            el.textContent = text;
            operations.push(`setElementText:#${el.id}="${text}"`);
        },
        parentNode: (node: MockNode) => node.parentNode,
        nextSibling: (node: MockNode) => {
            if (!node.parentNode) return null;
            const idx = node.parentNode.children.indexOf(node);
            return node.parentNode.children[idx + 1] || null;
        },
        createContainer: (): MockNode => createNode('container'),
        counts: (): OpCounts => {
            const counts: OpCounts = {
                createElement: 0,
                createText: 0,
                createComment: 0,
                insert: 0,
                remove: 0,
                setText: 0,
                setElementText: 0,
                patchProp: 0,
            };
            for (const op of operations) {
                const kind = op.slice(0, op.indexOf(':')) as keyof OpCounts;
                if (kind in counts) counts[kind]++;
            }
            return counts;
        },
        reset: () => {
            operations.length = 0;
        },
    };
}

/**
 * Flush point for tests that assert state after reactive writes.
 * Updates are synchronous today, so this is a microtask no-op — but every
 * counting test awaits it so that a future timing change only needs to be
 * reflected here.
 */
export function tick(): Promise<void> {
    return Promise.resolve();
}

export interface Row {
    id: number;
    label: string;
}

export function makeRows(n: number, offset = 0): Row[] {
    const rows: Row[] = new Array(n);
    for (let i = 0; i < n; i++) {
        rows[i] = { id: offset + i + 1, label: `row ${offset + i + 1}` };
    }
    return rows;
}
