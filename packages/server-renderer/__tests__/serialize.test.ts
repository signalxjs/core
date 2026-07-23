/**
 * The shared serializer module — one escaping/key-safety/dev-warning
 * discipline for every state blob, plus the per-app type-handler seam
 * (TYPE_HANDLER_TOKEN / provideTypeHandlers from sigx/internals).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    escapeJsonForScript,
    assignmentJs,
    stringifyWithHandlers,
    serializeBoundaryProps,
    getTypeHandlers,
    admitPayloadEntry,
    type TypeHandler
} from '../src/server/serialize';
import { asyncAssignmentJs } from '../src/server/state';
import { createSSRContext } from '../src/server/context';
import { provideTypeHandlers, TYPE_HANDLER_TOKEN } from 'sigx/internals';

afterEach(() => {
    vi.restoreAllMocks();
});

const dateHandler: TypeHandler = {
    name: 'date',
    test: (v) => v instanceof Date,
    serialize: (v) => ({ $date: (v as Date).getTime() })
};

describe('assignmentJs — the one blob discipline', () => {
    it('emits the null-prototype Object.assign statement for any global', () => {
        const js = assignmentJs('__SIGX_BOUNDARIES__', { 3: { hydrate: 'visible' } });
        expect(js).toBe(
            'window.__SIGX_BOUNDARIES__=Object.assign(Object.create(null),window.__SIGX_BOUNDARIES__,' +
            '{"3":{"hydrate":"visible"}});'
        );
    });

    it('asyncAssignmentJs is byte-identical to the pre-refactor wire format', () => {
        expect(asyncAssignmentJs({ stats: { n: 1 } })).toBe(
            'window.__SIGX_ASYNC__=Object.assign(Object.create(null),window.__SIGX_ASYNC__,{"stats":{"n":1}});'
        );
    });

    it('escapes script-breaking characters in values', () => {
        const js = assignmentJs('__SIGX_ASYNC__', { x: '</script><script>alert(1)</script>' });
        expect(js).not.toContain('</script>');
        expect(js).toContain('\\u003c/script\\u003e');
        expect(escapeJsonForScript(JSON.stringify('\u2028\u2029'))).toBe('"\\u2028\\u2029"');
    });
});

describe('stringifyWithHandlers — type-handler chain', () => {
    it('hands the RAW value to handlers (before toJSON — Date is matchable)', () => {
        const d = new Date(1720000000000);
        expect(stringifyWithHandlers({ at: d }, [dateHandler]))
            .toBe('{"at":{"$date":1720000000000}}');
    });

    it('matches at the top level and inside arrays', () => {
        const d = new Date(5);
        expect(stringifyWithHandlers(d, [dateHandler])).toBe('{"$date":5}');
        expect(stringifyWithHandlers([d], [dateHandler])).toBe('[{"$date":5}]');
    });

    it('first matching handler wins; unmatched values pass through', () => {
        const loud: TypeHandler = { name: 'loud', test: (v) => v instanceof Date, serialize: () => 'LOUD' };
        expect(stringifyWithHandlers({ at: new Date(5), n: 1 }, [dateHandler, loud]))
            .toBe('{"at":{"$date":5},"n":1}');
    });

    it('is plain JSON.stringify with no handlers', () => {
        expect(stringifyWithHandlers({ a: 1 }, [])).toBe('{"a":1}');
    });
});

describe('serializeBoundaryProps', () => {
    it('keeps data props, silently drops internals / functions / handlers / undefined', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(serializeBoundaryProps({
            start: 5,
            label: 'x',
            children: ['nested'],
            key: 'k',
            ref: {},
            slots: {},
            $models: {},
            onClick: () => {},
            handler: () => {},
            sym: Symbol('s'),
            missing: undefined
        })).toEqual({ start: 5, label: 'x' });
        expect(warn).not.toHaveBeenCalled();
    });

    it('returns undefined when nothing survives', () => {
        expect(serializeBoundaryProps({ onClick: () => {} })).toBeUndefined();
        expect(serializeBoundaryProps(null)).toBeUndefined();
        expect(serializeBoundaryProps({})).toBeUndefined();
    });

    it('dev-warns on circular values and dangerous keys, dropping them', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const circular: any = {};
        circular.self = circular;
        expect(serializeBoundaryProps({ circular, ok: 1, __proto__valid: 2 })).toEqual({ ok: 1, __proto__valid: 2 });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('boundary prop("circular")'));

        warn.mockClear();
        const props = Object.create(null);
        props.constructor = { evil: true };
        props.ok = 1;
        expect(serializeBoundaryProps(props)).toEqual({ ok: 1 });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"constructor"'));
    });

    it('a type handler claiming a value bypasses the JSON check', () => {
        const bigintHandler: TypeHandler = {
            name: 'bigint',
            test: (v) => typeof v === 'bigint',
            serialize: (v) => ({ $bigint: String(v) })
        };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(serializeBoundaryProps({ big: 10n }, [bigintHandler])).toEqual({ big: 10n });
        expect(warn).not.toHaveBeenCalled();
    });
});

describe('admitPayloadEntry — codec-aware admission (#420)', () => {
    it('admits handler-owned values NESTED in plain structures', () => {
        // Plain JSON.stringify THROWS on a nested bigint and flattens a
        // nested Map — but the emitter tags both, so admission must agree.
        expect(admitPayloadEntry('k', { total: 42n }, 'boundary prop', [])).toBe(true);
        expect(admitPayloadEntry('k', { seen: new Map([['a', 1]]) }, 'boundary prop', [])).toBe(true);
    });

    it('consults registered handlers at depth too', () => {
        // Self-referential: plain JSON AND the built-in walk throw on the
        // cycle — only the registered handler, applied AT DEPTH, breaks it
        // by serializing the id. Admission must flip with the handler.
        class Selfish {
            self: Selfish;
            constructor(public id: number) { this.self = this; }
        }
        const selfish: TypeHandler = {
            name: 'selfish',
            tag: '$selfish',
            test: (v) => v instanceof Selfish,
            serialize: (v) => (v as Selfish).id,
            revive: (v) => new Selfish(v as number)
        };
        const value = { node: new Selfish(7) };

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(admitPayloadEntry('k', value, 'boundary prop', [])).toBe(false);
        warn.mockRestore();
        expect(admitPayloadEntry('k', value, 'boundary prop', [selfish])).toBe(true);
    });

    it('still rejects circular structures and dangerous keys with a warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const circular: any = {};
        circular.self = circular;
        expect(admitPayloadEntry('k', circular, 'boundary prop', [])).toBe(false);
        expect(admitPayloadEntry('__proto__', { fine: 1 }, 'boundary prop', [])).toBe(false);
        expect(warn).toHaveBeenCalledTimes(2);
        warn.mockRestore();
    });
});

describe('provideTypeHandlers — per-app seam', () => {
    it('accumulates handlers across installs, earlier first', () => {
        const provides = new Map<symbol, unknown>();
        const a: TypeHandler = { name: 'a', test: () => false, serialize: (v) => v };
        const b: TypeHandler = { name: 'b', test: () => false, serialize: (v) => v };
        provideTypeHandlers({ provides }, [a]);
        provideTypeHandlers({ provides }, [b]);
        expect((provides.get(TYPE_HANDLER_TOKEN) as TypeHandler[]).map(h => h.name)).toEqual(['a', 'b']);
    });

    it('getTypeHandlers resolves through ctx._appContext, empty without an app', () => {
        const ctx = createSSRContext();
        expect(getTypeHandlers(ctx)).toEqual([]);

        const provides = new Map<symbol, unknown>();
        provideTypeHandlers({ provides }, [dateHandler]);
        ctx._appContext = { provides } as any;
        expect(getTypeHandlers(ctx).map(h => h.name)).toEqual(['date']);
    });
});
